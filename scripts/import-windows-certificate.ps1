$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:GITHUB_REF -ne 'refs/heads/main') { throw 'Signing requires protected main-branch CI' }
if (!$env:AW_WINDOWS_CERTIFICATE -or !$env:AW_WINDOWS_CERTIFICATE_PASSWORD -or $env:AW_EXPECTED_THUMBPRINT -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Missing approved Windows signing inputs' }
$certificatePath = Join-Path $env:RUNNER_TEMP 'agent-workspace-signing.pfx'
$imported = @()
try {
  [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($env:AW_WINDOWS_CERTIFICATE))
  $password = ConvertTo-SecureString $env:AW_WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
  $imported = @(Import-PfxCertificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\My -Password $password)
  $matching = @($imported | Where-Object { $_.HasPrivateKey -and $_.Thumbprint -eq $env:AW_EXPECTED_THUMBPRINT -and $_.NotAfter -gt (Get-Date) -and $_.NotBefore -le (Get-Date) })
  if ($matching.Count -ne 1) { throw 'Imported certificate does not match the approved, valid signing identity' }
  if (!($matching[0].EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' })) { throw 'Certificate does not permit code signing' }
  "AW_WINDOWS_THUMBPRINT=$($matching[0].Thumbprint)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
} catch {
  foreach ($cert in $imported) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force -ErrorAction SilentlyContinue }
  throw 'Windows signing certificate import/validation failed'
} finally {
  Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue
  $password = $null
}
