$ErrorActionPreference = 'Stop'
if ($env:AW_WINDOWS_THUMBPRINT -notmatch '^[0-9A-F]{40}$') { throw 'Approved certificate thumbprint unavailable' }
$files = @(Get-ChildItem -LiteralPath src-tauri/target/release/bundle -Recurse -File | Where-Object { $_.Extension -in '.exe', '.msi' })
$files += Get-Item -LiteralPath src-tauri/target/release/agent-workspace.exe
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $env:AW_WINDOWS_THUMBPRINT -or !$signature.TimeStamperCertificate) { throw "Invalid or untimestamped platform signature: $($file.Name)" }
}
