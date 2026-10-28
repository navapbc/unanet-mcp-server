// Configuration loading shared by the MCP server and `npm run check-setup`.
//
// Credentials live in a `.env` file in the repository folder. The server is
// started by an MCP client (Claude Code, Claude Desktop, ...) whose working
// directory is not under our control, so the file is found next to the code,
// not in the current directory. UNANET_ENV_FILE points at a different file.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
	DEFAULT_NAVA_UNANET_BASE_URL,
	DEFAULT_UNANET_APP_NAME,
	type UnanetAuth,
	isEnabled,
	validateAuth,
	validateUnanetBaseUrl,
} from "./auth.js";

/** The repository folder (the parent of `dist/` or `src/`). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface EnvFileStatus {
	/** The file that was read, or would have been. */
	path: string;
	exists: boolean;
}

/**
 * Load the `.env` file into `process.env`. Values already in the environment
 * win, so an MCP client's `env` block or `-e` flags override the file.
 */
export function loadEnvFile(): EnvFileStatus {
	const path = process.env.UNANET_ENV_FILE
		? resolve(process.env.UNANET_ENV_FILE)
		: join(PACKAGE_ROOT, ".env");
	const exists = existsSync(path);
	if (exists) dotenv.config({ path, quiet: true });
	return { path, exists };
}

export type ConfigResult =
	| { ok: true; auth: UnanetAuth }
	| { ok: false; problem: string; baseUrl: string | null };

/** Read and validate the Unanet settings from the environment. */
export function loadConfig(): ConfigResult {
	const allowInsecureLocalMock = isEnabled(process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK);
	const rawBaseUrl = process.env.UNANET_BASE_URL || DEFAULT_NAVA_UNANET_BASE_URL;
	try {
		const auth: UnanetAuth = {
			username: process.env.UNANET_USERNAME || "",
			password: process.env.UNANET_PASSWORD || "",
			baseUrl: validateUnanetBaseUrl(rawBaseUrl, { allowInsecureLocalMock }),
			appName: process.env.UNANET_APP_NAME || DEFAULT_UNANET_APP_NAME,
			customerId: process.env.UNANET_CUSTOMER_ID || undefined,
		};
		validateAuth(auth, { allowInsecureLocalMock });
		return { ok: true, auth };
	} catch (error) {
		return {
			ok: false,
			problem: error instanceof Error ? error.message : String(error),
			baseUrl: rawBaseUrl,
		};
	}
}

/** Plain-language next steps for a configuration problem. Never includes secrets. */
export function setupAdvice(envFile: EnvFileStatus): string[] {
	const where = envFile.exists
		? `Edit ${envFile.path}`
		: `Create ${envFile.path} (copy .env.example in the repository folder, or run ./setup-mac.sh on a Mac)`;
	return [
		`${where} so it sets UNANET_USERNAME, UNANET_PASSWORD and UNANET_BASE_URL. UNANET_BASE_URL is the Unanet address only, for example ${DEFAULT_NAVA_UNANET_BASE_URL} (https, no path such as /platform/rest).`,
		"The user enters the password in that file themselves; never ask for it in chat.",
		"Then run `npm run check-setup` in the repository folder to confirm, and restart the MCP client (Claude Code: start a new session; Claude Desktop: quit and reopen).",
		"Do not open the Unanet website in a browser to work around this: the connector is the supported route and the browser is not.",
	];
}
