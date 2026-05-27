#!/usr/bin/env bash
# Build the Next.js frontend and embed it into the micracode Python package.
#
# Usage:
#   ./scripts/build_frontend.sh
#
# Optional env vars:
#   NEXT_PUBLIC_API_BASE_URL  — defaults to "" (same-origin, correct for bundled mode)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/web"
STATIC_DIR="$REPO_ROOT/micracode/src/micracode/static"

export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-}"

echo "▸ Building Next.js frontend (NEXT_PUBLIC_API_BASE_URL='$NEXT_PUBLIC_API_BASE_URL')..."
cd "$WEB_DIR"
bun run build

echo "▸ Embedding static output into Python package..."
rm -rf "$STATIC_DIR"
mkdir -p "$STATIC_DIR"
touch "$STATIC_DIR/.gitkeep"
cp -r "$WEB_DIR/out/." "$STATIC_DIR/"

echo "✓ Done — frontend bundled into micracode/src/micracode/static/"
