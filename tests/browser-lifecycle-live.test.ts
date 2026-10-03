import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserContext, Page } from "patchright-core";
import { BrowserSession } from "../session.ts";
import { RUN_DIR_NAME } from "../constants.ts";

async function fixture(run: (session: BrowserSession, context: BrowserContext, page: () => Page) => Promise<void>) {
	const home = await mkdtemp(join(tmpdir(), "pi-browser-lifecycle-"));
	const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") });
	const session = new BrowserSession();
	// A typed inspection seam; only synthetic pages/profiles are used.
	const driver = session as unknown as { context: BrowserContext; requirePage(): Page };
	try {
		session.setMode("host");
		await session.ensureLaunched();
		await driver.context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body:
			`<form onsubmit="event.preventDefault(); document.documentElement.dataset.submitted='yes'"><button onclick="document.documentElement.dataset.clicked='yes'">Synthetic button</button></form>`,
		}));
		await session.execute({ action: "navigate", url: "https://93.184.216.34/one" });
		await run(session, driver.context, () => driver.requirePage());
	} finally {
		await session.shutdown();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(home, { recursive: true, force: true });
	}
}

const integration = { skip: process.env.BROWSER_LOCAL_INTEGRATION !== "1", timeout: 60_000 };

test("an already cancelled Enter cannot submit a form in a running browser", integration, async () => {
	await fixture(async (session, _context, page) => {
		await page().locator("button").focus();
		await assert.rejects(session.execute({ action: "press", key: "Enter" }, AbortSignal.abort()), /cancel|abort/i);
		assert.equal(await page().getAttribute("html", "data-submitted"), null);
	});
});

test("cookie redaction happens before snapshot wrapping and pagination", integration, async () => {
	await fixture(async (session, context, page) => {
		const secret = "fixture-cookie-secret-hidden";
		await context.addCookies([{ name: "fixture", value: secret, url: "https://93.184.216.34" }]);
		await page().setContent(`<p>${"x".repeat(3980)}${secret}</p>`);
		const snapshot = await session.execute({ action: "snapshot", limit: 1000 });
		assert.match(snapshot.content, /\[redacted\]/);
		assert.ok(!snapshot.content.includes("secret-hidden"));
	});
});

test("pagination keeps refs stable, navigation revokes them, and screenshots can attach PNGs", integration, async () => {
	await fixture(async (session, _context, page) => {
		await page().setContent(Array.from({ length: 250 }, (_, i) => `<button>Item ${i}</button>`).join(""));
		const first = await session.execute({ action: "snapshot", limit: 20 });
		const snapshotId = Number(first.details?.snapshot), offset = Number(first.details?.nextOffset);
		assert.ok(offset > 1);
		const next = await session.execute({ action: "snapshot", snapshotId, offset, limit: 20 });
		assert.equal(next.details?.snapshot, snapshotId);
		assert.match(next.content, /Item 20/);
		const ref = first.content.match(/- button .*\[ref=(r\d+e\d+)\]/)?.[1];
		assert.ok(ref);
		const saved = await session.execute({ action: "screenshot" });
		assert.equal(saved.image, undefined);
		const image = await session.execute({ action: "screenshot", image: true });
		assert.equal(image.image?.mimeType, "image/png");
		assert.equal(Buffer.from(image.image!.data, "base64").subarray(1, 4).toString(), "PNG");
		assert.match(image.content, /not secret-redacted/);
		const path = String(image.details?.path);
		assert.ok(path.startsWith(process.env.PI_CODING_AGENT_DIR! + "/browser-shots/"));
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		await page().reload();
		await assert.rejects(session.execute({ action: "click", ref }), /Stale/);
		await assert.rejects(session.execute({ action: "snapshot", snapshotId, offset }), /Stale/);
	});
});

test("closing the active tab invalidates its refs before another tab can receive input", integration, async () => {
	await fixture(async (session, _context, page) => {
		const first = page();
		const snapshot = await session.execute({ action: "tabs", tabAction: "new", url: "https://93.184.216.34/two" });
		const ref = snapshot.content.match(/- button .*\[ref=(r\d+e\d+)\]/)?.[1];
		assert.ok(ref);
		await page().close();
		await assert.rejects(session.execute({ action: "click", ref }), /stale|snapshot/i);
		assert.equal(await first.getAttribute("html", "data-clicked"), null);
	});
});

test("named profiles allow all public sites, isolate saved data and revoke selection on shutdown", integration, async () => {
	await fixture(async (session) => {
		const driver = session as unknown as { context: BrowserContext; requirePage(): Page };
		const origin = "https://93.184.216.34";
		const open = async (name: string) => {
			await session.selectProfile(name);
			await session.ensureLaunched();
			await driver.context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<p>Saved profile fixture</p>" }));
			await session.execute({ action: "navigate", url: origin });
			assert.equal(driver.requirePage().viewportSize(), null, "window sizing must not emulate a fixed viewport");
		};
		await session.createProfile("applications");
		await session.createProfile("other");
		await open("applications");
		const runDirectory = join(process.env.PI_CODING_AGENT_DIR!, RUN_DIR_NAME);
		const state = JSON.parse(await readFile(join(runDirectory, (await readdir(runDirectory))[0]), "utf8"));
		assert.ok(state.browserPid > 0, "real Chromium launch must record a verifiable process identity");
		assert.match(state.browserStartTime, /^\d+$/);
		await driver.context.addCookies([{ name: "saved", value: "saved-fixture-secret", url: origin, expires: Date.now() / 1000 + 86400 }]);
		await driver.requirePage().evaluate(() => localStorage.setItem("saved", "profile-storage-fixture"));
		await session.execute({ action: "navigate", url: "https://93.184.216.35" });
		assert.equal(driver.requirePage().url(), "https://93.184.216.35/");
		assert.match((await session.execute({ action: "snapshot" })).content, /Saved profile fixture/);
		await assert.rejects(session.execute({ action: "navigate", url: "http://127.0.0.1" }), /Blocked/);
		await assert.rejects(session.applyGrants([origin]), /all public sites/);
		await assert.rejects(session.importChromiumCookies([origin]), /clear grants/);
		await open("other");
		assert.deepEqual(await driver.context.cookies(), []);
		assert.equal(await driver.requirePage().evaluate(() => localStorage.getItem("saved")), null);
		await open("applications");
		assert.equal((await driver.context.cookies()).find((cookie) => cookie.name === "saved")?.value, "saved-fixture-secret");
		assert.equal(await driver.requirePage().evaluate(() => localStorage.getItem("saved")), "profile-storage-fixture");
		await session.closeBrowser();
		assert.equal(session.profileName(), "applications", "close retains approval and selection");
		await session.ensureLaunched();
		assert.equal((await driver.context.cookies()).find((cookie) => cookie.name === "saved")?.value, "saved-fixture-secret");
		await session.shutdown();
		assert.equal(session.profileName(), undefined);
		assert.deepEqual(session.grantList(), []);
		assert.deepEqual(await session.listProfiles(), ["applications", "other"]);
		session.setMode("host");
		await session.ensureLaunched();
		assert.deepEqual(await driver.context.cookies(), [], "anonymous launch cannot inherit saved cookies");
	});
});
