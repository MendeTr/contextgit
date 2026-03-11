#!/usr/bin/env bash
# build.sh — build all ContextHub packages in dependency order
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Installing dependencies"
pnpm install

echo "==> Building @contexthub/core"
pnpm --filter @contexthub/core build

echo "==> Building @contexthub/store"
pnpm --filter @contexthub/store build

echo "==> Building @contexthub/mcp"
pnpm --filter @contexthub/mcp build

echo "==> Building @contexthub/cli"
pnpm --filter @contexthub/cli build

echo "==> Building @contexthub/api"
pnpm --filter @contexthub/api build

echo ""
echo "Build complete. Run 'contexthub --help' via:"
echo "  node packages/cli/bin/run.js --help"
