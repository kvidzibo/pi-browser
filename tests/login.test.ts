import assert from "node:assert/strict";
import { test } from "node:test";
import { loginFromChromiumWithUI, loginWithUI } from "../login.ts";

for (const outcome of ["initial-cancel", "launch-failure", "finish-cancel", "input-cancel", "invalid-origin", "grant-cancel", "apply-failure", "success"]) {
	test(`login transaction: ${outcome}`, async () => {
		let armed = false, closes = 0, confirms = 0, granted: string[] = [];
		const session = {
			setMode: () => {}, closeBrowser: async () => { closes++; return "closed"; },
			clearGrants: async () => { armed = false; granted = []; }, armPersistentProfile: () => { armed = true; },
			ensureLaunched: async () => { if (outcome === "launch-failure") throw new Error("launch failed"); },
			applyGrants: async (origins: string[]) => { if (outcome === "apply-failure") throw new Error("apply failed"); granted = origins; },
		};
		const ctx: any = { ui: {
			confirm: async () => { confirms++; return !((confirms === 1 && outcome === "initial-cancel") || (confirms === 2 && outcome === "finish-cancel") || (confirms === 3 && outcome === "grant-cancel")); },
			input: async () => outcome === "input-cancel" ? undefined : outcome === "invalid-origin" ? "http://127.0.0.1" : "https://93.184.216.34",
			notify: () => {},
		} };
		const pending = loginWithUI(session, ctx);
		if (outcome.endsWith("failure") || outcome === "invalid-origin") await assert.rejects(pending);
		else await pending;
		assert.equal(armed, outcome === "success");
		assert.deepEqual(granted, outcome === "success" ? ["https://93.184.216.34"] : []);
		assert.equal(closes, outcome === "initial-cancel" ? 0 : outcome === "success" ? 1 : 2);
	});
}

for (const outcome of ["picker-cancel", "confirm-cancel", "private-origin", "success", "discovery-error"]) {
	test(`TUI cookie-site picker flow: ${outcome}`, async () => {
		const calls: string[] = [], notices: string[] = [];
		const approved = ["https://93.184.216.34", "https://93.184.216.35"];
		const session = {
			closeBrowser: async () => { calls.push("close"); return "closed"; },
			clearGrants: async () => { calls.push("clear"); },
			importChromiumCookies: async (origins: string[]) => { calls.push("import"); assert.deepEqual(origins, approved); return 3; },
		};
		const ctx: any = { mode: "tui", ui: {
			input: async () => { calls.push("input"); return undefined; },
			confirm: async (_title: string, body: string) => {
				calls.push("confirm"); for (const origin of approved) assert.ok(body.includes(origin));
				assert.ok(!body.includes("unselected-private-inventory")); return outcome !== "confirm-cancel";
			},
			notify: (message: string) => notices.push(message),
		} };
		const task = loginFromChromiumWithUI(session, ctx, {
			listSites: async () => { calls.push("list"); if (outcome === "discovery-error") throw new Error("private-source-error");
				return [...approved, "https://unselected-private-inventory.invalid"].map((origin) => ({ origin, label: origin })); },
			pickSites: async (sites) => { calls.push("pick"); assert.equal(sites.length, 3);
				return outcome === "picker-cancel" ? undefined : outcome === "private-origin" ? ["http://127.0.0.1"] : approved; },
		});
		if (outcome === "private-origin") await assert.rejects(task, /Blocked/); else await task;
		assert.deepEqual(calls, outcome === "success" ? ["list", "pick", "confirm", "close", "clear", "import"] :
			outcome === "discovery-error" ? ["list", "input"] : outcome === "confirm-cancel" ? ["list", "pick", "confirm"] : ["list", "pick"]);
		assert.ok(notices.every((notice) => !notice.includes("private-source-error") && !notice.includes("unselected-private-inventory")));
	});
}

test("RPC retains manual origin entry without reading the local site inventory", async () => {
	let scanned = false;
	await loginFromChromiumWithUI({ closeBrowser: async () => "", clearGrants: async () => {}, importChromiumCookies: async () => 1 },
		{ mode: "rpc", ui: { input: async () => undefined, notify: () => {} } } as any,
		{ listSites: async () => { scanned = true; return []; } });
	assert.equal(scanned, false);
});

for (const outcome of ["input-cancel", "invalid-origin", "confirm-cancel", "import-failure", "success"]) {
	test(`Chromium import command consent: ${outcome}`, async () => {
		const calls: string[] = [], messages: string[] = [];
		const session = {
			closeBrowser: async () => { calls.push("close"); return "closed"; },
			clearGrants: async () => { calls.push("clear"); },
			importChromiumCookies: async (origins: string[]) => {
				calls.push("import"); assert.deepEqual(origins, ["https://93.184.216.34"]);
				if (outcome === "import-failure") throw new Error("import failed");
				return 2;
			},
		};
		const ctx: any = { ui: {
			input: async () => outcome === "input-cancel" ? undefined : outcome === "invalid-origin" ? "http://127.0.0.1" : "https://93.184.216.34",
			confirm: async () => { calls.push("confirm"); return outcome !== "confirm-cancel"; },
			notify: (text: string) => messages.push(text),
		} };
		const pending = loginFromChromiumWithUI(session, ctx);
		if (outcome === "invalid-origin" || outcome === "import-failure") await assert.rejects(pending);
		else await pending;
		assert.deepEqual(calls, outcome === "success" ? ["confirm", "close", "clear", "import"] :
			outcome === "import-failure" ? ["confirm", "close", "clear", "import", "close", "clear"] :
			outcome === "confirm-cancel" ? ["confirm"] : []);
		assert.equal(messages.some((text) => text.includes("Loaded 2 Chromium cookies")), outcome === "success");
	});
}
