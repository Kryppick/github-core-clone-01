# ARCHITECTURE — github-core-clone-01 (keputusan koordinator, 14 Nov 2026)

## Prinsip
- Satu proses Node 22, stdlib saja (`node:http`, `node:crypto`, `node:zlib`). Tanpa dependensi.
- SATU store in-memory untuk semua permukaan (REST, GraphQL, MCP, git) — lintas permukaan
  adalah inti suite. Tidak ada store per protokol.
- Semua state di RAM (Map). Trial hanya 900 dtk; persistensi disk tidak dibutuhkan dan hanya
  memperlambat. Repo di-mount read-only di /bot; /tmp boleh ditulis tapi tidak perlu.
- Determinisme: jam = `MAKEFUN_TRIAL_NOW` (env var; fallback epoch skenario 2025-01-01 bila
  tak di-set — JANGAN Date.now() untuk field yang masuk response/state). Counter increment
  deterministik dari urutan request. Id global opaque deterministik: base64url("type:owner/repo:num")
  atau sejenis — stabil antar baca, ≠ string databaseId/number.
- Performa: handler lean — Map lookup langsung, JSON.stringify minimal, tanpa copy besar.
  Pack build: objek plain (tanpa delta), zlib deflate per objek, sideband chunk ≤ 64 KiB.
  Read workload (2000 GET / 2759 ms = 1.38 ms/req) dan write (200 POST / 349 ms = 1.7 ms/req)
  menuntut tanpa overhead per request (tanpa fsync, tanpa validasi berat, tanpa log per request).

## Layout file (repo kerja, target ≤ 16 MiB total, ≤ 8 MiB/file)
- `main.ts` — lifecycle starter (JANGAN diubah).
- `app.ts` — createApp(): HTTP server + router (tipis; delegasi ke modul).
- `store.ts` — Store: repos, issues, PRs, labels, comments, git objects, refs. Clock + id gen.
- `git-objects.ts` — SHA-1, loose object encode/decode (commit/tree/blob/tag), tree sort cara git.
- `pack.ts` — packfile read (parse + inflate + verifikasi trailer) & write (plain objects),
  delta decode (REF_DELTA/OFS_DELTA) untuk ketahanan — server tidak mengirim delta, tapi harus
  bisa MEMBACA delta bila client mengirim (client suite tidak mengirim delta saat push, tapi
  defensif itu murah).
- `pktline.ts` — pkt-line encode/decode, sideband writer.
- `git-http.ts` — upload-pack v2 (advertise, ls-refs, fetch + shallow + have/want negotiation),
  receive-pack v0 (advertise, command parse, unpack, FF check, report-status sideband).
- `rest.ts` — semua endpoint REST v3 (repos, branches, commits, contents, labels, issues,
  comments, pulls, merge, pagination Link, auth 401, request-id).
- `graphql.ts` — lexer/parser GraphQL subset + resolver + introspeksi __type + batch.
- `mcp.ts` — JSON-RPC 2.0, server/discover (2026-07-28) + fallback initialize legacy, tools/list,
  tools/call (6 tool wajib), error codes, concurrency (echo id).
- `util.ts` — sendJson, request-id, base64, sha helpers.
- `SPEC.md` — spesifikasi (ini hasil sintesis analis; bukan kode).
- `package.json`, `tsconfig.json`, `LICENSE` — dari starter (MIT).

## Urutan implementasi (prioritas sesuai instruksi parent)
1. Core: router + auth + request-id + JSON 404 + protocol checks (5 check) + store skeleton.
   Target: Works=1 stabil, skor > 15.
2. Git: object store + pack + upload-pack v2 + receive-pack v0. Target: git 30 check.
   Verifikasi: runner --json, grup git.
3. REST: repos/issues/pulls/contents/labels/comments + git/refs + branches/commits + merge squash.
   Target: repos+issues+pulls 50 check.
4. GraphQL: parser + 20 check. 5. MCP: 15 check (+200 agent).
6. Perf: ukur 4 workload dengan --perf; optimasi hot path (read/write/push/clone) sampai
   mendekati/melampaui T_ref. Target akhir: feature+agent setinggi mungkin, perf > 100
   (baseline total ≈ 900; hadiah butuh STRICTLY di atas baseline).

## Aturan implementasi (jebakan dari SPEC)
- JANGAN kirim ulang objek lama di fetch (have/want jujur). JANGAN lewatkan objek baru.
- Report-status: baris pertama "unpack ok"; ng reason persis "non-fast-forward".
- tools/list byte-identik antar panggilan; GraphQL id stabil; MCP echo id request.
- Contents PUT pertama melahirkan default branch; merge squash: commit baru di default branch
  dengan tree = head tree, parent = base tip; merge_commit_sha == sha reply merge.
- Pagination /user/repos: Link rel="next" satu origin, halaman ≤ per_page, tanpa duplikat.
- GraphQL unknown field → 200 + errors (bukan 400). Unknown repo → data.repository null, tanpa errors.
- MCP tanpa auth → 401 SEBELUM cek nama tool. Body bukan JSON → 400 + -32700.
- Shallow: shallow-info wajib; deepen kirim tepat 1 generasi.
- JANGAN pakai kode forge publik lain (GitHub/GitLab/Gitea/Forgejo). Semua dari nol.
- File yang ditulis agent harus direvisi ≥2 kali (transcript gate thinking_revised) — wajar
  dalam iterasi, tapi jangan tulis file besar sekali jadi tanpa revisi.
- Dev-only: ~/workspace/makefun/dev-tools/run-dev.ts (bootstrap standalone, di LUAR repo).
  Runner: sdk/run.ts --url http://127.0.0.1:18080 --token <apa saja> [--perf] [--json].
