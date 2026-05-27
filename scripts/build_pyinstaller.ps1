# Build the micracode-api PyInstaller binary (Windows PowerShell version).
# Output: dist\micracode-api.exe
# After building, copies the binary to apps\desktop\resources\backend\

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "==> Installing PyInstaller into the uv environment..."
uv add --dev pyinstaller

Write-Host "==> Running PyInstaller..."
uv run pyinstaller `
  --name micracode-api `
  --onefile `
  --hidden-import=micracode_core `
  --hidden-import=micracode_core.orchestrator `
  --hidden-import=micracode_core.tools `
  --hidden-import=micracode_core.storage `
  --hidden-import=micracode_core.llm `
  --hidden-import=micracode_core.config `
  --collect-all micracode `
  --collect-all micracode_core `
  --noconfirm `
  micracode/src/micracode/cli.py

Write-Host "==> Copying binary to apps\desktop\resources\backend\..."
New-Item -ItemType Directory -Force -Path "apps\desktop\resources\backend" | Out-Null
Copy-Item "dist\micracode-api.exe" "apps\desktop\resources\backend\micracode-api.exe" -Force

Write-Host "==> Done."
