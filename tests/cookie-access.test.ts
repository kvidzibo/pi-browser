import assert from "node:assert/strict";
import { test } from "node:test";
import { requestCookieAccessWithUI as requestCookieAccess } from "../cookie-access.ts";
import { MAX_COOKIE_ORIGINS } from "../constants.ts";

// Transaction tests inject dialogs without Pi peers; the native factory suite tests
// the real scrollable TUI, including its approval path with a synthetic session.
const requestCookieAccessWithUI: typeof requestCookieAccess = (session, ctx, params, signal) =>
	requestCookieAccess(session, ctx, params, signal, { confirm: (context, title, body, abort) => context.ui.confirm(title, body, { signal: abort }) });

const origins = ["https://93.184.216.34", "https://93.184.216.35:8443"];
function fixture(mode = "tui", approved: unknown = true) {
	const calls: string[] = [], prompts: string[] = [];
	let grants = ["https://previous.example"], imports = 0;
	const controller = new AbortController();
	const session = {
		hasCookieAccess: () => false,
		closeBrowser: async () => { calls.push("close"); return "closed"; },
		clearGrants: async () => { calls.push("clear"); grants = []; },
		importChromiumCookies: async (requested: string[], options?: { cookieNames?: string[]; signal?: AbortSignal }) => {
			calls.push("import"); imports++;
			assert.deepEqual(requested, origins);
			assert.deepEqual(options?.cookieNames, ["SID", "__Secure-session"]);
			assert.equal(options?.signal, controller.signal);
			grants = [...requested]; return 2;
		},
	};
	const ctx: any = { mode, hasUI: true, ui: {
		confirm: async (title: string, message: string, options: any) => {
			calls.push("confirm"); prompts.push(title, message);
			assert.deepEqual(grants, ["https://previous.example"]);
			assert.equal(imports, 0, "approval must precede all cookie import work");
			assert.equal(options.signal, controller.signal);
			return approved;
		},
	} };
	const params = { origins: [...origins], cookieNames: ["SID", "__Secure-session"] };
	return { session, ctx, params, calls, prompts, controller, grants: () => grants };
}

for (const mode of ["tui", "rpc"]) test(`model cookie request: explicit ${mode} approval without a site inventory`, async () => {
	const f = fixture(mode);
	const result = await requestCookieAccessWithUI(f.session, f.ctx, f.params, f.controller.signal);
	assert.equal(result.details?.status, "granted");
	assert.deepEqual(result.details?.origins, origins);
	assert.equal(result.details?.cookieCount, 2);
	assert.deepEqual(f.calls, ["confirm", "close", "clear", "import"]);
	assert.deepEqual(f.grants(), origins, "replace, never union with previous grants");
	const displayedOrigins = f.prompts[1].split("\n").filter((line) => line.startsWith("  ")).map((line) => line.trim());
	assert.deepEqual(result.details?.origins, displayedOrigins, "grants must exactly equal the destinations shown in the dialog");
	assert.match(f.prompts[0], /for this session/);
	for (const text of [...origins, ...f.params.cookieNames, "Default", "act as you", "reuse approval", "broader cookie-name access", "replaces", "/browser logout", "/reload", "shutdown"]) {
		assert.ok(f.prompts[1].includes(text), `missing approval detail: ${text}`);
	}
});

for (const answer of [false, undefined, "yes", "false"]) test(`denial/non-boolean consent cannot change the existing session (${answer})`, async () => {
	const f = fixture("tui", answer);
	// Avoid the factory's default for the explicitly undefined case.
	f.ctx.ui.confirm = async () => { f.calls.push("confirm"); return answer; };
	const result = await requestCookieAccessWithUI(f.session, f.ctx, f.params, f.controller.signal);
	assert.equal(result.details?.status, "denied");
	assert.match(result.content, /Do not retry/);
	assert.deepEqual(f.calls, ["confirm"]);
	assert.deepEqual(f.grants(), ["https://previous.example"]);
});

