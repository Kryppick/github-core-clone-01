// graphql.ts — GraphQL v4 endpoint (POST /api/graphql) for the forge.
// Hand-written lexer + recursive-descent parser for the subset the suite sends:
// operations (named/anonymous, operationName), variables, literal/variable/enum
// arguments, object/list input values, aliases, inline fragments, __type.
// Fragment spreads are parsed and resolved when a matching fragment exists;
// anything else unknown is reported as a GraphQL error (HTTP 200), never a crash.
// All data comes from the single shared Store; mutations mutate that same store
// so the REST view sees them immediately.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { HttpError, opaqueId, parseJsonBody, readBody, sendJson } from './util.ts';

// ===========================================================================
// Lexer
// ===========================================================================

type TokenKind =
  | 'name'
  | 'int'
  | 'float'
  | 'string'
  | 'punct'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

function isNameStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i] as string;
    // Whitespace, commas (insignificant), BOM.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    // Comments.
    if (ch === '#') {
      while (i < n && input[i] !== '\n' && input[i] !== '\r') i += 1;
      continue;
    }
    // '...' spread.
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    // Punctuation.
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    // Strings (incl. block strings).
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new ParseError('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const c = input[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const e = input[j + 1] as string;
          if (e === 'u') {
            const hex = input.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseError('bad unicode escape in string');
            out += String.fromCharCode(parseInt(hex, 16));
            j += 6;
          } else {
            const map: Record<string, string> = {
              '"': '"',
              '\\': '\\',
              '/': '/',
              b: '\b',
              f: '\f',
              n: '\n',
              r: '\r',
              t: '\t',
            };
            const rep = map[e];
            if (rep === undefined) throw new ParseError(`bad escape \\${e} in string`);
            out += rep;
            j += 2;
          }
          continue;
        }
        if (c === '\n' || c === '\r') throw new ParseError('unterminated string');
        out += c;
        j += 1;
      }
      if (!closed) throw new ParseError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    // Numbers (incl. negative).
    if (ch === '-' || isDigit(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      if (j >= n || !isDigit(input[j] as string)) throw new ParseError(`unexpected character '${ch}'`);
      while (j < n && isDigit(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && j + 1 < n && isDigit(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < n && isDigit(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        let k = j + 1;
        if (input[k] === '+' || input[k] === '-') k += 1;
        if (k < n && isDigit(input[k] as string)) {
          isFloat = true;
          j = k;
          while (j < n && isDigit(input[j] as string)) j += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    // Names.
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < n && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character '${ch}'`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ===========================================================================
// AST + parser
// ===========================================================================

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; of: TypeNode }
  | { kind: 'nonNull'; of: TypeNode };

interface FieldNode {
  kind: 'field';
  alias: string | undefined;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | undefined;
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | undefined;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | SpreadNode | InlineFragmentNode;

interface VarDef {
  name: string;
  type: TypeNode;
  defaultValue: ValueNode | undefined;
}

interface Operation {
  op: 'query' | 'mutation' | 'subscription';
  name: string | undefined;
  varDefs: VarDef[];
  selectionSet: SelectionNode[];
}

interface FragmentDef {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const tok = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new ParseError(`expected '${value}' but got '${tok.value}'`);
    }
  }

  private acceptPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  private expectName(what = 'name'): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new ParseError(`expected ${what} but got '${tok.value}'`);
    return tok.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ op: 'query', name: undefined, varDefs: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        const op = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        const selectionSet = this.parseSelectionSet();
        operations.push({ op, name, varDefs, selectionSet });
        continue;
      }
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        const on = this.expectName("'on'");
        if (on !== 'on') throw new ParseError(`expected 'on' but got '${on}'`);
        const typeCondition = this.expectName('fragment type condition');
        const selectionSet = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selectionSet });
        continue;
      }
      throw new ParseError(`unexpected token '${tok.value}' at document level`);
    }
    if (operations.length === 0) throw new ParseError('document contains no operation');
    return { operations, fragments };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated variable definitions');
      this.expectPunct('$');
      const name = this.expectName('variable name');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.acceptPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', of: inner };
    } else {
      type = { kind: 'named', name: this.expectName('type name') };
    }
    if (this.acceptPunct('!')) type = { kind: 'nonNull', of: type };
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    // Fragment spread / inline fragment.
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('inline fragment type');
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.parseDirectives();
        return { kind: 'spread', name };
      }
      // Anonymous inline fragment: `... { ... }`.
      this.parseDirectives();
      return { kind: 'inline', typeCondition: undefined, selectionSet: this.parseSelectionSet() };
    }
    // Field (possibly aliased).
    let name = this.expectName('field name');
    let alias: string | undefined;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName('field name after alias');
    }
    const args = this.parseArgs();
    this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  /** Directives are not used by the suite; parse and discard them. */
  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('directive name');
      this.parseArgs();
    }
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated arguments');
      const name = this.expectName('argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      return { kind: 'variable', name: this.expectName('variable name') };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new ParseError('unterminated list value');
        values.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new ParseError('unterminated object value');
        const name = this.expectName('object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: parseFloat(tok.value) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new ParseError(`unexpected value token '${tok.value}'`);
  }
}

// ===========================================================================
// Execution
// ===========================================================================

interface GqlError {
  message: string;
}

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
  fragments: Map<string, FragmentDef>;
}

/** A resolved object node: its GraphQL type plus the payload the resolvers read. */
type NodeValue = Record<string, unknown> & { __typename: string };

function node(typename: string, payload: Record<string, unknown>): NodeValue {
  return { __typename: typename, ...payload };
}

function resolveValue(value: ValueNode, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, ctx.variables);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  const n = asNumber(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

// --- enums -----------------------------------------------------------------

const ISSUE_STATE = new Set(['OPEN', 'CLOSED']);
const MERGEABLE_STATE = new Set(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
const PR_STATE = new Set(['OPEN', 'CLOSED', 'MERGED']);
const PR_MERGE_METHOD = new Set(['MERGE', 'SQUASH', 'REBASE']);
const REPO_PERMISSION = new Set(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']);
const ISSUE_ORDER_FIELD = new Set(['CREATED_AT', 'UPDATED_AT', 'COMMENTS']);
const ORDER_DIRECTION = new Set(['ASC', 'DESC']);

function checkEnum(ctx: ExecCtx, value: unknown, allowed: Set<string>, what: string): boolean {
  if (typeof value !== 'string' || !allowed.has(value)) {
    ctx.errors.push({ message: `Invalid value for ${what}: ${JSON.stringify(value)}` });
    return false;
  }
  return true;
}

// --- introspection data ----------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'headRefOid', 'baseRefOid',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'url', 'description',
  ],
  User: ['login', 'id', 'databaseId', 'name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
  Comment: ['id', 'body'],
  CommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// --- cursors ---------------------------------------------------------------

function issueCursor(n: number): string {
  return Buffer.from(`cursor:issue:${n}`, 'utf8').toString('base64url');
}

function prCursor(n: number): string {
  return Buffer.from(`cursor:pr:${n}`, 'utf8').toString('base64url');
}

function parseCursor(after: unknown, prefix: string): number | null {
  if (typeof after !== 'string' || after === '') return null;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    const m = new RegExp(`^${prefix}:(\\d+)$`).exec(text);
    return m === null ? null : parseInt(m[1] as string, 10);
  } catch {
    return null;
  }
}

// --- store lookups ---------------------------------------------------------

function findRepoById(store: Store, id: string): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((i) => i.id === id);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function findPullById(store: Store, id: string): { repo: Repo; pull: Pull } | undefined {
  for (const repo of store.repos.values()) {
    const pull = repo.pulls.find((p) => p.id === id);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

function decodeOpaque(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx <= 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

// --- mergeability (same rule as Store.mergePull, without applying it) ------

function sameEntry(
  a: { oid: string; mode: string } | undefined,
  b: { oid: string; mode: string } | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid;
}

function computeMergeable(store: Store, repo: Repo, pull: Pull): string {
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (baseTip === undefined) return 'UNKNOWN';
  const baseNow = store.flattenTree(repo, store.treeOidOfCommit(repo, baseTip) ?? null);
  const head = store.flattenTree(repo, store.treeOidOfCommit(repo, pull.headSha) ?? null);
  const mb = store.flattenTree(repo, store.treeOidOfCommit(repo, pull.mergeBaseSha) ?? null);
  for (const f of pull.files) {
    const inBaseNow = baseNow.get(f.filename);
    const inMb = mb.get(f.filename);
    const inHead = head.get(f.filename);
    if (!sameEntry(inBaseNow, inMb) && !sameEntry(inHead, inBaseNow)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// --- node wrappers ---------------------------------------------------------

function userNode(store: Store, login: string): NodeValue {
  return node('User', { login, id: opaqueId('user', login), databaseId: 1000 });
}

function repoNode(repo: Repo): NodeValue {
  return node('Repository', { repo });
}

function issueNode(repo: Repo, issue: Issue): NodeValue {
  return node('Issue', { repo, issue });
}

function pullNode(repo: Repo, pull: Pull): NodeValue {
  return node('PullRequest', { repo, pull });
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): NodeValue {
  return node('PageInfo', { hasNextPage, hasPreviousPage: false, startCursor, endCursor });
}

// --- connections -----------------------------------------------------------

function issueConnection(repo: Repo, args: Record<string, unknown>, ctx: ExecCtx): NodeValue | null {
  const statesRaw = args.states;
  let states: Set<string> | null = null;
  if (statesRaw !== undefined && statesRaw !== null) {
    if (!Array.isArray(statesRaw)) {
      ctx.errors.push({ message: 'Invalid value for states: expected a list' });
      return null;
    }
    states = new Set<string>();
    for (const s of statesRaw) {
      if (!checkEnum(ctx, s, ISSUE_STATE, 'states')) return null;
      states.add(s as string);
    }
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : undefined;
  let direction = 'DESC';
  if (orderBy !== undefined) {
    if (orderBy.field !== undefined && !checkEnum(ctx, orderBy.field, ISSUE_ORDER_FIELD, 'orderBy.field')) return null;
    if (orderBy.direction !== undefined) {
      if (!checkEnum(ctx, orderBy.direction, ORDER_DIRECTION, 'orderBy.direction')) return null;
      direction = orderBy.direction as string;
    }
  }
  let list = [...repo.issues];
  if (states !== null) {
    list = list.filter((i) => states.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const afterNum = parseCursor(args.after, 'cursor:issue');
  if (afterNum !== null) {
    list = list.filter((i) => (direction === 'ASC' ? i.number > afterNum : i.number < afterNum));
  }
  const totalCount = list.length;
  const first = asInt(args.first);
  const page = first === undefined ? list : list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  const last = page[page.length - 1];
  const endCursor = last === undefined ? null : issueCursor(last.number);
  const firstNode = page[0];
  const startCursor = firstNode === undefined ? null : issueCursor(firstNode.number);
  const nodes = page.map((i) => issueNode(repo, i));
  return node('IssueConnection', {
    nodes,
    edges: nodes.map((n) => node('IssueEdge', { node: n, cursor: issueCursor((n.issue as Issue).number) })),
    pageInfo: pageInfoNode(hasNextPage, endCursor, startCursor),
    totalCount,
  });
}

function pullConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
  let list = [...repo.pulls];
  list.sort((a, b) => b.number - a.number);
  const afterNum = parseCursor(args.after, 'cursor:pr');
  if (afterNum !== null) list = list.filter((p) => p.number < afterNum);
  const totalCount = list.length;
  const first = asInt(args.first);
  const page = first === undefined ? list : list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  const last = page[page.length - 1];
  const endCursor = last === undefined ? null : prCursor(last.number);
  const firstNode = page[0];
  const startCursor = firstNode === undefined ? null : prCursor(firstNode.number);
  const nodes = page.map((p) => pullNode(repo, p));
  return node('PullRequestConnection', {
    nodes,
    edges: nodes.map((n) => node('PullRequestEdge', { node: n, cursor: prCursor((n.pull as Pull).number) })),
    pageInfo: pageInfoNode(hasNextPage, endCursor, startCursor),
    totalCount,
  });
}

// --- field resolution ------------------------------------------------------

const KNOWN_ROOT_QUERY = new Set(['viewer', 'repository', 'node', '__type', '__schema']);
const KNOWN_ROOT_MUTATION = new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']);

function knownFieldsFor(typename: string): Set<string> {
  switch (typename) {
    case 'Query':
      return KNOWN_ROOT_QUERY;
    case 'Mutation':
      return KNOWN_ROOT_MUTATION;
    case 'Repository':
      return new Set(TYPE_FIELDS.Repository ?? []);
    case 'Issue':
      return new Set(TYPE_FIELDS.Issue ?? []);
    case 'PullRequest':
      return new Set(TYPE_FIELDS.PullRequest ?? []);
    case 'User':
      return new Set(TYPE_FIELDS.User ?? []);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
      return new Set(['nodes', 'edges', 'pageInfo', 'totalCount']);
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
      return new Set(['node', 'cursor']);
    case 'PageInfo':
      return new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']);
    case 'Ref':
      return new Set(['name']);
    case 'PullRequestChangedFile':
      return new Set(['path']);
    case 'Comment':
      return new Set(['id', 'body']);
    case 'CommentEdge':
      return new Set(['node', 'cursor']);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return new Set(['issue']);
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return new Set(['pullRequest']);
    case 'AddCommentPayload':
      return new Set(['commentEdge']);
    case '__Type':
      return new Set(['name', 'kind', 'fields', 'enumValues']);
    case '__Field':
    case '__EnumValue':
      return new Set(['name']);
    default:
      return new Set<string>();
  }
}

/** Resolve one field of `obj`; returns the raw value (scalar, NodeValue, array, null). */
function resolveFieldValue(typename: string, obj: NodeValue, field: FieldNode, ctx: ExecCtx): unknown {
  const store = ctx.store;
  const args = argsOf(field, ctx);
  const name = field.name;

  // __typename is available on every object type.
  if (name === '__typename') return typename;

  switch (typename) {
    case 'Query': {
      if (name === 'viewer') return userNode(store, store.viewerLogin);
      if (name === 'repository') {
        const owner = asString(args.owner);
        const repoName = asString(args.name);
        if (owner === undefined || repoName === undefined) {
          ctx.errors.push({ message: 'repository requires owner and name arguments' });
          return null;
        }
        if (owner !== store.viewerLogin) return null;
        const repo = store.getRepo(owner, repoName);
        return repo === undefined ? null : repoNode(repo);
      }
      if (name === 'node') {
        const id = asString(args.id);
        if (id === undefined) {
          ctx.errors.push({ message: 'node requires an id argument' });
          return null;
        }
        return resolveNode(store, id);
      }
      if (name === '__type') {
        const typeName = asString(args.name);
        if (typeName === undefined) {
          ctx.errors.push({ message: '__type requires a name argument' });
          return null;
        }
        return node('__Type', { typeName });
      }
      if (name === '__schema') {
        return node('__Schema', {});
      }
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') return mutateCreateIssue(store, args, ctx);
      if (name === 'closeIssue') return mutateCloseIssue(store, args, ctx);
      if (name === 'createPullRequest') return mutateCreatePullRequest(store, args, ctx);
      if (name === 'mergePullRequest') return mutateMergePullRequest(store, args, ctx);
      if (name === 'addComment') return mutateAddComment(store, args, ctx);
      break;
    }
    case 'Repository': {
      const repo = obj.repo as Repo;
      switch (name) {
        case 'id':
          return repo.id;
        case 'databaseId':
          return repo.databaseId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userNode(store, repo.owner);
        case 'defaultBranchRef': {
          const tip = store.branchTip(repo, repo.defaultBranch);
          return tip === undefined ? null : node('Ref', { name: repo.defaultBranch });
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'issue': {
          const number = asInt(args.number);
          if (number === undefined) {
            ctx.errors.push({ message: 'issue requires a number argument' });
            return null;
          }
          const issue = store.getIssue(repo, number);
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues':
          return issueConnection(repo, args, ctx);
        case 'pullRequests':
          return pullConnection(repo, args);
        case 'pullRequest': {
          const number = asInt(args.number);
          if (number === undefined) {
            ctx.errors.push({ message: 'pullRequest requires a number argument' });
            return null;
          }
          const pull = store.getPull(repo, number);
          return pull === undefined ? null : pullNode(repo, pull);
        }
      }
      break;
    }
    case 'Issue': {
      const issue = obj.issue as Issue;
      const repo = obj.repo as Repo;
      switch (name) {
        case 'id':
          return issue.id;
        case 'databaseId':
          return issue.number;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      }
      break;
    }
    case 'PullRequest': {
      const pull = obj.pull as Pull;
      const repo = obj.repo as Repo;
      switch (name) {
        case 'id':
          return pull.id;
        case 'databaseId':
          return pull.number;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          // A merged pull request reads as CLOSED (REST parity: state closed,
          // merged true); an unmerged closed one is CLOSED, else OPEN.
          return pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRefOid':
          return pull.headSha;
        case 'baseRefOid':
          return pull.baseSha;
        case 'mergeable':
          return computeMergeable(store, repo, pull);
        case 'files': {
          const first = asInt(args.first);
          const files = first === undefined ? pull.files : pull.files.slice(0, Math.max(0, first));
          const nodes = files.map((f) => node('PullRequestChangedFile', { path: f.filename }));
          return node('PullRequestChangedFileConnection', {
            nodes,
            edges: nodes.map((n) => node('PullRequestChangedFileEdge', { node: n, cursor: '' })),
            pageInfo: pageInfoNode(false, null, null),
            totalCount: pull.files.length,
          });
        }
      }
      break;
    }
    case 'User': {
      const login = obj.login as string;
      switch (name) {
        case 'login':
          return login;
        case 'id':
          return obj.id as string;
        case 'databaseId':
          return 1000;
        case 'name':
          return login;
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      switch (name) {
        case 'nodes':
          return obj.nodes as unknown[];
        case 'edges':
          return obj.edges as unknown[];
        case 'pageInfo':
          return obj.pageInfo as NodeValue;
        case 'totalCount':
          return obj.totalCount as number;
      }
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'CommentEdge': {
      if (name === 'node') return obj.node as NodeValue;
      if (name === 'cursor') return obj.cursor as string;
      break;
    }
    case 'PageInfo': {
      switch (name) {
        case 'hasNextPage':
          return obj.hasNextPage as boolean;
        case 'hasPreviousPage':
          return obj.hasPreviousPage as boolean;
        case 'startCursor':
          return obj.startCursor as string | null;
        case 'endCursor':
          return obj.endCursor as string | null;
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return obj.name as string;
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return obj.path as string;
      break;
    }
    case 'Comment': {
      if (name === 'id') return obj.id as string;
      if (name === 'body') return obj.body as string;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return obj.issue as NodeValue;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return obj.pullRequest as NodeValue;
      break;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return obj.commentEdge as NodeValue;
      break;
    }
    case '__Type': {
      const typeName = obj.typeName as string;
      switch (name) {
        case 'name':
          return typeName;
        case 'kind':
          return TYPE_ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT';
        case 'fields': {
          const fields = TYPE_FIELDS[typeName] ?? [];
          return fields.map((f) => node('__Field', { name: f }));
        }
        case 'enumValues': {
          const values = TYPE_ENUM_VALUES[typeName] ?? [];
          return values.map((v) => node('__EnumValue', { name: v }));
        }
      }
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return obj.name as string;
      break;
    }
    case '__Schema': {
      if (name === 'queryType') return node('__Type', { typeName: 'Query' });
      if (name === 'mutationType') return node('__Type', { typeName: 'Mutation' });
      break;
    }
    default:
      break;
  }
  return undefined;
}

function resolveNode(store: Store, id: string): NodeValue | null {
  const byId = findRepoById(store, id);
  if (byId !== undefined) return repoNode(byId);
  const issue = findIssueById(store, id);
  if (issue !== undefined) return issueNode(issue.repo, issue.issue);
  const pull = findPullById(store, id);
  if (pull !== undefined) return pullNode(pull.repo, pull.pull);
  const decoded = decodeOpaque(id);
  if (decoded === null) return null;
  if (decoded.kind === 'repo') {
    const [owner, name] = decoded.key.split('/');
    if (owner !== undefined && name !== undefined) {
      const repo = store.getRepo(owner, name);
      if (repo !== undefined) return repoNode(repo);
    }
    return null;
  }
  if (decoded.kind === 'issue' || decoded.kind === 'pr') {
    const m = /^(.+)\/([^/]+):(\d+)$/.exec(decoded.key);
    if (m === null) return null;
    const owner = m[1] as string;
    const name = m[2] as string;
    const number = parseInt(m[3] as string, 10);
    const repo = store.getRepo(owner, name);
    if (repo === undefined) return null;
    if (decoded.kind === 'issue') {
      const found = store.getIssue(repo, number);
      return found === undefined ? null : issueNode(repo, found);
    }
    const found = store.getPull(repo, number);
    return found === undefined ? null : pullNode(repo, found);
  }
  return null;
}

// --- mutations ---------------------------------------------------------------

function mutateCreateIssue(store: Store, args: Record<string, unknown>, ctx: ExecCtx): NodeValue | null {
  const input = isRecord(args.input) ? args.input : undefined;
  if (input === undefined) {
    ctx.errors.push({ message: 'createIssue requires an input object' });
    return null;
  }
  const repositoryId = asString(input.repositoryId);
  const title = asString(input.title);
  if (repositoryId === undefined || title === undefined) {
    ctx.errors.push({ message: 'createIssue input requires repositoryId and title' });
    return null;
  }
  const repo = findRepoById(store, repositoryId);
  if (repo === undefined) {
    ctx.errors.push({ message: `repository not found for id ${repositoryId}` });
    return null;
  }
  try {
    const issue = store.createIssue(repo, title, asString(input.body) ?? '', []);
    return node('CreateIssuePayload', { issue: issueNode(repo, issue) });
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function mutateCloseIssue(store: Store, args: Record<string, unknown>, ctx: ExecCtx): NodeValue | null {
  const input = isRecord(args.input) ? args.input : undefined;
  if (input === undefined) {
    ctx.errors.push({ message: 'closeIssue requires an input object' });
    return null;
  }
  const issueId = asString(input.issueId);
  if (issueId === undefined) {
    ctx.errors.push({ message: 'closeIssue input requires issueId' });
    return null;
  }
  const found = findIssueById(store, issueId);
  if (found === undefined) {
    ctx.errors.push({ message: `issue not found for id ${issueId}` });
    return null;
  }
  found.issue.state = 'closed';
  return node('CloseIssuePayload', { issue: issueNode(found.repo, found.issue) });
}

function mutateCreatePullRequest(store: Store, args: Record<string, unknown>, ctx: ExecCtx): NodeValue | null {
  const input = isRecord(args.input) ? args.input : undefined;
  if (input === undefined) {
    ctx.errors.push({ message: 'createPullRequest requires an input object' });
    return null;
  }
  const repositoryId = asString(input.repositoryId);
  const baseRefName = asString(input.baseRefName);
  const headRefName = asString(input.headRefName);
  const title = asString(input.title);
  if (repositoryId === undefined || baseRefName === undefined || headRefName === undefined || title === undefined) {
    ctx.errors.push({ message: 'createPullRequest input requires repositoryId, baseRefName, headRefName and title' });
    return null;
  }
  const repo = findRepoById(store, repositoryId);
  if (repo === undefined) {
    ctx.errors.push({ message: `repository not found for id ${repositoryId}` });
    return null;
  }
  try {
    const pull = store.createPull(repo, headRefName, baseRefName, title, asString(input.body) ?? '');
    return node('CreatePullRequestPayload', { pullRequest: pullNode(repo, pull) });
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function mutateMergePullRequest(store: Store, args: Record<string, unknown>, ctx: ExecCtx): NodeValue | null {
  const input = isRecord(args.input) ? args.input : undefined;
  if (input === undefined) {
    ctx.errors.push({ message: 'mergePullRequest requires an input object' });
    return null;
  }
  const pullRequestId = asString(input.pullRequestId);
  if (pullRequestId === undefined) {
    ctx.errors.push({ message: 'mergePullRequest input requires pullRequestId' });
    return null;
  }
  if (input.mergeMethod !== undefined && !checkEnum(ctx, input.mergeMethod, PR_MERGE_METHOD, 'mergeMethod')) {
    return null;
  }
  const found = findPullById(store, pullRequestId);
  if (found === undefined) {
    ctx.errors.push({ message: `pull request not found for id ${pullRequestId}` });
    return null;
  }
  try {
    store.mergePull(found.repo, found.pull);
    return node('MergePullRequestPayload', { pullRequest: pullNode(found.repo, found.pull) });
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function mutateAddComment(store: Store, args: Record<string, unknown>, ctx: ExecCtx): NodeValue | null {
  const input = isRecord(args.input) ? args.input : undefined;
  if (input === undefined) {
    ctx.errors.push({ message: 'addComment requires an input object' });
    return null;
  }
  const subjectId = asString(input.subjectId);
  const body = asString(input.body);
  if (subjectId === undefined || body === undefined) {
    ctx.errors.push({ message: 'addComment input requires subjectId and body' });
    return null;
  }
  const found = findIssueById(store, subjectId);
  if (found === undefined) {
    ctx.errors.push({ message: `subject not found for id ${subjectId}` });
    return null;
  }
  try {
    const comment = store.addComment(found.repo, found.issue.number, body);
    const commentId = opaqueId(
      'comment',
      `${found.repo.owner}/${found.repo.name}:${found.issue.number}:${comment.id}`,
    );
    const commentNodeValue = node('Comment', { id: commentId, body: comment.body });
    return node('AddCommentPayload', {
      commentEdge: node('CommentEdge', { node: commentNodeValue, cursor: '' }),
    });
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// --- selection-set resolution ------------------------------------------------

function resolveSelectionSet(
  typename: string,
  obj: NodeValue,
  selections: SelectionNode[],
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}"` });
        continue;
      }
      if (frag.typeCondition !== typename) continue;
      Object.assign(out, resolveSelectionSet(typename, obj, frag.selectionSet, ctx));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== undefined && sel.typeCondition !== typename) continue;
      Object.assign(out, resolveSelectionSet(typename, obj, sel.selectionSet, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const known = knownFieldsFor(typename);
    if (sel.name !== '__typename' && !known.has(sel.name)) {
      ctx.errors.push({
        message: `Cannot query field "${sel.name}" on type "${typename}".`,
      });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveFieldValue(typename, obj, sel, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    if (value === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${sel.name}" on type "${typename}".`,
      });
      out[key] = null;
      continue;
    }
    out[key] = resolveValueForSelection(value, sel.selectionSet, ctx);
  }
  return out;
}

/** Apply a field's sub-selection to a resolved value (object / list / scalar). */
function resolveValueForSelection(
  value: unknown,
  selectionSet: SelectionNode[] | undefined,
  ctx: ExecCtx,
): unknown {
  if (selectionSet === undefined || selectionSet.length === 0) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => resolveValueForSelection(entry, selectionSet, ctx));
  }
  if (isRecord(value) && typeof value.__typename === 'string') {
    return resolveSelectionSet(value.__typename as string, value as NodeValue, selectionSet, ctx);
  }
  // A scalar with a sub-selection is a schema error; report it, keep the scalar.
  ctx.errors.push({ message: 'Field with sub-selection resolved to a scalar value' });
  return value;
}

// --- operation execution -----------------------------------------------------

interface Envelope {
  data: Record<string, unknown>;
  errors?: GqlError[];
}

function executeOperation(
  store: Store,
  queryText: string,
  variables: Record<string, unknown>,
  operationName: string | undefined,
): Envelope {
  const errors: GqlError[] = [];
  let doc: Document;
  try {
    doc = new Parser(queryText).parseDocument();
  } catch (err) {
    return { data: {}, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: Operation | undefined;
  if (operationName !== undefined) {
    operation = doc.operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: {}, errors: [{ message: `Unknown operation named "${operationName}"` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return { data: {}, errors: [{ message: 'Must provide operation name if query contains multiple operations' }] };
  }
  const op = operation as Operation;
  // Apply variable defaults for variables the caller did not send.
  const vars: Record<string, unknown> = { ...variables };
  for (const def of op.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== undefined) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  const ctx: ExecCtx = { store, variables: vars, errors, fragments: doc.fragments };
  const rootType = op.op === 'mutation' ? 'Mutation' : 'Query';
  const root = node(rootType, {});
  const data = resolveSelectionSet(rootType, root, op.selectionSet, ctx);
  return errors.length > 0 ? { data, errors } : { data };
}

function isOperationBody(value: unknown): value is {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
} {
  return isRecord(value);
}

// ===========================================================================
// HTTP handler
// ===========================================================================

/**
 * Handle POST /api/graphql. Returns true when the request was this endpoint's
 * (any method/path other than POST /api/graphql returns false, untouched).
 */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path: string;
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return false;
  }
  if (req.method !== 'POST' || path !== '/api/graphql') return false;

  // Auth: Bearer must match the store token when one is set; with an empty
  // store token any non-empty bearer is accepted. No/wrong token -> 401 JSON.
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(auth);
  if (match === null || (match[1] as string).trim() === '') {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  if (store.token !== '' && match[1] !== store.token) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }

  let body: unknown;
  try {
    const buf = await readBody(req);
    body = parseJsonBody(buf);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message });
    } else {
      sendJson(res, 400, { message: 'malformed JSON body' });
    }
    return true;
  }

  // Batch: a JSON array of operation documents answers an array, in order.
  if (Array.isArray(body)) {
    const envelopes: Envelope[] = body.map((entry) => {
      if (!isOperationBody(entry) || typeof entry.query !== 'string') {
        return { data: {}, errors: [{ message: 'Each batch entry must be an object with a query string' }] };
      }
      const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
      const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
      return executeOperation(store, entry.query, variables, operationName);
    });
    sendJson(res, 200, envelopes);
    return true;
  }

  if (!isOperationBody(body) || typeof body.query !== 'string') {
    sendJson(res, 400, { message: 'GraphQL request body must be an object with a query string' });
    return true;
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  sendJson(res, 200, executeOperation(store, body.query, variables, operationName));
  return true;
}
