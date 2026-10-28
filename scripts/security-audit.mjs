import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function assessAudits(npm, rust) {
  const counts = npm?.metadata?.vulnerabilities;
  if (
    !counts ||
    ["info", "low", "moderate", "high", "critical"].some(
      (key) => !Number.isInteger(counts[key]) || counts[key] < 0,
    )
  )
    throw new Error(
      "npm advisory result is incomplete; cannot clear the security gate",
    );
  if (counts.high || counts.critical)
    throw new Error("High/critical npm advisories block the candidate");
  if (
    rust?.vulnerabilities?.found !== false ||
    rust?.vulnerabilities?.count !== 0 ||
    !Array.isArray(rust?.vulnerabilities?.list) ||
    rust.vulnerabilities.list.length
  )
    throw new Error(
      "Rust vulnerabilities or an incomplete audit block the candidate",
    );
  return {
    npm: counts,
    rustVulnerabilities: 0,
    warnings: rust.warnings ?? {},
    localPatches:
      "Registry audit excludes local packages; check:vendor and their focused regressions remain mandatory.",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync("artifacts/security", { recursive: true });
  const results = [];
  for (const [name, executable, args] of [
    [
      "npm",
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["audit", "--json"],
    ],
    [
      "rust",
      "cargo",
      [
        "audit",
        "--file",
        "src-tauri/Cargo.lock",
        "--json",
        ...(process.env.AW_ADVISORY_DB
          ? ["--db", process.env.AW_ADVISORY_DB, "--no-fetch"]
          : []),
      ],
    ],
  ]) {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    writeFileSync(`artifacts/security/${name}.json`, result.stdout ?? "");
    // Nonzero audit results must never be converted into success, even if a
    // failing tool happened to print a plausible partial report.
    if (result.error || result.status !== 0)
      throw new Error(
        `${name} audit did not complete successfully; inspect its local report and rerun after resolving the failure`,
      );
    results.push(JSON.parse(result.stdout));
  }
  const report = {
    timestamp: new Date().toISOString(),
    ...assessAudits(...results),
  };
  writeFileSync(
    "artifacts/security/summary.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
