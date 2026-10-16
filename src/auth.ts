import axios, { type AxiosInstance } from "axios";
import { z } from "zod";

export const DEFAULT_NAVA_UNANET_BASE_URL = "https://navapbc.unanet.biz";
export const DEFAULT_UNANET_APP_NAME = "NavaUnanetMCP";
const PLATFORM_TOKEN_CACHE_SKEW_MS = 30_000;
const DEFAULT_PLATFORM_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface UnanetAuth {
	username: string;
	password: string;
	baseUrl: string;
	appName?: string;
	// Optional tenant id for the login body. Omitted unless UNANET_CUSTOMER_ID
	// is set: the OpenAPI spec marks it optional and the Nava tenant logs in
	// without it, so nothing is guessed from the base URL.
	customerId?: string;
}

export type UnanetClient = AxiosInstance;

export interface BaseUrlValidationOptions {
	allowInsecureLocalMock?: boolean;
	allowedBaseUrls?: string[];
}

interface PlatformTokenCacheEntry {
	token: string;
	expiresAt: number;
}

const platformTokenCache = new Map<string, PlatformTokenCacheEntry>();
// In-flight logins keyed like the token cache, so N concurrent requests on a
// cold cache share ONE login instead of each posting /login (Unanet rejects
// bursts of concurrent logins with 400).
const platformLoginInFlight = new Map<string, Promise<string>>();

const platformLoginTokenPayloadSchema = z
	.object({
		token: z.string().min(1).optional(),
		expiresIn: z.number().positive().optional(),
		expiresInSeconds: z.number().positive().optional(),
		expiresAt: z.string().optional(),
		expiration: z.string().optional(),
	})
	.passthrough();

const platformLoginResponseSchema = z
	.object({
		token: z.string().min(1).optional(),
		message: platformLoginTokenPayloadSchema.optional(),
	})
	.passthrough()
	.refine((value) => value.token || value.message?.token, {
		message: "Login response must include a bearer token",
	});

function isLocalMockHost(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "localhost";
}

function normalizeOrigin(rawUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error("UNANET_BASE_URL is invalid");
	}

	if (parsed.username || parsed.password) {
		throw new Error("UNANET_BASE_URL must not contain embedded credentials");
	}

	if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
		throw new Error(
			"UNANET_BASE_URL must be an origin only, for example https://navapbc.unanet.biz",
		);
	}

	return parsed;
}

function allowedBaseUrlsFromEnv(): string[] {
	const configured = process.env.UNANET_ALLOWED_BASE_URLS;
	if (!configured) {
		return [DEFAULT_NAVA_UNANET_BASE_URL];
	}

	return [
		DEFAULT_NAVA_UNANET_BASE_URL,
		...configured
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
	];
}

export function isEnabled(value?: string): boolean {
	return value?.toLowerCase() === "true";
}

export function validateUnanetBaseUrl(
	rawBaseUrl: string,
	options: BaseUrlValidationOptions = {},
): string {
	if (!rawBaseUrl) {
		throw new Error("UNANET_BASE_URL environment variable is required");
	}

	const parsed = normalizeOrigin(rawBaseUrl);
	const origin = parsed.origin;

	if (isLocalMockHost(parsed.hostname)) {
		if (parsed.protocol !== "http:") {
			throw new Error(
				"Local mock UNANET_BASE_URL must use http://127.0.0.1 or http://localhost",
			);
		}
		if (!options.allowInsecureLocalMock) {
			throw new Error(
				"Local insecure mock URLs require UNANET_ALLOW_INSECURE_LOCAL_MOCK=true",
			);
		}
		return origin;
	}

	if (parsed.protocol !== "https:") {
		throw new Error("Production UNANET_BASE_URL must use HTTPS");
	}

	const allowedBaseUrls = options.allowedBaseUrls ?? allowedBaseUrlsFromEnv();
	const normalizedAllowedOrigins = allowedBaseUrls.map(
		(value) => normalizeOrigin(value).origin,
	);
	if (!normalizedAllowedOrigins.includes(origin)) {
		throw new Error(
			`UNANET_BASE_URL host is not allowed. Allowed origins: ${normalizedAllowedOrigins.join(", ")}`,
		);
	}

	return origin;
}

