# Artifacts Dashboard Plugin — API Contract & Threat Model

## Overview

The Artifacts plugin exposes three read-only REST routes under
`/api/plugins/artifacts/`.  All routes are protected by the dashboard's
existing `auth_middleware` / `gated_auth_middleware` stack — no
plugin-local auth bypass.

---

## Routes

### GET /api/plugins/artifacts/projects

Returns the list of known projects (from the kanban `projects` table and
the `topic_map` heuristic for staging/reports/briefs files).

```
Response 200:
{
  "profile": "default",
  "projects": [{"slug": "...", "name": "...", "count": 12}, ...],
  "unassigned_count": 5
}
```

### GET /api/plugins/artifacts/items

Query parameters:

| Param  | Type   | Default | Notes |
|--------|--------|---------|-------|
| project | str   | "all"   | slug, "_unassigned", or "all" |
| kind   | enum   | "all"   | image, doc, text, other, all |
| source | enum   | "all"   | staging, kanban, reports, all |
| q      | str    | ""      | free-text search, ≤ 100 chars |
| limit  | int    | 50      | 1–200 |
| cursor | str    | ""      | opaque base64 pagination token |

Responses:
- 200 — items list (see schema below)
- 422 — invalid enum value for kind/source, or q > 100 chars

```
{
  "items": [{
    "id":      "<24-hex opaque>",
    "name":    "02_mara_bell_c1.png",
    "kind":    "image",
    "mime":    "image/png",
    "size":    621568,
    "mtime":   1762067890,
    "source":  "staging",
    "group":   "grand-voyage-lineup-v3/mlx_regen",
    "project": "sinhangro",
    "task":    {"id": "t_xxx", "title": "...", "board": "default"} | null,
    "orphan":  false
  }, ...],
  "count":       456,
  "next_cursor": "...",
  "truncated":   false,
  "scan_ms":     42,
  "profile":     "default"
}
```

### GET /api/plugins/artifacts/content/{id}

Serve a file by its opaque id.  The id must be in the server-side
process-local TTL cache (populated by `/items`); a cache miss returns 404.

Responses:
- 200 — StreamingResponse with correct MIME and security headers
- 403 — containment failure, symlink, inode swap, or sensitive path
- 404 — id not in cache (orphan or cache expired) or file missing
- 413 — file > 100 MB

---

## ID Scheme

```
id = sha256(root_key + "\0" + board + "\0" + relpath)[:24]
```

`root_key ∈ {staging, reports, briefs, kanban:<board-slug>}`.

The id→(root_key, board, root_path, relpath) mapping is stored in a
**process-local TTL cache (60 s)**.  If the same id is generated for two
different tuples (hash collision), the scan aborts with 500 + a log entry.
The id is opaque to the client; the client must never construct it.

---

## MIME / Content Security Policy

| Extension(s)                      | Content-Type header             | Disposition |
|-----------------------------------|---------------------------------|-------------|
| .png .jpg .jpeg .gif .webp        | image/<ext>                     | inline      |
| .md .txt .csv .log .json .yaml .yml | text/plain; charset=utf-8     | inline      |
| .pdf                              | application/pdf                 | inline      |
| .svg .html .htm **and all others**| application/octet-stream        | attachment  |

Every response includes `X-Content-Type-Options: nosniff`.

The DB `content_type` field on kanban attachments is **not trusted** —
MIME is determined solely from the file extension.

---

## Verified-FD Serving

For every `/content/{id}` request:

1. Resolve `id` → `(root_key, board, root, relpath)` from process cache.
2. `lstat(root / relpath)` — confirm `S_ISREG`, get `(st_dev, st_ino)`.
3. `resolve().relative_to(root)` — confirm no symlink escape.
4. `os.open(path, O_RDONLY | O_NOFOLLOW)` — refuse symlink at the leaf.
5. `os.fstat(fd)` — confirm `(st_dev, st_ino)` matches step 2 (swap
   detection).  Mismatch → 403.
6. Confirm `S_ISREG` and size ≤ 100 MB on the fd.
7. `_is_sensitive_path(path)` guard.
8. Wrap fd with `os.fdopen` and stream via `StreamingResponse`.

`FileResponse(path)` is **never used** (it re-opens the path, losing the
verified fd).

---

## Trust Boundary

The four allowed roots are the trust boundary:

- `{hermes_home}/task-staging/`
- `{hermes_home}/reports/`
- `{hermes_home}/kanban/briefs/`
- Kanban attachment directories (per-board)

`_is_sensitive_path` is a secondary defence against known sensitive
filenames/dirs (`.env`, `mcp-tokens/`, `pairing/`, etc.).  The primary
defence is that files must be reachable within one of the four roots.

---

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| Path traversal (`../../../etc/passwd`) | `resolve().relative_to(root)` before open |
| Symlink escape at leaf | `O_NOFOLLOW` on `os.open` → ELOOP → 403 |
| TOCTOU / file swap between check and read | `lstat` st_dev/st_ino checked against post-open `fstat` |
| Intermediate directory symlink swap | full `resolve()` re-validates the whole path each request |
| Sensitive file exfil (`.env`, tokens) | `_is_sensitive_path` guard on every serve |
| XSS via SVG/HTML served inline | SVG/HTML/HTM → octet-stream + attachment |
| Script injection via JS/unknown ext | octet-stream + attachment for every non-allowlist ext |
| Content-type sniffing | `X-Content-Type-Options: nosniff` on every response |
| Opaque id reverse-engineering | id is a 24-hex SHA256 prefix; full path never in response |
| ID hash collision | Collision between two tuples → scan returns 500 |
| Unauthenticated access | Dashboard `auth_middleware` covers all `/api/plugins/…` routes |
| Token in URL | `authedFetch` sends token as header/cookie, not query param |
