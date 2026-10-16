// Shared helpers for Platform REST tool handlers.
//
// The Unanet Platform REST API is consistent about a few things: paged
// responses expose `items` / `page` / `pageCount` / `resultCount`, and
// creation endpoints return `{ key }`. Everything here exists so individual
// tool files do not re-implement the same unwrapping.

import { z } from "zod";

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function itemsFromResponse<T = any>(data: any): T[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.message?.items)) return data.message.items;
	if (Array.isArray(data?.content)) return data.content;
	return [];
}

export function pageInfo(data: any): {
	page: number | null;
	pageSize: number | null;
	pageCount: number | null;
	resultCount: number | null;
} {
	const source = data?.message ?? data ?? {};
	return {
		page: toNumberOrNull(source.page),
		pageSize: toNumberOrNull(source.pageSize),
		pageCount: toNumberOrNull(source.pageCount),
		resultCount: toNumberOrNull(source.resultCount),
	};
}

export function toNumberOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const numeric = typeof value === "number" ? value : Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

export function numericKey(value: unknown): number | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	const numeric = Number(value);
	return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

// Drop undefined (and optionally null) values so we never send `key: null`
// to endpoints that treat null as "clear this field".
export function compact<T extends Record<string, unknown>>(
	value: T,
	options: { dropNull?: boolean } = {},
): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(
			([, entry]) =>
				entry !== undefined && (!options.dropNull || entry !== null),
		),
	) as Partial<T>;
}

export function formatLocalDate(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function isValidIsoDate(value: string): boolean {
	if (!ISO_DATE_PATTERN.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.toISOString().split("T")[0] === value
	);
}

export const isoDateSchema = z
	.string()
	.refine(isValidIsoDate, "Date must be a valid YYYY-MM-DD date");

export const pageSchema = z.number().int().min(1).optional().default(1);
export const pageSizeSchema = (defaultSize = 50, max = 500) =>
	z.number().int().min(1).max(max).optional().default(defaultSize);

// Every live write requires an explicit `confirm: true` from the caller. This
// is enforced by the schema (z.literal(true)) AND re-checked at runtime so a
// handler invoked outside the MCP validation path stays safe.
export const confirmSchema = (what: string) =>
	z.literal(true).describe(`Must be true to confirm this live ${what}.`);

export function requireConfirm(args: any, what: string): string | null {
	return args?.confirm === true ? null : `confirm=true is required before ${what}.`;
}

export function keyName(value: any): { key: number | null; name: string | null } {
	if (value === null || value === undefined) return { key: null, name: null };
	if (typeof value !== "object") {
		return { key: toNumberOrNull(value), name: null };
	}
	return {
		key: toNumberOrNull(value.key ?? value.id),
		name:
			value.name ??
			value.title ??
			value.description ??
			value.code ??
			(value.firstName || value.lastName
				? [value.firstName, value.lastName].filter(Boolean).join(" ")
				: null) ??
			null,
	};
}

export function errorResult(error: unknown, extra: Record<string, unknown> = {}) {
	const message = error instanceof Error ? error.message : String(error);
	return { success: false, error: message, ...extra };
}

export function createdKey(data: any): number | null {
	return toNumberOrNull(data?.key ?? data?.id ?? data?.message?.key);
}
