import { Readable } from "node:stream";
import { PushConflictError } from "../errors.ts";
import type {
  ChangeSet,
  FileState,
  Provider,
  ProviderSpec,
  PushPayload,
  SnapshotEntry,
} from "../types.ts";
import { hashBuffer } from "../utils/hash.ts";
import { isValidText } from "../utils/text.ts";

const SNAPSHOT_PATH = ".stash/snapshot.json";
const DELETIONS_PREFIX = ".stash/deletions/";
const COMMIT_MESSAGE = "stash: sync";
const DEFAULT_BRANCH_FALLBACK = "main";
const PAGE_LIMIT = 1000;

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Normalize a user-entered base URL: drop trailing slashes and any pasted REST suffix. */
function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  url = url.replace(/\/rest\/api\/[\d.]+$/i, "");
  return url.replace(/\/+$/, "");
}

export interface BitbucketDataCenterConfig {
  baseUrl: string;
  token: string;
  project: string;
  repo: string;
}

/**
 * Stash provider backed by a self-hosted Bitbucket Data Center instance over
 * its REST 1.0 API. See docs/providers/bitbucket-datacenter.md for the remote
 * model and the constraints that shape this implementation (no Git Data API,
 * no GraphQL batch read, no REST file delete).
 */
export class BitbucketDataCenterProvider implements Provider {
  static spec: ProviderSpec = {
    setup: [
      { name: "baseUrl", label: "Bitbucket base URL (https://bitbucket.example.com)" },
      { name: "token", label: "HTTP access token", secret: true },
    ],
    connect: [
      { name: "project", label: "Project key (e.g. ENG)" },
      { name: "repo", label: "Repository slug" },
    ],
  };

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly project: string;
  private readonly repo: string;
  private defaultBranch: string | undefined;
  private headCommit: string | undefined;

  constructor(config: BitbucketDataCenterConfig) {
    if (!config.token) {
      throw new Error("Missing Bitbucket token");
    }
    if (!config.baseUrl || !/^https?:\/\//i.test(config.baseUrl)) {
      throw new Error("Invalid Bitbucket base URL. Expected an absolute http(s) URL");
    }
    if (!config.project) {
      throw new Error("Missing Bitbucket project key");
    }
    if (!config.repo) {
      throw new Error("Missing Bitbucket repository slug");
    }

    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.token = config.token;
    this.project = config.project;
    this.repo = config.repo;
  }

