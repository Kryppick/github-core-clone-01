// mcp.ts — Model Context Protocol endpoint (POST /mcp), JSON-RPC 2.0 Streamable HTTP.
// Answers are always plain application/json (never SSE); the client accepts both.
// One shared Store is the only state; the handler itself is stateless per request.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readBody, sendJson } from './util.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

/** Modern revisions, newest first; the first entry is the negotiated default. */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** Legacy handshake revisions the client offers, newest first. */
const LEGACY_VERSIONS: readonly string[] = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const MCP_UNSUPPORTED_VERSION = -32022;

type JsonRpcId = string | number | null;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Readonly<Record<string, { type: string; description: string }>>;
    required: readonly string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({ type: 'object' as const, properties: Object.freeze(properties), required: Object.freeze(required) }),
  });
}

/**
 * The six tools, as one frozen constant: two tools/list calls serialize the
 * same object, so their JSON is byte-identical. Required lists hold only
 * properties the suite can always fill (see SPEC "Argumen").
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: { type: 'string', description: 'Repository name.' },
    description: { type: 'string', description: 'Repository description.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
    owner: { type: 'string', description: 'Owner login (must be the authenticated user).' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name, or by full_name ("owner/repo").', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: { type: 'string', description: 'Full name "owner/repo".' },
  }, []),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: { type: 'string', description: 'Full name "owner/repo".' },
    title: { type: 'string', description: 'Issue title.' },
    body: { type: 'string', description: 'Issue body.' },
  }, ['title']),
  tool('list_issues', 'List issues of a repository, optionally filtered by state.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: { type: 'string', description: 'Full name "owner/repo".' },
    state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
  }, []),
  tool('create_pull_request', 'Create a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: { type: 'string', description: 'Full name "owner/repo".' },
    title: { type: 'string', description: 'Pull request title.' },
    head: { type: 'string', description: 'Head branch name.' },
    base: { type: 'string', description: 'Base branch name.' },
    body: { type: 'string', description: 'Pull request body.' },
  }, ['title', 'head', 'base']),
  tool('merge_pull_request', 'Merge an open pull request.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    full_name: { type: 'string', description: 'Full name "owner/repo".' },
    pull_number: { type: 'number', description: 'Pull request number.' },
    number: { type: 'number', description: 'Pull request number (alias of pull_number).' },
    title: { type: 'string', description: 'Pull request title (fallback lookup when no number is given).' },
    head: { type: 'string', description: 'Head branch name (fallback lookup when no number is given).' },
  }, []),
]);

// ------------------------------------------------------------ small helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize a property name the way the suite does: lowercase, drop non-alphanumerics. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The raw arguments object with normalized keys (first spelling wins). */
function normalizedArgs(value: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!isRecord(value)) return out;
  for (const [key, val] of Object.entries(value)) {
    const norm = normalizeKey(key);
    if (norm !== '' && !out.has(norm)) out.set(norm, val);
  }
  return out;
}

