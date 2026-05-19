param(
  [string]$OutputRoot = "dist-subserver",
  [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$packageName = "KakiMoni_SubServer-$Version"
$workDir = Join-Path $projectRoot $OutputRoot
$packageDir = Join-Path $workDir $packageName
$zipPath = Join-Path $workDir "$packageName-$stamp.zip"

Write-Host "[1/5] preparing directories..."
if (Test-Path $packageDir) {
  Remove-Item $packageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null

Write-Host "[2/5] copying runtime files..."
Copy-Item (Join-Path $projectRoot "server.js") $packageDir -Force
Copy-Item (Join-Path $projectRoot "package.json") $packageDir -Force
Copy-Item (Join-Path $projectRoot "package-lock.json") $packageDir -Force
Copy-Item (Join-Path $projectRoot "public") (Join-Path $packageDir "public") -Recurse -Force

Write-Host "[3/5] creating writable data folders..."
$savesDir = Join-Path $packageDir "saves"
$updatesDir = Join-Path $packageDir "updates"
New-Item -ItemType Directory -Path $savesDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $savesDir "client_settings") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $savesDir "rayout_data") -Force | Out-Null
for ($i = 1; $i -le 10; $i++) {
  $id = "ID{0:d2}" -f $i
  New-Item -ItemType Directory -Path (Join-Path $savesDir $id) -Force | Out-Null
}
'{"session":1,"counter":0}' | Set-Content -Path (Join-Path $savesDir ".state.json") -Encoding utf8

New-Item -ItemType Directory -Path $updatesDir -Force | Out-Null
foreach ($ch in @("client", "host", "layout")) {
  New-Item -ItemType Directory -Path (Join-Path $updatesDir "$ch\files") -Force | Out-Null
}

Write-Host "[4/5] writing README..."
$readme = @"
KakiMoni SubServer Package ($Version)

This package is for failover operation on a layout PC.

1) Open terminal in this folder.
2) Run: npm install --omit=dev
3) Run: node server.js

Default port: 3000
If you want to change port:
- PowerShell: `$env:KAKIMONI_PORT = "3100"; node server.js

Main WebUI:
- http://localhost:3000/host

Important:
- Keep this package version aligned with the main server version.
- Only use this as standby/failover server.
"@
Set-Content -Path (Join-Path $packageDir "README_SubServer.txt") -Value $readme -Encoding utf8

Write-Host "[5/5] creating zip..."
if (!(Test-Path $workDir)) {
  New-Item -ItemType Directory -Path $workDir -Force | Out-Null
}
Compress-Archive -Path "$packageDir\*" -DestinationPath $zipPath -Force

Write-Host "DONE"
Write-Host "PackageDir: $packageDir"
Write-Host "Zip: $zipPath"
