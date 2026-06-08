import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";

function itemsFromResponse<T>(data: any): T[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.message?.items)) return data.message.items;
	if (Array.isArray(data?.content)) return data.content;
	return [];
}

const statusMap: Record<string, string> = {
	Draft: "INUSE",
	Submitted: "SUBMITTED",
	Approved: "COMPLETED",
	Rejected: "DISAPPROVED",
};

const timeEntrySchema = z
	.object({
		projectId: z
			.string()
			.optional()
			.describe(
				"Project key, project code, or project name/title search text. Example: 1837, AI-PROJECT, or New Jersey.",
			),
		projectCode: z
			.string()
			.optional()
			.describe(
				"Optional project code/search text. Used when projectId is not provided.",
			),
		projectSearch: z
			.string()
			.optional()
			.describe(
				"Optional project code/name search text. Used when projectId/projectCode are not provided.",
			),
		taskId: z.string().optional().describe("Optional task key/id."),
		date: z
			.string()
			.optional()
			.describe("Work date in YYYY-MM-DD format. Defaults to today."),
		hours: z.number().positive().max(24),
		description: z.string().optional().describe("Timeslip comments/caption."),
		billable: z.boolean().optional().default(true),
		projectTypeKey: z.number().int().positive().optional(),
		payCodeKey: z.number().int().positive().optional(),
		laborCategoryKey: z.number().int().positive().optional(),
		locationKey: z.number().int().positive().optional(),
	})
	.superRefine((entry, context) => {
		if (!entry.projectId && !entry.projectCode && !entry.projectSearch) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["projectId"],
				message: "One of projectId, projectCode, or projectSearch is required.",
			});
		}
	});

function formatDate(date = new Date()): string {
	return date.toISOString().split("T")[0];
}

function numericKey(value: unknown): number | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	const numeric = Number(value);
	return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function projectSearchFields(project: any): string[] {
	return [
		project.key,
		project.projectKey,
		project.projectCode,
		project.code,
		project.title,
		project.name,
	]
		.filter((value) => value !== undefined && value !== null)
		.map((value) => String(value).toLowerCase());
}

function projectSearchText(project: any): string {
	return projectSearchFields(project).join(" ");
}

function projectSearchTokens(project: any): string[] {
	return projectSearchFields(project).flatMap((field) =>
		field.split(/[^a-z0-9]+/).filter(Boolean),
	);
}

function projectDisplay(project: any): string {
	return (
		project.projectCode ??
		project.code ??
		project.title ??
		project.name ??
		`project ${project.key ?? project.projectKey ?? "unknown"}`
	);
}

function projectKey(project: any): number | undefined {
	return numericKey(project.key ?? project.projectKey ?? project.id);
}

function firstDefinedKey(...values: unknown[]): number | undefined {
	for (const value of values) {
		const key = numericKey(value);
		if (key) return key;
	}
	return undefined;
}

function findExistingTemplate(
	timeslips: any[],
	resolvedProjectKey: number,
): any {
	return timeslips.find(
		(timeslip) =>
			(timeslip.project?.key ?? timeslip.projectKey) === resolvedProjectKey,
	);
}

function uniqueExistingKey(
	timeslips: any[],
	readKey: (timeslip: any) => unknown,
): number | undefined {
	const keys = new Set(
		timeslips
			.map(readKey)
			.map(numericKey)
			.filter((key): key is number => key !== undefined),
	);
	return keys.size === 1 ? [...keys][0] : undefined;
}

function editableTimesheetStatus(status: unknown): boolean {
	return ["NEW", "INUSE", "DISAPPROVED"].includes(
		String(status ?? "").toUpperCase(),
	);
}

function dateWithinTimesheet(workDate: string, timesheet: any): boolean {
	const beginDate =
		timesheet.beginDate ??
		timesheet.periodStart ??
		timesheet.timePeriod?.beginDate;
	const endDate =
		timesheet.endDate ?? timesheet.periodEnd ?? timesheet.timePeriod?.endDate;
	return Boolean(
		beginDate && endDate && beginDate <= workDate && workDate <= endDate,
	);
}

function projectCandidate(project: any): Record<string, unknown> {
	return {
		key: projectKey(project),
		code: project.projectCode ?? project.code ?? null,
		title: project.title ?? project.name ?? null,
	};
}

