# Bitbucket Data Center Provider — Iterative TDD Implementation Plan

Status: **proposal / not yet implemented**
Target file: `src/providers/bitbucket-datacenter-provider.ts`
Contract: [`docs/providers/overview.md`](./overview.md)
Reference implementation: [`src/providers/github-provider.ts`](../../src/providers/github-provider.ts)

This document plans a second built-in provider that uses a **Bitbucket Data
Center** (a.k.a. Bitbucket Server — formerly "Stash") instance as the remote
transport. It is written to be executed test-first: every iteration starts
with failing tests and ends with them green.

---

## 1. Goal & scope

Implement a `BitbucketDataCenterProvider` satisfying the Stash provider
contract (`fetch` / `get` / `push` + static `spec` + validating constructor),
talking to a self-hosted Bitbucket Data Center instance over its REST 1.0 API.

Same remote model as the GitHub provider:

- One Bitbucket DC repository = one stash connection.
- User files map to repository paths on the repo's **default branch**.
- `.stash/snapshot.json` is stored remotely alongside user files; other
  `.stash/` files stay local-only.
- Each sync cycle advances the branch with the changed content + snapshot.

**Out of scope:** Bitbucket *Cloud* (different API, OAuth, different host) —
that is a separate future provider. Pull-request / branch workflows. Anything
beyond transport (no merging/reconciliation — Stash owns that).

---

## 2. How a provider plugs in (recap)

From reading the codebase, wiring a new provider is small and mechanical:

| Concern | Mechanism |
|---|---|
| Contract | `implements Provider` from `src/types.ts` — `fetch`, `get`, `push` |
| CLI prompts | static `spec: ProviderSpec` (`setup` = global, `connect` = per-stash) |
| Construction | `constructor(config: Record<string, string>)` — merged setup+connect, flat |
| Registration | one line in `src/providers/index.ts`: `bitbucket-dc: BitbucketDataCenterProvider` |
| Conflict signal | throw `PushConflictError` from `src/errors.ts` |

`cli-main.ts:getProvider()` looks the class up in the registry and the
CLI derives `stash setup` / `stash connect` prompts straight from `spec`.
**No other CLI code changes are required** — registering the class is enough
for `stash setup bitbucket-dc`, `stash connect bitbucket-dc`, and sync to work.

The provider only participates in sync steps 2 (`fetch`), 4 (`push`), and 5
(`get`). Scanning, three-way merge, reconciliation, and local disk writes are
Stash's job.

---

## 3. GitHub vs Bitbucket Data Center — the API gap that shapes the design

The GitHub provider leans on two GitHub-only conveniences that **do not exist**
in Bitbucket DC's REST 1.0 API. This is the crux of the work.

| Capability | GitHub provider uses | Bitbucket DC equivalent |
|---|---|---|
| Branch head + tree | `GET /repos/{o}/{r}/branches/main` | `GET /rest/api/1.0/projects/{K}/repos/{S}/branches/default` → `latestCommit` |
| Read snapshot file | `GET /contents/.stash/snapshot.json` (base64) | `GET .../raw/.stash/snapshot.json?at={ref}` (raw bytes) |
| Batch text read | **GraphQL** `object(expression).text/isBinary` | ❌ none → **N parallel raw GETs** + `isValidText()` |
| Raw bytes | `GET /contents/{path}` raw media type | `GET .../raw/{path}?at={ref}` |
| List all files | `GET /git/trees/{sha}?recursive=1` | `GET .../files/{path}?at={ref}&start&limit` (**paginated**) |
| Atomic multi-file commit | `git/blobs` → `git/trees` → `git/commits` → move ref | ❌ **none** → per-file `PUT .../browse/{path}` |
| Per-write conflict check | n/a (atomic) | `sourceCommitId` form field on `browse` PUT → 409 on race |
| Ref-race detection | compare `main` head SHA before/after | compare default-branch `latestCommit` before/after |
| Auth | `Authorization: token …` (REST), `bearer …` (GraphQL) | `Authorization: Bearer <HTTP access token>` |
| Rate limit | `403` + `x-ratelimit-remaining: 0` | `429` + `Retry-After` (DC throttling) |

### Consequences for `push()`

Bitbucket DC has **no Git Data API** — you cannot assemble a tree and land it
as one commit. The write primitive is the per-file edit:

