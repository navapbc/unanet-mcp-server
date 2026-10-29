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

# dotenv has no escape sequences: a quoted value is taken literally up to the
# matching quote, and an unquoted value stops at "#". Pick a quote character
# the value does not contain. Double quotes also expand a literal \n or \r, so
# they are the last resort and refused for values that contain those.
dotenv_quote() {
	local value="$1"
	case "$value" in
	*$'\n'* | *$'\r'*)
		echo "A value with a line break cannot be stored in .env." >&2
		return 1
		;;
	esac
	if [[ "$value" != *"'"* ]]; then
		printf "'%s'" "$value"
	elif [[ "$value" != *'`'* ]]; then
		printf '`%s`' "$value"
	elif [[ "$value" != *'"'* && "$value" != *'\n'* && "$value" != *'\r'* ]]; then
		printf '"%s"' "$value"
	else
		echo "A value containing all of ' \` \" cannot be stored in .env; change the password or edit .env by hand." >&2
		return 1
	fi
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

# Prints why a base URL would be refused, using the server's own check.
# Returns 0 (nothing printed) when the URL is acceptable.
base_url_error() {
	local check='import { validateUnanetBaseUrl } from "./dist/auth.js"; try { validateUnanetBaseUrl(process.env.UNANET_CANDIDATE_URL); } catch (error) { console.log(error.message); process.exit(1); }'
	UNANET_CANDIDATE_URL="$1" node --input-type=module -e "$check" 2>/dev/null
}

configure_claude_code() {
	if ! command -v claude >/dev/null 2>&1; then
		echo "Claude Code (the 'claude' command) is not installed; skipping. To add the connector later run:"
		echo "  claude mcp add --scope user unanet -- $(shell_quote "$(command -v node)") $(shell_quote "$PROJECT_DIR/dist/index.js")"
		return 0
	fi
	if ! ask_yes_no "Add the connector to Claude Code (all your projects)?" "Y"; then
		return 0
	fi
	# Add refuses an existing entry without deleting its command or environment.
	if claude mcp add --scope user unanet -- "$(command -v node)" "$PROJECT_DIR/dist/index.js"; then
		echo "Added 'unanet' to Claude Code. Start a new Claude Code session; /mcp should show it connected."
	else
		echo "Could not add the connector to Claude Code; setup stopped before the sign-in check."
		echo "An existing 'unanet' entry was not removed or replaced; it may already be the one you want."
		echo "To inspect it, run 'claude mcp get unanet' yourself. It displays environment values that may contain passwords; do not share its output in chat."
		echo "If you want to keep that entry, rerun this installer and answer N to adding it to Claude Code."
		echo "Otherwise, see README.md for deliberately replacing a moved installation while preserving your settings."
		echo "Run 'npm run check-setup' separately to check the sign-in."
		return 1
	fi
}

write_env_file() {
	echo
	echo "Let's create your local .env file. It stays on this machine and is git-ignored."
	echo

	local base_url username password enable_reads enable_writes
	while true; do
		read -r -p "Unanet base URL [$DEFAULT_BASE_URL]: " base_url
		base_url="${base_url:-$DEFAULT_BASE_URL}"
		local base_url_problem
		if base_url_problem="$(base_url_error "$base_url")"; then
			break
		fi
		echo "That address will not work: $base_url_problem"
		echo "Press Enter to use $DEFAULT_BASE_URL (the Nava tenant)."
	done

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

	if ask_yes_no "Enable org-level read tools (projects, people, organizations, contracts, invoices)?" "N"; then
		enable_reads="true"
	else
		enable_reads="false"
	fi

	if ask_yes_no "Enable write-capable tools? Only do this if you understand the risk." "N"; then
		enable_writes="true"
	else
		enable_writes="false"
	fi

	local base_url_env username_env password_env
	base_url_env="$(dotenv_quote "$base_url")"
	username_env="$(dotenv_quote "$username")"
	password_env="$(dotenv_quote "$password")"

	umask 077
	cat >"$PROJECT_DIR/.env" <<EOF_ENV
# Unanet Platform REST Configuration
UNANET_BASE_URL=$base_url_env
UNANET_USERNAME=$username_env
UNANET_PASSWORD=$password_env
UNANET_APP_NAME=$DEFAULT_APP_NAME

# Extra tool surfaces. Defaults are safe.
UNANET_ENABLE_EXTENDED_READ_TOOLS=$enable_reads
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

if [[ -d "/Applications/Claude.app" || -d "$(dirname "$CLAUDE_CONFIG")" ]]; then
	configure_claude_desktop
else
	echo "Claude Desktop is not installed; skipping its config."
fi

echo
configure_claude_code

echo
echo "Checking that the connector can sign in to Unanet..."
if node dist/check-setup.js; then
	setup_ok=true
else
	setup_ok=false
fi

echo
if [[ "$setup_ok" == true ]]; then
	echo "Setup complete."
else
	echo "Setup finished, but the sign-in check failed. Follow the guidance above, then run: npm run check-setup"
fi
echo
echo "Next steps:"
echo "1. Claude Code: start a new session. Claude Desktop: fully quit and reopen it."
echo "2. Ask Claude: 'Show my Unanet leave balances.' It should use the unanet tools, never a web browser."
echo "3. If the tools are missing, run 'npm run check-setup' in $PROJECT_DIR and fix what it reports."
echo
