#!/usr/bin/env node
// Distil the full Unanet OpenAPI spec (spec/unanet-openapi.json, ~14 MB) into
// two compact, committed JSON files that the generic API tools load lazily:
//
//   spec/api-catalog.json  — one entry per operation: method, path, tag,
//                            summary, params, request/response schema names,
//                            and a read/write/sensitive classification.
//   spec/api-schemas.json  — shallow (one-level) view of every component
//                            schema: property name, type, required, enum.
//
// Re-run after `npm run fetch-spec`:  npm run build-catalog

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(here, "..", "spec", "unanet-openapi.json");
const CATALOG_PATH = join(here, "..", "spec", "api-catalog.json");
const SCHEMAS_PATH = join(here, "..", "spec", "api-schemas.json");

const METHODS = ["get", "post", "put", "patch", "delete"];

// Operations that advance workflows, destroy data, or touch auth. The generic
// write tool refuses these; they need a dedicated, human-in-the-loop tool.
const SENSITIVE_PATH = /\/(submit|approve|disapprove|complete|posts?|void|reverse|cancel|extract|send|email|lock|unlock|close|reopen|open|activate|deactivate|reset|purge|import|reject|retract|restore|defer|return|reconcile|scan|register|login|logout|token|password|pay|payout|payment-portal|exclude|include|users|api-keys?|credentials?)(\/|$)/i;
const SENSITIVE_SUMMARY = /\b(delet|remov|submit|approv|disapprov|void|revers|cancel|extract|send|email|lock|purge|reset|reject|retract|restor|defer|reconcil|password|token|login|\bpost|payout|\bpay\b|payment|dispos|credential|api key|integration user)/i;

// Any write under these resource groups moves money, books to the ledger,
// changes who can approve, or touches auth/config. Even a plain "create" here
// is not something an agent should do through a generic writer.
const SENSITIVE_TAGS = new Set([
	"Approval Groups",
	"Authentication",
	"Bank Reconciliation",
	"Bank accounts",
	"Configuration",
	"Customer Payments",
	"Deposits",
	"Exchange Rates",
	"External Logging",
	"Fixed Assets",
	"Integrations",
	"Invoices",
	"Journal Entries",
	"Mail",
	"Posting Groups",
	"Purchase Orders",
	"Purchase Requisitions",
	"Receiving Documents",
	"Statistical Account Journal Entries",
	"User Device Tokens",
	"Vendor Invoices",
	"Vendor Payments",
]);
const READ_POST_SUMMARY = /^(retriev|search|preview|validat|calculat|check|lookup|view)/i;

const refName = (ref) => (typeof ref === "string" ? ref.split("/").pop() : undefined);

function typeOf(schema) {
	if (!schema) return "unknown";
	if (schema.$ref) return `ref:${refName(schema.$ref)}`;
	if (schema.type === "array") {
		const items = schema.items ?? {};
		return `array<${items.$ref ? refName(items.$ref) : items.type ?? "unknown"}>`;
	}
	if (schema.allOf) return `allOf:${schema.allOf.map((x) => refName(x.$ref) ?? x.type).join("|")}`;
	if (schema.oneOf) return `oneOf:${schema.oneOf.map((x) => refName(x.$ref) ?? x.type).join("|")}`;
	let type = schema.type ?? "object";
	if (schema.format) type += `(${schema.format})`;
	return type;
}

