import axios, { type AxiosInstance } from "axios";
import { z } from "zod";

export const DEFAULT_NAVA_UNANET_BASE_URL = "https://navapbc.unanet.biz";
export const DEFAULT_UNANET_APP_NAME = "NavaUnanetMCP";
const PLATFORM_TOKEN_CACHE_SKEW_MS = 30_000;
const DEFAULT_PLATFORM_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface UnanetAuth {
	username: string;
	password: string;
	apiKey?: string;
	firmCode?: string;
	baseUrl: string;
	appName?: string;
}

export interface BaseUrlValidationOptions {
	allowInsecureLocalMock?: boolean;
	allowedBaseUrls?: string[];
}

interface PlatformTokenCacheEntry {
	token: string;
	expiresAt: number;
}

const platformTokenCache = new Map<string, PlatformTokenCacheEntry>();

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

export function validateLegacyAuth(auth: UnanetAuth): void {
	if (!auth.apiKey) {
		throw new Error(
			"UNANET_API_KEY environment variable is required for legacy API tools",
		);
	}
	if (!auth.firmCode) {
		throw new Error(
			"UNANET_FIRM_CODE environment variable is required for legacy API tools",
		);
	}
}

function safeUrlForLog(url?: string): string {
	return (url || "")
		.replace(/password=([^&]+)/gi, "password=***")
		.replace(/apikey=([^&]+)/gi, "apikey=***")
		.replace(/token=([^&]+)/gi, "token=***");
}

function apiError(message: string, status?: number): Error {
	const err = new Error(message);
	if (status !== undefined) {
		(err as Error & { status?: number }).status = status;
	}
	return err;
}

function handleApiError(error: any): never {
	if (error.response) {
		const status = error.response.status;
		const statusText = error.response.statusText;

		console.error(`[Unanet API] Response error: ${status} ${statusText}`);

		switch (status) {
			case 401:
				throw apiError(
					"Authentication failed. Please check your credentials.",
					status,
				);
			case 403:
				throw apiError(
					"Access forbidden. Please check your API permissions.",
					status,
				);
			case 429:
				throw apiError("Rate limit exceeded. Please try again later.", status);
			case 404:
				throw apiError(
					"Resource not found. Please check the ID and try again.",
					status,
				);
			case 500:
			case 502:
			case 503:
				throw apiError(
					"Unanet service is temporarily unavailable. Please try again later.",
					status,
				);
			default:
				throw apiError(`API error: ${status} ${statusText}`, status);
		}
	}

	if (error.request) {
		throw new Error(
			"No response from Unanet API. Please check your network connection and base URL.",
		);
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

export function createUnanetClient(auth: UnanetAuth): AxiosInstance {
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
	return `${auth.baseUrl}|${auth.username}|${auth.appName || DEFAULT_UNANET_APP_NAME}`;
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

	const client = createPlatformRestClient(auth);
	const response = await client.post("/platform/rest/login", {
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
}

export function clearPlatformTokenCache(): void {
	platformTokenCache.clear();
}
