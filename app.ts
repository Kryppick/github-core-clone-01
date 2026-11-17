// The forge's HTTP surface: one Store shared by all four surfaces, one thin
// router delegating to the protocol modules. main.ts owns the lifecycle
// (bind ephemeral port, register, poll /done); this file owns the routes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { sendJson } from './util.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitHttp } from './git-http.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  // Dev-only timing: GH_TIMING=1 logs one `TIMING <key> <ms>` line per request
  // to stderr (server-side handler time, excluding network). Off in trials.
  const timing = process.env.GH_TIMING === '1';
  const timed = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!timing) return fn();
    const start = performance.now();
    try {
      return await fn();
    } finally {
      process.stderr.write(`TIMING ${key} ${(performance.now() - start).toFixed(3)}\n`);
    }
  };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes. Every REST
        // reply carries X-GitHub-Request-Id (the protocol check reads it here).
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org', 'x-github-request-id': store.nextRequestId() });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (await timed('graphql', () => handleGraphQL(req, res, store))) return;
        }

        // MCP (Streamable HTTP).
        if (path === '/mcp') {
          if (await timed('mcp', () => handleMcp(req, res, store))) return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await timed('rest', () => handleRest(req, res, store, path, url.searchParams))) return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/...
        if (await timed(`git:${req.method ?? ''}:${(path.split('/').pop() ?? '').split('?')[0] ?? ''}`, () => handleGitHttp(req, res, store, path))) return;

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': store.nextRequestId() });
      } catch (err) {
        // Never let one request kill the server: answer 500 JSON and stay up.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do.
          }
        }
      }
    })();
  });
}