  async fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet> {
    const branchRes = await this.rest("GET", this.repoPath("/branches/default"));
    if (branchRes.status === 404) {
      this.defaultBranch = undefined;
      this.headCommit = undefined;
      return { added: new Map(), modified: new Map(), deleted: [] };
    }
    await this.ensureOk(branchRes, "Failed to load default branch");
    const branch = await branchRes.json();
    this.defaultBranch = branch.displayId as string;
    this.headCommit = branch.latestCommit as string;
    const ref = this.headCommit ?? this.defaultBranch ?? DEFAULT_BRANCH_FALLBACK;

    const remoteSnapshot = await this.loadRemoteSnapshot(ref);

    const addedPaths = new Set<string>();
    const modifiedPaths: string[] = [];
    const deleted: string[] = [];

    if (remoteSnapshot) {
      const remotePaths = new Set(Object.keys(remoteSnapshot));
      if (!localSnapshot) {
        for (const path of remotePaths) {
          addedPaths.add(path);
        }
      } else {
        const localPaths = new Set(Object.keys(localSnapshot));
        for (const path of remotePaths) {
          if (!localPaths.has(path)) {
            addedPaths.add(path);
            continue;
          }
          if (remoteSnapshot[path].hash !== localSnapshot[path].hash) {
            modifiedPaths.push(path);
          }
        }
        for (const path of localPaths) {
          if (!remotePaths.has(path)) {
            deleted.push(path);
          }
        }
      }
    } else {
      const remotePaths = await this.listFiles(ref);
      for (const path of remotePaths) {
        addedPaths.add(path);
      }
      if (localSnapshot) {
        for (const localPath of Object.keys(localSnapshot)) {
          if (!remotePaths.has(localPath)) {
            deleted.push(localPath);
          }
        }
      }
    }

    const added = new Map<string, FileState>();
    const modified = new Map<string, FileState>();
    const needsContent: string[] = [];

    for (const path of [...addedPaths, ...modifiedPaths]) {
      const entry = remoteSnapshot?.[path];
      if (entry && "modified" in entry) {
        // Snapshot already classifies this as binary — trust the metadata, no fetch.
        const state: FileState = { type: "binary", hash: entry.hash, modified: entry.modified };
        if (addedPaths.has(path)) {
          added.set(path, state);
        } else {
          modified.set(path, state);
        }
        continue;
      }
      needsContent.push(path);
    }

    // No GraphQL batch on Bitbucket DC — fetch raw bytes per path, in parallel.
    const contents = await Promise.all(
      needsContent.map(async (path) => [path, await this.fetchRawBytes(path, ref)] as const),
    );

    for (const [path, bytes] of contents) {
      const snapshotEntry = remoteSnapshot?.[path];
      let state: FileState;
      if (isValidText(bytes)) {
        state = { type: "text", content: bytes.toString("utf8") };
      } else {
        const hash = snapshotEntry?.hash ?? hashBuffer(bytes);
        const modifiedAt =
          snapshotEntry && "modified" in snapshotEntry ? snapshotEntry.modified : Date.now();
        state = { type: "binary", hash, modified: modifiedAt };
      }
      if (addedPaths.has(path)) {
        added.set(path, state);
      } else {
        modified.set(path, state);
      }
    }

    deleted.sort();
    return { added, modified, deleted };
  }

  async get(path: string): Promise<Readable> {
    const ref = this.headCommit ?? this.defaultBranch ?? DEFAULT_BRANCH_FALLBACK;
    const bytes = await this.fetchRawBytes(path, ref);
    return Readable.from(bytes);
  }

  async push(payload: PushPayload): Promise<void> {
    const branch = this.defaultBranch ?? DEFAULT_BRANCH_FALLBACK;
    // Bitbucket DC has no atomic multi-file commit: each write is its own
    // commit via the browse PUT, chained through sourceCommitId. The snapshot
    // is written LAST so a partial push self-heals on the next fetch().
    let sourceCommit = this.headCommit;

    const textWrites: Array<[string, string]> = [];
    const binaryWrites: Array<[string, () => Readable]> = [];
    for (const [path, value] of payload.files) {
      if (typeof value === "string") {
        textWrites.push([path, value]);
      } else {
        binaryWrites.push([path, value]);
      }
    }

    for (const [path, content] of textWrites) {
      sourceCommit = await this.putFile(path, content, branch, sourceCommit);
    }
    for (const [path, createStream] of binaryWrites) {
      const bytes = await streamToBuffer(createStream());
      sourceCommit = await this.putFile(path, bytes, branch, sourceCommit);
    }

    // Bitbucket DC REST cannot delete a file. Record a tombstone keyed by the
    // deleted path for an external reaper to perform the real `git rm`. The
    // path is dropped from the snapshot below, so sync ignores it immediately.
    for (const path of payload.deletions) {
      const marker = JSON.stringify({ path, deletedAt: Date.now() });
      sourceCommit = await this.putFile(`${DELETIONS_PREFIX}${path}`, marker, branch, sourceCommit);
    }

    sourceCommit = await this.putFile(
      SNAPSHOT_PATH,
      JSON.stringify(payload.snapshot),
      branch,
      sourceCommit,
    );

    this.headCommit = sourceCommit;
    this.defaultBranch = branch;
  }

