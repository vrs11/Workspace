import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
const { Response } = globalThis;
import {
  archiveFiles,
  prepareVendor,
  verifyVendor,
  sha256,
} from "../scripts/vendor.mjs";

function archive(entries) {
  const blocks = [];
  for (const [name, text, type = "0"] of entries) {
    const bytes = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header[156] = type.charCodeAt(0);
    header.fill(32, 148, 156);
    header.write(
      header
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    blocks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workspace vendor test "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, ".tools/vendor-archives");
  mkdirSync(cache, { recursive: true });
  mkdirSync(join(root, "patches"));
  const bytes = archive([
    ["fixture-1.0.0/src/lib.rs", "old\n"],
    ["fixture-1.0.0/LICENSE", "upstream notice\n"],
    ["fixture-1.0.0/omitted", "metadata\n"],
  ]);
  const manifest = {
    version: 1,
    packages: [
      {
        name: "fixture",
        version: "1.0.0",
        archiveSha256: sha256(bytes),
        modifiedFiles: ["src/lib.rs"],
        addedFiles: ["PATCHES.md"],
        removedFiles: ["omitted"],
        files: {
          "src/lib.rs": sha256("new\n"),
          LICENSE: sha256("upstream notice\n"),
          "PATCHES.md": sha256("provenance\n"),
        },
      },
    ],
  };
  writeFileSync(join(root, "patches/manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(cache, "fixture-1.0.0.crate"), bytes);
  writeFileSync(
    join(root, "patches/fixture.patch"),
    "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n" +
      "--- /dev/null\n+++ b/PATCHES.md\n@@ -0,0 +1 @@\n+provenance\n",
  );
  const options = {
    root,
    cache,
    fetchArchive: () => {
      throw new Error("Unexpected network access");
    },
  };
  return { ...options, options, bytes, manifest, vendor: join(root, "vendor") };
}

function unpublished(root) {
  assert.equal(existsSync(join(root, "vendor")), false);
  assert.equal(
    readdirSync(root).some((name) => name.startsWith(".vendor-prepare-")),
    false,
  );
}

test("offline preparation reproduces exact sources, notices and provenance; reuse performs no writes", async (t) => {
  const f = fixture(t);
  assert.equal(await prepareVendor(f.options), true);
  assert.equal(
    readFileSync(join(f.vendor, "fixture/src/lib.rs"), "utf8"),
    "new\n",
  );
  assert.equal(existsSync(join(f.vendor, "fixture/omitted")), false);
  const before = statSync(join(f.vendor, "fixture/src/lib.rs")).mtimeMs;
  assert.equal(await prepareVendor(f.options), false);
  assert.equal(statSync(join(f.vendor, "fixture/src/lib.rs")).mtimeMs, before);
  const result = await verifyVendor(f.options);
  assert.deepEqual(result[0].modified, ["src/lib.rs"]);
  assert.deepEqual(result[0].added, ["PATCHES.md"]);
  assert.deepEqual(result[0].removed, ["omitted"]);
});

test("edited or partial dependency trees are refused and preserved", async (t) => {
  const f = fixture(t);
  await prepareVendor(f.options);
  const path = join(f.vendor, "fixture/src/lib.rs");
  writeFileSync(path, "local edit\n");
  await assert.rejects(prepareVendor(f.options), /content drift/);
  assert.equal(readFileSync(path, "utf8"), "local edit\n");
  rmSync(path);
  await assert.rejects(prepareVendor(f.options), /inventory drift/);
  assert.equal(existsSync(path), false);
});

test("invalid cached archives fail without publishing partial sources", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cache, "fixture-1.0.0.crate"), "corrupt");
  await assert.rejects(prepareVendor(f.options), /checksum mismatch/);
  unpublished(f.root);
});

test("missing archives download only from the pinned URL and are verified before caching", async (t) => {
  const f = fixture(t);
  rmSync(join(f.cache, "fixture-1.0.0.crate"));
  let calls = 0;
  await prepareVendor({
    ...f.options,
    fetchArchive: (url) => {
      assert.equal(
        url,
        "https://static.crates.io/crates/fixture/fixture-1.0.0.crate",
      );
      calls++;
      return new Response(f.bytes);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(join(f.cache, "fixture-1.0.0.crate")), f.bytes);
});

test("HTTP errors, corrupt downloads and oversized downloads leave no tree/cache", async (t) => {
  for (const [response, expected] of [
    [() => new Response(null, { status: 503 }), /download failed/],
    [() => new Response("bad bytes"), /checksum mismatch/],
    [() => new Response(Buffer.alloc(16 * 1024 * 1024 + 1)), /size limit/],
  ]) {
    const f = fixture(t);
    rmSync(join(f.cache, "fixture-1.0.0.crate"));
    await assert.rejects(
      prepareVendor({ ...f.options, fetchArchive: response }),
      expected,
    );
    assert.equal(existsSync(join(f.cache, "fixture-1.0.0.crate")), false);
    unpublished(f.root);
  }
});

test("failed or incorrect patches leave no partial dependency directory", async (t) => {
  for (const patch of [
    "invalid patch",
    "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+wrong\n",
  ]) {
    const f = fixture(t);
    writeFileSync(join(f.root, "patches/fixture.patch"), patch);
    await assert.rejects(prepareVendor(f.options));
    unpublished(f.root);
  }
});

test("archive traversal, wrong prefixes, symlinks and duplicate entries are refused", () => {
  for (const entries of [
    [["fixture-1.0.0/../escape", "bad"]],
    [["fixture-1.0.0/dir\\escape", "bad"]],
    [["fixture-1.0.0/C:escape", "bad"]],
    [["different/file", "bad"]],
    [["fixture-1.0.0/link", "", "2"]],
    [
      ["fixture-1.0.0/file", "one"],
      ["fixture-1.0.0/file", "two"],
    ],
  ])
    assert.throws(() => archiveFiles(archive(entries), "fixture-1.0.0"));
});

test("unsafe manifest paths and undeclared source removals cannot be published", async (t) => {
  for (const unsafe of [true, false]) {
    const f = fixture(t);
    if (unsafe) f.manifest.packages[0].files["../escape"] = sha256("bad");
    else f.manifest.packages[0].removedFiles.push("LICENSE");
    writeFileSync(
      join(f.root, "patches/manifest.json"),
      JSON.stringify(f.manifest),
    );
    await assert.rejects(
      prepareVendor(f.options),
      /Invalid pinned crate manifest/,
    );
    unpublished(f.root);
  }
});

test("prepared source symlinks are refused without touching their targets", async (t) => {
  const f = fixture(t);
  await prepareVendor(f.options);
  const target = join(f.root, "external");
  writeFileSync(target, "keep\n");
  const path = join(f.vendor, "fixture/src/lib.rs");
  rmSync(path);
  symlinkSync(target, path);
  await assert.rejects(prepareVendor(f.options), /symlink/);
  assert.equal(readFileSync(target, "utf8"), "keep\n");
});

test("concurrent preparations publish one complete verified tree", async (t) => {
  const f = fixture(t);
  await Promise.all([prepareVendor(f.options), prepareVendor(f.options)]);
  assert.equal((await verifyVendor(f.options)).length, 1);
  assert.equal(
    readdirSync(f.root).some((name) => name.startsWith(".vendor-prepare-")),
    false,
  );
});
