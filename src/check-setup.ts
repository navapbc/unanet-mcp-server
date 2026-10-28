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
	console.log(
		"  - Check UNANET_USERNAME, UNANET_PASSWORD and UNANET_BASE_URL in the settings file against what works on the Unanet website. A password containing # must be wrapped in single quotes.",
	);
	process.exit(1);
}

console.log(`\nTo use it from Claude Code (once per machine):`);
console.log(`  claude mcp add --scope user unanet -- node ${JSON.stringify(serverEntry)}`);
console.log(`Then start a new Claude Code session and run /mcp: "unanet" should be listed as connected.`);
console.log(`Claude Desktop: ./setup-mac.sh (Mac) or setup-windows.bat (Windows) adds it; then quit and reopen Claude Desktop.`);
