import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BrowserSession } from "../session.ts";
import { CookieImportError, createChromiumCookieImport } from "../chromium-import.ts";
import { requestCookieAccessWithUI, type CookieAccessParams } from "../cookie-access.ts";

const home = mkdtempSync(join(tmpdir(), "pi-browser-session-"));
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") });
after(() => {
	for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	rmSync(home, { recursive: true, force: true });
});

test("granting an empty login context creates a usable blank tab", async () => {
	const session = new BrowserSession() as any;
	const page = { url: () => "about:blank", on: () => {} };
	session.context = { newPage: async () => page, close: async () => {} };
	await session.applyGrants(["https://93.184.216.34"]);
	assert.equal(session.requirePage(), page);
	await session.closeBrowser();
});

test("revoking an imported profile keeps its network grants until the browser is closed", async () => {
	const session = new BrowserSession() as any;
	let cleaned = false, grantsAtClose: string[] = [];
	session.grants = new Set(["https://93.184.216.34"]);
	session.importedProfile = { cleanup: async () => { cleaned = true; } };
	session.context = { close: async () => { grantsAtClose = session.grantList(); } };
	await session.clearGrants();
	assert.deepEqual(grantsAtClose, ["https://93.184.216.34"]);
	assert.equal(cleaned, true);
	assert.deepEqual(session.grantList(), []);
});

for (const outcome of ["copy-error", "launch-error", "no-cookies"]) {
	test(`failed Chromium import clears grants, deletes its copy and hides source errors: ${outcome}`, async () => {
		let cleaned = 0;
		const session = new BrowserSession(undefined, async () => {
			if (outcome === "copy-error") throw new Error("private-cookie-fixture");
			return { userDataDir: "/synthetic-only", executablePath: "/synthetic-chromium", cookieCount: 1, cleanup: async () => { cleaned++; } };
		}) as any;
		session.ensureLaunched = async () => {
			if (outcome === "launch-error") throw new Error("private-cookie-fixture");
			session.context = { cookies: async () => [], close: async () => {} };
		};
		await assert.rejects(session.importChromiumCookies(["https://93.184.216.34"]), (error: Error) => {
			assert.match(error.message, /cookie import failed/); assert.ok(!error.message.includes("private-cookie-fixture"));
			if (outcome === "no-cookies") {
				assert.ok(error instanceof CookieImportError);
				assert.equal(error.code, "cookies_not_loaded");
				assert.match(error.message, /No imported cookies loaded/);
			} else assert.ok(!(error instanceof CookieImportError));
			return true;
		});
		assert.deepEqual(session.grantList(), []);
		assert.equal(session.forcePersistent, false);
		assert.equal(session.importedProfile, undefined);
		assert.equal(session.hasCookieAccess(["https://93.184.216.34"]), false);
		assert.equal(cleaned, outcome === "copy-error" ? 0 : 1);
	});
}

for (const [code, message] of [
	["profile_missing", /profile directory was not found/],
	["cookie_database_missing", /No cookie database/],
	["no_matching_cookies", /No matching cookies/],
] as const) test(`known cookie failures survive importer/session/model boundaries (${code})`, async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const temp = mkdtempSync(join(home, "empty-cookies-")), root = join(temp, "chromium");
	if (code !== "profile_missing") mkdirSync(join(root, "Default"), { recursive: true });
	if (code === "no_matching_cookies") {
		const db = new DatabaseSync(join(root, "Default", "Cookies"));
		try {
			db.exec("CREATE TABLE cookies(host_key TEXT, name TEXT, has_expires INTEGER, expires_utc INTEGER)");
		} finally { db.close(); }
	}
	const before = readdirSync(temp);
	const session = new BrowserSession(undefined, (origins, options) => createChromiumCookieImport(origins, {
		...options, sourceRoot: root, tempRoot: temp, executablePath: "/synthetic-chromium", platform: "linux",
	}));
	let prompts = 0;
	try {
		await assert.rejects(requestCookieAccessWithUI(session, { hasUI: true, mode: "rpc", ui: {
			confirm: async () => { prompts++; return true; },
		} } as any, { origins: ["https://93.184.216.34"] }), (error: Error) => {
			assert.ok(error instanceof CookieImportError);
			assert.equal(error.code, code);
			assert.match(error.message, message);
			assert.ok(!error.message.includes(temp), "private source/copy paths must not reach the model");
			return true;
		});
		assert.equal(prompts, 1);
		assert.deepEqual(session.grantList(), []);
		assert.equal(session.hasCookieAccess(["https://93.184.216.34"]), false);
		assert.deepEqual(readdirSync(temp), before, "the failed copy must be removed");
	} finally { await session.shutdown(); rmSync(temp, { recursive: true, force: true }); }
});

