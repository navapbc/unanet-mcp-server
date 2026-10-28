#!/usr/bin/env node
// `npm run check-setup`: confirm the connector can sign in to Unanet with the
// configured credentials, and print how to register it with Claude Code and
// Claude Desktop. Never prints the password. Exit code 0 when sign-in works.

import { join } from "node:path";
import { getPlatformBearerToken, isEnabled } from "./auth.js";
import { PACKAGE_ROOT, loadConfig, loadEnvFile, setupAdvice } from "./config.js";

const envFile = loadEnvFile();
const config = loadConfig();
const serverEntry = join(PACKAGE_ROOT, "dist", "index.js");

console.log(`Unanet connector setup check`);
console.log(`  Repository: ${PACKAGE_ROOT}`);
console.log(`  Settings file: ${envFile.path}${envFile.exists ? "" : " (not found)"}`);

if (!config.ok) {
	console.log(`\nNOT READY: ${config.problem}`);
	for (const step of setupAdvice(envFile)) console.log(`  - ${step}`);
	process.exit(1);
}

const { auth } = config;
console.log(`  Unanet address: ${auth.baseUrl}`);
console.log(`  Username: ${auth.username}`);
console.log(
	`  Tools: self-service reads${isEnabled(process.env.UNANET_ENABLE_EXTENDED_READ_TOOLS) ? ", org-level reads" : ""}${isEnabled(process.env.UNANET_ENABLE_WRITE_TOOLS) ? ", writes" : ""}`,
);

try {
	await getPlatformBearerToken(auth);
	console.log(`\nREADY: signed in to ${auth.baseUrl} as ${auth.username}.`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.log(`\nNOT READY: sign-in to ${auth.baseUrl} failed: ${message}`);
	const failure = error as { status?: number; noResponse?: boolean } | null;
	if (failure?.status === 401) {
		console.log(
			"  - Check UNANET_USERNAME and UNANET_PASSWORD in the settings file. A password containing # must be wrapped in single quotes.",
		);
	} else if (failure?.status === 403) {
		console.log("  - Ask Finance about your Unanet account's permission or license for this operation; do not change your credentials to fix a permission denial.");
	} else if (failure?.noResponse) {
		console.log("  - Check your network connection and the Unanet base address, then try again. Do not change your password for a connection failure.");
	} else {
		console.log("  - Follow the error above; try again later or contact Billy Hunt if it persists. Do not change credentials unless Unanet reports an authentication failure.");
	}
	process.exit(1);
}

const windows = process.platform === "win32";
// JSON quoting does not protect shell expansions in an installation path.
const quotedEntry = windows
	? `'${serverEntry.replace(/'/g, "''")}'`
	: `'${serverEntry.replace(/'/g, "'\\''")}'`;
console.log(`\nTo use it from Claude Code (once per machine; run in ${windows ? "PowerShell, not Command Prompt" : "bash or zsh"}):`);
console.log(`  claude mcp add --scope user unanet -- node ${quotedEntry}`);
console.log(`Then start a new Claude Code session and run /mcp: "unanet" should be listed as connected.`);
console.log(`Claude Desktop: ./setup-mac.sh (Mac) or setup-windows.bat (Windows) adds it; then quit and reopen Claude Desktop.`);
