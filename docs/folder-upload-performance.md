# Folder upload performance

Folder imports previously ran `hash-object` and `update-index` sequentially for
every file. Uploading 1,000 files therefore started 2,000 Git processes and
rewrote the growing import index 1,000 times.

The importer now sends bounded groups of blobs to Git's
[fast-import plumbing](https://git-scm.com/docs/git-fast-import), then updates
the private index once per group. Groups contain at most 200 files or 8 MiB of
decoded contents. The browser targets 6 MiB per request, allowing one existing
8 MiB-limit file to travel alone. Neither path extracts a project checkout.

Paths use NUL-delimited index records, never fast-import commands. Blob records
use exact byte lengths, preserving binary data and empty files. The index is
updated only after Git successfully persists the blobs. Repeated uploads replace
the same paths, so a failed index update can be retried. Existing path checks,
secret/dependency exclusions, nested `.gitignore` processing, commit creation,
and access control remain in place. The UI now distinguishes uploading from
finishing the import.

## Reproduction

Run `npm run bench:folder-upload`. It compares the old per-file plumbing with
the new batching in temporary bare repositories, verifies that the 1,000-file
trees match, and removes the fixtures. It never uses the application database.

One local run on 2026-10-01, macOS arm64, Node 24.14.0, Git 2.54.0:

| Files | Source bytes | Old Git import | Batched Git import |
| --- | ---: | ---: | ---: |
| 1,000 | 1,106,890 | 20,311 ms | 154 ms |
| 10,000 | 11,078,890 | Not measured | 1,520 ms |

These timings cover blob writes, index updates and writing the tree. They exclude
folder scanning, browser encoding, HTTP transfer, authentication, final commit
metadata and background context indexing. They are local measurements, not a
latency guarantee for every folder or computer.

## Regression coverage

`npm run test:folder-upload` checks a real 10,000-file import against expected
blob hashes, binary and unusual filenames, empty files, retries, index lock
failure/recovery, SHA-1/SHA-256 repositories, unsafe/oversized files, ignore files
uploaded in a later batch, and absence of an extracted checkout. It also checks
browser request batching, transient HTTP retries and progress phases.

The PostgreSQL/Chrome handoff suite uploads 1,001 files through the real browser
UI and Next.js API, then reads an uploaded file as another member. It also covers
initial room uploads, additional repositories, finalization retries and recovery
from failed file/tree requests. The local production-build run completed the
1,001-file browser upload and displayed its repository in 1,088 ms; this fixture
uses tiny generated text files and an in-memory browser file selection, so it
does not measure disk folder-picker scanning. Use isolated test PostgreSQL and
Redis state.

## Transfer, not Git

The batching above made the Git side cheap — 10,000 files in about 1.5 s — which
left transfer as nearly all of an import's wall-clock time. Two things were
spending it.

Batches went out as base64 inside JSON, which adds about a third to the source
bytes, and nothing was compressed. Source code gzips well: a 2.96 MiB batch of
this repository's own files measured 3.98 MiB as base64 JSON and 1.25 MiB
gzipped, so the body is now gzipped when the browser has `CompressionStream` and
sent as-is when it does not. The server inflates it with a hard ceiling on the
decompressed size — the gateway caps the *compressed* body, which a bomb slips
under while expanding to something that would exhaust memory.

The uploader also read, base64-encoded and sent one batch at a time, so reading
sat idle for every round trip. It now prepares the next batch while the current
request is in flight. Still one request at a time: server-side writes serialize
on a repository lock, so overlapping requests would only queue behind it, and
one-in-flight keeps retry semantics and memory bounded.

Modelled over a 122 MiB, 21,000-file project on a 20 Mbit uplink with 180 ms
round trips: about 81 s before, about 21 s after. That is a model, not a
guarantee; it assumes a steady link and excludes scanning and background
context indexing.
