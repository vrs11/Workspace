import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseConfig } from "../scripts/release-config.mjs";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/update-signatures.json", import.meta.url)),
);
const base = {
  AW_UPDATER_PUBLIC_KEY: vectors.public_key,
  AW_UPDATER_ENDPOINT:
    "https://updates.example.invalid/{{target}}/{{arch}}/{{current_version}}",
};
test("candidate evidence builds cannot bypass branch/CI or production gates", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workspace-release-gates-"));
  const checklist = join(temporary, "acceptance.md");
  const run = (args, ref = "refs/heads/main", ci = "true") =>
    spawnSync(process.execPath, ["scripts/release-gate.mjs", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: ci,
        GITHUB_REF: ref,
        AW_RELEASE_CHECKLIST: checklist,
      },
    });
  try {
    assert.equal(run(["--candidate"]).status, 0);
    assert.notEqual(run([]).status, 0);
    assert.notEqual(run(["--candidate"], "refs/pull/1/merge").status, 0);
    assert.notEqual(run(["--candidate"], "refs/heads/main", "false").status, 0);
    assert.notEqual(run(["--publish"]).status, 0);
    writeFileSync(checklist, "# Acceptance\n- [ ] Pending gate\n");
    assert.equal(run(["--candidate"]).status, 0);
    assert.notEqual(run([]).status, 0);
    writeFileSync(checklist, "# Acceptance\n- [x] Reviewed gate\n");
    assert.equal(run([]).status, 0);
    writeFileSync(checklist, "Malformed or empty approval");
    assert.notEqual(run([]).status, 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
test("release config requires public HTTPS updater inputs and strict signature/version policy", () => {
  const config = releaseConfig("linux", base);
  assert.equal(config.plugins.updater.requireSignedVersion, true);
  assert.equal(config.plugins.updater.allowDowngrades, false);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  for (const url of [
    "http://example.invalid/update",
    "https://user:password@example.invalid/update",
    "https://example.invalid/update?secret=value",
    "https://example.invalid/update#key",
  ])
    assert.throws(() =>
      releaseConfig("linux", { ...base, AW_UPDATER_ENDPOINT: url }),
    );
  assert.throws(() =>
    releaseConfig("linux", { ...base, AW_UPDATER_PUBLIC_KEY: "" }),
  );
});
test("platform release config refuses absent or ad-hoc identities", () => {
  assert.throws(() => releaseConfig("darwin", base));
  assert.throws(() =>
    releaseConfig("darwin", { ...base, APPLE_SIGNING_IDENTITY: "-" }),
  );
  assert.deepEqual(
    releaseConfig("darwin", {
      ...base,
      APPLE_SIGNING_IDENTITY:
        "Developer ID Application: Fixture (NOT-A-REAL-IDENTITY)",
    }).bundle.targets,
    ["app", "dmg"],
  );
  assert.throws(() => releaseConfig("win32", base));
  const config = releaseConfig("win32", {
    ...base,
    AW_WINDOWS_THUMBPRINT: "A".repeat(40),
    AW_WINDOWS_TIMESTAMP_URL: "https://timestamp.example.invalid",
  });
  assert.equal(config.bundle.windows.digestAlgorithm, "sha256");
  assert.equal(config.bundle.windows.tsp, true);
  assert.throws(() =>
    releaseConfig("win32", {
      ...base,
      AW_WINDOWS_THUMBPRINT: "A".repeat(40),
      AW_WINDOWS_TIMESTAMP_URL: "http://timestamp.example.invalid",
    }),
  );
});

test("Workspace display name retains application identity and upgrades existing data in place", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  assert.equal(config.productName, "Workspace");
  assert.equal(config.app.windows[0].title, "Workspace");
  assert.equal(config.identifier, "org.agentworkspace.desktop");
  const driver = JSON.parse(
    readFileSync("tests/desktop/tauri.test.conf.json", "utf8"),
  );
  assert.equal(driver.productName, "Workspace Test");
  assert.notEqual(driver.identifier, config.identifier);
});
