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
	const beginDate = timesheet.beginDate ?? timesheet.periodStart;
	const endDate = timesheet.endDate ?? timesheet.periodEnd;
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

// Submit timesheet tool
export const submitTimesheetTool = {
	name: "unanet_submit_timesheet",
	description:
		"Add confirmed time entries to your Unanet timesheet using Platform REST timeslip rows. Use projectId as a project key, code, or name search.",
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
				const timesheetRef = await findTimesheet(client, workDate);
				const fullTimesheet = await getTimesheet(client, timesheetRef);
				if (!dateWithinTimesheet(workDate, fullTimesheet)) {
					return {
						success: false,
						error: `${workDate} is outside the resolved timesheet period ${fullTimesheet.beginDate ?? "unknown"} to ${fullTimesheet.endDate ?? "unknown"}.`,
					};
				}
				if (!editableTimesheetStatus(fullTimesheet.status)) {
					return {
						success: false,
						error: `Timesheet ${fullTimesheet.key ?? timesheetRef.key ?? timesheetRef.id} is not editable because its status is ${fullTimesheet.status}.`,
					};
				}
				const timesheetKey =
					fullTimesheet.key ?? timesheetRef.key ?? timesheetRef.id;
				const availableProjects = await getAvailableProjects(
					client,
					timesheetKey,
				);
				const timeslips = [...(fullTimesheet.timeslips ?? [])];

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

					timeslips.push(newTimeslip);
					addedEntries.push({
						workDate,
						hours: newTimeslip.hoursWorked,
						projectKey: newTimeslip.projectKey,
						project: projectDisplay(project),
						comments: newTimeslip.comments ?? null,
					});
				}

				await client.put(`/me/time/${timesheetKey}`, {
					key: timesheetKey,
					timeslips: timeslips.map(timeslipToUpdate),
					lastDrawerState: fullTimesheet.lastDrawerState ?? "DURATION",
				});
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

// Get timesheets tool
export const getTimesheetsTool = {
	name: "unanet_get_timesheets",
	description: "Retrieve timesheets for a date range via Platform REST",
	inputSchema: z.object({
		startDate: z.string().describe("Start date in YYYY-MM-DD format"),
		endDate: z.string().describe("End date in YYYY-MM-DD format"),
		status: z
			.enum(["Draft", "Submitted", "Approved", "Rejected", "All"])
			.optional()
			.default("All"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const criteria: Record<string, unknown> = {
				beginDateStart: args.startDate,
				beginDateEnd: args.endDate,
			};
			if (args.status !== "All") {
				criteria.statuses = [statusMap[args.status] ?? args.status];
			}

			const response = await client.post("/me/time/search", criteria, {
				params: { page: 1, pageSize: 50 },
			});
			const timesheets = itemsFromResponse<any>(response.data);

			return {
				success: true,
				count: timesheets.length,
				timesheets: timesheets.map((ts) => ({
					id: ts.id ?? ts.key,
					period: `${ts.periodStart ?? ts.beginDate ?? "unknown"} to ${ts.periodEnd ?? ts.endDate ?? "unknown"}`,
					status: ts.status,
					totalHours: ts.totalHours ?? ts.hours,
					totalBillableHours: ts.totalBillableHours ?? ts.billableHours,
					entries: ts.entries?.length ?? ts.details?.length ?? 0,
				})),
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
