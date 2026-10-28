// Ordinary cross-platform CLI fixture. No application protocol or integration.
import { writeFileSync, appendFileSync } from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
const [path, encoded, mode] = process.argv.slice(2);
if (!path || /[\\/]/.test(path))
  throw new Error("Fixture requires a local file name");
const text = Buffer.from(encoded, "base64").toString("utf8");
(mode === "append" ? appendFileSync : writeFileSync)(path, text);
process.stdout.write(text);