function resolveProject(
	projects: any[],
	entry: any,
): { project?: any; error?: string; candidates?: Record<string, unknown>[] } {
	const search = entry.projectId ?? entry.projectCode ?? entry.projectSearch;
	const searchKey = numericKey(search);

	if (searchKey) {
		const project = projects.find(
			(candidate) => projectKey(candidate) === searchKey,
		);
		return project
			? { project }
			: {
					error: `Project key '${searchKey}' is not available on this timesheet.`,
					candidates: projects.slice(0, 10).map(projectCandidate),
				};
	}

	if (!search) return { error: "No project search value provided." };

	const needle = String(search).trim().toLowerCase();
	const exactMatch = projects.find((project) =>
		[project.projectCode, project.code, project.title, project.name].some(
			(value) => String(value ?? "").toLowerCase() === needle,
		),
	);
	if (exactMatch) return { project: exactMatch };

	const fuzzyMatches = projects.filter((project) => {
		if (needle.length <= 3) {
			return projectSearchTokens(project).includes(needle);
		}
		return projectSearchText(project).includes(needle);
	});
	if (fuzzyMatches.length === 1) return { project: fuzzyMatches[0] };
	if (fuzzyMatches.length > 1) {
		return {
			error: `Project search '${search}' matched multiple projects. Use an exact project key/code.`,
			candidates: fuzzyMatches.slice(0, 10).map(projectCandidate),
		};
	}

	return {
		error: `Could not resolve project '${search}'.`,
		candidates: projects.slice(0, 10).map(projectCandidate),
	};
}

function timeslipToUpdate(timeslip: any): Record<string, unknown> {
	return removeUndefined({
		key: timeslip.key,
		projectKey: timeslip.project?.key ?? timeslip.projectKey,
		taskKey: timeslip.task?.key ?? timeslip.taskKey,
		laborCategoryKey: timeslip.laborCategory?.key ?? timeslip.laborCategoryKey,
		locationKey: timeslip.location?.key ?? timeslip.locationKey,
		projectTypeKey: timeslip.projectType?.key ?? timeslip.projectTypeKey,
		payCodeKey: timeslip.payCode?.key ?? timeslip.payCodeKey,
		workDate: timeslip.workDate,
		hoursWorked: timeslip.hoursWorked,
		comments: timeslip.comments || undefined,
		titos: timeslip.titos,
		udfs: timeslip.udfs,
	});
}

function removeUndefined(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	);
}

// Two timeslips occupy the same Unanet "cell" when they share project, task,
// pay code, project type, and work date. Unanet rejects a second row for the
// same cell, so adds must detect this and edit instead.
function isSameCell(existingTimeslip: any, newTimeslip: any): boolean {
	const sameKey = (
		existingValue: unknown,
		newValue: unknown,
	): boolean => numericKey(existingValue) === numericKey(newValue);
	return (
		existingTimeslip.workDate === newTimeslip.workDate &&
		sameKey(
			existingTimeslip.project?.key ?? existingTimeslip.projectKey,
			newTimeslip.projectKey,
		) &&
		sameKey(
			existingTimeslip.task?.key ?? existingTimeslip.taskKey,
			newTimeslip.taskKey,
		) &&
		sameKey(
			existingTimeslip.payCode?.key ?? existingTimeslip.payCodeKey,
			newTimeslip.payCodeKey,
		) &&
		sameKey(
			existingTimeslip.projectType?.key ?? existingTimeslip.projectTypeKey,
			newTimeslip.projectTypeKey,
		)
	);
}

function isDuplicate(existingTimeslip: any, newTimeslip: any): boolean {
	return (
		existingTimeslip.workDate === newTimeslip.workDate &&
		(existingTimeslip.project?.key ?? existingTimeslip.projectKey) ===
			newTimeslip.projectKey &&
		(existingTimeslip.task?.key ?? existingTimeslip.taskKey ?? undefined) ===
			newTimeslip.taskKey &&
		Number(existingTimeslip.hoursWorked) === Number(newTimeslip.hoursWorked) &&
		String(existingTimeslip.comments ?? "") ===
			String(newTimeslip.comments ?? "")
	);
}

async function findTimesheet(client: any, workDate: string): Promise<any> {
	const search = await client.post(
		"/me/time/search",
		{ workDate },
		{ params: { page: 1, pageSize: 1 } },
	);
	const existing = itemsFromResponse<any>(search.data)[0];
	if (existing?.key ?? existing?.id) {
		return existing;
	}

	throw new Error(
		`No existing timesheet was found for ${workDate}. Create the timesheet in Unanet first, then retry.`,
	);
}

async function getTimesheet(client: any, timesheetRef: any): Promise<any> {
	const key = timesheetRef.key ?? timesheetRef.id;
	const response = await client.get(`/me/time/${key}`);
	return response.data;
}