test("session reconstructs known errors rather than forwarding attached private details", async () => {
	const failure = new CookieImportError("no_matching_cookies");
	failure.message = "private-cookie-fixture";
	failure.cause = new Error("private-keyring-fixture");
	const session = new BrowserSession(undefined, async () => { throw failure; });
	await assert.rejects(session.importChromiumCookies(["https://93.184.216.34"]), (error: Error) => {
		assert.ok(error instanceof CookieImportError);
		assert.notEqual(error, failure);
		assert.equal(error.message, new CookieImportError("no_matching_cookies").message);
		assert.equal(error.cause, undefined);
		assert.ok(!String(error.stack).includes("private-"));
		return true;
	});
	assert.deepEqual(session.grantList(), []);
});

for (const action of ["clearGrants", "shutdown"]) {
	test(`failed cleanup is reported without source details and can be retried after ${action}`, async () => {
		const session = new BrowserSession() as any;
		let attempts = 0;
		session.grants = new Set(["https://93.184.216.34"]); session.forcePersistent = true;
		session.importedProfile = { userDataDir: "/synthetic-copy", cleanup: async () => {
			if (++attempts === 1) throw new Error("private-cleanup-fixture");
		} };
		await assert.rejects(session[action](), (error: Error) => {
			assert.match(error.message, /synthetic-copy.*Retry \/browser logout/);
			assert.ok(!error.message.includes("private-cleanup-fixture")); return true;
		});
		assert.equal(session.importCleanup.size, 1);
		assert.equal(session.importedProfile, undefined); assert.equal(session.forcePersistent, false);
		assert.equal(session.closed, false); assert.deepEqual(session.grantList(), []);
		await session.clearGrants();
		assert.equal(attempts, 2); assert.equal(session.importCleanup.size, 0);
	});
}

test("shutdown attempts cookie cleanup even if browser teardown throws", async () => {
	const session = new BrowserSession() as any;
	let cleaned = false;
	session.importedProfile = { cleanup: async () => { cleaned = true; } };
	session.teardown = async () => { throw new Error("teardown fixture failed"); };
	await assert.rejects(session.shutdown(), /teardown fixture failed/);
	assert.equal(cleaned, true); assert.equal(session.importCleanup.size, 0);
	assert.equal(session.closed, false); assert.equal(session.importedProfile, undefined);
});

test("a staging failure still leaves the session a cleanup retry handle", async () => {
	let cleaned = 0;
	const session = new BrowserSession(undefined, async (_origins, options) => {
		options!.registerCleanup!({ userDataDir: "/synthetic-copy", executablePath: "/synthetic-chromium", cookieCount: 0, cleanup: async () => { cleaned++; } });
		throw new Error("staging fixture failed");
	});
	await assert.rejects(session.importChromiumCookies(["https://93.184.216.34"]), /cookie import failed/);
	assert.equal(cleaned, 1);
});

for (const stage of ["before", "copy", "grants", "launch", "cookies"]) test(`import cancellation cleans the copy and grants (${stage})`, async () => {
	const controller = new AbortController();
	let copied = 0, cleaned = 0, launched = 0;
	const session = new BrowserSession(undefined, async (_origins, options) => {
		copied++;
		assert.deepEqual(options?.cookieNames, ["SID"]);
		if (stage === "copy") controller.abort();
		return { userDataDir: "/synthetic-copy", executablePath: "/synthetic-chromium", cookieCount: 1, cleanup: async () => { cleaned++; } };
	}) as any;
	const apply = session.applyGrants.bind(session);
	session.applyGrants = async (origins: string[]) => { await apply(origins); if (stage === "grants") controller.abort(); };
	session.ensureLaunched = async (signal: AbortSignal) => {
		launched++; assert.equal(signal, controller.signal);
		if (stage === "launch") controller.abort();
		session.context = { close: async () => {}, cookies: async () => {
			if (stage === "cookies") controller.abort(); return [{ name: "SID", value: "private-cookie-fixture" }];
		} };
	};
	if (stage === "before") controller.abort();
	await assert.rejects(session.importChromiumCookies(["https://93.184.216.34"], { cookieNames: ["SID"], signal: controller.signal }), /cookie import failed/);
	assert.equal(copied, stage === "before" ? 0 : 1);
	assert.equal(cleaned, copied);
	assert.equal(launched, stage === "launch" || stage === "cookies" ? 1 : 0);
	assert.deepEqual(session.grantList(), []);
	assert.equal(session.forcePersistent, false);
	assert.equal(session.context, undefined);
	assert.equal(session.importedProfile, undefined);
	assert.equal(session.hasCookieAccess(["https://93.184.216.34"], ["SID"]), false);
});

