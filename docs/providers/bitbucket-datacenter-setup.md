# Bitbucket Data Center — setup

How to sync a folder to a self-hosted **Bitbucket Data Center** (formerly
Bitbucket Server) repository. For the GitHub flow, see the
[README Quick Start](../../README.md#quick-start); for the provider's internals
and constraints, see [bitbucket-datacenter.md](bitbucket-datacenter.md).

> Bitbucket **Cloud** (bitbucket.org) is a different API and is **not**
> supported. This provider targets self-hosted Data Center / Server only.

## 1. Install Stash

```bash
npm install -g @telepath-computer/stash
```

## 2. Create an HTTP access token

Stash authenticates with a Bitbucket **HTTP access token** (Bearer token).

1. In Bitbucket, go to your repository → **Repository settings** → **HTTP access
   tokens** → **Create token** (a personal token under **Manage account** →
   **HTTP access tokens** also works).
2. Give it a name (e.g. `stash`).
3. Grant **Repository — Write** permission (this implies read). Stash needs to
   read files and push commits.
4. **Create** the token and copy it — you won't see it again.

You'll also need:

- **Base URL** — your Bitbucket host, e.g. `https://bitbucket.example.com`
  (no trailing path; a pasted `/rest/api/1.0` suffix is trimmed for you).
- **Project key** — the project the repo lives in, e.g. `ENG`.
- **Repository slug** — the repo's short name from its URL.

## 3. Save your credentials

Store the base URL and token in global config (prompted once):

```bash
stash setup bitbucket-dc
```

You'll be asked for:

| Prompt             | Value                                   |
| ------------------ | --------------------------------------- |
| Bitbucket base URL | `https://bitbucket.example.com`         |
| HTTP access token  | the token from step 2 (input is masked) |

## 4. Connect a folder

From the directory you want to sync:

```bash
cd dir-to-sync/
stash connect bitbucket-dc
```

You'll be asked for:

| Prompt          | Value             |
| --------------- | ----------------- |
| Project key     | e.g. `ENG`        |
| Repository slug | e.g. `team-notes` |

## 5. Start syncing

```bash
stash start
```

> [!TIP]
> Run `stash start` once and forget about it — Stash keeps every stash in sync
> in the background, even across restarts. Use `stash sync` for a one-shot sync
> or `stash watch` to sync in the foreground.

## Notes & limitations

- **Default branch.** Stash syncs to the repository's configured default branch
  (`main`, `master`, or whatever it's set to) — it's resolved automatically, not
  hardcoded.
- **Deletions are soft.** Bitbucket Data Center's REST API has no file-delete
  endpoint, so a deleted file is dropped from the snapshot and a tombstone is
  written under `.stash/deletions/<path>` for an external process to perform the
  real `git rm`. Until that runs, the file lingers in the repo. See
  [bitbucket-datacenter.md → Deletions](bitbucket-datacenter.md#deletions--tombstones).
- **One repo per connection.** As with the GitHub provider, one Bitbucket
  repository backs one stash connection.
