import test from "node:test";
import assert from "node:assert/strict";
import { BitbucketDataCenterProvider } from "../../src/providers/bitbucket-datacenter-provider.ts";
import type { PushPayload } from "../../src/types.ts";
import { MockHttpAPI } from "../helpers/mock-http-api.ts";

const REPO = "/rest/api/1.0/projects/PROJ/repos/repo";
const RAW = "/projects/PROJ/repos/repo/raw";

function makeProvider(): BitbucketDataCenterProvider {
  return new BitbucketDataCenterProvider({
    baseUrl: "https://bb.example.com",
    token: "test-token",
    project: "PROJ",
    repo: "repo",
  });
}

test("bitbucket-dc integration: fetch then push chains the fetched head commit", async () => {
  const writes: Array<{ path: string; body: any }> = [];
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, {
      status: 200,
      body: { displayId: "main", latestCommit: "head-abc" },
    })
    .on("GET", `${RAW}/.stash/snapshot.json?at=head-abc`, {
      status: 200,
      body: JSON.stringify({}),
    })
    .onRequest("PUT", `${REPO}/browse/hello.md`, ({ body }) => {
      writes.push({ path: "hello.md", body });
      return { status: 200, body: { id: "commit-1" } };
    })
    .onRequest("PUT", `${REPO}/browse/.stash/snapshot.json`, ({ body }) => {
      writes.push({ path: "snapshot", body });
      return { status: 200, body: { id: "commit-2" } };
    })
    .install();

  try {
    const provider = makeProvider();
    await provider.fetch({});
    await provider.push({
      files: new Map([["hello.md", "hello"]]),
      deletions: [],
      snapshot: { "hello.md": { hash: "sha256-hello" } },
    });

    // The first write must source from the commit captured during fetch().
    assert.equal(writes[0].body.sourceCommitId, "head-abc");
    assert.equal(writes[0].body.branch, "main");
    // Snapshot is written last, chaining off the prior write's commit.
    assert.deepEqual(
      writes.map((w) => w.path),
      ["hello.md", "snapshot"],
    );
    assert.equal(writes[1].body.sourceCommitId, "commit-1");
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("bitbucket-dc integration: realistic fetch → reconcile → push walkthrough", async () => {
  const localSnapshot = {
    "hello.md": { hash: "sha256-hello-world" },
    "image.png": { hash: "sha256-image", modified: 1709121600000 },
  };
  const remoteSnapshot = {
    "hello.md": { hash: "sha256-hello-world!" },
    "image.png": { hash: "sha256-image", modified: 1709121600000 },
    "photo.jpg": { hash: "sha256-photo", modified: 1709290800000 },
  };

  const writes: string[] = [];
  const api = new MockHttpAPI();
  const cleanup = api
    .on("GET", `${REPO}/branches/default`, {
      status: 200,
      body: { displayId: "main", latestCommit: "head-xyz" },
    })
    .on("GET", `${RAW}/.stash/snapshot.json?at=head-xyz`, {
      status: 200,
      body: JSON.stringify(remoteSnapshot),
    })
    // hello.md changed remotely (text) → fetched via raw; photo.jpg is a new binary
    .on("GET", `${RAW}/hello.md?at=head-xyz`, { status: 200, body: "hello world!" })
    .onRequest("PUT", /\/browse\//, ({ url }) => {
      writes.push(url.pathname.replace(`${REPO}/browse/`, ""));
      return { status: 200, body: { id: `c${writes.length}` } };
    })
    .install();

  try {
    const provider = makeProvider();
    const remoteChangeSet = await provider.fetch(localSnapshot);
    assert.equal(remoteChangeSet.modified.get("hello.md")?.type, "text");
    assert.equal(remoteChangeSet.added.get("photo.jpg")?.type, "binary");
    assert.deepEqual(remoteChangeSet.deleted, []);

    const payload: PushPayload = {
      files: new Map([
        ["hello.md", "hello brave world!"],
        ["new.md", "draft"],
      ]),
      deletions: ["image.png"],
      snapshot: {
        "hello.md": { hash: "sha256-merged" },
        "new.md": { hash: "sha256-draft" },
        "photo.jpg": { hash: "sha256-photo", modified: 1709290800000 },
      },
    };
    await provider.push(payload);

    // text writes, then the deletion tombstone, then the snapshot — last.
    assert.deepEqual(writes, [
      "hello.md",
      "new.md",
      ".stash/deletions/image.png",
      ".stash/snapshot.json",
    ]);
    assert.equal((provider as any).headCommit, `c${writes.length}`);
    api.assertDone();
  } finally {
    cleanup();
  }
});
