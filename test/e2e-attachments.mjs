import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const PORT = 3219;
const BASE = `http://127.0.0.1:${PORT}`;

function waitFor(proc, text, ms = 4000) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout " + text)), ms);
		const on = (d) => {
			if (d.toString().includes(text)) {
				clearTimeout(t);
				resolve();
			}
		};
		proc.stdout.on("data", on);
		proc.stderr.on("data", on);
	});
}

// newline-delimited JSON-RPC client over the server's stdio
function makeClient(proc) {
	let buf = "";
	const pending = new Map();
	proc.stdout.on("data", (d) => {
		buf += d.toString();
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id != null && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});
	let id = 0;
	return (method, params) =>
		new Promise((resolve) => {
			const myId = ++id;
			pending.set(myId, resolve);
			proc.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n",
			);
		});
}

function callTool(rpc, name, args) {
	return rpc("tools/call", { name, arguments: args }).then((r) => {
		if (r.error) return { __rpcError: r.error };
		const text = r.result?.content?.[0]?.text;
		try {
			return JSON.parse(text);
		} catch {
			return { __raw: text };
		}
	});
}

const log = (label, v) =>
	console.log(`\n### ${label}\n` + JSON.stringify(v, null, 2));

async function main() {
	const mock = spawn("node", ["dist/mock-server.js"], {
		cwd: REPO,
		env: { ...process.env, PORT: String(PORT) },
	});
	await waitFor(mock, "Mock Unanet API server running");

	const server = spawn("node", ["dist/index.js"], {
		cwd: REPO,
		env: {
			...process.env,
			UNANET_USERNAME: "test-user",
			UNANET_PASSWORD: "test-pass",
			UNANET_BASE_URL: BASE,
			UNANET_ALLOW_INSECURE_LOCAL_MOCK: "true",
			UNANET_ENABLE_WRITE_TOOLS: "true",
		},
	});
	await waitFor(server, "Server started successfully");
	const rpc = makeClient(server);

	await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "e2e", version: "1" },
	});
	rpc("notifications/initialized", {});

	const list = await rpc("tools/list", {});
	const names = list.result.tools.map((t) => t.name);
	console.log("attachment tools present:", {
		get: names.includes("unanet_get_expense_attachments"),
		add: names.includes("unanet_add_expense_attachment"),
	});

	// 1. create draft
	const draft = await callTool(rpc, "unanet_create_expense_report_draft", {
		confirm: true,
		purpose: "E2E attachment flow",
		location: "Remote",
		expenseProjectAllocations: [{ projectKey: 501, allocation: 100 }],
	});
	log("create draft", draft);
	const expenseId = draft.expenseId;

	// 2. add a detail
	const detail = await callTool(rpc, "unanet_add_expense_detail", {
		confirm: true,
		expenseId,
		expenseDate: "2026-06-14",
		expenseTypeKey: 301,
		paymentMethodKey: 401,
		transactionCurrency: 1,
		amount: 42.5,
		projectAllocationKey: 7100,
		summary: "Uber to venue",
		wizard: { type: "Taxi" },
	});
	log("add detail", detail);

	// 3. real PDF file on disk → upload via filePath + detailId
	const dir = mkdtempSync(join(tmpdir(), "e2e-receipts-"));
	const pdfPath = join(dir, "uber-2026-06-14.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n% mock receipt bytes\n%%EOF\n");
	const up = await callTool(rpc, "unanet_add_expense_attachment", {
		confirm: true,
		expenseId,
		detailId: detail.detailId,
		filePath: pdfPath,
	});
	log("upload (filePath + detailId)", up);

	// 4. read back attachments
	const atts = await callTool(rpc, "unanet_get_expense_attachments", {
		expenseId,
	});
	log("get attachments", atts);

	// 5. validate (no submit)
	const val = await callTool(rpc, "unanet_validate_expense_report", {
		expenseId,
	});
	log("validate", val);

	// --- edge cases ---
	const noFile = await callTool(rpc, "unanet_add_expense_attachment", {
		confirm: true,
		expenseId,
		filePath: "/does/not/exist.pdf",
	});
	log("EDGE nonexistent file", noFile);

	// 26MB of real bytes -> base64 (~35MB string) -> decoded length 26MB > 25MB
	// so the client-side guard must fire BEFORE any POST.
	const big = Buffer.alloc(26 * 1024 * 1024, 0x41).toString("base64");
	const tooBig = await callTool(rpc, "unanet_add_expense_attachment", {
		confirm: true,
		expenseId,
		data: big,
		name: "huge.pdf",
	});
	log("EDGE >25MB guard", { success: tooBig.success, error: tooBig.error });

	// A realistic ~3MB receipt must succeed (mock body limit is 50mb).
	const threeMb = Buffer.alloc(3 * 1024 * 1024, 0x42).toString("base64");
	const midSize = await callTool(rpc, "unanet_add_expense_attachment", {
		confirm: true,
		expenseId,
		data: threeMb,
		name: "big-hotel-folio.pdf",
	});
	log("EDGE ~3MB receipt accepted", {
		success: midSize.success,
		verified: midSize.verified,
		length: midSize.length,
	});

	const noConfirm = await callTool(rpc, "unanet_add_expense_attachment", {
		expenseId,
		filePath: pdfPath,
	});
	log("EDGE missing confirm (rpc error expected)", noConfirm);

	const locked = await callTool(rpc, "unanet_add_expense_attachment", {
		confirm: true,
		expenseId: 9001, // COMPLETED in mock
		filePath: pdfPath,
	});
	log("EDGE non-editable report", { success: locked.success, error: locked.error });

	mock.kill();
	server.kill();

	// summary assertions
	const ok =
		draft.success &&
		detail.success &&
		up.success &&
		up.verified === true &&
		up.detailId === detail.detailId &&
		atts.count >= 1 &&
		noFile.success === false &&
		tooBig.success === false &&
		/over the .* limit/.test(tooBig.error || "") &&
		midSize.success === true &&
		midSize.verified === true &&
		(noConfirm.__rpcError || noConfirm.success === false) &&
		locked.success === false;
	console.log("\n==== E2E RESULT:", ok ? "PASS" : "FAIL", "====");
	process.exit(ok ? 0 : 1);
}

main().catch((e) => {
	console.error("e2e crashed:", e);
	process.exit(2);
});
