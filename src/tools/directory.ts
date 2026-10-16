// Org-level READ tools: people, organizations, contracts, project tasks /
// assignments / notes, invoices, and small reference lookups. All read-only;
// registered only with the extended-read flag because they expose data beyond
// the caller's own records (subject to the caller's Unanet permissions).

import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";
import {
	compact,
	errorResult,
	isoDateSchema,
	itemsFromResponse,
	keyName,
	pageInfo,
	pageSchema,
	pageSizeSchema,
	toNumberOrNull,
} from "../utils/http.js";

// Unanet's DateRangeModel is { rangeStart, rangeEnd } and both are required.
function dateRange(start?: string, end?: string): { rangeStart: string; rangeEnd: string } | undefined {
	return start && end ? { rangeStart: start, rangeEnd: end } : undefined;
}

function personName(person: any): string | null {
	if (!person) return null;
	const parts = [person.firstName, person.middleInitial, person.lastName, person.suffix]
		.filter(Boolean)
		.join(" ");
	return parts || person.name || null;
}

function summarizePerson(person: any) {
	return {
		key: person?.key ?? null,
		username: person?.username ?? null,
		name: personName(person),
		firstName: person?.firstName ?? null,
		lastName: person?.lastName ?? null,
		email: person?.email ?? null,
		active: person?.active ?? null,
		personCode: person?.personCode ?? null,
		organization: keyName(person?.organization),
		laborCategory: keyName(person?.laborCategory),
		location: keyName(person?.location),
		employeeType: keyName(person?.employeeType),
		subcontractor: person?.subcontractor ?? null,
		hireDate: person?.hireDate ?? null,
		roles: person?.roles ?? undefined,
		timeApprovalGroup: keyName(person?.timeApprovalGroup),
		expenseReportApprovalGroup: keyName(person?.expenseReportApprovalGroup),
		leaveRequestApprovalGroup: keyName(person?.leaveRequestApprovalGroup),
	};
}

function summarizeOrganization(org: any) {
	return {
		key: org?.key ?? null,
		code: org?.code ?? null,
		name: org?.name ?? null,
		active: org?.active ?? null,
		type: org?.type ?? null,
		industry: org?.industry ?? null,
		legalEntity: typeof org?.legalEntity === "object" ? keyName(org?.legalEntity) : (org?.legalEntity ?? null),
		financialOrg: org?.financialOrg ?? null,
		url: org?.url ?? null,
		beginDate: org?.beginDate ?? null,
		endDate: org?.endDate ?? null,
	};
}

function summarizeContract(contract: any) {
	return {
		key: contract?.key ?? null,
		contractCode: contract?.contractCode ?? null,
		contractTitle: contract?.contractTitle ?? null,
		status: keyName(contract?.contractStatus),
		contractManager: keyName(contract?.contractManager),
		owningOrg: keyName(contract?.owningOrg),
		customer: keyName(contract?.customer),
		endCustomer: keyName(contract?.endCustomer),
		primeOrSub: contract?.primeOrSub ?? null,
		contractTypes: (contract?.contractTypes ?? []).map(keyName),
		awardDate: contract?.awardDate ?? null,
		beginDate: contract?.beginDate ?? null,
		endDate: contract?.endDate ?? null,
		ceilingAmount: toNumberOrNull(contract?.ceilingAmount),
		fundedValue: toNumberOrNull(contract?.fundedValue),
		totalValue: toNumberOrNull(contract?.totalValue),
		primaryNaicsCode: keyName(contract?.primaryNaicsCode),
		billingAnalyst: keyName(contract?.billingAnalyst),
	};
}

function summarizeTask(task: any) {
	return {
		key: task?.key ?? null,
		projectKey: task?.projectKey ?? null,
		number: task?.number ?? null,
		name: task?.name ?? null,
		sequence: task?.sequence ?? null,
		parentKey: task?.parentKey ?? null,
		indentLevel: task?.indentLevel ?? null,
		active: task?.active ?? null,
		revStartDate: task?.revStartDate ?? null,
		revEndDate: task?.revEndDate ?? null,
		completedDate: task?.completedDate ?? null,
		percentComplete: toNumberOrNull(task?.percentComplete),
		hoursBudget: toNumberOrNull(task?.hoursBudget),
		owningOrg: keyName(task?.owningOrg),
		projectType: keyName(task?.projectType),
	};
}

