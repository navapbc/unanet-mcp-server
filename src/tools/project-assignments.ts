// Project staffing write: assign people to a Unanet project. This is an
// org-level change (it needs project-manager rights in Unanet), unlike the
// /me/ self-service writes, so it lives in its own file with its own guards:
// a person cap, duplicate detection, silent by default, and a dry run.

import { z } from "zod";
import { type UnanetAuth, createUnanetClient, isOutcomeUnknown } from "../auth.js";
import {
	compact,
	confirmSchema,
	createdKey,
	errorResult,
	formatLocalDate,
	isoDateSchema,
	itemsFromResponse,
	requireConfirm,
} from "../utils/http.js";

const MAX_PEOPLE = 50;

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

export const assignPeopleToProjectTool = {
	name: "unanet_assign_people_to_project",
	description:
		"Assign people to a Unanet project (optionally a task), for example to add everyone in a channel to its bid code. Identify people by Unanet person key or by work email (exactly one active match is required). Skips people who already have an active assignment and never creates duplicates. Uses each person's Unanet defaults for rates, labor category and organizations, sends no assignment notifications unless notify=true, and handles at most 50 people per call. Set dryRun=true to see what would happen without changing anything. This changes the project staffing in Unanet and needs project-manager rights; Unanet decides whether you have them. Requires confirm: true.",
	inputSchema: z
		.object({
			confirm: confirmSchema("project assignment"),
			projectId: z.number().int().positive().describe("Unanet project key (the bid code's project)."),
			personKeys: z.array(z.number().int().positive()).max(MAX_PEOPLE).optional(),
			emails: z.array(z.string().email()).max(MAX_PEOPLE).optional(),
			taskKey: z.number().int().positive().optional().describe("Assign to this task instead of the whole project."),
			beginDate: isoDateSchema.optional().describe("Assignment start. Omit both dates to use the project/task dates."),
			endDate: isoDateSchema.optional().describe("Assignment end."),
			notify: z
				.boolean()
				.optional()
				.default(false)
				.describe("Send Unanet's assignment notifications (person, manager, lead, planner). Off by default."),
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
			for (const rawEmail of args.emails ?? []) {
				const email = String(rawEmail).toLowerCase();
				const response = await client.post("/people/search", { email, active: true }, { params: { page: 1, pageSize: 25 } });
				const matches = itemsFromResponse<any>(response.data).filter(
					(person) => String(person?.email ?? "").trim().toLowerCase() === email && person?.active !== false,
				);
				if (matches.length === 0) {
					results.push({ personKey: null, email, status: "notFound", error: "No active Unanet person has this email." });
				} else if (matches.length > 1) {
					results.push({ personKey: null, email, status: "ambiguous", candidates: matches.map((person) => person.key), error: "More than one active person has this email; use personKeys." });
				} else if (!seen.has(matches[0].key)) {
					seen.add(matches[0].key);
					toAssign.push({ personKey: matches[0].key, email });
				}
			}

			// 2. Assign one at a time. An unclear outcome or a permission error
			// stops the batch so a problem is not repeated for everyone.
			const beginDate = args.beginDate ?? formatLocalDate();
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
						compact({ personKeys: [personKey], taskKeys: args.taskKey ? [args.taskKey] : undefined, activeOnly: true }),
						{ params: { page: 1, pageSize: 1 } },
					);
					if (itemsFromResponse<any>(existing.data).length > 0) {
						results.push({ personKey, email, status: "alreadyAssigned" });
						continue;
					}
					if (args.dryRun) {
						results.push({ personKey, email, status: "wouldAssign" });
						continue;
					}
					const defaults = (
						await client.get(`/assigning/defaults/project/${args.projectId}/person/${personKey}/${beginDate}`)
					).data;
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
							billRateSource: defaults?.billRateSource ?? "PERSON",
							costRateSource: defaults?.costRateSource ?? "PERSON",
							personOrganizationKey: defaults?.personOrg?.key,
							projectOrganizationKey: defaults?.projectOrg?.key,
							laborCategoryKey: defaults?.laborCategory?.key,
							assignmentNotification: {
								notifyUser: notify,
								notifyPM: notify,
								notifyPL: notify,
								notifyPlanner: notify,
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
					if (unknown || error?.status === 401 || error?.status === 403) halted = true;
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
								"Unanet may have applied the last assignment before the request failed. Check the project's assignments (unanet_get_project_assignments) before retrying.",
						}
					: {}),
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};
