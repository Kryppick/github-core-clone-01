# SPEC — github-core-clone-01 (disintesis dari 5 laporan analis, 14 Nov 2026)

Sumber: `program/env/src/{manifest,wire,checks-git,checks-rest,checks-graphql,checks-mcp,bench,export,main}.ts`,
`program/scorer/{columns,score}.ts`, `calibration.json`, `rules/instance.yaml`, `RULES.txt`.
Runner lokal: `node22 --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK [--perf] [--json]`
Trial penuh lokal: `MAKEFUN_STATE_DIR=/tmp/gh-trial-N MAKEFUN_SHOP_TOKEN=TOK node22 program/env/server.mjs`
(8080) + entry `MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=TOK node22 --experimental-strip-types main.ts`.

## Skor (0–1000) — baseline house ≈ 900 (120/120, perf 100/200 di T_ref sendiri)
- feature = round(600 × passed/120); agent = round(200 × mcpPassed/15); perf = Σ 4 workload,
  per workload round(clamp(25 − 12.5·log2(t/T_ref), 0, 50)). score = feature+agent+perf.
- Hadiah butuh skor STRICTLY di atas baseline + 90% paired t-interval lead > 0. Seri tidak cukup.
- working = 1 hanya jika boot OK dan ≥1 check lolos. Trial 900 dtk; deadline internal env 810 dtk.
- 120 check: git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5.
- T_ref (ms, kalibrasi 2026-11-14, layout split — produksi pakai layout pod, bisa bergeser):
  push 1640.82 (200 push seq, 1 KiB) | clone 266.941 (50 shallow konkuren, repo 200 commit)
  | read 2759.715 (2000 GET issue, 1 keep-alive) | write 348.965 (200 POST issue).
  Di T_ref = 25 poin; 2× lebih cepat = 37.5; 4× = 50. p50 = median 3 ronde, warm-up 5 op, budget 60 dtk/workload.
- perf_p50_us = round(1000 × geomean 4 p50_ms) = tie-break (makin kecil makin baik).
- MCP bernilai ganda: 15 check = 200 agent + 75 feature = 275 poin. Jangan abaikan MCP.
- Determinisme: state export suite byte-identik antar live/replay. Entry: jangan pakai
  Date.now()/Math.random() untuk apa pun yang masuk state/response; jam = MAKEFUN_TRIAL_NOW,
  random dari MAKEFUN_TRIAL_SEED. created_at/updated_at hampir tidak dicek (hanya merged_at
  non-empty string). Id global harus opaque + stabil antar baca (bukan string databaseId/number).
- Auth: SATU token MAKEFUN_SHOP_TOKEN, Bearer di semua API (REST, GraphQL, MCP, helper git).
  Tanpa/salah token → 401 JSON {"message"}. TIDAK ADA 403 di mana pun: owner lain → 404.
  Semua reply REST: application/json (never HTML) + header X-GitHub-Request-Id non-empty.
  Error 401/404/422: {"message": string non-empty}. Route tak dikenal → 404 JSON.
  Body JSON malformed → 400. Label tak dikenal → 422. Contents sha basi → 409.
  Merge PR tak dikenal → 404; merge konflik → 405. GraphQL field tak dikenal → HTTP 200 + errors.
- Lifecycle: listen(0), JANGAN bind 8080; POST $MAKEFUN_ENV_URL/register {"port":N}
  (pertama menang, kedua 409); poll GET /done sampai {"done":true}, lalu exit 0.
  /healthz GET 200 {"ok":true} (dicek 2×). Boot budget 20 dtk.
- Store mulai KOSONG; suite membuat semua fixture lewat REST/git. Seeded scenario hanya
  menentukan nama/judul/path (seed tetap 0x6a09e667f3bcc909) — jangan hardcode nama.
  Login viewer = pemilik token; repo ke-7 viewer private (i%7==3); default branch "main".

