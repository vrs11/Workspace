import { test } from "node:test";
import assert from "node:assert/strict";
import { assessAudits } from "../scripts/security-audit.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const cleanNpm = {
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  },
};
const cleanRust = {
  vulnerabilities: { found: false, count: 0, list: [] },
  warnings: { unmaintained: [{ advisory: { id: "fixture-warning" } }] },
};
test("clean audits retain maintenance warnings without hiding a vulnerability", () => {
  const result = assessAudits(cleanNpm, cleanRust);
  assert.equal(result.rustVulnerabilities, 0);
  assert.equal(result.warnings.unmaintained[0].advisory.id, "fixture-warning");
});
test("high/critical findings and incomplete or contradictory reports fail closed", () => {
  for (const severity of ["high", "critical"]) {
    const npm = {
      metadata: { vulnerabilities: { ...cleanNpm.metadata.vulnerabilities } },
    };
    npm.metadata.vulnerabilities[severity] = 1;
    assert.throws(() => assessAudits(npm, cleanRust));
  }
  for (const npm of [{}, { metadata: { vulnerabilities: {} } }])
    assert.throws(() => assessAudits(npm, cleanRust));
  for (const vulnerabilities of [
    {},
    { found: true, count: 1, list: [{}] },
    { found: false, count: 0, list: [{}] },
  ])
    assert.throws(() => assessAudits(cleanNpm, { vulnerabilities }));
});
test("bundled MPL source archives match every locked MPL-only crate and its checksum", () => {
  const manifest = JSON.parse(
    readFileSync("artifacts/legal/third-party-sources/manifest.json", "utf8"),
  );
  const sbom = JSON.parse(
    readFileSync("artifacts/legal/sbom.cdx.json", "utf8"),
  );
  const required = sbom.components.filter(
    (c) =>
      c.purl.startsWith("pkg:cargo/") &&
      c.licenses.some((l) => l.expression === "MPL-2.0"),
  );
  assert.equal(manifest.packages.length, required.length);
  assert.ok(required.length);
  const lock = readFileSync("src-tauri/Cargo.lock", "utf8").split(
    "[[package]]",
  );
  for (const entry of required) {
    const source = manifest.packages.find(
      (p) => p.name === entry.name && p.version === entry.version,
    );
    assert.ok(source, entry.purl);
    assert.match(
      source.archive,
      /^[a-zA-Z0-9_-]+-[0-9][a-zA-Z0-9.+_-]*\.crate$/,
    );
    const block = lock.find(
      (b) =>
        b.includes(`\nname = "${entry.name}"\n`) &&
        b.includes(`\nversion = "${entry.version}"\n`),
    );
    const checksum = /^checksum = "([a-f0-9]{64})"$/m.exec(block)?.[1];
    assert.equal(source.sha256, checksum);
    assert.equal(
      createHash("sha256")
        .update(
          readFileSync(`artifacts/legal/third-party-sources/${source.archive}`),
        )
        .digest("hex"),
      checksum,
    );
  }
});

test("the linked standard library includes unchanged, complete upstream notices", () => {
  const manifest = JSON.parse(
    readFileSync("artifacts/legal/third-party-sources/manifest.json", "utf8"),
  );
  const notice = manifest.standardLibrary;
  const version = /^channel = "([^"]+)"$/m.exec(
    readFileSync("rust-toolchain.toml", "utf8"),
  )?.[1];
  assert.equal(notice.version, version);
  assert.equal(notice.archive, "RUST_STANDARD_LIBRARY_NOTICES.html.gz");
  const compressed = readFileSync(
    `artifacts/legal/third-party-sources/${notice.archive}`,
  );
  assert.equal(
    createHash("sha256").update(compressed).digest("hex"),
    notice.sha256,
  );
  const original = gunzipSync(compressed);
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    notice.originalSha256,
  );
  assert.ok(
    original.includes("Copyright notices for The Rust Standard Library"),
  );
  assert.ok(original.includes("Permission is hereby granted"));
  assert.ok(original.includes("TERMS AND CONDITIONS"));
});

test("SBOM identifiers encode scoped packages and remove legacy non-SPDX separators", () => {
  const sbom = JSON.parse(
    readFileSync("artifacts/legal/sbom.cdx.json", "utf8"),
  );
  for (const component of sbom.components) {
    assert.ok(
      component.licenses.every((license) => !license.expression.includes("/")),
      component.name,
    );
    if (component.purl.startsWith("pkg:npm/") && component.name.startsWith("@"))
      assert.ok(component.purl.startsWith("pkg:npm/%40"), component.purl);
    assert.ok(component.purl.includes("@"), component.name);
  }
});
