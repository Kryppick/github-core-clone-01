// REST v3 surface for github-core-clone-01 (prefix /api/v3).
// One function, delegated to by app.ts: handleRest answers true when the path
// belongs to /api/v3 (and always answers JSON), false otherwise so other
// surfaces (git, GraphQL, MCP) can claim the request.
//
// Auth: every /api/v3 route needs `Authorization: Bearer <store.token>`
// (when the store token is empty, any non-empty Bearer is accepted), except
// GET /api/v3[/] and GET /api/v3/meta. Missing/wrong token -> 401 JSON.
// There is no 403 anywhere: another owner's repo is a 404. Every reply
// (including 204 and errors) carries application/json and a non-empty
// X-GitHub-Request-Id from store.nextRequestId().

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readBody, sendJson } from './util.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a pathname into decoded, non-empty segments. */
function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map(decodeSegment);
}

/** Answer with JSON (or an empty 204), always with a request id. */
function reply(res: ServerResponse, store: Store, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  };
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  sendJson(res, status, body, headers);
}

function replyError(res: ServerResponse, store: Store, status: number, message: string): void {
  reply(res, store, status, { message }, {});
}

/** Bearer check against the store token (any non-empty Bearer when unset). */
function authorized(req: IncomingMessage, store: Store): boolean {
  const header = (req.headers.authorization ?? '').trim();
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const token = (match[1] ?? '').trim();
  if (token === '') return false;
  if (store.token === '') return true;
  return token === store.token;
}