```
PUT /rest/api/1.0/projects/{K}/repos/{S}/browse/{path}
multipart/form-data: content=<bytes>, message=<msg>, branch=<branch>,
                     sourceCommitId=<head captured during fetch>
```

So one `push()` becomes **a sequence of single-file commits**, not one. Two
hard consequences, both must be designed for:

1. **Non-atomic.** A crash mid-push leaves the remote partially written.
   Mitigation: write user content + deletions first, write
   `.stash/snapshot.json` **last**. The snapshot is the source of truth for
   `fetch()`; if we die before writing it, the next `fetch()` simply sees the
   already-written files as remote changes and reconciles them — self-healing,
   no corruption. Order is a correctness requirement, not a nicety.
2. **Conflict detection is per-write + end-to-end.** Each `browse` PUT carries
   `sourceCommitId`; a 409 means that file moved. Additionally, capture the
   default-branch `latestCommit` in `fetch()` and re-check before the first
   write; on any 409 or head drift, throw `PushConflictError` and let Stash
   retry the whole cycle (it retries up to 5×).

### Open spikes (resolve in the iteration that needs them, not before)

- **S1 — File deletion.** REST 1.0 has no clean single-file DELETE. Candidate
  approaches to validate against the live API: (a) `browse` PUT semantics for
  removal, (b) the multi-file commit endpoint if the target DC version exposes
  one, (c) committing a tree via the internal API. **Until S1 resolves,
  deletions are the riskiest path** — see Iteration 8.
- **S2 — Binary upload encoding.** Confirm whether `browse` PUT accepts raw
  binary multipart content directly (expected yes) vs. needing base64.
- **S3 — Default branch may be `master`.** Never hardcode `main`. Resolve via
  `branches/default` and cache `displayId` + `latestCommit` per `fetch()`.
- **S4 — Exact endpoint shapes / pagination envelope**
  (`isLastPage` / `nextPageStart`). Confirm against the DC REST reference for
  the deployment's version before relying on field names.

Each spike is a 30-minute `curl` against a real/throwaway DC instance (or the
Atlassian DC REST docs) — do it inside the iteration, capture findings in this
file, then write the test.

---

## 4. Configuration & `spec`

```ts
static spec: ProviderSpec = {
  setup: [   // global, ~/.stash/config.json — prompted by `stash setup bitbucket-dc`
    { name: "baseUrl", label: "Bitbucket base URL (https://bitbucket.example.com)" },
    { name: "token",   label: "HTTP access token", secret: true },
  ],
  connect: [ // per-stash, .stash/config.json — prompted by `stash connect bitbucket-dc`
    { name: "project", label: "Project key (e.g. ENG)" },
    { name: "repo",    label: "Repository slug" },
  ],
};
```