for (const mode of ["print", "json", "unknown", "no-ui"]) test(`no cookie access without a supported interactive UI (${mode})`, async () => {
	const f = fixture(mode);
	if (mode === "no-ui") { f.ctx.mode = "tui"; f.ctx.hasUI = false; }
	await assert.rejects(requestCookieAccessWithUI(f.session, f.ctx, f.params), /interactive approval/);
	assert.deepEqual(f.calls, []);
});

for (const bad of [undefined, [], "https://example.com", Array(MAX_COOKIE_ORIGINS + 1).fill(origins[0]),
	["example.com"], ["https://*.example.com"], ["file:///tmp/private"], ["https://example.com/path"],
	["https://93.184.216.34,93.184.216.35"], ["https://93.184.216.34%2c93.184.216.35"],
	["https://mail.google.com,accounts.google.com"], ["https://mail.google.com%2caccounts.google.com"],
	["https://" + Array(MAX_COOKIE_ORIGINS + 1).fill("host.example").join(",")],
	["https:example.com"], ["https://example.com/.."], ["https://example.com\\"],
	["https://example.com?"], ["https://example.com/#"],
	["https://bad_label.example"], ["https://-bad.example"], ["https://bad..example"],
	["https://" + "a".repeat(64) + ".example"],
	["https://example.com?token=hidden"], ["https://example.com/#hidden"], ["https://user:secret@example.com"],
	["https://exam\nple.com"], ["https://example.com\u202e"], [null], [1], ["https://" + "x".repeat(2100)]]) {
	test(`invalid origin request is rejected before prompting (${JSON.stringify(bad)?.slice(0, 100)})`, async () => {
		const f = fixture();
		// A validation regression must stop at denial, never perform live DNS/imports.
		f.ctx.ui.confirm = async () => { f.calls.push("confirm"); return false; };
		await assert.rejects(requestCookieAccessWithUI(f.session, f.ctx, { ...f.params, origins: bad as any }), /origins/);
		assert.deepEqual(f.calls, []);
	});
}

test("the maximum origin request imports exactly the displayed list without expanding it", async () => {
	const f = fixture();
	const requested = Array.from({ length: MAX_COOKIE_ORIGINS }, (_, i) => `https://93.184.216.${34 + i}`);
	let imported: string[] | undefined;
	f.session.importChromiumCookies = async (approved) => { imported = [...approved]; return 1; };
	const result = await requestCookieAccessWithUI(f.session, f.ctx, { origins: requested }, f.controller.signal);
	const displayed = f.prompts[1].split("\n").filter((line) => line.startsWith("  ")).map((line) => line.trim());
	assert.equal(displayed.length, MAX_COOKIE_ORIGINS);
	assert.deepEqual(displayed, requested);
	assert.deepEqual(imported, displayed);
	assert.deepEqual(result.details?.origins, displayed);
});

for (const [input, expected] of [
	["https://EXAMPLE.com:443/", "https://example.com"],
	["https://b\u00fccher.example/", "https://xn--bcher-kva.example"],
	["https://[2606:4700:4700::1111]:8443/", "https://[2606:4700:4700::1111]:8443"],
]) test(`valid origin is canonicalized before the dialog (${input})`, async () => {
	const f = fixture("rpc", false);
	const result = await requestCookieAccessWithUI(f.session, f.ctx, { origins: [input] }, f.controller.signal);
	assert.equal(result.details?.status, "denied");
	assert.ok(f.prompts[1].includes(`  ${expected}\n`));
	assert.deepEqual(f.calls, ["confirm"]);
});

for (const bad of [[], "SID", ["*"], ["SID=value"], ["SID\n"], ["SID\nallow"], ["SID\u202e"], [null]]) {
	test(`invalid name filter cannot turn into all-cookie access (${JSON.stringify(bad)})`, async () => {
		const f = fixture();
		await assert.rejects(requestCookieAccessWithUI(f.session, f.ctx, { origins, cookieNames: bad as any }), /cookieNames/);
		assert.deepEqual(f.calls, []);
	});
}

