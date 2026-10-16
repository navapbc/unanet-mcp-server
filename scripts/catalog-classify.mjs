// Read/write/sensitive classification for the Unanet OpenAPI operations.
// Used by build-api-catalog.mjs and unit-tested directly. `unanet_api_read`
// executes only operations classified "read"; nothing executes "write" or
// "sensitive" operations generically (there is no generic writer).

// Operations that advance workflows, destroy data, or touch auth.
const SENSITIVE_PATH = /\/(submit|approve|disapprove|complete|posts?|void|reverse|cancel|extract|send|email|lock|unlock|close|reopen|open|activate|deactivate|reset|purge|import|reject|retract|restore|defer|return|reconcile|scan|register|login|logout|token|password|pay|payout|payment-portal|exclude|include|users|api-keys?|credentials?)(\/|$)/i;
const SENSITIVE_SUMMARY = /\b(delet|remov|submit|approv|disapprov|void|revers|cancel|extract|send|email|lock|purge|reset|reject|retract|restor|defer|reconcil|password|token|login|\bpost|payout|\bpay\b|payment|dispos|credential|api key|integration user)/i;

// Any write under these resource groups moves money, books to the ledger,
// changes who can approve, or touches auth/config.
const SENSITIVE_TAGS = new Set([
	"Approval Groups",
	"Authentication",
	"Bank Reconciliation",
	"Bank accounts",
	"Configuration",
	"Customer Payments",
	"Deposits",
	"Exchange Rates",
	"External Logging",
	"Fixed Assets",
	"Integrations",
	"Invoices",
	"Journal Entries",
	"Mail",
	"Posting Groups",
	"Purchase Orders",
	"Purchase Requisitions",
	"Receiving Documents",
	"Statistical Account Journal Entries",
	"User Device Tokens",
	"Vendor Invoices",
	"Vendor Payments",
]);
const READ_POST_SUMMARY = /^(retriev|search|preview|validat|calculat|check|lookup|view)/i;

// Reads that can return credentials, tokens, bank or payroll data, a person's
// cost rate, or system configuration. A generic reader must not hand these to
// a model; use the Unanet UI or a purpose-built tool with its own review.
// Person rates and cost rates are named narrowly: mileage and labor-category
// rates are ordinary reference data.
const SENSITIVE_READ_PATH = /\/(tokens?|device-tokens?|integrations?|payroll|bank-accounts?|api-keys?|credentials?|secrets?|sftp|passwords?|cost-rates?)(\/|$)|\/people\/[^/]+\/rates?(\/|$)/i;
const SENSITIVE_READ_TAGS = new Set([
	"Authentication",
	"Bank Reconciliation",
	"Bank accounts",
	"Configuration",
	"External Logging",
	"Integrations",
	"Mail",
	"User Device Tokens",
]);

function isSensitiveRead(path, tag) {
	return SENSITIVE_READ_PATH.test(path) || SENSITIVE_READ_TAGS.has(tag);
}

export function classify(method, path, summary, tag) {
	if (method === "get") return isSensitiveRead(path, tag) ? "sensitive" : "read";
	if (SENSITIVE_PATH.test(path) || method === "delete") return "sensitive";
	if (method === "post" && READ_POST_SUMMARY.test(summary ?? "")) {
		return isSensitiveRead(path, tag) ? "sensitive" : "read";
	}
	if (SENSITIVE_SUMMARY.test(summary ?? "")) return "sensitive";
	if (SENSITIVE_TAGS.has(tag)) return "sensitive";
	return "write";
}
