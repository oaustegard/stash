import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { PushConflictError } from "../../src/errors.ts";
import { BitbucketDataCenterProvider } from "../../src/providers/bitbucket-datacenter-provider.ts";
import { MockHttpAPI } from "../helpers/mock-http-api.ts";

const REPO = "/rest/api/1.0/projects/PROJ/repos/repo";
// Raw content is served from the application root, not under /rest/api.
const RAW = "/projects/PROJ/repos/repo/raw";

function makeProvider(): BitbucketDataCenterProvider {
  return new BitbucketDataCenterProvider({
    baseUrl: "https://bb.example.com",
    token: "test-token",
    project: "PROJ",
    repo: "repo",
  });
}

function primed(provider: BitbucketDataCenterProvider, head = "head1", branch = "main"): void {
  (provider as any).headCommit = head;
  (provider as any).defaultBranch = branch;
}

test("constructor validates required config", () => {
  assert.throws(
    () =>
      new BitbucketDataCenterProvider({
        baseUrl: "https://x",
        token: "",
        project: "P",
        repo: "r",
      } as any),
    /token/i,
  );
  assert.throws(
    () =>
      new BitbucketDataCenterProvider({
        baseUrl: "not-a-url",
        token: "t",
        project: "P",
        repo: "r",
      } as any),
    /base URL/i,
  );
  assert.throws(
    () =>
      new BitbucketDataCenterProvider({
        baseUrl: "https://x",
        token: "t",
        project: "",
        repo: "r",
      } as any),
    /project/i,
  );
  assert.throws(
    () =>
      new BitbucketDataCenterProvider({
        baseUrl: "https://x",
        token: "t",
        project: "P",
        repo: "",
      } as any),
    /repository/i,
  );
});