test("omitting names explicitly asks for all destination-matching cookies, not an inventory", async () => {
	const f = fixture("rpc", false);
	await requestCookieAccessWithUI(f.session, f.ctx, { origins }, f.controller.signal);
	assert.match(f.prompts[1], /ALL cookies matching these destinations/);
	assert.deepEqual(f.calls, ["confirm"]);
});

test("approval cannot bypass the public-network gate", async () => {
	const f = fixture();
	await assert.rejects(requestCookieAccessWithUI(f.session, f.ctx, { origins: ["http://127.0.0.1"] }, f.controller.signal), /Blocked/);
	assert.deepEqual(f.calls, ["confirm"]);
	assert.deepEqual(f.grants(), ["https://previous.example"]);
});

test("requested scope is normalized, deduplicated and snapshotted before waiting for approval", async () => {
	const f = fixture();
	f.params.origins = [origins[0] + "/", origins[0], origins[1]];
	f.params.cookieNames.push("SID");
	const confirm = f.ctx.ui.confirm;
	f.ctx.ui.confirm = async (...args: any[]) => {
		const result = await confirm(...args);
		f.params.origins.push("https://unapproved.example");
		f.params.cookieNames.push("unapproved-cookie");
		return result;
	};
	const result = await requestCookieAccessWithUI(f.session, f.ctx, f.params, f.controller.signal);
	assert.deepEqual(result.details?.origins, origins);
	assert.deepEqual(result.details?.cookieNames, ["SID", "__Secure-session"]);
});

for (const stage of ["before", "dialog", "clear", "import"]) test(`cancellation cannot leave new grants (${stage})`, async () => {
	const f = fixture();
	if (stage === "before") f.controller.abort("private-abort-reason");
	if (stage === "dialog") f.ctx.ui.confirm = async (_title: string, _message: string, options: any) => {
		assert.equal(options.signal, f.controller.signal); f.controller.abort("private-abort-reason"); return true;
	};
	if (stage === "clear" || stage === "import") {
		const method = stage === "clear" ? "clearGrants" : "importChromiumCookies";
		const original = f.session[method] as Function;
		(f.session as any)[method] = async (...args: any[]) => {
			const result = await original(...args); f.controller.abort("private-abort-reason"); return result;
		};
	}
	const result = await requestCookieAccessWithUI(f.session, f.ctx, f.params, f.controller.signal);
	assert.equal(result.details?.status, "cancelled");
	assert.ok(!JSON.stringify(result).includes("private-abort-reason"));
	assert.deepEqual(f.grants(), stage === "before" || stage === "dialog" ? ["https://previous.example"] : []);
	assert.equal(f.calls.includes("import"), stage === "import");
});

for (const cleanupFails of [false, true]) test(`failed import hides source errors and cleans up (cleanup failure=${cleanupFails})`, async () => {
	const f = fixture();
	f.session.importChromiumCookies = async () => { f.calls.push("import"); throw new Error("private-cookie-value"); };
	if (cleanupFails) f.session.clearGrants = async () => {
		if (f.calls.includes("import")) throw new Error("private-cleanup-detail"); f.calls.push("clear");
	};
	await assert.rejects(requestCookieAccessWithUI(f.session, f.ctx, f.params, f.controller.signal), (error: Error) => {
		assert.match(error.message, cleanupFails ? /cleanup failed.*browser logout/ : /cookie access failed/);
		assert.ok(!error.message.includes("private-")); return true;
	});
	if (!cleanupFails) {
		assert.deepEqual(f.calls, ["confirm", "close", "clear", "import", "close", "clear"]);
		assert.deepEqual(f.grants(), []);
	}
});
