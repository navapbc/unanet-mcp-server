// Project staffing write: assign people to a Unanet project. This is an
// org-level change (Unanet requires the resource assigner, administrator or
// PR administrator role to create assignments), unlike the /me/ self-service writes, so it
// lives in its own file with its own guards: a person cap, a duplicate check
// at preflight, silent by default, validated Unanet defaults, and a dry run.

import { z } from "zod";
import { type UnanetAuth, type UnanetClient, createUnanetClient, isOutcomeUnknown } from "../auth.js";
import {
	compact,
	confirmSchema,
	createdKey,
	errorResult,
	formatLocalDate,
	isoDateSchema,
	requireConfirm,
} from "../utils/http.js";

const MAX_PEOPLE = 50;
// People search is paged. Uniqueness of an email is decided over every page,
// up to this bound; beyond it the email is refused rather than guessed.
const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 5;
// With no dates the duplicate check looks at every period Unanet allows
// (1900 to 2099), because the project or task dates the create would use are
// not known here: an existing assignment in any period then counts.
const LOOKUP_START = "1900-01-01";
const LOOKUP_END = "2099-12-31";
const RATE_SOURCES = new Set(["PERSON", "LABOR_CATEGORY", "OVERRIDE"]);

type PersonResult = {
	personKey: number | null;
	email?: string;
	status:
		| "assigned"
		| "wouldAssign"
		| "alreadyAssigned"
		| "notFound"
		| "ambiguous"
		| "failed"
		| "unknown"
		| "notAttempted";
	assignmentKey?: number | null;
	candidates?: number[];
	error?: string;
};

// The rows of a list response, or null when the body is not a recognised list
// envelope. A write must not read "unrecognised" as "nothing there".
function listFrom(data: any): any[] | null {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.message?.items)) return data.message.items;
	return null;
}

function pageCountOf(data: any): number | null {
	const count = data?.pageCount ?? data?.message?.pageCount;
	return typeof count === "number" ? count : null;
}

// Every active person whose email equals `email` (case-insensitive), read from
// all result pages. `complete` is false when the page bound was reached first.
async function findPeopleByEmail(client: UnanetClient, email: string) {
	const matches = new Map<number, any>();
	for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
		const response = await client.post(
			"/people/search",
			{ email, active: true },
			{ params: { page, pageSize: SEARCH_PAGE_SIZE } },
		);
		const rows = listFrom(response.data);
		if (rows === null) throw new Error("Unexpected response shape from the people search; nothing was assigned.");
		for (const person of rows) {
			if (String(person?.email ?? "").trim().toLowerCase() === email.toLowerCase() && person?.active !== false) {
				matches.set(person.key, person);
			}
		}
		const pageCount = pageCountOf(response.data);
		const last = pageCount !== null ? page >= pageCount : rows.length < SEARCH_PAGE_SIZE;
		if (last) return { matches: [...matches.values()], complete: true };
	}
	return { matches: [...matches.values()], complete: false };
}