function truncate(text, max) {
	if (!text) return undefined;
	const clean = String(text).replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Reads that can return credentials, tokens, bank or payroll data, or system
// configuration. A generic reader must not hand these to a model; use the
// Unanet UI or a purpose-built tool with its own review.
const SENSITIVE_READ_PATH = /\/(tokens?|device-tokens?|integrations?|payroll|bank-accounts?|api-keys?|credentials?|secrets?|sftp|passwords?)(\/|$)/i;
const SENSITIVE_READ_TAGS = new Set([
	"Authentication",
	"Bank Reconciliation",
	"Bank accounts",
	"Configuration",
	"External Logging",
	"Integrations",
	"Mail",
	"User Device Tokens",
]);

function classify(method, path, summary, tag) {
	if (method === "get") {
		return SENSITIVE_READ_PATH.test(path) || SENSITIVE_READ_TAGS.has(tag)
			? "sensitive"
			: "read";
	}
	if (SENSITIVE_PATH.test(path) || method === "delete") return "sensitive";
	if (method === "post" && READ_POST_SUMMARY.test(summary ?? "")) {
		return SENSITIVE_READ_PATH.test(path) || SENSITIVE_READ_TAGS.has(tag)
			? "sensitive"
			: "read";
	}
	if (SENSITIVE_SUMMARY.test(summary ?? "")) return "sensitive";
	if (SENSITIVE_TAGS.has(tag)) return "sensitive";
	return "write";
}

function jsonSchemaFrom(content) {
	if (!content) return undefined;
	return (
		content["application/json"]?.schema ??
		content["*/*"]?.schema ??
		Object.values(content)[0]?.schema
	);
}

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const componentSchemas = spec.components?.schemas ?? {};

const operations = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
	for (const method of METHODS) {
		const op = item[method];
		if (!op) continue;
		const summary = truncate(op.summary, 160);
		const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((param) => ({
			name: param.name,
			in: param.in,
			required: Boolean(param.required),
			type: typeOf(param.schema),
			enum: param.schema?.enum,
			description: truncate(param.description, 120),
		}));
		const bodySchema = jsonSchemaFrom(op.requestBody?.content);
		const okResponse =
			op.responses?.["200"] ?? op.responses?.["201"] ?? op.responses?.["202"];
		const responseSchema = jsonSchemaFrom(okResponse?.content);
		operations.push({
			id: op.operationId ?? `${method}_${path}`,
			method: method.toUpperCase(),
			path,
			tag: (op.tags ?? ["untagged"])[0],
			summary,
			description:
				op.description && op.description !== op.summary
					? truncate(op.description, 400)
					: undefined,
			kind: classify(method, path, op.summary, (op.tags ?? ["untagged"])[0]),
			params: params.length ? params : undefined,
			body: bodySchema ? typeOf(bodySchema) : undefined,
			bodyRequired: op.requestBody?.required ?? undefined,
			response: responseSchema ? typeOf(responseSchema) : undefined,
			deprecated: op.deprecated || undefined,
		});
	}
}

const schemas = {};
for (const [name, schema] of Object.entries(componentSchemas)) {
	const required = new Set(schema.required ?? []);
	const merged = { ...(schema.properties ?? {}) };
	for (const part of schema.allOf ?? []) Object.assign(merged, part.properties ?? {});
	const properties = Object.entries(merged).map(([propName, prop]) => ({
		name: propName,
		type: typeOf(prop),
		required: required.has(propName) || undefined,
		readOnly: prop.readOnly || undefined,
		enum: prop.enum,
		description: truncate(prop.description, 120),
	}));
	schemas[name] = {
		type: schema.type,
		extends: schema.allOf?.map((x) => refName(x.$ref)).filter(Boolean),
		oneOf: schema.oneOf?.map((x) => refName(x.$ref)).filter(Boolean),
		discriminator: schema.discriminator?.propertyName,
		properties: properties.length ? properties : undefined,
		enum: schema.enum,
		description: truncate(schema.description, 160),
	};
}

const tags = {};
for (const op of operations) tags[op.tag] = (tags[op.tag] ?? 0) + 1;

const catalog = {
	specVersion: spec.info?.version ?? null,
	operationCount: operations.length,
	tags,
	operations,
};

writeFileSync(CATALOG_PATH, JSON.stringify(catalog));
writeFileSync(SCHEMAS_PATH, JSON.stringify(schemas));

const kinds = {};
for (const op of operations) kinds[op.kind] = (kinds[op.kind] ?? 0) + 1;
console.error(
	`[build-api-catalog] ${operations.length} operations (${Object.entries(kinds)
		.map(([k, v]) => `${k}=${v}`)
		.join(", ")}), ${Object.keys(schemas).length} schemas → spec/api-catalog.json, spec/api-schemas.json`,
);
