#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"

echo "Generating scenario manifest..."
node scripts/generate-manifest.cjs

echo "Building app..."
npm run build

echo "Preparing GitHub Pages payload..."
rm -rf docs
mkdir -p docs
cp -a dist/. docs/
cp -a data docs/data

echo "✔ Build copied to docs/. Commit and push to publish."
