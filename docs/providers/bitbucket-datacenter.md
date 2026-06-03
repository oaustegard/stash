# Bitbucket Data Center Provider

The Bitbucket Data Center provider implements the remote side of the Stash
provider contract against a self-hosted **Bitbucket Data Center** (formerly
Bitbucket Server) instance, using its REST 1.0 API directly. It does not clone
repositories locally.

> Bitbucket **Cloud** (bitbucket.org) is a different API and is **not**
> supported by this provider.

## Remote Model

- One Bitbucket Data Center repository is the remote for one stash connection.
- All user files map directly to repository paths on the repo's **default
  branch** (resolved at runtime — it may be `main`, `master`, or anything else).
- `.stash/snapshot.json` is stored remotely alongside user files.
- Other `.stash/` files remain local-only, except deletion tombstones (below).
- Each file written produces its own commit (see [push](#pushpayload)).

## Configuration

```ts
type BitbucketDataCenterConfig = {
  baseUrl: string; // https://bitbucket.example.com
  token: string; // HTTP access token
  project: string; // project key, e.g. ENG
  repo: string; // repository slug
};
```

- `baseUrl` and `token` come from global config written by
  `stash setup bitbucket-dc`. A pasted trailing `/` or `/rest/api/1.0` suffix
  is normalized away.
- `project` and `repo` come from per-stash config written by
  `stash connect bitbucket-dc`.

The provider name is `bitbucket-dc`.

## Authentication

- All requests use `Authorization: Bearer <token>` (an HTTP access token).
- Form/PUT submissions include `X-Atlassian-Token: no-check` to bypass XSRF
  protection.
- `401` surfaces as an authentication error, `403` as a permission error.

## API surface

Bitbucket Data Center has **no Git Data API** (no atomic blob/tree/commit) and
**no GraphQL**. The provider uses only these REST resources:

| Purpose               | Endpoint                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| Default branch + head | `GET /rest/api/1.0/projects/{K}/repos/{S}/branches/default`              |
| Raw file content      | `GET /projects/{K}/repos/{S}/raw/{path}?at={ref}` _(app root, not REST)_ |
| List files (paged)    | `GET /rest/api/1.0/projects/{K}/repos/{S}/files?at={ref}&start&limit`    |
| Write a file          | `PUT /rest/api/1.0/projects/{K}/repos/{S}/browse/{path}` (multipart)     |

## `fetch(localSnapshot)`

`fetch()` returns a `ChangeSet` describing what changed remotely since the
local snapshot.

High-level flow:

1. Load the default branch; store `displayId` and `latestCommit`.
2. Attempt to read `.stash/snapshot.json` (raw) at the head commit.
3. If the remote snapshot exists, diff it against the local snapshot.
4. If it does not exist, list all files recursively (paginated) and treat them
   as added.
5. For changed **text** candidates, fetch raw content **per path in parallel**
   (no batch endpoint exists).
6. For binary files already classified in the snapshot (entries with a
   `modified` timestamp), use the metadata directly without a content fetch.

Important rules:

- Empty repo (no default branch, `404`) returns an empty `ChangeSet`.
- `.stash/` paths are excluded from file-listing discovery.
- Binary detection reuses Stash's `isValidText`, matching local scanning so
  files do not ping-pong across syncs.

## `get(path)`

`get()` streams one binary file from the raw endpoint at the current head ref.
Only used when reconcile determines the remote side won for a binary file.

## `push(payload)`

Bitbucket Data Center cannot land multiple files in one atomic commit, so a
push is a **sequence of single-file commits** via the browse `PUT`, each
chained through `sourceCommitId`.

High-level flow:

1. Write each text file (`content` as a form field).
2. Write each binary file (`content` as a multipart blob).
3. Write a deletion tombstone for each deleted path (see below).
4. Write `.stash/snapshot.json` **last**.
5. Track the latest commit id as the new head.

Important rules:

- **Snapshot is written last.** Because the push is not atomic, a crash
  mid-push leaves the remote partially written. Writing the snapshot last makes
  this self-healing: the next `fetch()` sees the already-written files as remote
  changes and reconciles them — no corruption.
- **Conflict detection.** Each write carries the `sourceCommitId` captured
  during `fetch()` (then the id returned by the previous write). A `409`
  response means the branch moved under us → `PushConflictError`. Stash retries
  the whole sync cycle.
- An empty `files`/`deletions` payload still writes the snapshot.
- On an empty repo, the first write omits `sourceCommitId` and creates the
  branch + initial commit.

### Deletions — tombstones

Bitbucket Data Center's REST API has **no file-delete endpoint** (the only
write verb on the file resource is `PUT updateContent`; `DELETE` exists on the
API for _other_ resources — repositories, branches, webhooks — but not file
content). Stash therefore handles `payload.deletions` as a **soft delete**:

- The deleted path is dropped from `.stash/snapshot.json`, so sync ignores it
  immediately on every client that has a snapshot.
- A tombstone marker is written to `.stash/deletions/<path>` recording the
  deleted path and a timestamp.

An **external reaper process** (out of scope for this provider) consumes the
tombstones, performs the real `git rm` of each listed path, removes the marker,
and pushes. Until that runs, the physical file lingers in the repository as an
orphan; a brand-new client doing a no-snapshot first sync would re-discover it.

## Error Model

- branch moved during push (`409`) → `PushConflictError`
- rate limit (`429`) → descriptive error including `Retry-After` when present
- auth failure (`401`) → descriptive error
- permission denied (`403`) → descriptive error
- other network and API failures bubble up to the caller

Retry policy belongs to `Stash`, not the provider.