/**
 * Read and parse a JSON object body. An empty body is {}. A malformed body
 * (or a non-object JSON value) is a 400, per the protocol checks.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON in request body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

function parseNumberSegment(segment: string): number | undefined {
  if (!/^[0-9]+$/.test(segment)) return undefined;
  const n = Number.parseInt(segment, 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

// ---------------------------------------------------------------------------------------------
// Shapes (extra fields are allowed by the suite, so these carry the asserted ones)

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
    full_name: `${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: repo.owner },
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination (?per_page= & ?page=, GitHub-style Link header)

interface PageParams {
  perPage: number;
  page: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function paginate<T>(items: readonly T[], params: PageParams): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const start = (params.page - 1) * params.perPage;
  return { page: items.slice(start, start + params.perPage), totalPages };
}

/** `<url>; rel="next", ...` with the request's own origin; last page has no next. */
function linkHeader(req: IncomingMessage, pathname: string, params: PageParams, totalPages: number): string | null {
  if (totalPages <= 1) return null;
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
  const url = (page: number): string => `${origin}${pathname}?per_page=${params.perPage}&page=${page}`;
  const parts: string[] = [];
  if (params.page < totalPages) parts.push(`<${url(params.page + 1)}>; rel="next"`);
  if (params.page > 1) parts.push(`<${url(params.page - 1)}>; rel="prev"`);
  parts.push(`<${url(1)}>; rel="first"`);
  parts.push(`<${url(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function replyPage<T>(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  pathname: string,
  query: URLSearchParams,
  items: readonly T[],
): void {
  const params = pageParams(query);
  const { page, totalPages } = paginate(items, params);
  const extra: Record<string, string> = {};
  const link = linkHeader(req, pathname, params, totalPages);
  if (link !== null) extra.link = link;
  reply(res, store, 200, page, extra);
}

// ---------------------------------------------------------------------------------------------
// Repository resolution

/** The repo for /repos/{owner}/{name}/..., or a 404 (never a 403). */
function requireRepo(store: Store, owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  pathname: string,
  query: URLSearchParams,
): Promise<boolean> {
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  const method = req.method ?? 'GET';
  const seg = segmentsOf(pathname.replace(/^\/api\/v3/, '') || '/');

  try {
    // --- No-auth routes: the API root and /meta. ---
    if (method === 'GET' && seg.length === 0) {
      reply(
        res,
        store,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_authorizations_html_url: '/api/v3/authorizations',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          user_url: '/api/v3/users/{user}',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return true;
    }
    if (method === 'GET' && seg.length === 1 && seg[0] === 'meta') {
      reply(res, store, 200, { installed_version: '1.0.0' });
      return true;
    }

    // --- Everything else needs a Bearer token. ---
    if (!authorized(req, store)) {
      replyError(res, store, 401, 'Requires authentication');
      return true;
    }

    // --- JSON body for the methods that carry one (malformed -> 400). ---
    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const body = needsBody ? await readJsonBody(req) : {};

    // --- GET /user ---
    if (method === 'GET' && seg.length === 1 && seg[0] === 'user') {
      reply(res, store, 200, { login: store.viewerLogin, id: 1000, type: 'User' });
      return true;
    }

    // --- /user/repos ---
    if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
      if (method === 'POST') {
        const name = asString(body.name);
        if (name === '') throw new HttpError(422, 'Repository name is required');
        const repo = store.createRepo(name, asBool(body.private, false), asString(body.description));
        reply(res, store, 201, repoJson(repo));
        return true;
      }
      if (method === 'GET') {
        replyPage(req, res, store, pathname, query, store.listViewerRepos().map(repoJson));
        return true;
      }
      replyError(res, store, 404, 'Not Found');
      return true;
    }

    // --- /repos/{owner}/{name}[/...] ---
    if (seg.length >= 3 && seg[0] === 'repos') {
      const owner = seg[1] as string;
      const name = seg[2] as string;
      const repo = requireRepo(store, owner, name);
      const tail = seg.slice(3);

      // /repos/{o}/{r}
      if (tail.length === 0) {
        if (method === 'GET') {
          reply(res, store, 200, repoJson(repo));
          return true;
        }
        if (method === 'PATCH') {
          const description = body.description;
          if (typeof description === 'string') repo.description = description;
          reply(res, store, 200, repoJson(repo));
          return true;
        }
        if (method === 'DELETE') {
          store.deleteRepo(owner, name);
          reply(res, store, 204, null);
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/git/refs (create + list all)
      if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
        if (method === 'POST') {
          const ref = asString(body.ref);
          const sha = asString(body.sha);
          if (ref === '' || sha === '') throw new HttpError(422, 'ref and sha are required');
          store.createRef(repo, ref, sha);
          reply(res, store, 201, { ref, object: { sha } });
          return true;
        }
        if (method === 'GET') {
          const refs = [...repo.refs.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([ref, sha]) => ({ ref, object: { sha } }));
          reply(res, store, 200, refs);
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/git/refs/heads/{branch...}
      if (tail.length >= 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads') {
        const branch = tail.slice(3).join('/');
        if (method === 'GET') {
          const sha = repo.refs.get(`refs/heads/${branch}`);
          if (sha === undefined) throw new HttpError(404, 'Not Found');
          reply(res, store, 200, { ref: `refs/heads/${branch}`, object: { sha } });
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/branches
      if (tail.length === 1 && tail[0] === 'branches') {
        if (method === 'GET') {
          const branches = [...repo.refs.entries()]
            .filter(([ref]) => ref.startsWith('refs/heads/'))
            .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          reply(res, store, 200, branches);
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/branches/{branch...}
      if (tail.length >= 2 && tail[0] === 'branches') {
        const branch = tail.slice(1).join('/');
        if (method === 'GET') {
          const sha = store.branchTip(repo, branch);
          if (sha === undefined) throw new HttpError(404, 'Not Found');
          reply(res, store, 200, { name: branch, commit: { sha } });
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/commits[?sha=<ref>]
      if (tail.length === 1 && tail[0] === 'commits') {
        if (method === 'GET') {
          const ref = query.get('sha') ?? undefined;
          const commits = store.listCommits(repo, ref).map((c) => ({ sha: c.sha, commit: { message: c.message } }));
          reply(res, store, 200, commits);
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/contents/{path...} (path '' = root directory)
      if (tail.length >= 1 && tail[0] === 'contents') {
        const path = tail.slice(1).join('/');
        if (method === 'PUT') {
          const content = asString(body.content);
          if (content === '') throw new HttpError(422, 'content is required');
          const branch = asString(body.branch, repo.defaultBranch) || repo.defaultBranch;
          const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
          const result = store.putContents(repo, branch, path, content, asString(body.message), sha);
          const fileName = path.split('/').pop() ?? path;
          reply(res, store, result.isNew ? 201 : 200, {
            content: { sha: result.blobSha, encoding: 'base64', name: fileName, path },
            commit: { sha: result.commitSha },
          });
          return true;
        }
        if (method === 'GET') {
          const ref = query.get('ref') ?? repo.defaultBranch;
          const found = store.getContents(repo, ref, path);
          if (found === undefined) throw new HttpError(404, 'Not Found');
          if (found.kind === 'file') {
            const fileName = path.split('/').pop() ?? path;
            reply(res, store, 200, {
              type: 'file',
              encoding: 'base64',
              content: found.content.toString('base64'),
              sha: found.sha,
              size: found.size,
              name: fileName,
              path,
            });
          } else {
            reply(
              res,
              store,
              200,
              found.entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.sha })),
            );
          }
          return true;
        }
        if (method === 'DELETE') {
          const sha = asString(body.sha);
          if (sha === '') throw new HttpError(422, 'sha is required');
          const branch = asString(body.branch, repo.defaultBranch) || repo.defaultBranch;
          const result = store.deleteContents(repo, branch, path, asString(body.message), sha);
          reply(res, store, 200, { commit: { sha: result.commitSha } });
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/labels
      if (tail.length === 1 && tail[0] === 'labels') {
        if (method === 'POST') {
          const labelName = asString(body.name);
          if (labelName === '') throw new HttpError(422, 'Label name is required');
          const color = asString(body.color, 'ededed');
          repo.labels.set(labelName, { name: labelName, color });
          reply(res, store, 201, { name: labelName, color });
          return true;
        }
        if (method === 'GET') {
          reply(
            res,
            store,
            200,
            [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })),
          );
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/issues
      if (tail.length === 1 && tail[0] === 'issues') {
        if (method === 'POST') {
          const title = asString(body.title);
          if (title === '') throw new HttpError(422, 'Issue title is required');
          const issue = store.createIssue(repo, title, asString(body.body), asStringArray(body.labels));
          reply(res, store, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let issues = repo.issues;
          if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
          else if (state === 'all') issues = [...issues];
          else issues = issues.filter((i) => i.state === 'open');
          if (query.get('sort') === 'created') {
            const dir = query.get('direction') ?? 'desc';
            issues = [...issues].sort((a, b) =>
              dir === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
            );
          }
          replyPage(req, res, store, pathname, query, issues.map((i) => issueJson(repo, i)));
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/issues/{n}
      if (tail.length === 2 && tail[0] === 'issues') {
        const number = parseNumberSegment(tail[1] as string);
        const issue = number === undefined ? undefined : store.getIssue(repo, number);
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          reply(res, store, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const state = asString(body.state);
          if (state !== 'open' && state !== 'closed') throw new HttpError(422, 'state must be "open" or "closed"');
          issue.state = state;
          reply(res, store, 200, issueJson(repo, issue));
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/issues/{n}/comments
      if (tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments') {
        const number = parseNumberSegment(tail[1] as string);
        const issue = number === undefined ? undefined : store.getIssue(repo, number);
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'POST') {
          const commentBody = asString(body.body);
          if (commentBody === '') throw new HttpError(422, 'Comment body is required');
          const comment = store.addComment(repo, number as number, commentBody);
          reply(res, store, 201, { id: comment.id, body: comment.body });
          return true;
        }
        if (method === 'GET') {
          reply(
            res,
            store,
            200,
            issue.comments.map((c) => ({ id: c.id, body: c.body })),
          );
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/pulls
      if (tail.length === 1 && tail[0] === 'pulls') {
        if (method === 'POST') {
          const head = asString(body.head);
          const base = asString(body.base);
          const title = asString(body.title);
          if (head === '' || base === '' || title === '') {
            throw new HttpError(422, 'head, base and title are required');
          }
          const pull = store.createPull(repo, head, base, title, asString(body.body));
          reply(res, store, 201, pullJson(pull));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = repo.pulls;
          if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
          else if (state === 'all') pulls = [...pulls];
          else pulls = pulls.filter((p) => p.state === 'open');
          replyPage(req, res, store, pathname, query, pulls.map(pullJson));
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/pulls/{n}
      if (tail.length === 2 && tail[0] === 'pulls') {
        const number = parseNumberSegment(tail[1] as string);
        const pull = number === undefined ? undefined : store.getPull(repo, number);
        if (pull === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          reply(res, store, 200, pullJson(pull));
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/pulls/{n}/files
      if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'files') {
        const number = parseNumberSegment(tail[1] as string);
        const pull = number === undefined ? undefined : store.getPull(repo, number);
        if (pull === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          reply(
            res,
            store,
            200,
            pull.files.map((f) => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              changes: f.changes,
            })),
          );
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/pulls/{n}/merge
      if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'merge') {
        const number = parseNumberSegment(tail[1] as string);
        const pull = number === undefined ? undefined : store.getPull(repo, number);
        if (pull === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'PUT') {
          const result = store.mergePull(repo, pull);
          reply(res, store, 200, {
            merged: true,
            sha: result.sha,
            message: `Merge pull request #${pull.number} from ${pull.headRef}`,
          });
          return true;
        }
        replyError(res, store, 404, 'Not Found');
        return true;
      }

      replyError(res, store, 404, 'Not Found');
      return true;
    }

    // Unknown route under /api/v3.
    replyError(res, store, 404, 'Not Found');
    return true;
  } catch (err) {
    if (err instanceof HttpError) {
      replyError(res, store, err.status, err.message);
      return true;
    }
    replyError(res, store, 500, err instanceof Error ? err.message : 'Internal Server Error');
    return true;
  }
}