function cookieAccessFixture(mode: "tui" | "rpc" = "rpc") {
	const state = { prompts: 0, copies: 0, closes: 0, cleanups: 0, allow: true, failImport: false };
	const session = new BrowserSession(undefined, async () => {
		state.copies++;
		if (state.failImport) throw new Error("synthetic import failure");
		return { userDataDir: "/synthetic-copy", executablePath: "/synthetic-chromium", cookieCount: 1,
			cleanup: async () => { state.cleanups++; } };
	});
	session.ensureLaunched = async () => {
		(session as any).context = { cookies: async () => [{ name: "SID", value: "synthetic-private-cookie" }],
			close: async () => { state.closes++; } };
	};
	const ctx: any = { mode, hasUI: true, ui: { confirm: async () => { state.prompts++; return state.allow; } } };
	const request = (params: CookieAccessParams, signal?: AbortSignal) => session.withLock(() =>
		requestCookieAccessWithUI(session, ctx, params, signal, { confirm: (context, title, body, abort) =>
			context.ui.confirm(title, body, { signal: abort }) }));
	return { session, state, ctx, request };
}

const cookieScope = { origins: ["https://93.184.216.34", "https://93.184.216.35:8443"], cookieNames: ["SID", "session"] };

for (const mode of ["tui", "rpc"] as const) test(`cookie approval is reused for matching/subset requests and browser close (${mode})`, async () => {
	const f = cookieAccessFixture(mode);
	try {
		assert.equal((await f.request(cookieScope)).details?.status, "granted");
		const context = (f.session as any).context;
		for (const params of [cookieScope,
			{ origins: [...cookieScope.origins].reverse(), cookieNames: ["session", "SID", "SID"] },
			{ origins: [cookieScope.origins[0] + ":443/"], cookieNames: ["SID"] },
		]) {
			const reused = await f.request(params);
			assert.equal(reused.details?.status, "granted");
			assert.equal(reused.details?.reused, true);
			assert.match(reused.content, /already approved/i);
			assert.equal((f.session as any).context, context);
			assert.deepEqual(f.session.grantList(), cookieScope.origins, "subset requests must not silently revoke active grants");
		}
		assert.deepEqual(f.state, { prompts: 1, copies: 1, closes: 0, cleanups: 0, allow: true, failImport: false });
		await f.session.closeBrowser();
		assert.equal((await f.request(cookieScope)).details?.reused, true);
		assert.equal((f.session as any).context, undefined, "reuse should not launch or reimport after close");
		assert.equal(f.state.prompts, 1); assert.equal(f.state.copies, 1); assert.equal(f.state.cleanups, 0);
	} finally { await f.session.shutdown(); }
});

test("queued matching cookie requests share a single approval and import", async () => {
	const f = cookieAccessFixture();
	try {
		const results = await Promise.all([f.request(cookieScope), f.request(cookieScope)]);
		assert.ok(results.every((result) => result.details?.status === "granted"));
		assert.equal(results[1].details?.reused, true);
		assert.equal(f.state.prompts, 1); assert.equal(f.state.copies, 1);
	} finally { await f.session.shutdown(); }
});

test("cookie approval requires both the imported scope and still-active origin grants", async () => {
	const f = cookieAccessFixture();
	try {
		await f.request(cookieScope);
		await f.session.closeBrowser();
		const newOrigin = "https://93.184.216.36";
		await f.session.applyGrants([cookieScope.origins[0], newOrigin]);
		f.state.allow = false;
		assert.equal((await f.request({ origins: [newOrigin], cookieNames: ["SID"] })).details?.status, "denied");
		assert.equal((await f.request({ origins: [cookieScope.origins[1]], cookieNames: ["SID"] })).details?.status, "denied");
		assert.equal((await f.request({ origins: [cookieScope.origins[0]], cookieNames: ["SID"] })).details?.reused, true);
		assert.equal(f.state.prompts, 3); assert.equal(f.state.copies, 1);
	} finally { await f.session.shutdown(); }
});