export function validateAuth(
	auth: UnanetAuth,
	options: BaseUrlValidationOptions = {},
): void {
	if (!auth.username) {
		throw new Error("UNANET_USERNAME environment variable is required");
	}
	if (!auth.password) {
		throw new Error("UNANET_PASSWORD environment variable is required");
	}
	if (!auth.baseUrl) {
		throw new Error("UNANET_BASE_URL environment variable is required");
	}

	validateUnanetBaseUrl(auth.baseUrl, options);
}

function safeUrlForLog(url?: string): string {
	return (url || "")
		.replace(/password=([^&]+)/gi, "password=***")
		.replace(/apikey=([^&]+)/gi, "apikey=***")
		.replace(/token=([^&]+)/gi, "token=***");
}

// Callers URL-encode path parameters, but dot segments survive encoding and
// the HTTP client collapses them, which would send the request to a different
// resource than the one named. Refuse them for every tool.
function assertNoDotSegments(url?: string): void {
	if (!url) return;
	for (const segment of url.split("?")[0].split("/")) {
		let decoded = segment;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			// Keep the raw segment.
		}
		if (decoded === "." || decoded === "..") {
			throw new Error("Refusing a request path that contains a dot segment.");
		}
	}
}

type ApiError = Error & { status?: number; method?: string; noResponse?: boolean };

function apiError(message: string, status?: number, method?: string): Error {
	const err: ApiError = new Error(message);
	if (status !== undefined) err.status = status;
	if (method) err.method = method;
	return err;
}

const MUTATING_METHODS = new Set(["post", "put", "patch", "delete"]);

// True when a MUTATING request may have been applied by Unanet even though it
// failed: it was sent and no response came back, or Unanet answered 5xx. A
// failed read, or a failure before the request is sent (login, setup), is not.
export function isOutcomeUnknown(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { noResponse, status, method } = error as ApiError;
	if (!method || !MUTATING_METHODS.has(method)) return false;
	return noResponse === true || (typeof status === "number" && status >= 500);
}

/**
 * Pull Unanet's own error description out of a platform REST error body, e.g.
 * {errors:[{code:"FORBIDDEN_INSUFFICIENT_LICENSE",description:"Insufficient
 * license for API access."}]}. Returns "" when the body has no usable detail.
 */
function unanetErrorDetail(data: unknown): string {
	if (!data || typeof data !== "object") return "";
	const body = data as {
		errors?: Array<{ code?: string; description?: string }>;
		code?: string;
		description?: string;
	};
	const first = body.errors?.[0];
	const description = first?.description ?? body.description ?? "";
	const code = first?.code ?? body.code ?? "";
	if (!description && !code) return "";
	return ` Unanet says: ${[code, description].filter(Boolean).join(" — ")}`;
}

function handleApiError(error: any): never {
	const method = String(error.config?.method ?? "").toLowerCase();
	if (error.response) {
		const status = error.response.status;
		const statusText = error.response.statusText;
		const detail = unanetErrorDetail(error.response.data);

		console.error(`[Unanet API] Response error: ${status} ${statusText}`);

		switch (status) {
			case 401:
				throw apiError(
					`Authentication failed. Please check your credentials.${detail}`,
					status,
					method,
				);
			case 403:
				throw apiError(
					`Access forbidden. Your Unanet account does not have permission for this operation.${detail}`,
					status,
					method,
				);
			case 429:
				throw apiError("Rate limit exceeded. Please try again later.", status, method);
			case 404:
				throw apiError(
					"Resource not found. Please check the ID and try again.",
					status,
					method,
				);
			default:
				// Client errors (400, 409, 422...) carry Unanet's code and description, which
				// explain a rejected request. Server errors (5xx) stay generic: their
				// descriptions are for Unanet support staff.
				throw apiError(
					`API error: ${status} ${statusText}${status < 500 ? detail : ""}`,
					status,
					method,
				);
		}
	}

	if (error.request) {
		const noResponse: ApiError = new Error(
			"No response from Unanet API. Please check your network connection and base URL.",
		);
		noResponse.noResponse = true;
		noResponse.method = method;
		throw noResponse;
	}

	throw new Error(`Request setup error: ${error.message}`);
}

