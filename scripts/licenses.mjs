import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { noticeTextIndex } from "./license-notices.mjs";
const licenseTexts = noticeTextIndex();
const npm = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }),
);
const cargo = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--locked",
      "--format-version",
      "1",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  ),
);
const components = [];
const legacyLicenses = {
  "MIT/Apache-2.0": "MIT OR Apache-2.0",
  "Apache-2.0/MIT": "Apache-2.0 OR MIT",
  "Apache-2.0 / MIT": "Apache-2.0 OR MIT",
  "BSD-3-Clause/MIT": "BSD-3-Clause OR MIT",
  "Unlicense/MIT": "Unlicense OR MIT",
};
function expression(license) {
  const normalized = legacyLicenses[license] ?? license;
  if (normalized.includes("/"))
    throw new Error(`Review this legacy license expression: ${license}`);
  return normalized;
}
const purl = (type, name, version) =>
  `pkg:${type}/${name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`;
const notices = [
  "# Third-party notices",
  "",
  "Generated from locked dependencies. External command-line tools are separately installed and not bundled. Original application code: Apache-2.0.",
  "",
  "Source for the MPL-only Rust dependencies is included in the application's third-party-sources directory as the original checksum-verified .crate archives. These are gzip-compressed tar archives, available without a network request. Their source remains under MPL-2.0; the original license and copyright notices are retained. For dual-licensed dependencies, the MIT or Apache-2.0 alternative applies where offered. Build tools are inventoried too; they are not installed with Workspace.",
  "",
  "The statically linked Rust standard library's complete upstream copyright and license notices are included as third-party-sources/RUST_STANDARD_LIBRARY_NOTICES.html.gz. Decompress with gzip (or an archive tool) and open the HTML locally. These notices are supplied unchanged from the pinned Rust toolchain.",
  "",
];
const lockPackages = readFileSync("src-tauri/Cargo.lock", "utf8").split(
  "[[package]]",
);
const sources = [];
const legalRoot = process.env.AW_LICENSE_OUTPUT_DIR ?? "artifacts/legal";
const legalSources = join(legalRoot, "third-party-sources");
mkdirSync(legalSources, { recursive: true });
mkdirSync("artifacts/evidence", { recursive: true });
const problems = [];
const overrides = JSON.parse(
  readFileSync("scripts/license-overrides.json", "utf8"),
);
const seen = new Set();
for (const [reported, packages] of Object.entries(npm)) {
  for (const group of packages)
    for (const path of group.paths) {
      const p = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      const identity = `${p.name}@${p.version}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      let license = reported;
      const override = overrides[identity];
      if (override) {
        if (
          createHash("sha256")
            .update(readFileSync(join(path, override.source)))
            .digest("hex") !== override.sha256
        )
          throw new Error(`License evidence drift: ${identity}`);
        license = override.license;
      }
      if (/UNKNOWN|UNLICENSED/i.test(license))
        problems.push(`Unresolved npm license ${identity}: ${license}`);
      components.push({
        type: "library",
        name: p.name,
        version: p.version,
        purl: purl("npm", p.name, p.version),
        licenses: [{ expression: expression(license) }],
      });
      notices.push(`## ${p.name} ${p.version}`, "", `License: ${license}`, "");
      const author = typeof p.author === "string" ? p.author : p.author?.name;
      const repository =
        typeof p.repository === "string" ? p.repository : p.repository?.url;
      if (author) notices.push(`Author: ${author}`, "");
      if (repository) notices.push(`Upstream: ${repository}`, "");
      const names = readdirSync(path).filter((n) =>
        /^(license|licence|notice)(\.|$)/i.test(n),
      );
      if (override) names.push(override.source);
      for (const name of names) {
        const file = join(path, name);
        try {
          notices.push(licenseTexts.reference(readFileSync(file, "utf8")), "");
        } catch (e) {
          problems.push(`Cannot read license ${file}: ${e.message}`);
        }
      }
    }
}
for (const p of cargo.packages) {
  if (p.name === "agent-workspace") continue;
  if (!p.license && !p.license_file)
    problems.push(`Unresolved crate license ${p.name}`);
  const patch = join(dirname(p.manifest_path), "PATCHES.md");
  const pedigree = existsSync(patch)
    ? {
        notes: readFileSync(patch, "utf8"),
      }
    : undefined;
  if (p.license === "MPL-2.0") {
    if (!p.source?.startsWith("registry+"))
      throw new Error(`MPL source requires explicit provenance: ${p.name}`);
    const block = lockPackages.find(
      (entry) =>
        entry.includes(`\nname = "${p.name}"\n`) &&
        entry.includes(`\nversion = "${p.version}"\n`),
    );
    const checksum = /^checksum = "([a-f0-9]{64})"$/m.exec(block ?? "")?.[1];
    const sourceIndex = dirname(dirname(p.manifest_path));
    const archive = `${p.name}-${p.version}.crate`;
    const cache = join(
      dirname(dirname(sourceIndex)),
      "cache",
      basename(sourceIndex),
      archive,
    );
    const sha256 = createHash("sha256")
      .update(readFileSync(cache))
      .digest("hex");
    if (!checksum || sha256 !== checksum)
      throw new Error(`Locked source checksum mismatch: ${archive}`);
    copyFileSync(cache, join(legalSources, archive));
    sources.push({
      name: p.name,
      version: p.version,
      archive,
      sha256,
      license: p.license,
    });
  }
  components.push({
    type: "library",
    name: p.name,
    version: p.version,
    purl: purl("cargo", p.name, p.version),
    licenses: [
      { expression: expression(p.license || "LicenseRef-package-file") },
    ],
    ...(pedigree
      ? {
          pedigree,
          properties: [{ name: "agent-workspace:local-patch", value: p.name }],
        }
      : {}),
  });
  notices.push(
    `## ${p.name} ${p.version}`,
    "",
    `License: ${p.license || p.license_file}`,
    "",
  );
  if (p.authors?.length) notices.push(`Authors: ${p.authors.join(", ")}`, "");
  if (p.repository) notices.push(`Upstream: ${p.repository}`, "");
  if (pedigree) notices.push("Local patch:", "", pedigree.notes, "");
  for (const name of readdirSync(dirname(p.manifest_path)).filter((n) =>
    /^(license|licence|notice)(\.|-|$)/i.test(n),
  )) {
    const file = join(dirname(p.manifest_path), name);
    try {
      notices.push(licenseTexts.reference(readFileSync(file, "utf8")), "");
    } catch (e) {
      problems.push(`Cannot read license ${file}: ${e.message}`);
    }
  }
}
const rustVersion = execFileSync("rustc", ["--version"], { encoding: "utf8" })
  .trim()
  .split(" ")[1];