test("mutating request or result arrays cannot widen remembered cookie approval", async () => {
	const f = cookieAccessFixture();
	try {
		const params = { origins: [...cookieScope.origins], cookieNames: [...cookieScope.cookieNames] };
		const result = await f.request(params);
		const newOrigin = "https://93.184.216.36";
		params.origins.push(newOrigin); params.cookieNames.push("new-name");
		(result.details!.origins as string[]).push(newOrigin);
		(result.details!.cookieNames as string[]).push("new-name");
		f.state.allow = false;
		assert.equal((await f.request({ origins: [newOrigin], cookieNames: ["SID"] })).details?.status, "denied");
		assert.equal((await f.request({ origins: cookieScope.origins, cookieNames: ["new-name"] })).details?.status, "denied");
		assert.equal(f.state.prompts, 3); assert.equal(f.state.copies, 1);
	} finally { await f.session.shutdown(); }
});

test("all-cookie approval also covers named subsets, including a manual Chromium import", async () => {
	const f = cookieAccessFixture();
	try {
		// This is the same approved import entrypoint used by /browser login --from-chromium.
		await f.session.importChromiumCookies(cookieScope.origins);
		for (const cookieNames of [undefined, ["SID"], ["another-name"]]) {
			assert.equal((await f.request({ origins: [cookieScope.origins[0]], cookieNames })).details?.reused, true);
		}
		assert.equal(f.state.prompts, 0); assert.equal(f.state.copies, 1);
	} finally { await f.session.shutdown(); }
});

for (const params of [
	{ ...cookieScope, origins: ["https://93.184.216.36"] },
	{ ...cookieScope, origins: ["http://93.184.216.34"] },
	{ ...cookieScope, origins: ["https://93.184.216.34:8443"] },
	{ ...cookieScope, cookieNames: ["SID", "new-name"] },
	{ ...cookieScope, cookieNames: ["sid"] },
	{ origins: cookieScope.origins },
]) test(`broader/different cookie access still prompts: ${JSON.stringify(params)}`, async () => {
	const f = cookieAccessFixture();
	try {
		await f.request(cookieScope);
		const context = (f.session as any).context;
		f.state.allow = false;
		assert.equal((await f.request(params)).details?.status, "denied");
		assert.equal(f.state.prompts, 2); assert.equal(f.state.copies, 1);
		assert.equal((f.session as any).context, context);
		assert.deepEqual(f.session.grantList(), cookieScope.origins);
		assert.equal((await f.request(cookieScope)).details?.reused, true, "denial must preserve the earlier approval");
		assert.equal(f.state.prompts, 2);
	} finally { await f.session.shutdown(); }
});

for (const reset of ["clearGrants", "shutdown"] as const) test(`cookie approval ends on ${reset}`, async () => {
	const f = cookieAccessFixture();
	try {
		await f.request(cookieScope);
		await f.session[reset]();
		f.state.allow = false;
		assert.equal((await f.request(cookieScope)).details?.status, "denied");
		assert.equal(f.state.prompts, 2); assert.equal(f.state.copies, 1); assert.equal(f.state.cleanups, 1);
	} finally { await f.session.shutdown(); }
});

test("approved replacement forgets the replaced scope rather than accumulating cookie permissions", async () => {
	const f = cookieAccessFixture();
	const next = { origins: ["https://93.184.216.36"], cookieNames: ["other"] };
	try {
		await f.request(cookieScope);
		await f.request(next);
		assert.equal(f.state.prompts, 2); assert.equal(f.state.copies, 2); assert.equal(f.state.cleanups, 1);
		assert.equal((await f.request(next)).details?.reused, true);
		f.state.allow = false;
		assert.equal((await f.request(cookieScope)).details?.status, "denied");
		assert.equal(f.state.prompts, 3);
	} finally { await f.session.shutdown(); }
});

test("failed replacement cannot retain old or attempted cookie approval", async () => {
	const f = cookieAccessFixture();
	const next = { origins: ["https://93.184.216.36"] };
	try {
		await f.request(cookieScope);
		f.state.failImport = true;
		await assert.rejects(f.request(next), /cookie access failed/);
		f.state.allow = false;
		assert.equal((await f.request(cookieScope)).details?.status, "denied");
		assert.equal((await f.request(next)).details?.status, "denied");
		assert.equal(f.state.prompts, 4); assert.equal(f.state.copies, 2);
	} finally { await f.session.shutdown(); }
});

test("isolated login origin grants do not approve access to the user's Chromium profile", async () => {
	const f = cookieAccessFixture();
	try {
		await f.session.applyGrants(cookieScope.origins);
		f.state.allow = false;
		assert.equal((await f.request(cookieScope)).details?.status, "denied");
		assert.equal(f.state.prompts, 1); assert.equal(f.state.copies, 0);
	} finally { await f.session.shutdown(); }
});