## GIT smart HTTP — 30 check (SHA-1 saja; tanpa git binary)
- Repo dibuat via REST POST /user/repos; push TIDAK bisa menciptakan repo. Path /<owner>/<repo>.git.
- upload-pack = protocol v2 WAJIB (header Git-Protocol: version=2 → jawab v2; v0 gagal
  advertise-v2, ls-refs, ls-refs-prefix, semua clone/fetch). Advertisement v2: baris pertama
  "version 2", capabilities: fetch, ls-refs (wajib); sarankan juga fetch=shallow (client menolak
  deepen bila tidak diiklankan), ls-refs=unborn, agent, object-format=sha1.
  Content-Type advertisement: application/x-git-upload-pack-advertisement.
- ls-refs v2: request command=ls-refs, delim 0001, peel, symrefs, unborn (bila diiklankan),
  ref-prefix <prefix> (filter DI SERVER). Respons: "<oid> SP <ref> [symref-target:<t>] [peeled:<oid>]";
  HEAD muncul dengan symref-target: refs/heads/main; unborn: "unborn <ref> [symref-target:...]".
- fetch v2: command=fetch, delim, thin-pack, no-progress, ofs-delta, want/have/shallow/deepen <n>/done.
  Respons section: acknowledgments (NAK/ACK/ready), shallow-info (shallow/unshallow),
  wanted-refs, packfile (paket sideband band 1/2/3). Section tak dikenal → client error.
  Fetch harus jujur have/want: JANGAN kirim ulang objek yang sudah dimiliki client
  (fetch-incremental gagal bila ada objek lama); JANGAN lewatkan objek baru.
  wants kosong → hasil kosong. Tip sudah dimiliki → 0 objek (pack boleh 0 entry).
- Shallow: depth-1 clone hanya tip + tree + blob tip; parent/grandparent DILARANG ada;
  respons wajib section shallow-info dengan "shallow <tip>". Deepen 2 dari shallow-1: kirim
  tepat 1 generasi (parent + tree), boundary bergerak (shallow <parent> dan/atau unshallow <tip>).
  Shallow fetch tip baru (depth 1, haves=[lama], shallow=[lama]): hanya objek tip baru.
- receive-pack = v0 SAJA. Advertisement: preamble "# service=git-receive-pack", baris
  "<oid> SP <ref>\0<capabilities>", capabilities wajib: report-status, side-band-64k, delete-refs
  (+ sarankan agent, ofs-delta). Tag annotated: dua baris (tag + peeled ^{}). Repo kosong:
  pseudo-ref capabilities^{} OID nol + symref=HEAD:refs/heads/main. HEAD v0: OID tip + symref cap.
- receive-pack request: command pkt-lines "<old> SP <new> SP <ref>" (+ capabilities setelah NUL
  di baris pertama), flush 0000, lalu packfile mentah (selalu ada, bahkan pack 0 objek;
  delete-only TANPA pack). Client kirim report-status-v2 bila diiklankan.
- Report status (sideband band 1 bila side-band-64k): baris pertama HARUS "unpack ok" (bila tidak
  ada baris unpack → gagal); lalu tepat 1 baris ok/ng per command: "ok <ref>" / "ng <ref> <reason>".
  Reason penolakan FF HARUS persis "non-fast-forward". unpack tetap ok walau ada ng.
- Fast-forward: old ancestor dari new, atau old=ZERO (create), atau new=ZERO (delete) → ok.
  Non-FF → ng non-fast-forward, ref TIDAK bergerak, server tetap sehat. Multi-ref: tiap ref
  independen (push-mixed-report: tepat 2 baris, hanya ref ok yang diterapkan).
  Create branch dari ZERO ke OID yang sudah ada = ok (pack kosong). Delete butuh delete-refs.