  private repoPath(path: string): string {
    return `/rest/api/1.0/projects/${this.project}/repos/${this.repo}${path}`;
  }

  // Raw file content is served from the application root, NOT under /rest/api.
  private rawPath(path: string): string {
    return `/projects/${this.project}/repos/${this.repo}/raw/${encodePath(path)}`;
  }

  private async loadRemoteSnapshot(ref: string): Promise<Record<string, SnapshotEntry> | null> {
    const res = await this.rawResponse(SNAPSHOT_PATH, ref);
    if (res.status === 404) {
      return null;
    }
    await this.ensureOk(res, "Failed to fetch remote snapshot");
    const text = await res.text();
    return JSON.parse(text) as Record<string, SnapshotEntry>;
  }

  private async listFiles(ref: string): Promise<Set<string>> {
    const paths = new Set<string>();
    let start = 0;
    for (;;) {
      const res = await this.rest(
        "GET",
        this.repoPath(`/files?at=${encodeURIComponent(ref)}&start=${start}&limit=${PAGE_LIMIT}`),
      );
      await this.ensureOk(res, "Failed to list repository files");
      const page = await res.json();
      for (const value of (page.values as string[]) ?? []) {
        if (value.startsWith(".stash/")) {
          continue;
        }
        paths.add(value);
      }
      if (page.isLastPage !== false || typeof page.nextPageStart !== "number") {
        break;
      }
      start = page.nextPageStart as number;
    }
    return paths;
  }

  private async putFile(
    path: string,
    content: string | Buffer,
    branch: string,
    sourceCommitId: string | undefined,
  ): Promise<string> {
    const form = new FormData();
    if (typeof content === "string") {
      form.set("content", content);
    } else {
      const name = path.split("/").pop() ?? "file";
      form.set("content", new Blob([Uint8Array.from(content)]), name);
    }
    form.set("message", COMMIT_MESSAGE);
    form.set("branch", branch);
    if (sourceCommitId) {
      form.set("sourceCommitId", sourceCommitId);
    }

    const res = await this.request("PUT", this.repoPath(`/browse/${encodePath(path)}`), {
      body: form,
    });
    if (res.status === 409) {
      throw new PushConflictError(`Remote moved during push (conflict writing ${path})`);
    }
    await this.ensureOk(res, `Failed to write ${path}`);
    const body = await res.json();
    return body.id as string;
  }

  private async fetchRawBytes(path: string, ref: string): Promise<Buffer> {
    const res = await this.rawResponse(path, ref);
    await this.ensureOk(res, `Failed to fetch raw content for ${path}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private rawResponse(path: string, ref: string): Promise<Response> {
    return this.rest("GET", `${this.rawPath(path)}?at=${encodeURIComponent(ref)}`);
  }

  private rest(method: string, path: string, body?: unknown): Promise<Response> {
    return this.request(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      contentType: body === undefined ? undefined : "application/json",
    });
  }

  private async request(
    method: string,
    path: string,
    options: { body?: BodyInit; contentType?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "User-Agent": "stash",
      // Bitbucket rejects form/PUT submissions as XSRF without this header.
      "X-Atlassian-Token": "no-check",
    };
    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body,
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new Error(
        `Bitbucket API rate limit exceeded.${retryAfter ? ` Retry after ${retryAfter}s.` : ""}`,
      );
    }
    if (response.status === 401) {
      throw new Error("Bitbucket authentication failed. Check your token.");
    }
    if (response.status === 403) {
      throw new Error(
        "Bitbucket permission denied (403). " +
          "Ensure your token has write access to this repository.",
      );
    }

    return response;
  }

  private async ensureOk(response: Response, message: string): Promise<void> {
    if (response.ok) {
      return;
    }
    const statusText = response.statusText.trim();
    const status =
      statusText.length > 0 ? `${response.status} ${statusText}` : `${response.status}`;
    throw new Error(`${message} (${status})`);
  }
}