test("cached approval does not bypass cancellation, input validation or the UI-mode boundary", async () => {
	const f = cookieAccessFixture();
	try {
		await f.request(cookieScope);
		assert.equal((await f.request(cookieScope, AbortSignal.abort())).details?.status, "cancelled");
		await assert.rejects(f.request({ ...cookieScope, cookieNames: [] }), /cookieNames/);
		await assert.rejects(f.request({ ...cookieScope, origins: [cookieScope.origins[0] + "/path"] }), /origins/);
		f.ctx.mode = "print";
		await assert.rejects(f.request(cookieScope), /interactive approval/);
		assert.equal(f.state.prompts, 1); assert.equal(f.state.copies, 1);
	} finally { await f.session.shutdown(); }
});

test("the browser driver cannot bypass the cookie permission UI", async () => {
	let copied = false;
	const session = new BrowserSession(undefined, async () => { copied = true; throw new Error("must not import"); });
	await assert.rejects(session.execute({ action: "request_cookies" }), /Unknown action/);
	assert.equal(copied, false);
});

test("snapshot revisions never repeat after closing and reopening", async () => {
	const session = new BrowserSession() as any;
	const page = { url: () => "https://93.184.216.34/", title: async () => "fixture", on: () => {}, mainFrame: () => ({}),
		locator: () => ({ ariaSnapshot: async () => "- button [ref=e1]" }) };
	session.adoptPage(page, true);
	const before = await session.snapshotResult(page);
	await session.closeBrowser();
	session.adoptPage(page, true);
	const after = await session.snapshotResult(page);
	assert.ok(after.details.snapshot > before.details.snapshot);
	assert.throws(() => session.locator(page, `r${before.details.snapshot}e1`), /[Ss]tale/);
});

test("ungranted subresources are fetched and fulfilled, never continued with browser cookies", async () => {
	let fetches = 0, fulfilled: any;
	const session = new BrowserSession(async (url, input) => {
		fetches++; assert.equal(url, "https://93.184.216.34/asset"); assert.equal(input.method, "GET");
		return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("fixture") };
	}) as any;
	session.grants = new Set(["https://granted.example"]);
	let handler!: Function;
	await session.installNetworkGate({ route: async (_pattern: string, fn: Function) => { handler = fn; } });
	await handler({ request: () => ({ url: () => "https://93.184.216.34/asset", resourceType: () => "image", method: () => "GET",
		allHeaders: async () => ({ cookie: "private" }), postDataBuffer: () => null }),
		continue: () => assert.fail("cannot strip browser cookies with continue"),
		fulfill: async (response: any) => { fulfilled = response; }, abort: () => assert.fail("fixture should load"),
	});
	assert.equal(fetches, 1); assert.equal(fulfilled.body.toString(), "fixture");
	await session.closeBrowser();
});

for (const [type, granted, expected] of [["image", true, "continue"], ["document", true, "continue"], ["document", false, "abort"], ["websocket", false, "abort"], ["eventsource", false, "abort"]] as const) {
	test(`network gate preserves ${type} policy (granted: ${granted})`, async () => {
		const session = new BrowserSession(async () => { assert.fail("must not fetch statelessly"); }) as any;
		session.grants = new Set([granted ? "https://93.184.216.34" : "https://other.example"]);
		let handler!: Function, actual: string | undefined;
		await session.installNetworkGate({ route: async (_pattern: string, fn: Function) => { handler = fn; } });
		await handler({ request: () => ({ url: () => "https://93.184.216.34/", resourceType: () => type }),
			continue: async () => { actual = "continue"; }, abort: async () => { actual = "abort"; }, fulfill: () => assert.fail("must not fulfill"),
		});
		assert.equal(actual, expected); await session.closeBrowser();
	});
}

test("closing the browser aborts pending stateless resource fetches", async () => {
	let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
	const session = new BrowserSession(async (_url, _input, options) => new Promise((_resolve, reject) => {
		started(); options!.signal!.addEventListener("abort", () => reject(new Error("closed")), { once: true });
	})) as any;
	session.grants = new Set(["https://granted.example"]);
	let handler!: Function, aborted = false;
	await session.installNetworkGate({ route: async (_pattern: string, fn: Function) => { handler = fn; } });
	const pending = handler({ request: () => ({ url: () => "https://93.184.216.34/asset", resourceType: () => "image", method: () => "GET", allHeaders: async () => ({}), postDataBuffer: () => null }),
		continue: () => assert.fail("must fetch cookieless"), fulfill: () => assert.fail("cancelled response"), abort: async () => { aborted = true; },
	});
	await ready; await session.closeBrowser(); await pending;
	assert.equal(aborted, true);
});
