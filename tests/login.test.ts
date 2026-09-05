import assert from "node:assert/strict";
import { test } from "node:test";
import { loginWithUI } from "../login.ts";

for (const outcome of ["initial-cancel", "launch-failure", "finish-cancel", "input-cancel", "invalid-origin", "grant-cancel", "apply-failure", "success"]) {
	test(`login transaction: ${outcome}`, async () => {
		let armed = false, closes = 0, confirms = 0, granted: string[] = [];
		const session = {
			setMode: () => {}, closeBrowser: async () => { closes++; return "closed"; },
			clearGrants: () => { armed = false; granted = []; }, armPersistentProfile: () => { armed = true; },
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
