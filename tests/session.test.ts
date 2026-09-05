import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BrowserSession } from "../session.ts";

const home = mkdtempSync(join(tmpdir(), "pi-browser-session-"));
const previousHome = process.env.HOME; process.env.HOME = home;
after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; rmSync(home, { recursive: true, force: true }); });

test("snapshot revisions never repeat after closing and reopening", async () => {
	const session = new BrowserSession() as any;
	const page = { url: () => "https://93.184.216.34/", title: async () => "fixture",
		locator: () => ({ ariaSnapshot: async () => "- button [ref=e1]" }) };
	const before = await session.snapshotResult(page);
	await session.closeBrowser();
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
