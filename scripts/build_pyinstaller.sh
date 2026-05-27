#!/usr/bin/env bash
# Build the micracode-api PyInstaller binary from the monorepo root.
# Output: dist/micracode-api (Linux/Mac) or dist/micracode-api.exe (Windows)
# After building, copies the binary to apps/desktop/resources/backend/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Installing PyInstaller into the uv environment..."
uv add --dev pyinstaller

echo "==> Running PyInstaller..."
uv run pyinstaller \
  --name micracode-api \
  --onefile \
  --hidden-import=micracode_core \
  --hidden-import=micracode_core.orchestrator \
  --hidden-import=micracode_core.tools \
  --hidden-import=micracode_core.storage \
  --hidden-import=micracode_core.llm \
  --hidden-import=micracode_core.config \
  --collect-all micracode \
  --collect-all micracode_core \
  --noconfirm \
  micracode/src/micracode/cli.py

echo "==> Copying binary to apps/desktop/resources/backend/..."
mkdir -p apps/desktop/resources/backend

if [[ "$OSTYPE" == "msys"* ]] || [[ "$OSTYPE" == "cygwin"* ]] || [[ -f "dist/micracode-api.exe" ]]; then
  cp dist/micracode-api.exe apps/desktop/resources/backend/micracode-api.exe
else
  cp dist/micracode-api apps/desktop/resources/backend/micracode-api
  chmod +x apps/desktop/resources/backend/micracode-api
fi

echo "==> Done."
