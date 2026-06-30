#!/usr/bin/env node
// Monthly Unanet OpenAPI spec drift check.
// Compares the committed repo spec against the live spec and appends a
// human-readable result to today's Second Brain daily log.
// Report-only: it never auto-commits/pushes. Billy decides whether to refresh.

import { createHash } from "node:crypto";
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SPEC_URL = "https://dev.portal.unanet.io/platform/rest/openapi.json";
const REPO = join(homedir(), "dev", "unanet-mcp-server");
const COMMITTED = join(REPO, "spec", "unanet-openapi.json");
const DAILY_DIR = join(
	homedir(),
	"Library",
	"Mobile Documents",
	"iCloud~md~obsidian",
	"Documents",
	"Second Brain",
	"daily-log",
);

const METHODS = ["get", "post", "put", "delete", "patch"];

function log(msg) {
	console.error(`[unanet-spec-drift] ${msg}`);
}

// The live spec endpoint serializes JSON non-deterministically (key ordering /
// whitespace vary between requests) and embeds randomly-generated `example` /
// `examples` values that churn every generation. Hash a canonical,
// recursively key-sorted form with those illustrative nodes stripped, so only
// meaningful contract changes (paths, params, schemas, required flags)
// register as drift.
const VOLATILE_KEYS = new Set(["example", "examples"]);

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			if (VOLATILE_KEYS.has(key)) continue;
			out[key] = canonicalize(value[key]);
		}
		return out;
	}
	return value;
}

function canonicalHash(spec) {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(spec)))
		.digest("hex");
}

function specStats(spec) {
	const paths = spec.paths || {};
	const ops = new Set();
	for (const [p, methods] of Object.entries(paths)) {
		for (const m of Object.keys(methods)) {
			if (METHODS.includes(m)) ops.add(`${m.toUpperCase()} ${p}`);
		}
	}
	return {
		version: spec.info?.version ?? "unknown",
		pathCount: Object.keys(paths).length,
		opCount: ops.size,
		schemaCount: Object.keys(spec.components?.schemas ?? {}).length,
		ops,
	};
}

function pad(n) {
	return String(n).padStart(2, "0");
}

function dateParts(d = new Date()) {
	return {
		ymd: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
		weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
	};
}

function ensureDailyLog(ymd, weekday) {
	const file = join(DAILY_DIR, `${ymd}.md`);
	if (!existsSync(file)) {
		const skeleton = `---\ntags: [daily-log]\ncreated: ${ymd}\nupdated: ${ymd}\n---\n# ${ymd} (${weekday})\n\n## Work Log\n\n| Time | Task | Notes |\n|------|------|-------|\n\n## Activity by Project\n\n## GitHub Activity\n\n## Decisions / Notes\n`;
		writeFileSync(file, skeleton);
	}
	return file;
}

function appendToDailyLog(entry) {
	const { ymd, hm, weekday } = dateParts();
	const file = ensureDailyLog(ymd, weekday);
	let body = readFileSync(file, "utf8");
	const header = "## GitHub Activity";
	const block = `\n### ${hm} Unanet API spec drift check\n\n${entry}\n`;
	if (body.includes(header)) {
		// Insert the block right after the GitHub Activity header.
		body = body.replace(header, `${header}\n${block}`);
	} else {
		body += `\n${header}\n${block}`;
	}
	writeFileSync(file, body);
	return file;
}

async function main() {
	if (!existsSync(COMMITTED)) {
		log(`committed spec missing at ${COMMITTED}; abort`);
		process.exit(1);
	}

	const committedRaw = readFileSync(COMMITTED, "utf8");
	const committedSpec = JSON.parse(committedRaw);
	const committed = specStats(committedSpec);
	const committedHash = canonicalHash(committedSpec);

	let liveRaw;
	try {
		const res = await fetch(SPEC_URL, { signal: AbortSignal.timeout(60000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		liveRaw = await res.text();
	} catch (err) {
		const entry = `⚠️ Could not fetch live spec from ${SPEC_URL}: ${err.message}. Committed spec unchanged (\`${committed.version}\`). Will retry next month.`;
		const file = appendToDailyLog(entry);
		log(`fetch failed: ${err.message}; logged to ${file}`);
		process.exit(0);
	}

	let live;
	let liveHash;
	try {
		const liveSpec = JSON.parse(liveRaw);
		live = specStats(liveSpec);
		liveHash = canonicalHash(liveSpec);
	} catch (err) {
		const entry = `⚠️ Live spec fetched but failed to parse as JSON: ${err.message}. Committed spec unchanged (\`${committed.version}\`).`;
		appendToDailyLog(entry);
		log("live spec parse failed");
		process.exit(0);
	}

	if (liveHash === committedHash) {
		const entry = `✅ Up to date. Committed spec matches live (\`${committed.version}\`, ${committed.opCount} operations). No action needed.`;
		const file = appendToDailyLog(entry);
		log(`no drift; logged to ${file}`);
		return;
	}

	// Drift detected — summarize what changed.
	const added = [...live.ops].filter((o) => !committed.ops.has(o)).sort();
	const removed = [...committed.ops].filter((o) => !live.ops.has(o)).sort();
	const cap = (arr) =>
		arr.slice(0, 25).map((o) => `    - \`${o}\``).join("\n") +
		(arr.length > 25 ? `\n    - …and ${arr.length - 25} more` : "");

	const lines = [];
	lines.push("🔔 **Drift detected — committed spec is out of date.**");
	lines.push("");
	lines.push(
		`- Version: committed \`${committed.version}\` → live \`${live.version}\``,
	);
	lines.push(
		`- Operations: ${committed.opCount} → ${live.opCount} (${live.opCount - committed.opCount >= 0 ? "+" : ""}${live.opCount - committed.opCount})`,
	);
	lines.push(
		`- Schemas: ${committed.schemaCount} → ${live.schemaCount}; Paths: ${committed.pathCount} → ${live.pathCount}`,
	);
	if (added.length) {
		lines.push(`- Added operations (${added.length}):`);
		lines.push(cap(added));
	}
	if (removed.length) {
		lines.push(`- Removed operations (${removed.length}):`);
		lines.push(cap(removed));
	}
	if (!added.length && !removed.length) {
		lines.push(
			"- No operations added or removed — the change is field-level (parameters, schema bodies, descriptions, or required flags within existing endpoints). Diff the spec to see specifics.",
		);
	}
	lines.push("");
	lines.push(
		"- To refresh: `cd ~/dev/unanet-mcp-server && npm run fetch-spec && git add spec/unanet-openapi.json && git commit -m \"chore: refresh Unanet OpenAPI spec\" && git push` (push is manual by policy).",
	);
	lines.push(
		"- Then review [[mcp-coverage]] for any new self-service endpoints worth exposing.",
	);

	const file = appendToDailyLog(lines.join("\n"));
	log(`drift detected; logged to ${file}`);
}

main().catch((err) => {
	log(`fatal: ${err.message}`);
	try {
		appendToDailyLog(`⚠️ Drift check crashed: ${err.message}`);
	} catch {}
	process.exit(1);
});
