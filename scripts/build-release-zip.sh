#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

PACKAGE_NAME="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).name")"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"
OUTPUT_DIR="${REPO_ROOT}/release"
ARCHIVE_NAME="${PACKAGE_NAME}-v${VERSION}.zip"
ARCHIVE_PATH="${OUTPUT_DIR}/${ARCHIVE_NAME}"

echo "Building ${PACKAGE_NAME} v${VERSION}..."
npm run build

mkdir -p "${OUTPUT_DIR}"
rm -f "${ARCHIVE_PATH}"

(
  cd "${REPO_ROOT}/dist"
  zip -r "${ARCHIVE_PATH}" .
)

echo "Created release archive: ${ARCHIVE_PATH}"