function summarizeAssignment(assignment: any) {
	return {
		key: assignment?.key ?? null,
		person: keyName(assignment?.person),
		project: keyName(assignment?.project),
		projectCode: assignment?.project?.code ?? null,
		task: keyName(assignment?.task),
		beginDate: assignment?.beginDate ?? null,
		endDate: assignment?.endDate ?? null,
		budgetHours: toNumberOrNull(assignment?.budgetHours),
		etcHours: toNumberOrNull(assignment?.etcHours),
		laborCategory: keyName(assignment?.laborCategory),
		location: keyName(assignment?.location),
		personOrganization: keyName(assignment?.personOrganization),
		projectOrganization: keyName(assignment?.projectOrganization),
		lastUpdated: assignment?.lastUpdated ?? null,
	};
}

function summarizeInvoice(invoice: any) {
	return {
		key: invoice?.key ?? null,
		invoiceNumber: invoice?.invoiceNumber ?? null,
		project: keyName(invoice?.project),
		projectCode: invoice?.project?.code ?? null,
		customer: keyName(invoice?.customer),
		invoiceDate: invoice?.invoiceDate ?? null,
		postDate: invoice?.postDate ?? null,
		amount: toNumberOrNull(invoice?.amount),
		balance: toNumberOrNull(invoice?.balance),
		currency: invoice?.currency?.code ?? null,
		status: invoice?.status ?? null,
		completedTimestamp: invoice?.completedTimestamp ?? null,
		emailedTimestamp: invoice?.emailedTimestamp ?? null,
	};
}

function summarizeNote(note: any) {
	return {
		key: note?.key ?? null,
		project: keyName(note?.project),
		title: note?.title ?? null,
		note: note?.note ?? null,
		noteType: keyName(note?.noteType),
		status: keyName(note?.status),
		creator: personName(note?.creator) ?? keyName(note?.creator).name,
		assignee: personName(note?.assignee) ?? keyName(note?.assignee).name,
		createDate: note?.createDate ?? null,
		modifiedDate: note?.modifiedDate ?? null,
		actionDate: note?.actionDate ?? null,
		completedDate: note?.completedDate ?? null,
	};
}

// People ---------------------------------------------------------------------

