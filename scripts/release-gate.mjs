import { readFileSync } from "node:fs";
const candidate = process.argv.slice(2).join(" ") === "--candidate";
if (process.argv.length > 2 && !candidate)
  throw new Error("Unknown release gate mode");
if (process.env.GITHUB_REF !== "refs/heads/main" || process.env.CI !== "true")
  throw new Error("Release builds require protected main-branch CI");
const checklistPath =
  process.env.AW_RELEASE_CHECKLIST ?? "LOCAL/docs/RELEASE_CHECKLIST.md";
let checklist;
try {
  checklist = readFileSync(checklistPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT" || !candidate)
    throw new Error(
      "Production release requires a reviewed checklist supplied through AW_RELEASE_CHECKLIST",
      { cause: error },
    );
  console.log(
    "Candidate verification only: no local acceptance checklist supplied. This workflow cannot publish.",
  );
  process.exit(0);
}
if (!/^- \[[ x]\] /m.test(checklist))
  throw new Error("Release checklist contains no acceptance gates");
const outstanding = checklist
  .split("\n")
  .filter((line) => line.startsWith("- [ ]"));
if (outstanding.length && !candidate)
  throw new Error(
    `Release blocked by ${outstanding.length} unchecked gates:\n${outstanding.join("\n")}`,
  );
console.log(
  candidate
    ? `Candidate verification only: ${outstanding.length} production gates remain. This workflow cannot publish.`
    : "Checklist gate cleared; native signing jobs still require approved environment inputs.",
);
