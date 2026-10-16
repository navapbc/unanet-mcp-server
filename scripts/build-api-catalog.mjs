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
// `node scripts/build-api-catalog.mjs --check` exits 1 when the committed files
// differ from a fresh build (used by the test suite).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./catalog-classify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(here, "..", "spec", "unanet-openapi.json");
const CATALOG_PATH = join(here, "..", "spec", "api-catalog.json");
const SCHEMAS_PATH = join(here, "..", "spec", "api-schemas.json");

const METHODS = ["get", "post", "put", "patch", "delete"];

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

const catalogJson = JSON.stringify(catalog);
const schemasJson = JSON.stringify(schemas);

if (process.argv.includes("--check")) {
	const stale = [];
	if (readFileSync(CATALOG_PATH, "utf8") !== catalogJson) stale.push("spec/api-catalog.json");
	if (readFileSync(SCHEMAS_PATH, "utf8") !== schemasJson) stale.push("spec/api-schemas.json");
	if (stale.length) {
		console.error(`[build-api-catalog] out of date: ${stale.join(", ")}. Run npm run build-catalog.`);
		process.exit(1);
	}
	console.error("[build-api-catalog] committed catalog matches the spec and classifier");
	process.exit(0);
}

writeFileSync(CATALOG_PATH, catalogJson);
writeFileSync(SCHEMAS_PATH, schemasJson);

const kinds = {};
for (const op of operations) kinds[op.kind] = (kinds[op.kind] ?? 0) + 1;
console.error(
	`[build-api-catalog] ${operations.length} operations (${Object.entries(kinds)
		.map(([k, v]) => `${k}=${v}`)
		.join(", ")}), ${Object.keys(schemas).length} schemas → spec/api-catalog.json, spec/api-schemas.json`,
);
