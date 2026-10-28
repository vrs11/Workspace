import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function verifyPackageResources(directory) {
  const manifest = JSON.parse(
    readFileSync("artifacts/legal/third-party-sources/manifest.json", "utf8"),
  );
  const resources = [
    ["LICENSE.txt", "LICENSE"],
    ["THIRD_PARTY_NOTICES.md", "artifacts/legal/THIRD_PARTY_NOTICES.md"],
    ["sbom.cdx.json", "artifacts/legal/sbom.cdx.json"],
    [
      "third-party-sources/manifest.json",
      "artifacts/legal/third-party-sources/manifest.json",
    ],
    ...[...manifest.packages, manifest.standardLibrary].map((item) => [
      `third-party-sources/${item.archive}`,
      `artifacts/legal/third-party-sources/${item.archive}`,
    ]),
  ];
  for (const [packaged, source] of resources) {
    const hash = (path) =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    if (hash(join(directory, packaged)) !== hash(source))
      throw new Error(
        `Packaged resource does not match the reviewed source: ${packaged}`,
      );
  }
  return {
    resources: resources.length,
    mplSourceArchives: manifest.packages.length,
    standardLibraryNotices: manifest.standardLibrary.version,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2])
    throw new Error("Provide the packaged application resource directory");
  console.log(JSON.stringify(verifyPackageResources(process.argv[2]), null, 2));
}
