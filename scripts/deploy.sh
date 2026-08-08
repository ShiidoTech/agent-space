#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
EXPECTED_PUBLISHER="ShiidoTech"
EXPECTED_REPOSITORY="https://github.com/ShiidoTech/agent-space.git"

cd "${ROOT_DIR}"

# Loading a local .env remains convenient, but CI and shell-provided
# credentials are supported too.
if [[ -f "${ENV_FILE}" ]]; then
	set -a
	source "${ENV_FILE}"
	set +a
fi

ACTUAL_PUBLISHER="$(node -p "require('./package.json').publisher")"
ACTUAL_REPOSITORY="$(node -p "require('./package.json').repository.url")"

if [[ "${ACTUAL_PUBLISHER}" != "${EXPECTED_PUBLISHER}" ]]; then
	echo "Error: refusing to publish publisher '${ACTUAL_PUBLISHER}'."
	echo "Expected the ShiidoTech fork publisher '${EXPECTED_PUBLISHER}'."
	exit 1
fi

if [[ "${ACTUAL_REPOSITORY}" != "${EXPECTED_REPOSITORY}" ]]; then
	echo "Error: refusing to publish package metadata for '${ACTUAL_REPOSITORY}'."
	echo "Expected '${EXPECTED_REPOSITORY}'."
	exit 1
fi

if [[ "${AGENT_SPACE_ALLOW_MARKETPLACE_PUBLISH:-}" != "1" ]]; then
	echo "Error: Marketplace publishing is intentionally gated."
	echo "Set AGENT_SPACE_ALLOW_MARKETPLACE_PUBLISH=1 only when publishing an intentional ShiidoTech release."
	exit 1
fi

if [[ -z "${VSCE_KEY:-}" ]]; then
	echo "Error: VSCE_KEY is not set (shell environment or ${ENV_FILE})."
	exit 1
fi

bunx @vscode/vsce publish -p "${VSCE_KEY}"