async function getAvailableProjects(
	client: any,
	timesheetKey: number,
): Promise<any[]> {
	const response = await client.get(`/time/${timesheetKey}/projects`, {
		params: { page: 1, pageSize: 500 },
	});
	return itemsFromResponse<any>(response.data);
}

function buildNewTimeslip(entry: any, project: any, fullTimesheet: any): any {
	const resolvedProjectKey = projectKey(project);
	if (!resolvedProjectKey) {
		throw new Error(
			"Could not resolve a numeric project key for the time entry.",
		);
	}

	const existingTimeslips = fullTimesheet.timeslips ?? [];
	const template = findExistingTemplate(existingTimeslips, resolvedProjectKey);
	const taskKey = firstDefinedKey(
		entry.taskId,
		project.taskKey,
		project.task?.key,
	);
	const newTimeslip = removeUndefined({
		key: null,
		projectKey: resolvedProjectKey,
		taskKey,
		projectTypeKey: firstDefinedKey(
			entry.projectTypeKey,
			project.projectTypeKey,
			project.projectType?.key,
			template?.projectType?.key,
			uniqueExistingKey(
				existingTimeslips,
				(timeslip) => timeslip.projectType?.key,
			),
		),
		payCodeKey: firstDefinedKey(
			entry.payCodeKey,
			project.payCodeKey,
			project.payCode?.key,
			template?.payCode?.key,
			uniqueExistingKey(existingTimeslips, (timeslip) => timeslip.payCode?.key),
		),
		laborCategoryKey: firstDefinedKey(
			entry.laborCategoryKey,
			project.laborCategoryKey,
			project.laborCategory?.key,
			template?.laborCategory?.key,
			uniqueExistingKey(
				existingTimeslips,
				(timeslip) => timeslip.laborCategory?.key,
			),
		),
		locationKey: firstDefinedKey(
			entry.locationKey,
			project.locationKey,
			project.location?.key,
			template?.location?.key,
			uniqueExistingKey(
				existingTimeslips,
				(timeslip) => timeslip.location?.key,
			),
		),
		workDate: entry.date ?? formatDate(),
		hoursWorked: entry.hours,
		comments: entry.description,
	});

	const missing = ["projectTypeKey", "payCodeKey"].filter(
		(field) => !newTimeslip[field],
	);
	if (project.taskRequired && !newTimeslip.taskKey) {
		missing.push("taskKey");
	}
	if (project.locationRequired && !newTimeslip.locationKey) {
		missing.push("locationKey");
	}
	if (missing.length > 0) {
		throw new Error(
			`Missing required Platform REST timeslip keys: ${missing.join(", ")}. Provide them explicitly or use a project with defaults on the timesheet.`,
		);
	}

	return newTimeslip;
}

// Shared write helpers ------------------------------------------------------

// Load a timesheet that is safe to write to: it must exist, cover the work
// date, and be in an editable status. Returns a discriminated result so each
// tool can surface a precise error instead of throwing.
async function loadWritableTimesheet(
	client: any,
	workDate: string,
): Promise<
	| {
			ok: true;
			fullTimesheet: any;
			timesheetKey: number;
			timeslips: any[];
	  }
	| { ok: false; error: string }
> {
	const timesheetRef = await findTimesheet(client, workDate);
	const fullTimesheet = await getTimesheet(client, timesheetRef);
	if (!dateWithinTimesheet(workDate, fullTimesheet)) {
		return {
			ok: false,
			error: `${workDate} is outside the resolved timesheet period ${fullTimesheet.beginDate ?? fullTimesheet.timePeriod?.beginDate ?? "unknown"} to ${fullTimesheet.endDate ?? fullTimesheet.timePeriod?.endDate ?? "unknown"}.`,
		};
	}
	if (!editableTimesheetStatus(fullTimesheet.status)) {
		return {
			ok: false,
			error: `Timesheet ${fullTimesheet.key ?? timesheetRef.key ?? timesheetRef.id} is not editable because its status is ${fullTimesheet.status}.`,
		};
	}
	return {
		ok: true,
		fullTimesheet,
		timesheetKey: fullTimesheet.key ?? timesheetRef.key ?? timesheetRef.id,
		timeslips: [...(fullTimesheet.timeslips ?? [])],
	};
}

// Persist the full timeslip set with a single Platform REST PUT.
async function commitTimeslips(
	client: any,
	timesheetKey: number,
	timeslips: any[],
	fullTimesheet: any,
): Promise<void> {
	await client.put(`/me/time/${timesheetKey}`, {
		key: timesheetKey,
		timeslips: timeslips.map(timeslipToUpdate),
		lastDrawerState: fullTimesheet.lastDrawerState ?? "DURATION",
	});
}

