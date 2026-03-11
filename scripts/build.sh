#!/usr/bin/env bash
# build.sh — build all ContextGit packages in dependency order
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Installing dependencies"
pnpm install

echo "==> Building @contextgit/core"
pnpm --filter @contextgit/core build

echo "==> Building @contextgit/store"
pnpm --filter @contextgit/store build

echo "==> Building @contextgit/mcp"
pnpm --filter @contextgit/mcp build

echo "==> Building @contextgit/cli"
pnpm --filter @contextgit/cli build

echo "==> Building @contextgit/api"
pnpm --filter @contextgit/api build

echo ""
echo "Build complete. Run 'contextgit --help' via:"
echo "  node packages/cli/bin/run.js --help"
