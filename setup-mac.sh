#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
DEFAULT_BASE_URL="https://navapbc.unanet.biz"
DEFAULT_APP_NAME="NavaUnanetMCP"

shell_quote() {
	local value="$1"
	printf "'%s'" "${value//\'/\'\\\'\'}"
}

ask_yes_no() {
	local prompt="$1"
	local default="${2:-N}"
	local answer
	read -r -p "$prompt [$default]: " answer || true
	answer="${answer:-$default}"
	case "$answer" in
	[Yy] | [Yy][Ee][Ss]) return 0 ;;
	*) return 1 ;;
	esac
}

major_version() {
	local raw="$1"
	raw="${raw#v}"
	printf '%s' "${raw%%.*}"
}

write_env_file() {
	echo
	echo "Let's create your local .env file. It stays on this machine and is git-ignored."
	echo

	local base_url username password enable_reads enable_writes
	read -r -p "Unanet base URL [$DEFAULT_BASE_URL]: " base_url
	base_url="${base_url:-$DEFAULT_BASE_URL}"

	read -r -p "Unanet username: " username
	while [[ -z "$username" ]]; do
		read -r -p "Unanet username is required: " username
	done

	read -r -s -p "Unanet password: " password
	echo
	while [[ -z "$password" ]]; do
		read -r -s -p "Unanet password is required: " password
		echo
	done

	if ask_yes_no "Enable extra read tools like projects and timesheets?" "Y"; then
		enable_reads="true"
	else
		enable_reads="false"
	fi

	if ask_yes_no "Enable write-capable tools? Only do this if you understand the risk." "N"; then
		enable_writes="true"
	else
		enable_writes="false"
	fi

	umask 077
	cat >"$PROJECT_DIR/.env" <<EOF_ENV
# Unanet Platform REST Configuration
UNANET_BASE_URL=$base_url
UNANET_USERNAME=$username
UNANET_PASSWORD=$password
UNANET_APP_NAME=$DEFAULT_APP_NAME

# Extra tool surfaces. Defaults are safe.
UNANET_ENABLE_LEGACY_READ_TOOLS=$enable_reads
UNANET_ENABLE_WRITE_TOOLS=$enable_writes

# Local mock testing only. Never enable for production URLs.
UNANET_ALLOW_INSECURE_LOCAL_MOCK=false

LOG_LEVEL=info
EOF_ENV
	chmod 600 "$PROJECT_DIR/.env"
	echo "Created $PROJECT_DIR/.env"
}

configure_claude_desktop() {
	local config_dir command_line
	config_dir="$(dirname "$CLAUDE_CONFIG")"
	mkdir -p "$config_dir"

	if [[ -f "$CLAUDE_CONFIG" ]]; then
		cp "$CLAUDE_CONFIG" "$CLAUDE_CONFIG.bak.$(date +%Y%m%d%H%M%S)"
	else
		printf '{\n  "mcpServers": {}\n}\n' >"$CLAUDE_CONFIG"
	fi

	command_line="cd $(shell_quote "$PROJECT_DIR") && node dist/index.js"

	CLAUDE_CONFIG="$CLAUDE_CONFIG" UNANET_MCP_COMMAND_LINE="$command_line" node <<'NODE'
const fs = require('fs');
const configPath = process.env.CLAUDE_CONFIG;
const commandLine = process.env.UNANET_MCP_COMMAND_LINE;
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  throw new Error(`Claude Desktop config is not valid JSON: ${error.message}`);
}
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  config = {};
}
if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
  config.mcpServers = {};
}
config.mcpServers.unanet = {
  command: '/bin/bash',
  args: ['-lc', commandLine]
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
NODE

	echo "Updated Claude Desktop config: $CLAUDE_CONFIG"
}

echo "============================================"
echo "  Unanet MCP Server Setup for macOS"
echo "============================================"
echo

echo "Project: $PROJECT_DIR"
echo

if ! command -v node >/dev/null 2>&1; then
	echo "ERROR: Node.js is not installed."
	echo "Install Node.js 20 LTS or newer from https://nodejs.org/ and run this script again."
	exit 1
fi

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(major_version "$NODE_VERSION")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
	echo "ERROR: Node.js $NODE_VERSION found, but this project requires Node.js 20 or newer."
	echo "Install the current LTS from https://nodejs.org/ and run this script again."
	exit 1
fi

echo "Node.js: $NODE_VERSION"
echo "npm: $(npm --version)"
echo

echo "Installing dependencies..."
cd "$PROJECT_DIR"
npm install

echo
echo "Building the server..."
npm run build

if [[ -f "$PROJECT_DIR/.env" ]]; then
	echo
	echo ".env already exists; leaving it unchanged."
	if ask_yes_no "Open .env for review now?" "N"; then
		open -a TextEdit "$PROJECT_DIR/.env" || true
	fi
else
	write_env_file
fi

configure_claude_desktop

echo
echo "Setup complete."
echo
echo "Next steps:"
echo "1. Fully quit and reopen Claude Desktop."
echo "2. Ask Claude: 'Show my Unanet leave balances.'"
echo "3. If Claude does not see the unanet server, check Claude Desktop's MCP logs."
echo