function timeslipProjectKey(timeslip: any): number | undefined {
	return numericKey(timeslip.project?.key ?? timeslip.projectKey);
}

// Does an existing timeslip row match the caller's project selector?
// Numeric selectors match the project key exactly; text selectors use the same
// token-aware matching as project resolution so short terms like "AI" stay
// precise.
function timeslipMatchesProject(timeslip: any, projectId: string): boolean {
	const needle = String(projectId).trim().toLowerCase();
	if (!needle) {
		return false;
	}
	const key = numericKey(needle);
	if (key !== undefined) {
		return timeslipProjectKey(timeslip) === key;
	}
	const haystack = String(
		timeslip.project?.name ?? timeslip.project?.title ?? "",
	).toLowerCase();
	if (needle.length <= 3) {
		return haystack
			.split(/[^a-z0-9]+/)
			.filter(Boolean)
			.includes(needle);
	}
	return haystack.includes(needle);
}

// Find existing rows matching a selector (timeslip key, and/or project, and/or
// task). Never guesses: when more than one row matches it returns the
// candidates so the caller can disambiguate.
function selectTimeslips(
	timeslips: any[],
	selector: {
		timeslipKey?: number;
		projectId?: string;
		taskId?: number;
		workDate?: string;
	},
): { matches: any[]; ambiguous?: boolean; candidates?: any[] } {
	let matches = timeslips;
	// When selecting by project/task (not an exact key), scope to the work date
	// so we never match an identical project on a different day of the period.
	if (selector.workDate !== undefined && selector.timeslipKey === undefined) {
		matches = matches.filter(
			(timeslip) => timeslip.workDate === selector.workDate,
		);
	}
	if (selector.timeslipKey !== undefined) {
		matches = matches.filter(
			(timeslip) => numericKey(timeslip.key) === Number(selector.timeslipKey),
		);
	}
	if (selector.projectId !== undefined) {
		matches = matches.filter((timeslip) =>
			timeslipMatchesProject(timeslip, selector.projectId as string),
		);
	}
	if (selector.taskId !== undefined) {
		matches = matches.filter(
			(timeslip) =>
				numericKey(timeslip.task?.key ?? timeslip.taskKey) ===
				Number(selector.taskId),
		);
	}
	if (matches.length > 1) {
		return {
			matches,
			ambiguous: true,
			candidates: matches.map(summarizeTimeslip),
		};
	}
	return { matches };
}