/** First present synonym wins; returns undefined when none is present. */
function pick(args: Map<string, unknown>, synonyms: readonly string[]): unknown {
  for (const synonym of synonyms) {
    const value = args.get(normalizeKey(synonym));
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickString(args: Map<string, unknown>, synonyms: readonly string[]): string | undefined {
  const value = pick(args, synonyms);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickNumber(args: Map<string, unknown>, synonyms: readonly string[]): number | undefined {
  const value = pick(args, synonyms);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function pickBoolean(args: Map<string, unknown>, synonyms: readonly string[]): boolean | undefined {
  const value = pick(args, synonyms);
  return typeof value === 'boolean' ? value : undefined;
}

// Synonym groups (SPEC "Argumen"; normalized spellings).
const SYN = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  fullName: ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pullNumber: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  description: ['description', 'about', 'summary', 'body'],
  isPrivate: ['private', 'is_private'],
  state: ['state', 'status'],
} as const;

/** Resolve owner + repo from arguments; full_name ("owner/repo") fills gaps. */
function resolveOwnerRepo(args: Map<string, unknown>, store: Store): { owner: string; repo: string } | null {
  let owner = pickString(args, SYN.owner);
  let repo = pickString(args, SYN.repo);
  const fullName = pickString(args, SYN.fullName);
  if ((owner === undefined || repo === undefined) && fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0 && slash < fullName.length - 1) {
      if (owner === undefined) owner = fullName.slice(0, slash);
      if (repo === undefined) repo = fullName.slice(slash + 1);
    }
  }
  if (repo === undefined) return null;
  return { owner: owner ?? store.viewerLogin, repo };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    full_name: `${repo.owner}/${repo.name}`,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    pull_number: pull.number,
    pull_request_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

/** A successful tool result: JSON text plus the same object as structuredContent. */
function toolOk(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** A tool execution error: isError:true with a plain-text explanation. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** A JSON-RPC error the suite raises as its own exception type. */
class RpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

// ------------------------------------------------------------ tool execution

function callTool(name: string, args: Map<string, unknown>, store: Store): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = pickString(args, SYN.name);
      if (repoName === undefined) return toolError('Missing required argument: name');
      const owner = pickString(args, SYN.owner);
      if (owner !== undefined && owner !== store.viewerLogin) {
        throw new RpcError(JSON_RPC_INVALID_PARAMS, `owner must be ${store.viewerLogin}`);
      }
      const description = pickString(args, SYN.description) ?? '';
      const isPrivate = pickBoolean(args, SYN.isPrivate) ?? false;
      try {
        const repo = store.createRepo(repoName, isPrivate, description);
        return toolOk(repoJson(repo));
      } catch (err) {
        if (err instanceof HttpError) return toolError(err.message);
        throw err;
      }
    }
    case 'get_repo': {
      const target = resolveOwnerRepo(args, store);
      if (target === null) return toolError('Missing required argument: repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const title = pickString(args, SYN.title);
      if (title === undefined) return toolError('Missing required argument: title');
      const target = resolveOwnerRepo(args, store);
      if (target === null) return toolError('Missing required argument: repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      const body = pickString(args, SYN.body) ?? '';
      try {
        const issue = store.createIssue(repo, title, body, []);
        return toolOk(issueJson(repo, issue));
      } catch (err) {
        if (err instanceof HttpError) return toolError(err.message);
        throw err;
      }
    }
    case 'list_issues': {
      const target = resolveOwnerRepo(args, store);
      if (target === null) return toolError('Missing required argument: repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      const state = pickString(args, SYN.state);
      const wanted = state === undefined ? 'all' : state.toLowerCase();
      const issues = repo.issues
        .filter((issue) => wanted === 'all' || issue.state === wanted)
        .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      return toolOk({ issues });
    }
    case 'create_pull_request': {
      const missing: string[] = [];
      const title = pickString(args, SYN.title);
      const head = pickString(args, SYN.head);
      const base = pickString(args, SYN.base);
      if (title === undefined) missing.push('title');
      if (head === undefined) missing.push('head');
      if (base === undefined) missing.push('base');
      if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
      const target = resolveOwnerRepo(args, store);
      if (target === null) return toolError('Missing required argument: repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      const body = pickString(args, SYN.body) ?? '';
      try {
        const pull = store.createPull(repo, head as string, base as string, title as string, body);
        return toolOk(pullJson(pull));
      } catch (err) {
        if (err instanceof HttpError) return toolError(err.message);
        throw err;
      }
    }
    case 'merge_pull_request': {
      const target = resolveOwnerRepo(args, store);
      if (target === null) return toolError('Missing required argument: repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError('Not Found');
      let pull: Pull | undefined;
      const number = pickNumber(args, SYN.pullNumber);
      if (number !== undefined) {
        pull = store.getPull(repo, number);
      } else {
        // Fallback: find the pull by title and/or head among the open ones.
        const title = pickString(args, SYN.title);
        const head = pickString(args, SYN.head);
        const open = repo.pulls.filter((p) => p.state === 'open');
        pull = open.find((p) => (title === undefined || p.title === title) && (head === undefined || p.headRef === head));
        if (pull === undefined && title === undefined && head === undefined && open.length === 1) pull = open[0];
      }
      if (pull === undefined) return toolError('Not Found');
      try {
        const { sha } = store.mergePull(repo, pull);
        return toolOk({
          merged: true,
          number: pull.number,
          pull_number: pull.number,
          sha,
          merge_commit_sha: sha,
          merged_at: pull.mergedAt,
          state: pull.state,
        });
      } catch (err) {
        if (err instanceof HttpError) return toolError(err.message);
        throw err;
      }
    }
    default:
      throw new RpcError(JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
  }
}

// ------------------------------------------------------------ JSON-RPC plumbing

function sendResult(res: ServerResponse, id: JsonRpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function sendRpcError(res: ServerResponse, httpStatus: number, id: JsonRpcId, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(res, httpStatus, { jsonrpc: '2.0', id, error });
}

/** The version a discover/initialize request asks for (top-level or _meta). */
function requestedVersion(params: Record<string, unknown>): string | undefined {
  if (typeof params.protocolVersion === 'string') return params.protocolVersion;
  const meta = params._meta;
  if (isRecord(meta)) {
    const v = meta['io.modelcontextprotocol/protocolVersion'] ?? meta.protocolVersion;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function handleMethod(method: string, params: Record<string, unknown>, store: Store): unknown {
  switch (method) {
    case 'server/discover': {
      const wanted = requestedVersion(params);
      if (wanted !== undefined && !SUPPORTED_VERSIONS.includes(wanted)) {
        throw new RpcError(MCP_UNSUPPORTED_VERSION, `Unsupported protocol version: ${wanted}`, { supported: [...SUPPORTED_VERSIONS] });
      }
      return {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const chosen = offered !== undefined && (SUPPORTED_VERSIONS.includes(offered) || LEGACY_VERSIONS.includes(offered))
        ? offered
        : undefined;
      if (chosen === undefined) {
        throw new RpcError(JSON_RPC_INVALID_PARAMS, `Unsupported protocol version: ${offered ?? '(none)'}`);
      }
      return {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    }
    case 'tools/list':
      // No pagination: every tool at once, no nextCursor.
      return { tools: TOOLS };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : undefined;
      if (name === undefined || name === '') {
        throw new RpcError(JSON_RPC_INVALID_PARAMS, 'tools/call requires a tool name');
      }
      const args = normalizedArgs(params.arguments);
      return callTool(name, args, store);
    }
    default:
      throw new RpcError(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/**
 * Handle the MCP endpoint. Returns true when this request was answered here
 * (POST /mcp, plus best-effort DELETE /mcp for a legacy session close);
 * false for any other method/path, so the caller can route it elsewhere.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/mcp') return false;
  if (req.method === 'DELETE') {
    // Legacy session close: best-effort, no body needed.
    sendJson(res, 200, {});
    return true;
  }
  if (req.method !== 'POST') return false;

  // Auth first, before the body is even read: a missing/wrong Bearer is 401
  // regardless of which tool or method the body names.
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (bearer === '' || (store.token !== '' && bearer !== store.token)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }

  // Body must be JSON; a malformed body is HTTP 400 + JSON-RPC -32700.
  let parsed: unknown;
  try {
    const raw = await readBody(req);
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendRpcError(res, 400, null, JSON_RPC_PARSE_ERROR, 'Parse error');
    return true;
  }
  if (!isRecord(parsed)) {
    sendRpcError(res, 400, null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
    return true;
  }

  // A request without an id is a notification (e.g. notifications/initialized):
  // 202 with an empty body, no JSON-RPC answer.
  const id: JsonRpcId | undefined = 'id' in parsed ? (parsed.id as JsonRpcId) : undefined;
  if (id === undefined) {
    if (!res.writableEnded) {
      res.writeHead(202, { 'content-length': '0' });
      res.end();
    }
    return true;
  }

  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};
  try {
    const result = handleMethod(method, params, store);
    sendResult(res, id, result);
  } catch (err) {
    if (err instanceof RpcError) {
      sendRpcError(res, 200, id, err.code, err.message, err.data);
    } else {
      // Never leak a stack or a 500 for a method/tool failure: unknown methods
      // and tools are already RpcErrors above; anything else is invalid params.
      sendRpcError(res, 200, id, JSON_RPC_INVALID_PARAMS, err instanceof Error ? err.message : 'Invalid params');
    }
  }
  return true;
}