export const assignPeopleToProjectTool = {
	name: "unanet_assign_people_to_project",
	description:
		"Assign people to a Unanet project (optionally a task), for example to add everyone in a channel to its bid code. Identify people by Unanet person key or by work email (exactly one active match is required; looking people up by email needs a Unanet role that can search people, otherwise pass personKeys). Skips people who already have an assignment overlapping the period, found at preflight; this is a check before creating, not a lock. With no dates, a person with an assignment in any period is skipped (pass beginDate and endDate to add someone for a new period). Uses each person's Unanet defaults for rates, labor category and organizations (and refuses a person whose defaults cannot be read), sends no assignment notifications unless notify=true, and handles at most 50 people per call. dryRun=true previews who would be assigned without changing anything; it does not reserve anything or prove the create will be allowed. This changes project staffing in Unanet: Unanet requires the resource assigner, administrator or PR administrator role (and the resource assignment license for the defaults lookup) and decides whether you have it. Requires confirm: true.",
	inputSchema: z
		.object({
			confirm: confirmSchema("project assignment"),
			projectId: z.number().int().positive().describe("Unanet project key (the bid code's project)."),
			personKeys: z.array(z.number().int().positive()).max(MAX_PEOPLE).optional(),
			emails: z.array(z.string().email().max(50)).max(MAX_PEOPLE).optional(),
			taskKey: z.number().int().positive().optional().describe("Assign to this task instead of the whole project."),
			beginDate: isoDateSchema.optional().describe("Assignment start. With neither date the project/task dates apply. Unanet's behavior with only one date is not verified."),
			endDate: isoDateSchema.optional().describe("Assignment end."),
			notify: z
				.boolean()
				.optional()
				.default(false)
				.describe("Send Unanet's assignment notifications (person, manager, lead, planner, assigner, requestor). Off by default."),
			dryRun: z.boolean().optional().default(false).describe("Report what would be assigned; change nothing."),
		})
		.superRefine((value, context) => {
			const total = (value.personKeys?.length ?? 0) + (value.emails?.length ?? 0);
			if (total === 0) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["personKeys"], message: "Provide personKeys or emails." });
			}
			if (total > MAX_PEOPLE) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["personKeys"], message: `At most ${MAX_PEOPLE} people per call.` });
			}
			if (value.beginDate && value.endDate && value.endDate < value.beginDate) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "endDate must not be before beginDate." });
			}
		}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "assigning people to a project");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const results: PersonResult[] = [];
			const toAssign: Array<{ personKey: number; email?: string }> = [];
			const seen = new Set<number>();

			// 1. Resolve every requested person before changing anything.
			for (const personKey of args.personKeys ?? []) {
				if (seen.has(personKey)) continue;
				seen.add(personKey);
				toAssign.push({ personKey });
			}
			for (const email of args.emails ?? []) {
				const { matches, complete } = await findPeopleByEmail(client, email);
				if (matches.length > 1) {
					results.push({ personKey: null, email, status: "ambiguous", candidates: matches.map((person) => person.key), error: "More than one active person has this email; use personKeys." });
				} else if (!complete) {
					results.push({ personKey: null, email, status: "failed", error: `Too many search results to decide this email (more than ${MAX_SEARCH_PAGES * SEARCH_PAGE_SIZE}); use personKeys.` });
				} else if (matches.length === 0) {
					results.push({ personKey: null, email, status: "notFound", error: "No active Unanet person has this email." });
				} else if (!seen.has(matches[0].key)) {
					seen.add(matches[0].key);
					toAssign.push({ personKey: matches[0].key, email });
				}
			}

			// 2. Assign one at a time. An unclear outcome, a permission or login
			// error, or rate limiting stops the batch so the problem is not
			// repeated for everyone.
			const today = formatLocalDate();
			const defaultsDate = args.beginDate ?? today;
			const rangeStart = args.beginDate ?? LOOKUP_START;
			const rangeEnd = args.endDate ?? LOOKUP_END;
			let halted = false;
			for (const { personKey, email } of toAssign) {
				if (halted) {
					results.push({ personKey, email, status: "notAttempted" });
					continue;
				}
				// Only the create request can leave an unknown outcome; failed lookups
				// changed nothing.
				let creating = false;
				try {
					const existing = await client.post(
						`/projects/${args.projectId}/people-assignments/search`,
						compact({
							personKeys: [personKey],
							taskKeys: args.taskKey ? [args.taskKey] : undefined,
							dateRange: { rangeStart, rangeEnd },
						}),
						{ params: { page: 1, pageSize: 1 } },
					);
					const found = listFrom(existing.data);
					if (found === null) {
						results.push({ personKey, email, status: "failed", error: "Unexpected response shape from the assignment lookup; nothing was assigned for this person." });
						continue;
					}
					if (found.length > 0) {
						results.push({ personKey, email, status: "alreadyAssigned" });
						continue;
					}
					if (args.dryRun) {
						results.push({ personKey, email, status: "wouldAssign" });
						continue;
					}
					const raw = (
						await client.get(`/assigning/defaults/project/${args.projectId}/person/${personKey}/${defaultsDate}`)
					).data;
					const defaults = raw?.message && typeof raw.message === "object" ? raw.message : raw;
					const personOrg = defaults?.personOrg?.key;
					const projectOrg = defaults?.projectOrg?.key;
					if (
						!RATE_SOURCES.has(defaults?.billRateSource) ||
						!RATE_SOURCES.has(defaults?.costRateSource) ||
						!Number.isInteger(personOrg) ||
						!Number.isInteger(projectOrg)
					) {
						results.push({ personKey, email, status: "failed", error: "Unanet returned no usable assignment defaults for this person; nothing was assigned." });
						continue;
					}
					const notify = args.notify === true;
					creating = true;
					const created = await client.post(
						`/projects/${args.projectId}/people-assignments`,
						compact({
							projectKey: args.projectId,
							personKey,
							taskKey: args.taskKey,
							beginDate: args.beginDate,
							endDate: args.endDate,
							useWbsDates: args.beginDate || args.endDate ? undefined : true,
							billRateSource: defaults.billRateSource,
							costRateSource: defaults.costRateSource,
							personOrganizationKey: personOrg,
							projectOrganizationKey: projectOrg,
							laborCategoryKey: defaults?.laborCategory?.key,
							assignmentNotification: {
								notifyUser: notify,
								notifyPM: notify,
								notifyPL: notify,
								notifyPlanner: notify,
								notifyAssigner: notify,
								notifyRequestor: notify,
							},
						}),
					);
					results.push({ personKey, email, status: "assigned", assignmentKey: createdKey(created.data) });
				} catch (error: any) {
					const unknown = creating && isOutcomeUnknown(error);
					results.push({
						personKey,
						email,
						status: unknown ? "unknown" : "failed",
						error: error?.message ?? String(error),
					});
					// No HTTP status means the request never got an answer (a failed
					// login, a dropped connection on a read): do not repeat it per person.
					if (unknown || error?.status === undefined || [401, 403, 429].includes(error.status)) halted = true;
				}
			}

			const count = (status: PersonResult["status"]) => results.filter((result) => result.status === status).length;
			const ok = results.every((result) => ["assigned", "wouldAssign", "alreadyAssigned"].includes(result.status));
			return {
				success: ok,
				projectId: args.projectId,
				dryRun: args.dryRun === true,
				summary: {
					requested: results.length,
					assigned: count("assigned"),
					wouldAssign: count("wouldAssign"),
					alreadyAssigned: count("alreadyAssigned"),
					notFound: count("notFound"),
					ambiguous: count("ambiguous"),
					failed: count("failed"),
					unknown: count("unknown"),
					notAttempted: count("notAttempted"),
				},
				results,
				...(count("unknown") > 0
					? {
							outcome: "unknown",
							warning:
								"Unanet may have applied the last assignment before the request failed. Check the project's staffing in Unanet, or call this tool again with dryRun=true (it reports who already has an assignment), before retrying.",
						}
					: {}),
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};