const pinnedRust = /^channel = "([^"]+)"$/m.exec(
  readFileSync("rust-toolchain.toml", "utf8"),
)?.[1];
if (rustVersion !== pinnedRust)
  throw new Error("Select the pinned Rust toolchain before generating notices");
const sysroot = execFileSync("rustc", ["--print", "sysroot"], {
  encoding: "utf8",
}).trim();
const rustNotices = readFileSync(
  join(sysroot, "share/doc/rust/COPYRIGHT-library.html"),
);
const compressedRustNotices = gzipSync(rustNotices);
const standardLibrary = {
  name: "Rust standard library",
  version: rustVersion,
  archive: "RUST_STANDARD_LIBRARY_NOTICES.html.gz",
  sha256: createHash("sha256").update(compressedRustNotices).digest("hex"),
  originalSha256: createHash("sha256").update(rustNotices).digest("hex"),
  source: "Pinned Rust distribution share/doc/rust/COPYRIGHT-library.html",
};
writeFileSync(
  join(legalSources, standardLibrary.archive),
  compressedRustNotices,
);
components.push({
  type: "library",
  name: "rust-std",
  version: rustVersion,
  purl: `pkg:generic/rust-std@${rustVersion}`,
  licenses: [{ expression: "MIT OR Apache-2.0" }],
});
writeFileSync(
  join(legalSources, "manifest.json"),
  JSON.stringify(
    {
      format: 1,
      description:
        "Original locked MPL-2.0 source archives; extract with tar -xzf <name>.crate. Licenses and source notices remain inside each archive.",
      packages: sources.sort((a, b) => a.name.localeCompare(b.name)),
      standardLibrary,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(legalRoot, "THIRD_PARTY_NOTICES.md"),
  [...notices, ...licenseTexts.sections()]
    .join("\n")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, ""),
);
writeFileSync(
  join(legalRoot, "sbom.cdx.json"),
  JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          type: "application",
          name: "agent-workspace",
          version: "0.1.0",
          licenses: [{ expression: "Apache-2.0" }],
        },
      },
      components,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  "artifacts/evidence/license-review.json",
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      components: components.length,
      problems,
      status: problems.length
        ? "BLOCKED"
        : "license inventory and bundled source availability verified",
    },
    null,
    2,
  ) + "\n",
);
if (problems.length) throw new Error(problems.join("\n"));
console.log(
  `Generated ${components.length} dependency entries, notices and SBOM. This is not an advisory/security audit.`,
);
