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
TAG="v${VERSION}"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Refusing to package: worktree has uncommitted tracked changes." >&2
  exit 1
fi

if ! git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Refusing to package: missing tag ${TAG}. Create it with: git tag -a ${TAG} -m \"${TAG}\"" >&2
  exit 1
fi

if [ "$(git rev-parse "${TAG}^{commit}")" != "$(git rev-parse HEAD)" ]; then
  echo "Refusing to package: HEAD is not at ${TAG}. Check out the release commit first." >&2
  exit 1
fi

echo "Building ${PACKAGE_NAME} v${VERSION}..."
npm run build

mkdir -p "${OUTPUT_DIR}"
rm -f "${ARCHIVE_PATH}"

(
  cd "${REPO_ROOT}/dist"
  zip -r "${ARCHIVE_PATH}" .
)

echo "Created release archive: ${ARCHIVE_PATH}"
