import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";

// Create contact tool
export const createContactTool = {
	name: "unanet_create_contact",
	description:
		"Create a contact under a Platform REST organization. Requires organizationId.",
	inputSchema: z.object({
		organizationId: z
			.string()
			.describe("The organization key/id to create the contact under"),
		firstName: z.string(),
		lastName: z.string(),
		email: z.string().email(),
		phone: z.string().optional(),
		title: z.string().optional(),
		notes: z.string().optional(),
		confirm: z
			.literal(true)
			.describe("Must be true to confirm this live contact creation write."),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return {
				success: false,
				error: "confirm=true is required before creating a contact.",
			};
		}

		const client = createUnanetClient(auth);

		try {
			const contactData = {
				firstName: args.firstName,
				lastName: args.lastName,
				email: args.email,
				phone: args.phone,
				title: args.title,
				comments: args.notes,
			};

			const response = await client.post(
				`/organizations/${args.organizationId}/contacts`,
				contactData,
			);

			return {
				success: true,
				message: "Contact created successfully",
				contactId: response.data.id ?? response.data.key,
				contact: response.data,
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};

// Update lead tool
export const updateLeadTool = {
	name: "unanet_update_lead",
	description:
		"Unsupported: Platform REST does not expose the legacy lead endpoint",
	inputSchema: z.object({
		leadId: z.string(),
		status: z.enum(["New", "Qualified", "Proposal", "Won", "Lost"]).optional(),
		value: z.number().optional(),
		probability: z.number().min(0).max(100).optional(),
		notes: z.string().optional(),
	}),
	handler: async (args: any, _auth: UnanetAuth) => ({
		success: false,
		leadId: args.leadId,
		error:
			"Platform REST OpenAPI does not expose /leads. This legacy CRM lead tool is disabled until a real Platform endpoint is identified.",
	}),
};

// Create opportunity tool
export const createOpportunityTool = {
	name: "unanet_create_opportunity",
	description:
		"Unsupported: Platform REST does not expose the legacy opportunity endpoint",
	inputSchema: z.object({
		name: z.string(),
		description: z.string().optional(),
		value: z.number().positive(),
		probability: z.number().min(0).max(100),
		stage: z.string(),
		closeDate: z.string().describe("Expected close date in YYYY-MM-DD format"),
		contactId: z.string().optional(),
		notes: z.string().optional(),
	}),
	handler: async (args: any, _auth: UnanetAuth) => ({
		success: false,
		name: args.name,
		error:
			"Platform REST OpenAPI does not expose /opportunities. This legacy CRM opportunity tool is disabled until a real Platform endpoint is identified.",
	}),
};

// Get company info tool
export const getCompanyInfoTool = {
	name: "unanet_get_company_info",
	description:
		"Get detailed information about a Platform REST organization/company",
	inputSchema: z.object({
		companyId: z.string().describe("The organization/company key/id"),
		includeContacts: z.boolean().optional().default(false),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const [companyResponse, contactsResponse] = await Promise.all([
				client.get(`/organizations/${args.companyId}`),
				args.includeContacts
					? client
							.get(`/organizations/${args.companyId}/contacts`)
							.catch((error) => ({
								data: { error: error.message },
							}))
					: Promise.resolve(undefined),
			]);

			return {
				success: true,
				company: companyResponse.data,
				contacts: contactsResponse?.data,
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};
