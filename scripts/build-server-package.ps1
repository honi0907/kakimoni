param(
  [string]$OutputRoot = "release-build",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = [string]$packageJson.version
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$mode = "Bundled"
$workDir = Join-Path $projectRoot $OutputRoot
$packageName = "KakiMoni_Server-$Version-$mode"
$packageDir = Join-Path $workDir $packageName
$zipPath = Join-Path $workDir "$packageName-$stamp.zip"

Write-Host "[1/6] preparing directories..."
if (Test-Path $packageDir) {
  Remove-Item $packageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null

Write-Host "[2/6] copying runtime files..."
$copyItems = @(
  "server.js",
  "package.json",
  "package-lock.json",
  "name.txt",
  "name_base.txt",
  ".hintrc",
  "public",
  "savedata",
  "host",
  "client",
  "scripts"
)
foreach ($item in $copyItems) {
  $src = Join-Path $projectRoot $item
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $packageDir $item) -Recurse -Force
  }
}

Write-Host "[3/6] creating writable data folders..."
$savesDir = Join-Path $packageDir "saves"
New-Item -ItemType Directory -Path $savesDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $savesDir "client_settings") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $savesDir "rayout_data") -Force | Out-Null
for ($i = 1; $i -le 10; $i++) {
  $id = "ID{0:d2}" -f $i
  New-Item -ItemType Directory -Path (Join-Path $savesDir $id) -Force | Out-Null
}
'{"session":1,"counter":0}' | Set-Content -Path (Join-Path $savesDir ".state.json") -Encoding utf8

$updatesDir = Join-Path $packageDir "updates"
foreach ($ch in @("client", "host", "layout")) {
  $targetDir = Join-Path $updatesDir $ch
  New-Item -ItemType Directory -Path (Join-Path $targetDir "files") -Force | Out-Null
  $latestJson = Join-Path $projectRoot "updates\$ch\latest.json"
  if (Test-Path $latestJson) {
    Copy-Item $latestJson (Join-Path $targetDir "latest.json") -Force
  }
}

Write-Host "[4/6] writing README..."
$readme = @"
KakiMoni Server Package ($Version / $mode)

1) Open terminal in this folder.
2) Run: node server.js

Default port: 3000
Main WebUI: http://localhost:3000/host

Notes:
- Production dependencies are already bundled.
- update manifests are bundled; update files are downloaded from GitHub Release URLs.
"@
Set-Content -Path (Join-Path $packageDir "README_Server.txt") -Value $readme -Encoding utf8

Write-Host "[5/6] installing production dependencies into package..."
Push-Location $packageDir
try {
  npm install --omit=dev | Out-Host
} finally {
  Pop-Location
}

Write-Host "[6/6] creating zip..."
if (!(Test-Path $workDir)) {
  New-Item -ItemType Directory -Path $workDir -Force | Out-Null
}
if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}
Compress-Archive -Path "$packageDir\*" -DestinationPath $zipPath -Force

Write-Host "DONE"
Write-Host "PackageDir: $packageDir"
Write-Host "Zip: $zipPath"