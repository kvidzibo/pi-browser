import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findChromium } from "../browser-bin.ts";
import { createChromiumCookieImport, IMPORT_BROWSER_ARGS, IMPORT_IGNORE_ARGS } from "../chromium-import.ts";
import { BrowserSession } from "../session.ts";
import { requestCookieAccessWithUI } from "../cookie-access.ts";
import { privateKeyring } from "./keyring-fixture.ts";

for (const keyring of [false, true]) test(`local Chromium import: persistent/session cookies, redaction, relaunch and cleanup (keyring=${keyring})`, {
	skip: process.env.BROWSER_LOCAL_INTEGRATION !== "1", timeout: 60000,
}, async (t) => {
	if (keyring) {
		const { execFileSync } = await import("node:child_process");
		try { for (const cmd of ["gnome-keyring-daemon", "dbus-daemon", "gdbus"]) execFileSync("which", [cmd], { stdio: "ignore" }); }
		catch {
			if (process.env.BROWSER_REQUIRE_KEYRING === "1") throw new Error("Required private keyring fixture tools unavailable");
			t.skip("private desktop-keyring fixture tools unavailable"); return;
		}
	}
	const { chromium } = await import("patchright-core");
	const executablePath = (await findChromium()).executablePath;
	const dir = await mkdtemp(join(tmpdir(), "pi-import-live-test-"));
	const root = join(dir, "chromium");
	const beforeEnv = { ...process.env };
	// Synthetic profiles only. Do not use the tester's real HOME or desktop keyring.
	Object.assign(process.env, { HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), XDG_CONFIG_HOME: join(dir, "config"),
		XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state"), XDG_RUNTIME_DIR: join(dir, "run"),
		XDG_CURRENT_DESKTOP: keyring ? "GNOME" : "", GNOME_KEYRING_CONTROL: join(dir, "keyring-control"),
		DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/no-session-bus`, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${dir}/no-system-bus` });
	let isolatedKeyring: Awaited<ReturnType<typeof privateKeyring>> | undefined;
	let source: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
	let importedDir = "";
	const session = new BrowserSession(undefined, async (origins, options) => {
		const imported = await createChromiumCookieImport(origins, { ...options, sourceRoot: root, executablePath, tempRoot: dir });
		importedDir = imported.userDataDir;
		return imported;
	});
	try {
		await mkdir(process.env.XDG_RUNTIME_DIR!, { recursive: true, mode: 0o700 });
		await mkdir(process.env.HOME!, { recursive: true, mode: 0o700 });
		if (keyring) { isolatedKeyring = await privateKeyring(dir); process.env.DBUS_SESSION_BUS_ADDRESS = isolatedKeyring.address; }
		await mkdir(join(root, "Default"), { recursive: true });
		await writeFile(join(root, "Default", "Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
		source = await chromium.launchPersistentContext(root, { executablePath, headless: false,
			args: [...IMPORT_BROWSER_ARGS, ...(keyring ? ["--password-store=gnome-libsecret"] : [])],
			ignoreDefaultArgs: keyring ? IMPORT_IGNORE_ARGS : undefined,
		});
		await source.route("**/*", (route) => route.abort());
		await source.addCookies([
			{ name: "persistent", value: "persistent-fixture-secret", url: "https://93.184.216.34", httpOnly: true, secure: true, sameSite: "Strict", expires: Date.now() / 1000 + 86400 },
			{ name: "session", value: "session-fixture-secret", url: "https://93.184.216.34", httpOnly: true, secure: true },
			{ name: "ungranted", value: "ungranted-fixture-secret", url: "https://93.184.216.35", expires: Date.now() / 1000 + 86400 },
		]);
		await source.close(); source = undefined;
		const sourceCookiePath = await stat(join(root, "Default", "Network", "Cookies")).then(() => join(root, "Default", "Network", "Cookies"), () => join(root, "Default", "Cookies"));
		const before = await readFile(sourceCookiePath);
		assert.ok(!before.includes(Buffer.from("persistent-fixture-secret")), "fixture must actually exercise encrypted disk cookies");
		if (keyring) {
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(sourceCookiePath, { readOnly: true });
			try { assert.equal(db.prepare("SELECT hex(substr(encrypted_value, 1, 3)) AS prefix FROM cookies WHERE name='persistent'").get()!.prefix, "763131", "must exercise libsecret v11, not basic v10"); }
			finally { db.close(); }
		}

		session.setMode("host"); // The entire test runs under xvfb-run.
		assert.equal(await session.importChromiumCookies(["https://93.184.216.34"]), 2);
		assert.match(session.statusText(), /source=chromium-copy/);
		let context = (session as any).context;
		const cookies = await context.cookies();
		assert.deepEqual(cookies.map((cookie: any) => cookie.name).sort(), ["persistent", "session"]);
		assert.equal(cookies.find((cookie: any) => cookie.name === "persistent").value, "persistent-fixture-secret");
		assert.equal(cookies.find((cookie: any) => cookie.name === "persistent").sameSite, "Strict");
		assert.equal(cookies.find((cookie: any) => cookie.name === "session").expires, -1);
		assert.ok(cookies.every((cookie: any) => cookie.httpOnly && cookie.secure));
		// Fulfill the synthetic public-origin request locally; no site is contacted.
		await context.route("https://93.184.216.34/**", (route: any) => route.fulfill({ contentType: "text/html", body: "<p>persistent-fixture-secret</p>" }));
		const result = await session.execute({ action: "navigate", url: "https://93.184.216.34/" });
		assert.ok(!result.content.includes("persistent-fixture-secret"));
		await assert.rejects(session.execute({ action: "navigate", url: "https://93.184.216.35/" }), /not granted/);
		await session.closeBrowser();
		await session.ensureLaunched();
		context = (session as any).context;
		assert.equal((await context.cookies()).length, 2, "close/reopen must retain session cookies without recopying the source");
		const params = { origins: ["https://93.184.216.34"], cookieNames: ["session"] };
		const denied = await session.withLock(() => requestCookieAccessWithUI(session,
			{ hasUI: true, mode: "rpc", ui: { confirm: async () => false } } as any, params));
		assert.equal(denied.details?.status, "denied");
		assert.equal((session as any).context, context, "denial must not close or replace the active browser");
		const previousSnapshot = await session.execute({ action: "snapshot" });
		const previousSnapshotId = Number(previousSnapshot.details?.snapshot);
		await session.execute({ action: "snapshot", snapshotId: previousSnapshotId, offset: 1 });
		const previousCopy = importedDir;
		const approved = await session.withLock(() => requestCookieAccessWithUI(session,
			{ hasUI: true, mode: "rpc", ui: { confirm: async () => true } } as any, params));
		assert.equal(approved.details?.status, "granted");
		assert.equal(approved.details?.cookieCount, 1);
		assert.ok(!JSON.stringify(approved).includes("fixture-secret"));
		assert.deepEqual(session.grantList(), params.origins);
		await assert.rejects(session.execute({ action: "snapshot", snapshotId: previousSnapshotId, offset: 1 }), /Stale/);
		context = (session as any).context;
		assert.deepEqual((await context.cookies()).map((cookie: any) => cookie.name), ["session"]);
		assert.notEqual(importedDir, previousCopy);
		await assert.rejects(stat(previousCopy), { code: "ENOENT" });
		await session.clearGrants();
		assert.deepEqual(session.grantList(), []);
		await assert.rejects(stat(importedDir), { code: "ENOENT" });
		assert.deepEqual(await readFile(sourceCookiePath), before, "source cookie data remains unchanged");
	} finally {
		await source?.close(); await session.shutdown(); await isolatedKeyring?.stop();
		for (const key of Object.keys(process.env)) if (!(key in beforeEnv)) delete process.env[key];
		Object.assign(process.env, beforeEnv);
		await rm(dir, { recursive: true, force: true });
	}
});