Constructor receives the flat merge `{ baseUrl, token, project, repo }`.
Validate eagerly (mirror the GitHub provider's constructor throw-on-bad-input):

- `token` present and non-empty.
- `baseUrl` present, parseable URL; strip any trailing `/` and any trailing
  `/rest/...` the user may paste.
- `project` and `repo` present and non-empty.

No `branch` field — the default branch is discovered at runtime (S3).

---

## 5. Test strategy

The repo already gives us everything we need; mirror it exactly.

- **Runner:** `node --test` (built-in, no Jest/Vitest). New unit files under
  `tests/unit/*.test.ts` and integration under `tests/integration/*.test.ts`
  are auto-discovered by the existing `npm test` glob — **no config change.**
- **HTTP mock:** `tests/helpers/mock-github-api.ts` already monkeypatches
  `globalThis.fetch` and **matches on `pathname + search` only, ignoring the
  host** — so it works unchanged against a `https://bitbucket.example.com/...`
  base. **Iteration 0 renames it to `MockHttpAPI`** (host-agnostic) with a
  back-compat `export const MockGitHubAPI = MockHttpAPI` so the existing GitHub
  tests keep passing. New tests import `MockHttpAPI`.
- **Three layers**, matching the existing GitHub provider:
  1. **Unit** (`tests/unit/bitbucket-datacenter-provider.test.ts`) — mock
     `fetch`, assert request shapes + returned `ChangeSet`/push behavior. The
     bulk of the work. Mirror each existing GitHub unit test case.
  2. **Integration** (`tests/integration/bitbucket-datacenter-provider.integration.test.ts`)
     — fuller fetch→push→fetch round-trips against the mock, mirroring
     `github-provider.integration.test.ts`.
  3. **E2E** (optional, env-gated like `test:e2e`) — real DC instance via
     `.env` (`BITBUCKET_DC_BASE_URL`, `_TOKEN`, `_PROJECT`, `_REPO`). Skipped
     when env is absent so CI stays green without a live server.

**TDD loop per iteration:** write the failing test(s) → run `npm test` (red) →
implement the minimum to pass → run `npm test` (green) → `npm run lint` +
`npm run format:check` → refactor → commit.

---

## 6. Iterations

Each iteration is a vertical, test-first slice. Ship each as its own commit;
the provider is registered (Iteration 9) only once it's real, so partial work
never reaches the CLI.

### Iteration 0 — Harness & stub
- **Red:** rename `MockGitHubAPI` → `MockHttpAPI` (keep alias); add
  `bitbucket-datacenter-provider.test.ts` with one constructor test.
- **Green:** create `BitbucketDataCenterProvider` skeleton — class implementing
  `Provider` with method stubs that `throw new Error("not implemented")`, plus
  `static spec` from §4.
- **Done when:** existing GitHub suite still green; new file compiles; the one
  constructor test runs (red→green next iteration).

### Iteration 1 — Constructor + `spec` validation
- **Red:** tests for missing token, missing/garbage `baseUrl`, missing
  `project`/`repo`, and `baseUrl` normalization (trailing slash, pasted
  `/rest/api/1.0`). Assert `spec.setup`/`spec.connect` field names.
- **Green:** implement constructor validation + URL normalization; store
  `baseUrl`, `token`, `project`, `repo`.

### Iteration 2 — REST plumbing (private)
- **Red:** tests for the request helper — sends `Authorization: Bearer`,
  `Accept: application/json`, correct `X-Atlassian`/User-Agent headers; maps
  `401`→auth error, `403`→permission error, `429`→rate-limit error surfacing
  `Retry-After`. A `paginate()` helper that follows `nextPageStart` until
  `isLastPage`.
- **Green:** implement `rest()`, `ensureOk()`, `rawUrl()`, `apiPath()`,
  `paginate()` mirroring the GitHub provider's private helpers.

### Iteration 3 — `fetch()`: empty / uninitialized repo
- **Red:** `branches/default` → 404 (or empty repo) returns
  `{ added:{}, modified:{}, deleted:[] }`. Mirror the GitHub "empty repo"
  test exactly.
- **Green:** capture-and-bail logic; reset cached head/branch.

### Iteration 4 — `fetch()`: remote snapshot diff
- **Red:** snapshot exists; diff vs `localSnapshot` for added / modified /
  deleted; binary entries (have `modified`) classified from snapshot metadata
  without a content fetch; changed **text** fetched via parallel
  `raw/{path}` GETs; `isValidText()` reclassifies as binary on invalid UTF-8.
  Mirror GitHub's "diffs remote snapshot and fetches changed text",
  "no remote changes skips fetch", and binary-handling cases.
- **Green:** implement the diff + per-path raw fetch (replacing GitHub's
  GraphQL batch with `Promise.all` of raw GETs). Reuse `hashBuffer`,
  `isValidText`.

### Iteration 5 — `fetch()`: no remote snapshot (first sync from another client)
- **Red:** no `.stash/snapshot.json`; recursive `files` listing (paginated,
  `.stash/` excluded) returns all paths as `added`; classify each via raw +
  `isValidText`. Mirror GitHub's "first sync returns all added".
- **Green:** implement listing + classification path. Exercise `paginate()`.

### Iteration 6 — `get()`
- **Red:** streams one binary file's bytes from `raw/{path}` as a `Readable`;
  surfaces 404/error.
- **Green:** thin wrapper over the raw fetch returning `Readable.from(bytes)`.

### Iteration 7 — `push()`: text happy path + bootstrap
- **Red:** writes each text file via `browse` PUT with `message`,
  `branch=<defaultDisplayId>`, `sourceCommitId=<captured head>`; writes
  `.stash/snapshot.json` **last**; empty-repo bootstrap creates the initial
  commit; updates cached head to the last returned commit. Assert
  snapshot-last ordering and that a files-empty/snapshot-only push still
  writes the snapshot (contract requires it).
- **Green:** implement sequential writes + bootstrap.

### Iteration 8 — `push()`: binaries, deletions, conflicts ⚠️
- **Resolve S1 (deletion) and S2 (binary encoding) first** — capture findings
  in §3.
- **Red:** binary file thunks streamed and uploaded; deletions applied via the
  S1-chosen mechanism; a 409 on any write **or** a default-branch head that
  moved since `fetch()` throws `PushConflictError`; a non-conflict rejection
  surfaces a descriptive (non-`PushConflictError`) error. Mirror GitHub's
  conflict test.
- **Green:** implement binary upload, deletion, and conflict mapping.

### Iteration 9 — Registration + integration test
- **Red:** integration test mirroring `github-provider.integration.test.ts`
  (full fetch→push→fetch round-trip on the mock).
- **Green:** add `"bitbucket-dc": BitbucketDataCenterProvider` to
  `src/providers/index.ts`. Verify `getProvider("bitbucket-dc")` resolves and
  the CLI derives prompts from `spec` (a small `cli-main` smoke assertion).

### Iteration 10 — Docs + green gate
- Write `docs/providers/bitbucket-datacenter.md` mirroring `github.md`
  (remote model, config, auth, fetch/get/push flow, error model, the
  non-atomic-push + snapshot-last note).
- Link it from `docs/providers/overview.md` ("built-in providers").
- Optional env-gated E2E (§5.3) + a `test:e2e` entry if a DC instance is
  available.
- **Gate:** `npm test`, `npm run lint`, `npm run format:check` all green.

---

## 7. File-by-file change list

| File | Change |
|---|---|
| `src/providers/bitbucket-datacenter-provider.ts` | **new** — the provider |
| `src/providers/index.ts` | register `bitbucket-dc` (Iteration 9) |
| `tests/helpers/mock-github-api.ts` → `mock-http-api.ts` | rename to `MockHttpAPI`, keep `MockGitHubAPI` alias |
| `tests/unit/bitbucket-datacenter-provider.test.ts` | **new** — unit suite |
| `tests/integration/bitbucket-datacenter-provider.integration.test.ts` | **new** — round-trip |
| `tests/e2e/…` (optional) | env-gated live-instance suite |
| `docs/providers/bitbucket-datacenter.md` | **new** — mirror `github.md` |
| `docs/providers/overview.md` | link the new provider |

**Reused unchanged:** `src/types.ts` (contract is sufficient), `src/errors.ts`
(`PushConflictError`), `src/utils/hash.ts` (`hashBuffer`), `src/utils/text.ts`
(`isValidText` — reusing it is what keeps binary classification consistent with
local scanning, satisfying the contract's anti-ping-pong constraint).

---

## 8. Definition of done

- All three method contracts implemented and unit-tested, mirroring every
  existing GitHub provider test case 1:1.
- `PushConflictError` thrown on ref race; descriptive errors on auth / rate
  limit / permission; other errors propagate (no retry logic in the provider).
- Binary classification uses the shared `isValidText` so files don't ping-pong.
- Snapshot written **last** in every push (crash-safe, self-healing).
- Spikes S1–S4 resolved and their findings recorded in §3.
- Registered in `src/providers/index.ts`; `stash setup/connect bitbucket-dc`
  work end-to-end.
- Docs written and linked.
- `npm test`, `npm run lint`, `npm run format:check` green.

---

## 9. Risk register

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | No REST file-delete (S1) | High | Spike early in Iter 8; may need version-specific endpoint or alternative |
| R2 | Non-atomic multi-file push | Certain | Snapshot-last ordering → self-healing; document the window |
| R3 | Default branch ≠ `main` (S3) | Medium | Resolve via `branches/default`, never hardcode |
| R4 | Pagination envelope drift across DC versions (S4) | Medium | Centralize in `paginate()`; assert against target version |
| R5 | Rate-limit shape differs from GitHub | Medium | Map `429` + `Retry-After` explicitly in Iter 2 |
| R6 | No CI access to a live DC instance | High | E2E env-gated/skippable; unit+integration via mock carry correctness |
