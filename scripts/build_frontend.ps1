# Build the Next.js frontend and embed it into the micracode Python package.
#
# Usage:
#   .\scripts\build_frontend.ps1
#
# Optional env vars:
#   NEXT_PUBLIC_API_BASE_URL  — defaults to "" (same-origin, correct for bundled mode)

$ErrorActionPreference = "Stop"

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$WebDir    = Join-Path $RepoRoot "apps\web"
$StaticDir = Join-Path $RepoRoot "micracode\src\micracode\static"

if (-not $env:NEXT_PUBLIC_API_BASE_URL) { $env:NEXT_PUBLIC_API_BASE_URL = "" }

Write-Host "▸ Building Next.js frontend (NEXT_PUBLIC_API_BASE_URL='$env:NEXT_PUBLIC_API_BASE_URL')..."
Set-Location $WebDir
bun run build

Write-Host "▸ Embedding static output into Python package..."
if (Test-Path $StaticDir) { Remove-Item -LiteralPath $StaticDir -Recurse -Force }
New-Item -ItemType Directory -Path $StaticDir | Out-Null
New-Item -ItemType File -Path (Join-Path $StaticDir ".gitkeep") | Out-Null
Copy-Item -Path (Join-Path $WebDir "out\*") -Destination $StaticDir -Recurse -Force

Write-Host "✓ Done — frontend bundled into micracode/src/micracode/static/"