- Packfile: header PACK + versi 2/3 + count; entry = header varint (tipe: commit=1 tree=2 blob=3
  tag=4, OFS_DELTA=6, REF_DELTA=7) + zlib deflate konten mentah; trailer = SHA-1 semua byte
  sebelumnya. Client KIRIM pack tanpa delta (plain objects only), urutan bebas, hanya objek yang
  belum dimiliki server (dihitung dari advertisement receive-pack; fallback: semua objek).
  Server BOLEH kirim tanpa delta sama sekali (pack-deltas: delta opsional). Bila kirim delta:
  OFS_DELTA base harus di pack yang sama & offset lebih kecil; REF_DELTA base boleh thin (harus
  dimiliki client via have). Trailer checksum SELALU diverifikasi — satu byte salah = gagal.
  declaredCount = jumlah entry ter-parse = jumlah objek unik. Ukuran inflate harus cocok header.
- Pkt-line: 4 hex digit panjang (payload+4), 0000 flush, 0001 delim, 0002 response-end, maks
  65520 byte/paket. Sideband: byte pertama band (1=data, 2=progress, 3=error→gagal); band lain
  atau paket sideband kosong → gagal; minimal 1 paket sideband di section packfile.
- Refs/HEAD: default refs/heads/main; HEAD selalu symref → refs/heads/main. Repo kosong: 0 ref
  refs/*, HEAD unborn. Repo tak ada: info/refs upload-pack DAN receive-pack → 404, server tetap hidup.
- Objek: SHA-1 atas "<type> <size>\0"+konten; commit/tree/blob/tag harus byte-identik dengan
  yang di-push (jangan normalisasi ulang tree/commit). Tree sort cara git (dir seolah berakhir /),
  mode 100644 file, 40000 dir. Commit: "tree <oid>\nparent ...\nauthor <n> <e> <epoch> +0000\n
  committer ...\n\n<message>\n". Tag: object/type/tag/tagger\n\n<message>.
- Malformed request (POST "zzzznot-a-pkt-line" ke git-upload-pack): status bebas, ASAL server
  tetap hidup sesudahnya. Push 100 file / blob 20 KB direvisi 3× harus round-trip byte-identik.
- Check git lengkap: advertise-v2, advertise-receive-pack, advertise-headers, unknown-repo-404,
  ls-refs, ls-refs-prefix, clone-empty, push-first-commit, clone-object-hashes, clone-blob-bytes,
  clone-tree-entries, clone-commit-bytes, clone-annotated-tag, fetch-incremental, fetch-nothing-new,
  fetch-shallow-depth1, fetch-shallow-deepen, fetch-shallow-new-tip, push-update-ref,
  push-create-branch, push-delete-branch, push-non-fast-forward, push-mixed-report,
  push-delete-tag, push-100-files, pack-integrity, pack-deltas, sideband-framing,
  push-sideband-report, repo-survives-errors.

## REST v3 — 55 check (repos 15, issues 15, pulls 20, protocol 5). Prefix /api/v3.
- GET /api/v3/ → 200 JSON + header X-OAuth-Scopes (nilai tak dicek; starter kirim "repo, read:org").
- GET /api/v3/meta → 200 {"installed_version": string non-empty}.
- POST /api/v3/user/repos {name, private, description} → 201 {name==dikirim, private==dikirim}.
  Duplikat: 422 diterima sebagai "sudah ada" (hanya di check pagination).
- GET /api/v3/repos/{o}/{r} → 200 {name, private, default_branch non-empty, description};
  default_branch stabil antar GET; tak ada → 404. Tanpa token ke repo privat → 401.
  Owner lain (nama sama) → 404. PATCH {description} → 200, deskripsi baru bertahan di GET.
  DELETE → 204 (tanpa body), GET sesudahnya 404.
- GET /api/v3/user/repos?per_page=10 → 200 array [{name}]; pagination Link rel="next" WAJIB benar:
  30 repo seeded, tiap halaman ≤10, total ≥3 halaman, tanpa nama berulang, ke-30 tercapai,
  selesai ≤20 halaman, URL next satu origin. Format: Link: <url>; rel="next", <url>; rel="last".
  List lain hanya per_page=100/10 tanpa asersi Link.
- POST /repos/{o}/{r}/git/refs {ref:"refs/heads/<b>", sha:SHA40} → 201 {ref==dikirim, object:{sha}}.
- GET /repos/{o}/{r}/branches → 200 [{name non-empty, commit:{sha}}]; harus memuat default DAN
  branch baru, sha branch baru == sha saat dibuat.
- GET /repos/{o}/{r}/commits[?sha=<ref>] → 200 [{sha, commit:{message}}]; commit di branch muncul
  di ?sha=<branch> dengan message persis, dan TIDAK BOLEH muncul di list tanpa sha (default)
  sebelum merge.
- PUT /repos/{o}/{r}/contents/{path} {message, content:base64 UTF-8, branch?, sha?} → 201 create;
  200 ATAU 201 update; 409 sha basi. Response {content:{sha:SHA40, encoding:"base64"},
  commit:{sha:SHA40}}. PUT pertama melahirkan default branch (tanpa commit sebelumnya).
  Update: kirim sha = sha blob saat ini; sha baru harus BERBEDA dari sha lama. Update di branch:
  branch:"<branch>" (+ sha bila file sudah ada di branch itu).
- GET contents/{path}[?ref=<branch>] → 200 file {type:"file", encoding:"base64", content, sha,
  size=byteLength UTF-8} / 200 array direktori [{type:"file"|"dir", name, path, sha}] / 404 setelah
  hapus. Base64 decode abaikan [\r\n\t ] dan harus sama byte-demi-byte.
- DELETE contents/{path} {message, sha} → 200 {commit:{sha}}; GET sesudahnya 404.
- POST /repos/{o}/{r}/labels {name, color:"ededed"} → 201 {name non-empty}. Label HARUS dibuat
  dulu sebelum issue memakainya.
- POST /repos/{o}/{r}/issues {title, body, labels?} → 201 Issue {number int ≥1, title, body,
  state:"open", labels:[{name}]}; label tak dikenal → 422.
- GET /repos/{o}/{r}/issues?state=&sort=&direction=&per_page= → 200 array Issue.
  sort=created&direction=asc|desc harus persis urutan pembuatan/kebalikannya.
  list-open-excludes-closed: closed tidak muncul di state=open.
- GET /repos/{o}/{r}/issues/{n} → 200 Issue (number/title/body == yang dibuat).
  PATCH {state:"open"|"closed"} → 200 {number, state==dikirim}; close bertahan di GET.
- POST /repos/{o}/{r}/issues/{n}/comments {body} → 201 {id int ≥1, body==dikirim}.
  GET .../comments → 200 [{id, body}] memuat comment baru (cocok id+body).
- POST /repos/{o}/{r}/pulls {head, base, title, body} → 201 PR {number, state:"open",
  head:{ref==head, sha==tip head}, base:{ref==base, sha==tip base}}.
- GET /repos/{o}/{r}/pulls?state=all → open+merged; tanpa state → hanya open.
  GET /pulls/{n} → 200 PR / 404 (nomor 999999999).
- GET /pulls/{n}/files → 200 [{filename non-empty, status non-empty, additions int ≥0,
  deletions ≥0, changes ≥0}]; file baru: status ∈ added/modified/changed, additions ≥1;
  semua path yang diubah tercantum. PR 2 file diubah dalam 1 PR (files-multiple).
- PUT /pulls/{n}/merge {merge_method:"squash"} → 200 {merged:true, sha:SHA40, message:string}.
  Setelah merge GET /pulls/{n}: state:"closed", merged:true, merged_at:string non-empty,
  merge_commit_sha == sha reply merge. Merge commit muncul di GET /commits?sha=<defaultBranch>;
  isi squash terbaca via GET /contents/<path>?ref=<defaultBranch> (sama dengan konten head).
  Merge PR tak dikenal → 404. Konflik (dua branch dari tip sama ubah file sama, konten beda;
  merge pertama 200, kedua → 405).
- Bentuk objek (field ekstra DIIZINKAN kecuali disebut lain): Repository {name, private,
  default_branch, description}; Issue {number, title, body, state, labels}; PR open {number,
  state, title, body, head:{ref,sha}, base:{ref,sha}}; Label {name}; Comment {id, body};
  Commit {sha, commit:{message}}; Branch {name, commit:{sha}}; PullFile {filename, status,
  additions, deletions, changes}. TIDAK dicek: id repo/issue/PR, node_id, url/html_url, user,
  created_at/updated_at/closed_at. Issue number increment +1 per repo (angka awal tak diasersi).
- Urutan setup check: POST user/repos → PUT contents (file pertama) → baca default_branch →
  POST git/refs branch → PUT contents?branch commit di branch → POST pulls / POST labels →
  POST issues → PATCH / merge / komentar. repos.pagination jalan PERTAMA (30 repo seeded).

## GraphQL v4 — 20 check. POST /api/graphql {query, variables}; tanpa token → 401 persis.
- Satu operasi → {data, errors}; batch → array JSON [{query, variables, operationName?}] →
  array 2 envelope {data, errors} URUTAN SAMA. Field tak dikenal → HTTP 200 + errors non-kosong,
  minimal satu message mengandung nama field (contoh noSuchFieldOnViewer). Repo tak dikenal →
  data.repository = null, TANPA errors. Jawaban 2xx tanpa data maupun errors = parse error client.
- Operasi yang dikirim (gh + github-mcp-server):
  viewer-login: viewer{login} == login pemilik token.
  repository-fields($owner,$name): repository{id, databaseId, name, owner{login},
    defaultBranchRef{name}, viewerPermission ∈ ADMIN/MAINTAIN/WRITE/TRIAGE/READ,
    hasIssuesEnabled===true}. id global == id saat fixture dibuat; databaseId numerik sama.
  introspection: __type(name:"Issue"){fields(includeDeprecated:true){name}} wajib id, number,
    title, state, body. __type PullRequest wajib id, number, headRefName, baseRefName, mergeable,
    state, merged, files. __type Repository wajib id, databaseId, name, nameWithOwner, owner,
    defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest.
    __type SearchType enumValues wajib memuat ISSUE. Dua alias __type dalam satu dokumen harus
    dijawab sekaligus. Enum: IssueState OPEN/CLOSED; MergeableState MERGEABLE/CONFLICTING/UNKNOWN;
    PullRequestState OPEN/CLOSED/MERGED; PullRequestMergeMethod MERGE/SQUASH/REBASE;
    RepositoryPermission ADMIN/MAINTAIN/WRITE/TRIAGE/READ; IssueOrderField CREATED_AT/UPDATED_AT/COMMENTS;
    OrderDirection ASC/DESC.
  issues-open-order: repository{issues(first:10, states:[OPEN], orderBy:{field:CREATED_AT,
    direction:DESC}){nodes{number,title,state,id}}} — hanya OPEN; CLOSED tidak boleh muncul;
    urutan nomor MENURUN tegas (nomor = proxy CREATED_AT).
  issue-by-number: repository{issue(number){number,title,state,id,body}} — state OPEN, title/body
    sama persis dengan REST.
  create-issue: mutation($input:CreateIssueInput!){createIssue(input{repositoryId,title,body})
    {issue{number,id}}} — REST GET issue tsb 200, title sama, state open.
  close-issue: mutation CloseIssue($input:CloseIssueInput!){closeIssue(input{issueId})
    {issue{number,id,state}}} — state CLOSED; REST baca closed.
  pull-requests-list: repository{pullRequests(first:5){nodes{number,headRefName,baseRefName,
    mergeable,state}}} — ≤5 node, PR fixture ada, state OPEN, mergeable ∈ MERGEABLE/CONFLICTING/UNKNOWN.
  pull-request-files: repository{pullRequest(number){number, files(first:10){nodes{path}}}} —
    path wajib memuat path file yang diubah di head branch.
  create-pull-request: mutation($input:CreatePullRequestInput!){createPullRequest(
    input{repositoryId, baseRefName, headRefName, title}){pullRequest{number,id,state,
    headRefName,baseRefName}}} — head branch sudah punya commit (via git push); REST GET pulls/{n}
    head.ref/base.ref sama.
  merge-pull-request: mutation MergePullRequest($input:MergePullRequestInput!){mergePullRequest(
    input{pullRequestId, mergeMethod:"SQUASH"}){pullRequest{number,merged,state}}} — merged true;
    REST merged true + state closed.
  add-comment: mutation AddComment($input:AddCommentInput!){addComment(input{subjectId,body})
    {commentEdge{node{id,body}}}} — body sama persis; REST GET comments memuatnya.
  node-repository: query NodeRepository($id:ID!){node(id:$id){id, ... on Repository{name,
    nameWithOwner}}} — nameWithOwner == "{owner}/{repo}".
  issues-pagination: repository{issues(first,after){nodes{number}, pageInfo{hasNextPage,endCursor}}} —
    repo 7 issue: halaman 1 first:5 → tepat 5 node, hasNextPage true, endCursor non-empty;
    halaman 2 (after=endCursor) → tepat 2 node, hasNextPage false; gabungan 7 nomor berbeda.
  global-id-stability: id repo & issue opaque (≠ string databaseId/number), stabil antar baca.
- Semua hasil GraphQL diverifikasi silang via REST — SATU store, bukan store terpisah.
- Parser harus dukung: variabel ($x: T!), argumen literal/variabel/enum/object input/list,
  alias, inline fragment (... on Repository), operationName, batch array, __type dengan argumen.

## MCP — 15 check. POST /mcp, JSON-RPC 2.0 Streamable HTTP, jawaban application/json ATAU
## text/event-stream (SSE, frame data: terakhir dengan id cocok = respons). Tiap request ≤ 3 dtk.
- Header request: Accept: application/json, text/event-stream; Content-Type: application/json;
  MCP-Protocol-Version: <revisi>; Mcp-Method: <nama>; tools/call juga Mcp-Name: <tool>;
  Authorization: Bearer <token>; Mcp-Session-Id bila server pernah memberikannya (legacy saja).
  params selalu memuat _meta (protocolVersion, clientInfo {name:"makefun-github-core-clone-env",
  version:"1.0.0"}, clientCapabilities {}).
- Modern (preferensi): revisi 2026-07-28. Langkah pertama client = server/discover (id "discover-1").
  Jawab DiscoverResult: supportedVersions = array non-empty string YYYY-MM-DD (harus memuat
  2026-07-28 atau entri pertama dipakai), capabilities (wajib memuat tools), serverInfo {name,
  version} non-kosong. Bila server menolak versi dengan -32022 + error.data.supported, client
  retry sekali dengan versi itu. Era modern = tanpa session.
- Legacy (bila discover dijawab 404/405 atau -32601 — penolakan lain BUKAN fallback, langsung gagal):
  initialize (params {protocolVersion, capabilities:{}, clientInfo}, TANPA header MCP-Protocol-Version;
  client tawarkan 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 newest-first; server jawab
  result.protocolVersion yang dipilihnya; -32602 → client coba revisi berikutnya) lalu notifikasi
  notifications/initialized (tanpa id). Bila respons bawa header Mcp-Session-Id, client bawa itu di
  semua request berikut; close() kirim DELETE /mcp dengan header itu (best-effort).
  Check server-discover: server pre-discover LOLOS ("pre-discover revision") selama initialize berhasil.
  Check initialize: serverInfo.name/version non-kosong + capabilities.tools ada.
- tools/list: ≥6 tools, wajib create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request. Prefix server diizinkan (github__create_issue),
  dicocokkan suffix + case-insensitive (normalisasi: lowercase, buang non-alfanumerik).
  Setiap tool: description non-empty + inputSchema type object. Dua panggilan tools/list harus
  menghasilkan array tools IDENTIK byte demi byte (JSON.stringify sama). tools/list ikuti
  nextCursor s.d. 10 halaman.
- Argumen (suite memetakan nama semantik ke properti inputSchema terdekat; sinonim dikenali):
  owner: owner/owner_login/org/organization/user/user_login/login/account/namespace/owner_name;
  repo: repo/repository/repository_name/repo_name/project/project_name;
  title: title/issue_title/pr_title/pull_request_title/subject;
  body: body/issue_body/description/content/text/comment;
  head: head/head_ref/head_branch/pull_request_head/pr_head/source/source_ref/source_branch/from/from_branch/branch;
  base: base/base_ref/base_branch/pull_request_base/pr_base/target/target_ref/target_branch/into/into_branch;
  pull_number: pull_number/pull_request_number/pr_number/number/issue_number/index;
  name: name/repo/repository/repository_name/repo_name;
  description: description/about/summary/body; private: private/is_private; state: state/status.
  Khusus full_name: bila skema tak punya repo tapi punya full_name/repo_full_name/
  repository_full_name/fullName, suite kirim "owner/repo" ke properti itu.
  Bila inputSchema.required memuat properti yang tak bisa diisi suite → tool tidak dipanggil,
  check gagal menyebut properti itu. JANGAN wajibkan properti di luar yang suite kirim.
- Tool contracts: create_repo {name, description?, private?} (+ create_repo rest-parity dikirim
  {owner, name, description, private:true}; result harus memuat full_name "owner/repo" bila ada).
  get_repo {owner, repo} — result teks/JSON memuat nama repo.
  create_issue {owner, repo, title, body?} — REST GET issues?state=all memuat title sama.
  list_issues {owner, repo, state?} (dikirim state:"open") — teks result memuat judul issue REST
  ATAU "number": <n>.
  create_pull_request {owner, repo, title, head, base} (+ body bila skema punya) — REST GET
  pulls/{n} head.ref/base.ref sama; nomor dari result (number/pull_number/pull_request_number)
  atau dicari via REST berdasarkan title/head.
  merge_pull_request {owner, repo, pull_number} — REST GET pulls/{n} merged===true.
- Result sukses: {content:[{type:"text", text:"..."}]} (boleh structuredContent). Check baca
  structuredContent dulu; bila tidak ada, parse JSON pertama di teks.
- Error: tool tak dikenal → JSON-RPC -32602 atau -32601, JANGAN HTTP 500. tools/call tanpa argumen
  wajib → isError:true ATAU -32602. Body bukan JSON → HTTP 400 + -32700 (legacy boleh HTTP 200 +
  -32700). tools/call tanpa Authorization → HTTP 401 persis (dicek SEBELUM keberadaan tool).
- Concurrency: dua tools/call get_repo bersamaan, id string berbeda ("concurrent-left-<tag>",
  "concurrent-right-<tag>"); jawaban harus echo id yang sama persis + isi repo masing-masing
  (tidak tertukar). Id default client angka menaik dari 1; echo id apa pun bentuknya (string/number).
- Konsistensi MCP↔REST: objek sama, id stabil antar baca (repo & issue: dua GET REST berurutan
  id identik sebagai string). Setup MCP memakai REST: GET /api/v3/user (login pemilik token),
  POST /user/repos, GET /repos/{o}/{r}, PUT contents (dengan/tanpa branch), POST /git/refs,
  GET /git/refs/heads/{branch} (atau /branches/{branch}), GET/POST issues, GET/POST pulls.