test("constructor normalizes base URL (trailing slash + pasted REST suffix)", async () => {
  const provider = new BitbucketDataCenterProvider({
    baseUrl: "https://bb.example.com/rest/api/1.0/",
    token: "t",
    project: "PROJ",
    repo: "repo",
  });
  const api = new MockHttpAPI();
  const cleanup = api
    .onRequest("GET", `${REPO}/branches/default`, ({ url }) => {
      assert.equal(url.origin, "https://bb.example.com");
      assert.equal(url.pathname, `${REPO}/branches/default`);
      return { status: 404, body: { errors: [] } };
    })
    .install();
  try {
    await provider.fetch({});
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("spec exposes setup + connect fields", () => {
  const spec = BitbucketDataCenterProvider.spec;
  assert.deepEqual(
    spec.setup.map((f) => f.name),
    ["baseUrl", "token"],
  );
  assert.deepEqual(
    spec.connect.map((f) => f.name),
    ["project", "repo"],
  );
  assert.equal(spec.setup.find((f) => f.name === "token")?.secret, true);
});

test("fetch: empty repo (no default branch) returns empty changeset", async () => {
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, { status: 404, body: { errors: [] } })
    .install();
  try {
    const provider = makeProvider();
    const changeSet = await provider.fetch({});
    assert.equal(changeSet.added.size, 0);
    assert.equal(changeSet.modified.size, 0);
    assert.deepEqual(changeSet.deleted, []);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("fetch: diffs remote snapshot and fetches changed text via raw", async () => {
  const remoteSnapshot = {
    "hello.md": { hash: "sha256-new" },
    "image.png": { hash: "sha256-image", modified: 42 },
  };
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, {
      status: 200,
      body: { displayId: "main", latestCommit: "head1" },
    })
    .on("GET", `${RAW}/.stash/snapshot.json?at=head1`, {
      status: 200,
      body: JSON.stringify(remoteSnapshot),
    })
    .on("GET", `${RAW}/hello.md?at=head1`, { status: 200, body: "hello from remote" })
    .install();
  try {
    const provider = makeProvider();
    const localSnapshot = {
      "hello.md": { hash: "sha256-old" },
      "old.md": { hash: "sha256-old-file" },
    };
    const changeSet = await provider.fetch(localSnapshot);
    assert.equal(changeSet.modified.get("hello.md")?.type, "text");
    assert.equal((changeSet.modified.get("hello.md") as any)?.content, "hello from remote");
    assert.deepEqual(changeSet.deleted, ["old.md"]);
    assert.deepEqual(changeSet.added.get("image.png"), {
      type: "binary",
      hash: "sha256-image",
      modified: 42,
    });
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("fetch: no remote changes skips raw content fetch", async () => {
  const snapshot = { "hello.md": { hash: "same" } };
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, {
      status: 200,
      body: { displayId: "main", latestCommit: "head1" },
    })
    .on("GET", `${RAW}/.stash/snapshot.json?at=head1`, {
      status: 200,
      body: JSON.stringify(snapshot),
    })
    .install();
  try {
    const provider = makeProvider();
    const result = await provider.fetch(snapshot);
    assert.equal(result.added.size, 0);
    assert.equal(result.modified.size, 0);
    assert.deepEqual(result.deleted, []);
    api.assertDone(); // no raw/hello.md call registered → would throw if attempted
  } finally {
    cleanup();
  }
});

test("fetch: first sync with no local snapshot returns all added", async () => {
  const remoteSnapshot = {
    "hello.md": { hash: "h1" },
    "image.bin": { hash: "h2", modified: 12 },
  };
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, {
      status: 200,
      body: { displayId: "main", latestCommit: "head1" },
    })
    .on("GET", `${RAW}/.stash/snapshot.json?at=head1`, {
      status: 200,
      body: JSON.stringify(remoteSnapshot),
    })
    .on("GET", `${RAW}/hello.md?at=head1`, { status: 200, body: "hello" })
    .install();
  try {
    const provider = makeProvider();
    const result = await provider.fetch(undefined);
    assert.deepEqual(result.added.get("hello.md"), { type: "text", content: "hello" });
    assert.deepEqual(result.added.get("image.bin"), { type: "binary", hash: "h2", modified: 12 });
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("fetch: no remote snapshot uses paginated file listing, excludes .stash/", async () => {
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, {
      status: 200,
      body: { displayId: "main", latestCommit: "head1" },
    })
    .on("GET", `${RAW}/.stash/snapshot.json?at=head1`, { status: 404, body: { errors: [] } })
    .on("GET", `${REPO}/files?at=head1&start=0&limit=1000`, {
      status: 200,
      body: { values: ["readme.md", ".stash/config.json"], isLastPage: false, nextPageStart: 2 },
    })
    .on("GET", `${REPO}/files?at=head1&start=2&limit=1000`, {
      status: 200,
      body: { values: ["dir/note.md", ".stash/snapshot.json"], isLastPage: true },
    })
    .on("GET", `${RAW}/readme.md?at=head1`, { status: 200, body: "readme" })
    .on("GET", `${RAW}/dir/note.md?at=head1`, { status: 200, body: "note" })
    .install();
  try {
    const provider = makeProvider();
    const result = await provider.fetch({});
    assert.equal(result.added.get("readme.md")?.type, "text");
    assert.equal(result.added.get("dir/note.md")?.type, "text");
    assert.equal(result.added.has(".stash/config.json"), false);
    assert.equal(result.added.has(".stash/snapshot.json"), false);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("fetch: invalid UTF-8 content falls back to binary", async () => {
  const remoteSnapshot = { "latin1.txt": { hash: "h1" } };
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, {
      status: 200,
      body: { displayId: "main", latestCommit: "head1" },
    })
    .on("GET", `${RAW}/.stash/snapshot.json?at=head1`, {
      status: 200,
      body: JSON.stringify(remoteSnapshot),
    })
    .on("GET", `${RAW}/latin1.txt?at=head1`, { status: 200, body: Buffer.from([0xe9]) })
    .install();
  try {
    const provider = makeProvider();
    const result = await provider.fetch(undefined);
    assert.equal(result.added.get("latin1.txt")?.type, "binary");
    assert.equal((result.added.get("latin1.txt") as any).hash, "h1");
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("get: streams raw bytes and sends Bearer auth", async () => {
  const api = new MockHttpAPI();
  const cleanup = api
    .onRequest("GET", `${RAW}/file%20name.bin?at=main`, ({ headers }) => {
      assert.equal(headers.get("authorization"), "Bearer test-token");
      return { status: 200, body: Buffer.from([1, 2, 3, 4]) };
    })
    .install();
  try {
    const provider = makeProvider();
    (provider as any).defaultBranch = "main";
    const stream = await provider.get("file name.bin");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4]));
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("push: text-only writes snapshot last and chains sourceCommitId", async () => {
  const calls: Array<{ path: string; body: any }> = [];
  const api = new MockHttpAPI();
  const cleanup = api
    .onRequest("PUT", `${REPO}/browse/hello.md`, ({ body }) => {
      calls.push({ path: "hello.md", body });
      return { status: 200, body: { id: "commit-1" } };
    })
    .onRequest("PUT", `${REPO}/browse/.stash/snapshot.json`, ({ body }) => {
      calls.push({ path: "snapshot", body });
      return { status: 200, body: { id: "commit-2" } };
    })
    .install();
  try {
    const provider = makeProvider();
    primed(provider, "head1", "main");
    await provider.push({
      files: new Map([["hello.md", "hello"]]),
      deletions: [],
      snapshot: { "hello.md": { hash: "sha256-hello" } },
    });
    assert.deepEqual(
      calls.map((c) => c.path),
      ["hello.md", "snapshot"],
    );
    assert.equal(calls[0].body.content, "hello");
    assert.equal(calls[0].body.branch, "main");
    assert.equal(calls[0].body.sourceCommitId, "head1");
    // snapshot write chains off the commit returned by the first write
    assert.equal(calls[1].body.sourceCommitId, "commit-1");
    assert.equal((provider as any).headCommit, "commit-2");
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("push: snapshot-only push still writes the snapshot", async () => {
  let sawSnapshot = false;
  const api = new MockHttpAPI();
  const cleanup = api
    .onRequest("PUT", `${REPO}/browse/.stash/snapshot.json`, ({ body }) => {
      sawSnapshot = true;
      assert.equal((body as any).branch, "main");
      return { status: 200, body: { id: "commit-1" } };
    })
    .install();
  try {
    const provider = makeProvider();
    primed(provider, "head1", "main");
    await provider.push({ files: new Map(), deletions: [], snapshot: { "a.md": { hash: "h" } } });
    assert.equal(sawSnapshot, true);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("push: 409 on a write throws PushConflictError", async () => {
  const api = new MockHttpAPI();
  const cleanup = api
    .on("PUT", `${REPO}/browse/hello.md`, { status: 409, body: { errors: [{ message: "stale" }] } })
    .install();
  try {
    const provider = makeProvider();
    primed(provider, "head1", "main");
    await assert.rejects(
      provider.push({ files: new Map([["hello.md", "hi"]]), deletions: [], snapshot: {} }),
      PushConflictError,
    );
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("push: binary content is uploaded as multipart blob", async () => {
  let binaryBody: any;
  const api = new MockHttpAPI();
  const cleanup = api
    .onRequest("PUT", `${REPO}/browse/image.png`, ({ body }) => {
      binaryBody = body;
      return { status: 200, body: { id: "commit-1" } };
    })
    .on("PUT", `${REPO}/browse/.stash/snapshot.json`, { status: 200, body: { id: "commit-2" } })
    .install();
  try {
    const provider = makeProvider();
    primed(provider, "head1", "main");
    await provider.push({
      files: new Map([["image.png", () => Readable.from(Buffer.from("PNGDATA"))]]),
      deletions: [],
      snapshot: { "image.png": { hash: "h", modified: 1 } },
    });
    // FormData blob entries are surfaced as their decoded text by the mock
    assert.equal(binaryBody.content, "PNGDATA");
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("push: deletions write a tombstone marker under .stash/deletions/", async () => {
  let tombstone: any;
  const api = new MockHttpAPI();
  const cleanup = api
    .onRequest("PUT", `${REPO}/browse/.stash/deletions/old.md`, ({ body }) => {
      tombstone = body;
      return { status: 200, body: { id: "commit-1" } };
    })
    .on("PUT", `${REPO}/browse/.stash/snapshot.json`, { status: 200, body: { id: "commit-2" } })
    .install();
  try {
    const provider = makeProvider();
    primed(provider, "head1", "main");
    await provider.push({
      files: new Map(),
      deletions: ["old.md"],
      snapshot: {},
    });
    const marker = JSON.parse(tombstone.content);
    assert.equal(marker.path, "old.md");
    assert.equal(typeof marker.deletedAt, "number");
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("push: empty repo omits sourceCommitId on the first write", async () => {
  const bodies: any[] = [];
  const api = new MockHttpAPI();
  const cleanup = api
    .onRequest("PUT", `${REPO}/browse/hello.md`, ({ body }) => {
      bodies.push(body);
      return { status: 200, body: { id: "commit-1" } };
    })
    .onRequest("PUT", `${REPO}/browse/.stash/snapshot.json`, ({ body }) => {
      bodies.push(body);
      return { status: 200, body: { id: "commit-2" } };
    })
    .install();
  try {
    const provider = makeProvider(); // no headCommit/defaultBranch → empty repo
    await provider.push({
      files: new Map([["hello.md", "hello"]]),
      deletions: [],
      snapshot: { "hello.md": { hash: "h" } },
    });
    assert.equal(bodies[0].sourceCommitId, undefined);
    assert.equal(bodies[0].branch, "main");
    assert.equal(bodies[1].sourceCommitId, "commit-1");
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("errors: 429 rate limit surfaces retry-after", async () => {
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, {
      status: 429,
      body: { errors: [] },
      headers: { "retry-after": "30" },
    })
    .install();
  try {
    const provider = makeProvider();
    await assert.rejects(provider.fetch({}), /rate limit.*30/i);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("errors: 401 throws descriptive auth error", async () => {
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, { status: 401, body: { errors: [] } })
    .install();
  try {
    const provider = makeProvider();
    await assert.rejects(provider.fetch({}), /authentication failed/i);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("errors: REST failures use concise status text", async () => {
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${RAW}/file.bin?at=main`, {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "text/html" },
      body: "<!DOCTYPE html><html><body>outage</body></html>",
    })
    .install();
  try {
    const provider = makeProvider();
    (provider as any).defaultBranch = "main";
    await assert.rejects(provider.get("file.bin"), (error: unknown) => {
      const message = (error as Error).message;
      assert.equal(message, "Failed to fetch raw content for file.bin (503 Service Unavailable)");
      assert.equal(message.includes("<!DOCTYPE html>"), false);
      return true;
    });
    api.assertDone();
  } finally {
    cleanup();
  }
});
