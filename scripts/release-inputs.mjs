const required = ["TAURI_SIGNING_PRIVATE_KEY"];
if (process.platform === "darwin")
  required.push(
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  );
if (process.platform === "win32") required.push("AW_WINDOWS_THUMBPRINT");
if (process.env.CI !== "true" || process.env.GITHUB_REF !== "refs/heads/main")
  throw new Error("Signing requires protected main-branch CI");
const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length)
  throw new Error(`Missing protected signing inputs: ${missing.join(", ")}`);
console.log("Required signing inputs are present. No values are logged.");
