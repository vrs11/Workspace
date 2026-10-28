// Reconstruct path dependencies from pinned archives and reviewed patches.
// Downloaded code is never executed; every resulting byte is verified.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const archiveLimit = 16 * 1024 * 1024;
const safePath = (name) =>
  typeof name === "string" &&
  !/[\\:\x00-\x1f\x7f]/.test(name) &&
  name.split("/").every((part) => part && part !== "." && part !== "..");
const same = (left, right) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
};

export function archiveFiles(compressed, prefix) {
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const result = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) =>
      header.subarray(start, end).toString("utf8").split("\0")[0];
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join("/");
    const size = field(124, 136).trim();
    const length = /^[0-7]+$/.test(size) ? Number.parseInt(size, 8) : NaN;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + 512 + length > tar.length
    )
      throw new Error("Malformed pinned crate archive");
    const type = header[156];
    if (type === 0 || type === 48) {
      if (!name.startsWith(prefix + "/"))
        throw new Error("Unexpected crate archive prefix");
      const relative = name.slice(prefix.length + 1);
      if (!safePath(relative)) throw new Error("Unsafe crate member name");
      if (result.has(relative))
        throw new Error("Duplicate crate archive member");
      result.set(relative, tar.subarray(offset + 512, offset + 512 + length));
    } else if (type !== 53)
      throw new Error(`Unsupported pinned archive entry type ${type}`);
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  if (!result.size) throw new Error("Empty pinned crate archive");
  return result;
}

function filesAt(root, relative = "") {
  if (!lstatSync(root).isDirectory())
    throw new Error("Local vendor directory required; symlinks refused");
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = relative ? relative + "/" + entry.name : entry.name;
      if (!entry.isFile() && !entry.isDirectory())
        throw new Error("Local vendor symlink/special file refused");
      return entry.isDirectory() ? filesAt(root, path) : [path];
    },
  );
}

function readManifest(root) {
  const bytes = readFileSync(join(root, "patches/manifest.json"));
  const manifest = JSON.parse(bytes);
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.packages) ||
    !manifest.packages.length
  )
    throw new Error("Unsupported vendor manifest");
  const names = new Set();
  for (const pkg of manifest.packages) {
    if (
      !/^[a-z0-9-]+$/.test(pkg.name) ||
      !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
      !/^[a-f0-9]{64}$/.test(pkg.archiveSha256) ||
      names.has(pkg.name) ||
      !pkg.files ||
      !Object.keys(pkg.files).length ||
      !Object.entries(pkg.files).every(
        ([path, hash]) => safePath(path) && /^[a-f0-9]{64}$/.test(hash),
      ) ||
      !Array.isArray(pkg.modifiedFiles) ||
      !Array.isArray(pkg.addedFiles) ||
      !Array.isArray(pkg.removedFiles) ||
      !pkg.removedFiles.every(
        (path) => safePath(path) && !Object.hasOwn(pkg.files, path),
      ) ||
      ![...pkg.modifiedFiles, ...pkg.addedFiles].every(
        (path) => safePath(path) && Object.hasOwn(pkg.files, path),
      )
    )
      throw new Error("Invalid pinned crate manifest");
    names.add(pkg.name);
  }
  return { bytes, packages: manifest.packages };
}

function validatePackage(pkg, root, original) {
  const actual = filesAt(root).sort();
  if (!same(actual, Object.keys(pkg.files)))
    throw new Error(`Vendor file inventory drift: ${pkg.name}`);
  const modified = [],
    added = [];
  for (const name of actual) {
    const current = readFileSync(join(root, name));
    if (sha256(current) !== pkg.files[name])
      throw new Error(`Vendor content drift: ${pkg.name}/${name}`);
    if (original) {
      const upstream = original.get(name);
      if (!upstream) added.push(name);
      else if (!current.equals(upstream)) modified.push(name);
    }
  }
  const removed = original
    ? [...original.keys()].filter((name) => !Object.hasOwn(pkg.files, name))
    : [];
  if (
    original &&
    (!same(removed, pkg.removedFiles) ||
      !same(modified, pkg.modifiedFiles) ||
      !same(added, pkg.addedFiles))
  )
    throw new Error(`Undeclared vendor delta: ${pkg.name}`);
  return {
    name: pkg.name,
    version: pkg.version,
    archiveSha256: pkg.archiveSha256,
    files: actual.length,
    modified,
    added,
    removed,
  };
}

