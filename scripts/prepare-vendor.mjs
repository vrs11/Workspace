import { prepareVendor } from "./vendor.mjs";

try {
  if (await prepareVendor())
    console.error("Prepared checksum-verified local dependency patches.");
} catch (error) {
  console.error(
    `Cannot prepare vendor: ${error.message}\nExisting files were preserved. Review local changes before moving/removing vendor and retrying pnpm prepare:vendor.`,
  );
  process.exitCode = 1;
}