function addSafeInterceptors(client: AxiosInstance): AxiosInstance {
	client.interceptors.request.use(
		(config) => {
			const safeUrl = safeUrlForLog(config.url);
			console.error(`[Unanet API] ${config.method?.toUpperCase()} ${safeUrl}`);
			return config;
		},
		(error) => {
			console.error("[Unanet API] Request error:", error.message);
			return Promise.reject(error);
		},
	);

	client.interceptors.response.use(
		(response) => response,
		(error) => handleApiError(error),
	);

	return client;
}

export function createUnanetClient(auth: UnanetAuth): UnanetClient {
	const baseURL = validateUnanetBaseUrl(auth.baseUrl, {
		allowInsecureLocalMock: isEnabled(
			process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK,
		),
	});

	const client = axios.create({
		baseURL,
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			"X-Una-App": auth.appName || DEFAULT_UNANET_APP_NAME,
		},
		timeout: 30000,
	});

	client.interceptors.request.use(async (config) => {
		assertNoDotSegments(config.url);
		const token = await getPlatformBearerToken(auth);
		config.headers.Authorization = `Bearer ${token}`;
		if (
			config.url?.startsWith("/") &&
			!config.url.startsWith("/platform/rest/")
		) {
			config.url = `/platform/rest${config.url}`;
		}

		return config;
	});

	return addSafeInterceptors(client);
}

export function createPlatformRestClient(
	auth: UnanetAuth,
	bearerToken?: string,
): AxiosInstance {
	const baseURL = validateUnanetBaseUrl(auth.baseUrl, {
		allowInsecureLocalMock: isEnabled(
			process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK,
		),
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		"X-Una-App": auth.appName || DEFAULT_UNANET_APP_NAME,
	};

	if (bearerToken) {
		headers.Authorization = `Bearer ${bearerToken}`;
	}

	const client = axios.create({
		baseURL,
		headers,
		timeout: 30000,
	});

	return addSafeInterceptors(client);
}

function platformTokenCacheKey(auth: UnanetAuth): string {
	return `${auth.baseUrl}|${auth.username}|${auth.appName || DEFAULT_UNANET_APP_NAME}|${auth.customerId ?? ""}`;
}

function getPlatformTokenExpiration(
	message: z.infer<typeof platformLoginTokenPayloadSchema>,
): number {
	const now = Date.now();
	const ttlSeconds = message.expiresIn ?? message.expiresInSeconds;
	if (ttlSeconds) {
		return now + ttlSeconds * 1000;
	}

	const timestamp = message.expiresAt ?? message.expiration;
	if (timestamp) {
		const parsed = Date.parse(timestamp);
		if (!Number.isNaN(parsed)) {
			return parsed;
		}
	}

	return now + DEFAULT_PLATFORM_TOKEN_TTL_MS;
}


export async function getPlatformBearerToken(
	auth: UnanetAuth,
): Promise<string> {
	const cacheKey = platformTokenCacheKey(auth);
	const cached = platformTokenCache.get(cacheKey);
	if (cached && cached.expiresAt - PLATFORM_TOKEN_CACHE_SKEW_MS > Date.now()) {
		return cached.token;
	}

	const inFlight = platformLoginInFlight.get(cacheKey);
	if (inFlight) return inFlight;

	const login = (async () => {
		const client = createPlatformRestClient(auth);
		const response = await client.post("/platform/rest/login", {
			...(auth.customerId ? { customerId: auth.customerId } : {}),
			username: auth.username,
			password: auth.password,
		});

		const parsed = platformLoginResponseSchema.safeParse(response.data);
		if (!parsed.success) {
			throw new Error("Unexpected Unanet login response shape");
		}

		const tokenPayload = parsed.data.message ?? parsed.data;
		const token = tokenPayload.token;
		if (!token) {
			throw new Error("Unexpected Unanet login response shape");
		}

		platformTokenCache.set(cacheKey, {
			token,
			expiresAt: getPlatformTokenExpiration(tokenPayload),
		});

		return token;
	})();

	platformLoginInFlight.set(cacheKey, login);
	try {
		return await login;
	} finally {
		platformLoginInFlight.delete(cacheKey);
	}
}

export function clearPlatformTokenCache(): void {
	platformTokenCache.clear();
	platformLoginInFlight.clear();
}
