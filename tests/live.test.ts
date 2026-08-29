import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAction } from "../actions.ts";
import { BrowserSession } from "../session.ts";

const live = process.env.BROWSER_LIVE === "1";

test("live: navigate example.com and snapshot has heading", { skip: !live }, async () => {
	const session = new BrowserSession();
	session.setMode("headless");
	try {
		const nav = await session.withLock(() =>
			session.execute(validateAction({ action: "navigate", url: "https://example.com" })),
		);
		assert.match(nav.content, /UNTRUSTED PAGE CONTENT/);
		assert.match(nav.content, /example/i);
		assert.match(nav.content, /\[ref=r\d+e\d+\]/);
	} finally {
		try {
			await session.shutdown();
		} catch (err) {
			console.error("shutdown", err);
		}
	}
});