// Submit timesheet tool
export const updateTimesheetTool = {
	name: "unanet_update_timesheet",
	description:
		"Add time entries (timeslip rows) to your in-progress Unanet timesheet via Platform REST. This does NOT submit the timesheet for approval and does NOT change or overwrite existing rows: it reads the current timeslips, appends the new entries, and saves the full set. Exact-duplicate rows are rejected unless allowDuplicate=true. Use projectId as a project key, code, or name search.",
	inputSchema: z.object({
		entries: z.array(timeEntrySchema).min(1),
		confirm: z
			.literal(true)
			.describe("Must be true to confirm this live timesheet write."),
		allowDuplicate: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				"Set true only when intentionally adding an exact duplicate entry.",
			),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return {
				success: false,
				error: "confirm=true is required before writing timesheet entries.",
			};
		}

		const client = createUnanetClient(auth);

		try {
			const entriesByDate = new Map<string, any[]>();
			for (const entry of args.entries) {
				const date = entry.date ?? formatDate();
				entriesByDate.set(date, [
					...(entriesByDate.get(date) ?? []),
					{ ...entry, date },
				]);
			}

			const addedEntries = [];
			for (const [workDate, entries] of entriesByDate) {
				const loaded = await loadWritableTimesheet(client, workDate);
				if (!loaded.ok) {
					return { success: false, error: loaded.error };
				}
				const { fullTimesheet, timesheetKey, timeslips } = loaded;
				const availableProjects = await getAvailableProjects(
					client,
					timesheetKey,
				);

				for (const entry of entries) {
					const resolution = resolveProject(availableProjects, entry);
					if (!resolution.project) {
						return {
							success: false,
							error: resolution.error,
							availableProjectCount: availableProjects.length,
							candidates: resolution.candidates,
						};
					}
					const project = resolution.project;

					const newTimeslip = buildNewTimeslip(entry, project, {
						...fullTimesheet,
						timeslips,
					});
					if (
						!args.allowDuplicate &&
						timeslips.some((timeslip) => isDuplicate(timeslip, newTimeslip))
					) {
						return {
							success: false,
							error:
								"An exact matching time entry already exists. Set allowDuplicate=true if this is intentional.",
							workDate,
							project: projectDisplay(project),
						};
					}
					// Unanet stores one timeslip per project+date+task+payCode+type
					// "cell"; adding a second for the same cell is rejected by the API.
					// Detect it up front and point the caller at edit instead of
					// surfacing an opaque 400.
					const sameCell = timeslips.find((timeslip) =>
						isSameCell(timeslip, newTimeslip),
					);
					if (sameCell) {
						return {
							success: false,
							error: `A time entry already exists for ${projectDisplay(project)} on ${workDate} (${sameCell.hoursWorked ?? 0} hours). Unanet allows only one entry per project/day, so use unanet_edit_timeslip to change its hours or comment instead of adding another.`,
							workDate,
							existingRow: summarizeTimeslip(sameCell),
						};
					}

					timeslips.push(newTimeslip);
					addedEntries.push({
						workDate,
						hours: newTimeslip.hoursWorked,
						projectKey: newTimeslip.projectKey,
						project: projectDisplay(project),
						comments: newTimeslip.comments ?? null,
					});
				}

				await commitTimeslips(
					client,
					timesheetKey,
					timeslips,
					fullTimesheet,
				);
			}

			return {
				success: true,
				message: `Added ${addedEntries.length} time entr${addedEntries.length === 1 ? "y" : "ies"} to Unanet.`,
				entries: addedEntries,
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};

// Edit timeslip tool
export const editTimeslipTool = {
	name: "unanet_edit_timeslip",
	description:
		"Edit an existing timeslip row in place on your in-progress Unanet timesheet (change hours and/or comment). Identify the row by timeslipKey, or by projectId (key/code/name) plus date. If more than one row matches, the tool returns the candidates and makes no change instead of guessing. Requires confirm: true.",
	inputSchema: z.object({
		date: z
			.string()
			.optional()
			.describe("Work date in YYYY-MM-DD format. Defaults to today."),
		timeslipKey: z
			.number()
			.int()
			.optional()
			.describe("Exact existing timeslip row key (most precise selector)."),
		projectId: z
			.string()
			.optional()
			.describe("Project key, code, or name to match the row to edit."),
		taskId: z
			.number()
			.int()
			.optional()
			.describe("Optional task key to disambiguate rows on the same project."),
		hours: z
			.number()
			.min(0)
			.max(24)
			.optional()
			.describe("New hours for the row. Omit to leave hours unchanged."),
		description: z
			.string()
			.optional()
			.describe("New comment for the row. Omit to leave the comment unchanged."),
		confirm: z
			.literal(true)
			.describe("Must be true to confirm this live timesheet edit."),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return {
				success: false,
				error: "confirm=true is required before editing a timeslip.",
			};
		}
		if (args.timeslipKey === undefined && args.projectId === undefined) {
			return {
				success: false,
				error: "Provide timeslipKey or projectId to identify the row to edit.",
			};
		}
		if (args.hours === undefined && args.description === undefined) {
			return {
				success: false,
				error: "Provide hours and/or description to change. Nothing to edit.",
			};
		}

		const client = createUnanetClient(auth);
		const workDate = args.date ?? formatDate();

		try {
			const loaded = await loadWritableTimesheet(client, workDate);
			if (!loaded.ok) {
				return { success: false, error: loaded.error };
			}
			const { fullTimesheet, timesheetKey, timeslips } = loaded;

			const selection = selectTimeslips(timeslips, {
				timeslipKey: args.timeslipKey,
				projectId: args.projectId,
				taskId: args.taskId,
				workDate,
			});
			if (selection.ambiguous) {
				return {
					success: false,
					error:
						"Multiple timeslip rows match. Re-run with timeslipKey to pick exactly one.",
					candidates: selection.candidates,
				};
			}
			const target = selection.matches[0];
			if (!target) {
				return {
					success: false,
					error: `No timeslip row on ${workDate} matched the given selector.`,
					availableRows: timeslips
						.filter((row) => row.workDate === workDate)
						.map(summarizeTimeslip),
				};
			}

			const before = summarizeTimeslip(target);
			if (args.hours !== undefined) {
				target.hoursWorked = args.hours;
			}
			if (args.description !== undefined) {
				target.comments = args.description;
			}

			await commitTimeslips(client, timesheetKey, timeslips, fullTimesheet);

			return {
				success: true,
				message: "Updated 1 timeslip row in Unanet.",
				workDate,
				before,
				after: summarizeTimeslip(target),
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

// Delete timeslip tool
export const deleteTimeslipTool = {
	name: "unanet_delete_timeslip",
	description:
		"Clear an existing time entry on your in-progress Unanet timesheet by setting it to 0 hours and removing its comment. Unanet has no true row delete, so the project may still appear on the timesheet with no hours. Identify the entry by timeslipKey, or by projectId (key/code/name) plus date. If more than one row matches, the tool returns the candidates and changes nothing instead of guessing. Requires confirm: true.",
	inputSchema: z.object({
		date: z
			.string()
			.optional()
			.describe("Work date in YYYY-MM-DD format. Defaults to today."),
		timeslipKey: z
			.number()
			.int()
			.optional()
			.describe("Exact existing timeslip row key (most precise selector)."),
		projectId: z
			.string()
			.optional()
			.describe("Project key, code, or name to match the row to delete."),
		taskId: z
			.number()
			.int()
			.optional()
			.describe("Optional task key to disambiguate rows on the same project."),
		confirm: z
			.literal(true)
			.describe("Must be true to confirm this live timesheet deletion."),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return {
				success: false,
				error: "confirm=true is required before deleting a timeslip.",
			};
		}
		if (args.timeslipKey === undefined && args.projectId === undefined) {
			return {
				success: false,
				error: "Provide timeslipKey or projectId to identify the row to delete.",
			};
		}

		const client = createUnanetClient(auth);
		const workDate = args.date ?? formatDate();

		try {
			const loaded = await loadWritableTimesheet(client, workDate);
			if (!loaded.ok) {
				return { success: false, error: loaded.error };
			}
			const { fullTimesheet, timesheetKey, timeslips } = loaded;

			const selection = selectTimeslips(timeslips, {
				timeslipKey: args.timeslipKey,
				projectId: args.projectId,
				taskId: args.taskId,
				workDate,
			});
			if (selection.ambiguous) {
				return {
					success: false,
					error:
						"Multiple timeslip rows match. Re-run with timeslipKey to pick exactly one.",
					candidates: selection.candidates,
				};
			}
			const target = selection.matches[0];
			if (!target) {
				return {
					success: false,
					error: `No timeslip row on ${workDate} matched the given selector.`,
					availableRows: timeslips
						.filter((row) => row.workDate === workDate)
						.map(summarizeTimeslip),
				};
			}

			const cleared = summarizeTimeslip(target);
			// Unanet has no per-timeslip delete: clear the cell to zero hours and
			// drop the comment, then save the full set. The project row may remain
			// on the timesheet at 0 hours (Unanet keeps assigned projects).
			target.hoursWorked = 0;
			target.comments = "";
			await commitTimeslips(client, timesheetKey, timeslips, fullTimesheet);

			return {
				success: true,
				message:
					"Cleared 1 time entry (set to 0 hours). The project may still appear on the timesheet with no hours.",
				workDate,
				cleared,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

// Submit timesheet for approval tool
export const submitTimesheetForApprovalTool = {
	name: "unanet_submit_timesheet_for_approval",
	description:
		"Submit your Unanet timesheet for approval (POST /me/time/{id}/submit). The tool validates the timesheet first: it refuses on validation errors, and on warnings it returns them and does nothing unless ignoreWarnings is true. This is a one-way action that locks the timesheet from further edits, so it requires confirm: true.",
	inputSchema: z.object({
		date: z
			.string()
			.optional()
			.describe(
				"Any date within the timesheet period to submit. Defaults to today.",
			),
		comment: z
			.string()
			.optional()
			.describe("Optional submission comment."),
		ignoreWarnings: z
			.boolean()
			.optional()
			.default(false)
			.describe("Submit even if validation returns non-blocking warnings."),
		confirm: z
			.literal(true)
			.describe("Must be true to confirm this one-way submission."),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return {
				success: false,
				error: "confirm=true is required before submitting a timesheet.",
			};
		}

		const client = createUnanetClient(auth);
		const workDate = args.date ?? formatDate();

		try {
			const timesheetRef = await findTimesheet(client, workDate);
			const timesheetKey = timesheetRef.key ?? timesheetRef.id;
			if (!editableTimesheetStatus(timesheetRef.status)) {
				return {
					success: false,
					error: `Timesheet ${timesheetKey} cannot be submitted because its status is ${timesheetRef.status}.`,
				};
			}

			const validation = (await client.get(`/me/time/${timesheetKey}/validate`))
				.data;
			// Field names verified against live Platform REST /validate response.
			const errors = [
				...(validation.errors ?? []),
				...(validation.timeslipErrors ?? []),
				...(validation.itemEntryErrors ?? []),
				...(validation.timesheetTITOMissingStops ?? []),
				...(validation.timesheetTITOOverlaps ?? []),
				...(validation.timeslipTITOMissingStops ?? []),
				...(validation.timeslipTITOOverlaps ?? []),
				...(validation.titoHourMismatches ?? []),
			];
			if (errors.length > 0) {
				return {
					success: false,
					error:
						"Timesheet has validation errors and was not submitted. Fix these and retry.",
					validationErrors: errors,
				};
			}
			const warnings = validation.warnings ?? [];
			if (warnings.length > 0 && !args.ignoreWarnings) {
				return {
					success: false,
					error:
						"Timesheet has validation warnings. Review them, then re-run with ignoreWarnings=true to submit anyway.",
					validationWarnings: warnings,
				};
			}

			await client.post(`/me/time/${timesheetKey}/submit`, {
				comment: args.comment,
				ignoreWarnings: args.ignoreWarnings,
			});

			return {
				success: true,
				message: `Submitted timesheet ${timesheetKey} for approval.`,
				timesheetKey,
				submittedWarnings: warnings.length > 0 ? warnings : undefined,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

function timesheetPeriod(timesheet: any): {
	startDate: string;
	endDate: string;
} {
	return {
		startDate:
			timesheet.beginDate ??
			timesheet.periodStart ??
			timesheet.timePeriod?.beginDate ??
			"unknown",
		endDate:
			timesheet.endDate ??
			timesheet.periodEnd ??
			timesheet.timePeriod?.endDate ??
			"unknown",
	};
}

// Platform REST timesheet search only filters on the period BEGIN date
// (beginDateStart/beginDateEnd) or a single workDate. To capture a sheet
// that began before the requested range but still covers it, widen the
// begin-date search backward by one period length, then keep only sheets
// whose period overlaps the requested [startDate, endDate] window.
function shiftIsoDate(date: string, deltaDays: number): string {
	const parsed = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) {
		return date;
	}
	parsed.setUTCDate(parsed.getUTCDate() + deltaDays);
	return parsed.toISOString().split("T")[0];
}

function periodsOverlap(
	timesheet: any,
	startDate: string,
	endDate: string,
): boolean {
	const { startDate: begin, endDate: end } = timesheetPeriod(timesheet);
	if (begin === "unknown" || end === "unknown") {
		return true;
	}
	return begin <= endDate && end >= startDate;
}

function summarizeTimeslip(timeslip: any): Record<string, unknown> {
	return {
		key: timeslip.key,
		workDate: timeslip.workDate,
		hoursWorked: timeslip.hoursWorked,
		project: timeslip.project
			? {
					key: timeslip.project.key,
					name: timeslip.project.name,
				}
			: null,
		task: timeslip.task
			? {
					key: timeslip.task.key,
					name: timeslip.task.name,
				}
			: null,
		projectType: timeslip.projectType?.name ?? null,
		payCode: timeslip.payCode?.name ?? null,
		laborCategory: timeslip.laborCategory?.name ?? null,
		location: timeslip.location?.name ?? null,
		comments: timeslip.comments ?? null,
	};
}

function summarizeProject(project: any): Record<string, unknown> {
	return {
		key: projectKey(project),
		code: project.projectCode ?? project.code ?? null,
		title: project.title ?? project.name ?? null,
		taskRequired: project.taskRequired ?? false,
		locationRequired: project.locationRequired ?? false,
		projectTypeKey: project.projectTypeKey ?? project.projectType?.key ?? null,
		payCodeKey: project.payCodeKey ?? project.payCode?.key ?? null,
		laborCategoryKey:
			project.laborCategoryKey ?? project.laborCategory?.key ?? null,
		locationKey: project.locationKey ?? project.location?.key ?? null,
	};
}

// Get timesheets tool
export const getTimesheetsTool = {
	name: "unanet_get_timesheets",
	description:
		"Retrieve timesheets for a date range via Platform REST, including entry-level timeslip summaries.",
	inputSchema: z.object({
		startDate: z.string().describe("Start date in YYYY-MM-DD format"),
		endDate: z.string().describe("End date in YYYY-MM-DD format"),
		status: z
			.enum(["Draft", "Submitted", "Approved", "Rejected", "All"])
			.optional()
			.default("All"),
		limit: z.number().int().positive().max(50).optional().default(10),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const criteria: Record<string, unknown> = {
				beginDateStart: shiftIsoDate(args.startDate, -31),
				beginDateEnd: args.endDate,
			};
			if (args.status && args.status !== "All") {
				criteria.statuses = [statusMap[args.status] ?? args.status];
			}

			const response = await client.post("/me/time/search", criteria, {
				params: { page: 1, pageSize: Math.max(args.limit, 31) },
			});
			const timesheets = itemsFromResponse<any>(response.data)
				.filter((ts) => periodsOverlap(ts, args.startDate, args.endDate))
				.slice(0, args.limit);
			const detailedTimesheets = await Promise.all(
				timesheets.map(async (timesheet) => {
					try {
						return await getTimesheet(client, timesheet);
					} catch {
						return timesheet;
					}
				}),
			);

			return {
				success: true,
				count: detailedTimesheets.length,
				timesheets: detailedTimesheets.map((ts) => {
					const period = timesheetPeriod(ts);
					// Hide empty (0-hour) cells: Unanet leaves a project row behind
					// when an entry is cleared, and those are not real time entries.
					const timeslips = (ts.timeslips ?? []).filter(
						(timeslip: any) => Number(timeslip.hoursWorked) > 0,
					);
					return {
						id: ts.id ?? ts.key,
						period: `${period.startDate} to ${period.endDate}`,
						status: ts.status,
						totalHours: ts.totalHours ?? ts.hours,
						totalBillableHours: ts.totalBillableHours ?? ts.billableHours,
						entries: timeslips.length,
						timeslips: timeslips.map(summarizeTimeslip),
					};
				}),
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};

export const getMyTimesheetProjectsTool = {
	name: "unanet_get_my_timesheet_projects",
	description:
		"List projects available to charge on your timesheet for a given date.",
	inputSchema: z.object({
		date: z
			.string()
			.optional()
			.describe("Date in YYYY-MM-DD format. Defaults to today."),
		search: z
			.string()
			.optional()
			.describe("Optional code/title search text, e.g. AI or New Jersey."),
		limit: z.number().int().positive().max(500).optional().default(100),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);
		const workDate = args.date ?? formatDate();

		try {
			const timesheetRef = await findTimesheet(client, workDate);
			const timesheetKey = timesheetRef.key ?? timesheetRef.id;
			const projects = await getAvailableProjects(client, timesheetKey);
			const search = String(args.search ?? "")
				.trim()
				.toLowerCase();
			const filtered = search
				? projects.filter((project) =>
						search.length <= 3
							? projectSearchTokens(project).includes(search)
							: projectSearchText(project).includes(search),
					)
				: projects;

			return {
				success: true,
				date: workDate,
				timesheetKey,
				count: filtered.length,
				projects: filtered.slice(0, args.limit).map(summarizeProject),
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};

// Submit expense tool
export const submitExpenseTool = {
	name: "unanet_submit_expense",
	description:
		"Create an expense report shell via Platform REST. Project allocation details require Platform-specific keys.",
	inputSchema: z.object({
		projectId: z.string(),
		date: z.string().describe("Date in YYYY-MM-DD format"),
		category: z
			.string()
			.describe("Expense category (e.g., Travel, Meals, Supplies)"),
		amount: z.number().positive(),
		description: z.string(),
		reimbursable: z.boolean().default(true),
	}),
	handler: async (args: any, _auth: UnanetAuth) => {
		return {
			success: false,
			error:
				"Platform REST expense creation requires expenseProjectAllocations with Unanet keys, not the legacy projectId/category/amount shape. This tool needs a dedicated expense-allocation implementation before it can safely write.",
			requestedExpense: args,
		};
	},
};

// Approve timesheet tool
export const approveTimesheetTool = {
	name: "unanet_approve_timesheet",
	description:
		"Approve a submitted manager-approval timesheet via Platform REST",
	inputSchema: z.object({
		timesheetId: z
			.string()
			.describe("The ID/key of the timesheet approval to approve"),
		comments: z.string().optional().describe("Approval comments"),
		confirm: z
			.literal(true)
			.describe("Must be true to confirm this live approval write."),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return {
				success: false,
				error: "confirm=true is required before approving a timesheet.",
			};
		}

		const client = createUnanetClient(auth);

		try {
			await client.post(
				`/me/approvals/time/manager/${args.timesheetId}/approve`,
				{
					comments: args.comments,
				},
			);

			return {
				success: true,
				message: `Timesheet ${args.timesheetId} approved successfully`,
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};