function validateTree(vendor, manifest) {
  if (!lstatSync(vendor).isDirectory())
    throw new Error("Local vendor directory required; symlinks refused");
  if (!readFileSync(join(vendor, "patches.json")).equals(manifest.bytes))
    throw new Error("Vendor manifest drift; existing sources were preserved");
  for (const pkg of manifest.packages)
    validatePackage(pkg, join(vendor, pkg.name));
}

async function upstream(pkg, cache, fetchArchive) {
  mkdirSync(cache, { recursive: true });
  const prefix = `${pkg.name}-${pkg.version}`;
  const path = join(cache, prefix + ".crate");
  if (!present(path)) {
    const response = await fetchArchive(
      `https://static.crates.io/crates/${pkg.name}/${prefix}.crate`,
      { signal: AbortSignal.timeout(60_000), redirect: "error" },
    );
    if (!response.ok)
      throw new Error(`Upstream archive download failed: ${response.status}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > archiveLimit)
        throw new Error("Upstream archive size limit exceeded");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (sha256(bytes) !== pkg.archiveSha256)
      throw new Error("Upstream archive checksum mismatch");
    const temporary = mkdtempSync(join(cache, ".download-"));
    try {
      writeFileSync(join(temporary, "archive"), bytes);
      renameSync(join(temporary, "archive"), path);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  if (!lstatSync(path).isFile() || lstatSync(path).size > archiveLimit)
    throw new Error("Invalid cached upstream archive");
  const bytes = readFileSync(path);
  if (sha256(bytes) !== pkg.archiveSha256)
    throw new Error("Cached upstream archive checksum mismatch");
  return archiveFiles(bytes, prefix);
}

// Preserve edited/partial trees. Review them before moving/removing vendor and
// rerunning preparation. A new tree becomes visible only after full validation.
export async function prepareVendor({
  root = repositoryRoot,
  cache = join(root, ".tools/vendor-archives"),
  fetchArchive = fetch,
} = {}) {
  const manifest = readManifest(root);
  const vendor = join(root, "vendor");
  if (present(vendor)) {
    validateTree(vendor, manifest);
    return false;
  }
  const temporary = mkdtempSync(join(root, ".vendor-prepare-"));
  try {
    for (const pkg of manifest.packages) {
      const original = await upstream(pkg, cache, fetchArchive);
      const destination = join(temporary, pkg.name);
      mkdirSync(destination);
      for (const [name, bytes] of original) {
        if (pkg.removedFiles.includes(name)) continue;
        const path = join(destination, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes, { flag: "wx" });
      }
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
      );
      Object.assign(env, {
        GIT_CEILING_DIRECTORIES: temporary,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      });
      execFileSync(
        "git",
        [
          "apply",
          "--no-index",
          "--whitespace=nowarn",
          join(root, "patches", pkg.name + ".patch"),
        ],
        { cwd: destination, env, stdio: "pipe", timeout: 30_000 },
      );
      validatePackage(pkg, destination, original);
    }
    writeFileSync(join(temporary, "patches.json"), manifest.bytes);
    try {
      renameSync(temporary, vendor);
    } catch (error) {
      // Concurrent preparation may have published the same verified tree.
      if (!existsSync(vendor)) throw error;
      validateTree(vendor, manifest);
    }
    return true;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function verifyVendor({
  root = repositoryRoot,
  cache = join(root, ".tools/vendor-archives"),
  fetchArchive = fetch,
} = {}) {
  await prepareVendor({ root, cache, fetchArchive });
  const manifest = readManifest(root);
  const evidence = [];
  for (const pkg of manifest.packages) {
    const original = await upstream(pkg, cache, fetchArchive);
    evidence.push(
      validatePackage(pkg, join(root, "vendor", pkg.name), original),
    );
  }
  return evidence;
}
