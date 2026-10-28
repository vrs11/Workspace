import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, verifyVendor } from "./vendor.mjs";

const packages = await verifyVendor();
const evidence = join(repositoryRoot, "artifacts/evidence");
mkdirSync(evidence, { recursive: true });
writeFileSync(
  join(evidence, "vendor-validation.json"),
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      result: "PASS",
      method:
        "Every local byte and declared delta verified against checksum-pinned upstream archives; no downloaded code execution",
      packages,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Verified ${packages.length} local dependency patches against pinned upstream sources.`,
);