export const searchPeopleTool = {
	name: "unanet_search_people",
	description:
		"Search Unanet people (employees/contractors) by name, email, person code, organization, labor category, etc. Returns what your Unanet role permits. Read-only.",
	inputSchema: z.object({
		name: z.string().optional().describe("Matches person name and username."),
		email: z.string().optional().describe("Exact email match."),
		personCode: z.string().optional(),
		active: z.boolean().optional().default(true),
		keys: z.array(z.number().int().positive()).optional(),
		orgCodeKeys: z.array(z.number().int().positive()).optional(),
		laborCategoryKeys: z.array(z.number().int().positive()).optional(),
		employeeTypeKeys: z.array(z.number().int().positive()).optional(),
		managerOnly: z.boolean().optional().describe("Only people you manage."),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 500),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const { page, pageSize, ...criteria } = args;
			const response = await client.post("/people/search", compact(criteria), {
				params: { page, pageSize },
			});
			const people = itemsFromResponse<any>(response.data).map(summarizePerson);
			return { success: true, count: people.length, paging: pageInfo(response.data), people };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getPersonTool = {
	name: "unanet_get_person",
	description:
		"Read one Unanet person record by key, optionally with their project assignments and leave balances. Read-only.",
	inputSchema: z.object({
		personId: z.number().int().positive(),
		includeAssignments: z.boolean().optional().default(false),
		includeLeaveBalances: z.boolean().optional().default(false),
		includeRaw: z.boolean().optional().default(false),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const [person, assignments, leave] = await Promise.all([
				client.get(`/people/${args.personId}`),
				args.includeAssignments
					? client
							.post(
								`/people/${args.personId}/assignments/search`,
								{ activeOnly: true },
								{ params: { page: 1, pageSize: 200 } },
							)
							.then((response) => ({
								items: itemsFromResponse<any>(response.data).map(summarizeAssignment),
								error: null,
							}))
							.catch((error) => ({ items: [], error: error.message }))
					: Promise.resolve(null),
				args.includeLeaveBalances
					? client
							.post(`/people/${args.personId}/leave`, {})
							.then((response) => ({
								items: itemsFromResponse<any>(response.data).map((item) => ({
									project: keyName(item?.project),
									task: keyName(item?.task),
									balanceHours: toNumberOrNull(item?.budget),
									usedHours: toNumberOrNull(item?.actuals),
								})),
								error: null,
							}))
							.catch((error) => ({ items: [], error: error.message }))
					: Promise.resolve(null),
			]);
			return {
				success: true,
				person: summarizePerson(person.data),
				assignments,
				leaveBalances: leave,
				raw: args.includeRaw ? person.data : undefined,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

// Organizations ---------------------------------------------------------------

export const searchOrganizationsTool = {
	name: "unanet_search_organizations",
	description:
		"Search Unanet organizations (customers, vendors, internal orgs) by name/code, with active/legal-entity/vendor filters. Read-only.",
	inputSchema: z.object({
		name: z.string().optional(),
		code: z.string().optional(),
		active: z.boolean().optional(),
		legalEntity: z.boolean().optional(),
		financialOrg: z.boolean().optional(),
		hasVendorProfile: z.boolean().optional(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 500),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const { page, pageSize, ...criteria } = args;
			const response = await client.post("/organizations/search", compact(criteria), {
				params: { page, pageSize },
			});
			const organizations = itemsFromResponse<any>(response.data).map(summarizeOrganization);
			return { success: true, count: organizations.length, paging: pageInfo(response.data), organizations };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getOrganizationTool = {
	name: "unanet_get_organization",
	description:
		"Read one Unanet organization by key, optionally with its contacts and addresses. Read-only. (Supersedes unanet_get_company_info.)",
	inputSchema: z.object({
		organizationId: z.number().int().positive(),
		includeContacts: z.boolean().optional().default(false),
		includeAddresses: z.boolean().optional().default(false),
		includeRaw: z.boolean().optional().default(false),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const optional = (enabled: boolean, path: string, map: (item: any) => any, paged = true) =>
				enabled
					? client
							.get(path, paged ? { params: { page: 1, pageSize: 200 } } : undefined)
							.then((response) => ({
								items: itemsFromResponse<any>(response.data).map(map),
								error: null,
							}))
							.catch((error) => ({ items: [], error: error.message }))
					: Promise.resolve(null);
			const [org, contacts, addresses] = await Promise.all([
				client.get(`/organizations/${args.organizationId}`),
				optional(args.includeContacts, `/organizations/${args.organizationId}/contacts`, (contact) => ({
					key: contact?.key ?? null,
					name: [contact?.first, contact?.middle, contact?.last].filter(Boolean).join(" ") || null,
					title: contact?.title ?? null,
					active: contact?.active ?? null,
					primaryEmail: contact?.primaryEmail ?? null,
					primaryPhone: contact?.primaryPhone ?? null,
					defaultBillTo: contact?.defaultBillTo ?? null,
					defaultRemitTo: contact?.defaultRemitTo ?? null,
				})),
				optional(args.includeAddresses, `/organizations/${args.organizationId}/addresses`, (address) => address, false),
			]);
			return {
				success: true,
				organization: summarizeOrganization(org.data),
				contacts,
				addresses,
				raw: args.includeRaw ? org.data : undefined,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

// Contracts -------------------------------------------------------------------

export const searchContractsTool = {
	name: "unanet_search_contracts",
	description:
		"Search Unanet contracts by code/title, status, type, customer org, NAICS, or award dates. Read-only.",
	inputSchema: z.object({
		contractCode: z.string().optional(),
		contractTitle: z.string().optional(),
		contractKeys: z.array(z.number().int().positive()).optional(),
		contractStatusKeys: z.array(z.number().int().positive()).optional(),
		contractTypeKeys: z.array(z.number().int().positive()).optional(),
		orgKeys: z.array(z.number().int().positive()).optional().describe("Customer organization keys."),
		legalEntityKeys: z.array(z.number().int().positive()).optional(),
		primaryNaicsCodeKeys: z.array(z.number().int().positive()).optional(),
		awardBeginDate: isoDateSchema.optional(),
		awardEndDate: isoDateSchema.optional(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 500),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const { page, pageSize, ...criteria } = args;
			// ContractSearchModel marks the key arrays as required; send empty arrays.
			const body = {
				legalEntityKeys: [],
				contractKeys: [],
				contractTypeKeys: [],
				contractStatusKeys: [],
				contractClauseKeys: [],
				orgKeys: [],
				primaryNaicsCodeKeys: [],
				supportingNaicsCodeKeys: [],
				billingAnalystKeys: [],
				...compact(criteria),
			};
			const response = await client.post("/contracts/search", body, {
				params: { page, pageSize },
			});
			const contracts = itemsFromResponse<any>(response.data).map(summarizeContract);
			return { success: true, count: contracts.length, paging: pageInfo(response.data), contracts };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getContractTool = {
	name: "unanet_get_contract",
	description:
		"Read one Unanet contract by key, optionally with its associated projects and modifications. Read-only.",
	inputSchema: z.object({
		contractId: z.number().int().positive(),
		includeProjects: z.boolean().optional().default(true),
		includeMods: z.boolean().optional().default(false),
		includeRaw: z.boolean().optional().default(false),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const optional = (enabled: boolean, path: string) =>
				enabled
					? client
							.get(path)
							.then((response) => ({ items: itemsFromResponse<any>(response.data), error: null }))
							.catch((error) => ({ items: [], error: error.message }))
					: Promise.resolve(null);
			const [contract, projects, mods] = await Promise.all([
				client.get(`/contracts/${args.contractId}`),
				optional(args.includeProjects, `/contracts/${args.contractId}/projects`),
				optional(args.includeMods, `/contracts/${args.contractId}/mods`),
			]);
			return {
				success: true,
				contract: summarizeContract(contract.data),
				projects,
				mods,
				raw: args.includeRaw ? contract.data : undefined,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

// Projects (beyond projects.ts) ----------------------------------------------

export const getProjectTasksTool = {
	name: "unanet_get_project_tasks",
	description:
		"List the tasks (WBS) of a Unanet project, or search tasks across projects by name/number. Read-only.",
	inputSchema: z.object({
		projectId: z.number().int().positive().optional().describe("Project key. Omit to search across projects."),
		projectKeys: z.array(z.number().int().positive()).optional(),
		name: z.string().optional().describe("Task name contains."),
		taskNumber: z.string().optional(),
		active: z.boolean().optional(),
		page: pageSchema,
		pageSize: pageSizeSchema(100, 500),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const params = { page: args.page, pageSize: args.pageSize };
			const useSearch = !args.projectId || args.name || args.taskNumber || args.active !== undefined;
			const response = useSearch
				? await client.post(
						"/projects/tasks/search",
						compact({
							projectKeys: args.projectKeys ?? (args.projectId ? [args.projectId] : undefined),
							name: args.name,
							taskNumber: args.taskNumber,
							active: args.active,
						}),
						{ params },
					)
				: await client.get(`/projects/${args.projectId}/tasks`, { params });
			const tasks = itemsFromResponse<any>(response.data).map(summarizeTask);
			return { success: true, count: tasks.length, paging: pageInfo(response.data), tasks };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getProjectAssignmentsTool = {
	name: "unanet_get_project_assignments",
	description:
		"List who is assigned to a Unanet project (people assignments), optionally filtered by person, task or date range. Read-only.",
	inputSchema: z.object({
		projectId: z.number().int().positive(),
		personKeys: z.array(z.number().int().positive()).optional(),
		taskKeys: z.array(z.number().int().positive()).optional(),
		activeOnly: z.boolean().optional().default(true),
		startDate: isoDateSchema.optional().describe("Assignment overlap range start; requires endDate too."),
		endDate: isoDateSchema.optional().describe("Assignment overlap range end; requires startDate too."),
		page: pageSchema,
		pageSize: pageSizeSchema(100, 500),
	}).refine((value) => Boolean(value.startDate) === Boolean(value.endDate), {
		message: "startDate and endDate must be provided together (DateRangeModel requires both).",
		path: ["startDate"],
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.post(
				`/projects/${args.projectId}/people-assignments/search`,
				compact({
					personKeys: args.personKeys,
					taskKeys: args.taskKeys,
					activeOnly: args.activeOnly,
					dateRange: dateRange(args.startDate, args.endDate),
				}),
				{ params: { page: args.page, pageSize: args.pageSize } },
			);
			const assignments = itemsFromResponse<any>(response.data).map(summarizeAssignment);
			return { success: true, count: assignments.length, paging: pageInfo(response.data), assignments };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getProjectNotesTool = {
	name: "unanet_get_project_notes",
	description: "List notes recorded on a Unanet project. Read-only.",
	inputSchema: z.object({
		projectId: z.number().int().positive(),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(`/projects/${args.projectId}/notes`);
			const notes = itemsFromResponse<any>(response.data).map(summarizeNote);
			return { success: true, count: notes.length, paging: pageInfo(response.data), notes };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getProjectAdminsTool = {
	name: "unanet_get_project_admins",
	description:
		"Read the administrative roles on a Unanet project: primary/alternate managers, project approvers, leads, billing managers, customers, viewers. Read-only.",
	inputSchema: z.object({
		projectId: z.number().int().positive(),
		roles: z
			.array(
				z.enum([
					"managers",
					"project-approvers",
					"leads",
					"billing-managers",
					"customers",
					"viewers",
					"resource-planners",
					"resource-assigners",
				]),
			)
			.optional()
			.default(["managers", "project-approvers", "leads"]),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const results = await Promise.all(
				args.roles.map(async (role: string) => {
					const alternateSegment = ["project-approvers", "customers"].includes(role)
						? "alternates"
						: "alternate";
					const load = (segment: string) =>
						client
							.get(
								`/projects/${args.projectId}/admin/${role}/${segment}`,
								// Only the singular `alternate` lists are paged in the spec;
								// `primary` and the plural `alternates` take no query params.
								segment === "alternate" ? { params: { page: 1, pageSize: 100 } } : undefined,
							)
							.then((response) => {
								const data = response.data;
								const items = Array.isArray(data) || data?.items ? itemsFromResponse<any>(data) : [data];
								return items.filter(Boolean).map((item) => ({
									key: item?.key ?? item?.person?.key ?? null,
									name: personName(item) ?? personName(item?.person) ?? keyName(item?.person).name ?? item?.name ?? null,
								}));
							})
							.catch((error) => ({ error: error.message }));
					const [primary, alternate] = await Promise.all([load("primary"), load(alternateSegment)]);
					return { role, primary, alternate };
				}),
			);
			const failed = results.filter(
				(result: any) => !Array.isArray(result.primary) && !Array.isArray(result.alternate),
			);
			return {
				success: failed.length < results.length,
				projectId: args.projectId,
				admins: results,
				endpointErrors: results.flatMap((result: any) =>
					[
						!Array.isArray(result.primary) ? { role: result.role, segment: "primary", error: result.primary.error } : null,
						!Array.isArray(result.alternate) ? { role: result.role, segment: "alternate", error: result.alternate.error } : null,
					].filter(Boolean),
				),
				...(failed.length === results.length ? { error: "Every project admin endpoint failed; see endpointErrors." } : {}),
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

// Invoices --------------------------------------------------------------------

export const searchInvoicesTool = {
	name: "unanet_search_invoices",
	description:
		"Search Unanet customer invoices by number, keys, or invoice/created/completed/posted date ranges. Read-only.",
	inputSchema: z.object({
		invoiceNumber: z.string().optional(),
		invoiceKeys: z.array(z.number().int().positive()).optional(),
		invoiceDateStart: isoDateSchema.optional(),
		invoiceDateEnd: isoDateSchema.optional(),
		completedDateStart: isoDateSchema.optional(),
		completedDateEnd: isoDateSchema.optional(),
		postedDateStart: isoDateSchema.optional(),
		postedDateEnd: isoDateSchema.optional(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 500),
	}).superRefine((value, context) => {
		for (const field of ["invoiceDate", "completedDate", "postedDate"]) {
			const start = (value as any)[`${field}Start`];
			const end = (value as any)[`${field}End`];
			if (Boolean(start) !== Boolean(end)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [`${field}Start`],
					message: `${field}Start and ${field}End must be provided together (DateRangeModel requires both).`,
				});
			}
		}
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.post(
				"/invoices/search",
				compact({
					invoiceNumber: args.invoiceNumber,
					invoiceKeys: args.invoiceKeys,
					invoiceDate: dateRange(args.invoiceDateStart, args.invoiceDateEnd),
					completedDate: dateRange(args.completedDateStart, args.completedDateEnd),
					postedDate: dateRange(args.postedDateStart, args.postedDateEnd),
				}),
				{ params: { page: args.page, pageSize: args.pageSize } },
			);
			const invoices = itemsFromResponse<any>(response.data).map(summarizeInvoice);
			return { success: true, count: invoices.length, paging: pageInfo(response.data), invoices };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getInvoiceTool = {
	name: "unanet_get_invoice",
	description:
		"Read one Unanet customer invoice by key, optionally with its status history and transaction summary. Read-only.",
	inputSchema: z.object({
		invoiceId: z.number().int().positive(),
		includeHistory: z.boolean().optional().default(false),
		includeTransactionSummary: z.boolean().optional().default(false),
		includeRaw: z.boolean().optional().default(false),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const optional = (enabled: boolean, path: string, paged: boolean) =>
				enabled
					? client
							.get(path, paged ? { params: { page: 1, pageSize: 100 } } : undefined)
							.then((response) => ({ data: response.data, error: null }))
							.catch((error) => ({ data: null, error: error.message }))
					: Promise.resolve(null);
			const [invoice, history, summary] = await Promise.all([
				client.get(`/invoices/${args.invoiceId}`),
				optional(args.includeHistory, `/invoices/${args.invoiceId}/history`, true),
				optional(args.includeTransactionSummary, `/invoices/${args.invoiceId}/transaction-summary`, false),
			]);
			return {
				success: true,
				invoice: summarizeInvoice(invoice.data),
				history: history ? { items: itemsFromResponse<any>(history.data), error: history.error } : null,
				transactionSummary: summary,
				raw: args.includeRaw ? invoice.data : undefined,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

// Reference data --------------------------------------------------------------

const REFERENCE_KINDS = {
	laborCategories: { path: "/labor-categories", searchParam: "name" },
	projectTypes: { path: "/project-types", searchParam: "name" },
	projectStatuses: { path: "/project-statuses", searchParam: "name" },
	payCodes: { path: "/pay-codes", searchParam: null },
	locations: { path: "/locations", searchParam: "name" },
	employeeTypes: { path: "/employee-types", searchParam: "code" },
	organizationTypes: { path: "/organization-types", searchParam: "name" },
	occupations: { path: "/occupations", searchParam: "name" },
	paymentTerms: { path: "/payment-terms", searchParam: null },
	industries: { path: "/industries", searchParam: null },
	naicsCodes: { path: "/naics-codes", searchParam: null },
	socioeconomicStatuses: { path: "/socioeconomic-statuses", searchParam: null },
	costStructures: { path: "/cost-structures", searchParam: null },
	costElements: { path: "/cost-elements", searchParam: null },
	changeReasons: { path: "/change-reasons", searchParam: null },
	expenseVendors: { path: "/expense-vendors", searchParam: null },
	vatLocations: { path: "/expenses/vat-locations", searchParam: null },
	mileageRates: { path: "/mileage", searchParam: "description" },
	accounts: { path: "/accounts", searchParam: "name" },
	statisticalAccounts: { path: "/statistical-accounts", searchParam: "description" },
	businessWeeks: { path: "/business-weeks", searchParam: "name" },
	fiscalYears: { path: "/calendar/fiscal/years", searchParam: null },
	timePeriodSetups: { path: "/time-period-setups", searchParam: null },
	skillTypes: { path: "/skill-types", searchParam: "name" },
	skillLevels: { path: "/skill-levels", searchParam: "name" },
	planSetNames: { path: "/plan-set-names", searchParam: null },
	invoiceFormats: { path: "/invoice-formats", searchParam: null },
	contractTypes: { path: "/contracts/types", searchParam: null },
	contractStatuses: { path: "/contracts/statuses", searchParam: null },
	customLinks: { path: "/custom-links", searchParam: null },
	expenseTypes: { path: "/expense-types", searchParam: "name" },
	paymentMethods: { path: "/payment-methods", searchParam: null },
	currencies: { path: "/currencies/currency-codes", searchParam: "currencyCode" },
} as const;

type ReferenceKind = keyof typeof REFERENCE_KINDS;
const REFERENCE_KIND_NAMES = Object.keys(REFERENCE_KINDS) as [ReferenceKind, ...ReferenceKind[]];

function summarizeReferenceItem(item: any) {
	if (!item || typeof item !== "object") return item;
	return compact(
		{
			key: item.key ?? null,
			name: item.name ?? item.description ?? item.title ?? item.code ?? null,
			code: item.code ?? item.number ?? undefined,
			description: item.name && item.description ? item.description : undefined,
			active: item.active ?? item.enabled ?? item.open ?? undefined,
			// Keep a few kind-specific fields that matter for downstream writes.
			wizardType: item.wizardType,
			billable: item.billable,
			administrative: item.administrative,
			exemptUsage: item.exemptUsage,
			factor: item.factor,
			reimbursable: item.reimbursable,
			paymentMethodCode: item.paymentMethodCode,
			decimals: item.decimals,
			type: item.type,
			beginDate: item.beginDate,
			endDate: item.endDate,
			url: item.url,
		},
		{ dropNull: false },
	);
}

export const getReferenceDataTool = {
	name: "unanet_get_reference_data",
	description: `Read a Unanet reference/lookup list by kind. Kinds: ${REFERENCE_KIND_NAMES.join(", ")}. Use these keys when other tools need e.g. laborCategoryKey, payCodeKey, projectTypeKey, expenseTypeKey. Read-only.`,
	inputSchema: z.object({
		kind: z.enum(REFERENCE_KIND_NAMES),
		search: z.string().optional().describe("Name/code filter where the endpoint supports it."),
		includeInactive: z.boolean().optional().default(false),
		page: pageSchema,
		pageSize: pageSizeSchema(100, 500),
		includeRaw: z.boolean().optional().default(false),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const kind = REFERENCE_KINDS[args.kind as ReferenceKind];
			const client = createUnanetClient(auth);
			const params: Record<string, unknown> = { page: args.page, pageSize: args.pageSize };
			if (kind.searchParam && args.search) params[kind.searchParam] = args.search;
			// Active-filter parameter names differ per endpoint; send the ones each accepts.
			if (!args.includeInactive) {
				if (["laborCategories", "projectTypes", "locations", "payCodes", "paymentTerms", "costStructures", "customLinks"].includes(args.kind)) params.active = true;
				if (["expenseTypes"].includes(args.kind)) params.enabled = true;
				if (["paymentMethods", "vatLocations"].includes(args.kind)) params.activeOnly = true;
				if (["projectStatuses"].includes(args.kind)) params.open = true;
			} else if (["accounts", "statisticalAccounts", "occupations"].includes(args.kind)) {
				params.includeInactive = true;
			}
			const response = await client.get(kind.path, { params });
			const raw = itemsFromResponse<any>(response.data);
			const items = raw.map(summarizeReferenceItem);
			return {
				success: true,
				kind: args.kind,
				count: items.length,
				paging: pageInfo(response.data),
				items,
				raw: args.includeRaw ? raw : undefined,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const pingTool = {
	name: "unanet_ping",
	description:
		"Health check: confirms the Unanet Platform REST API is reachable and returns its version. Read-only, no data access.",
	inputSchema: z.object({}),
	handler: async (_args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const [ping, version] = await Promise.all([
				client.get("/ping").then((r) => r.data).catch((error) => ({ error: error.message })),
				client.get("/ping/version").then((r) => r.data).catch((error) => ({ error: error.message })),
			]);
			return { success: true, baseUrl: auth.baseUrl, ping, version };
		} catch (error) {
			return errorResult(error);
		}
	},
};
