#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"

echo "Preparing public dataset..."
npm run prepare-public-data

echo "Generating scenario manifest..."
node scripts/generate-manifest.cjs

echo "Building app..."
export GITHUB_PAGES=true
npm run build
unset GITHUB_PAGES

echo "Preparing GitHub Pages payload..."
rm -rf docs
mkdir -p docs
cp -a dist/. docs/
cp -a data_public docs/data_public

echo "✔ Build copied to docs/. Commit and push to publish."
