import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CookieImportError, cookieHostMatches, createChromiumCookieImport, defaultChromiumRoot, IMPORT_IGNORE_ARGS, listChromiumCookieSites, parseCookieNames } from "../chromium-import.ts";
import { MAX_COOKIE_NAMES, MAX_COOKIE_NAME_CHARS } from "../constants.ts";

const future = BigInt(Date.now()) * 1000n + 11644473600000000n + 86400000000n;
async function fixture(run: (root: string, path: string, db: DatabaseSync, temp: string) => Promise<void>, network = true) {
	const temp = await mkdtemp(join(tmpdir(), "pi-import-test-"));
	const root = join(temp, "chromium");
	const dir = network ? join(root, "Default", "Network") : join(root, "Default");
	await mkdir(dir, { recursive: true });
	const path = join(dir, "Cookies");
	const db = new DatabaseSync(path);
	db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
		CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER); INSERT INTO meta VALUES ('version', 24);
		CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, has_expires INTEGER, expires_utc INTEGER, is_httponly INTEGER, samesite INTEGER);
	`);
	const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, 1, 2)");
	insert.run(".example.test", "domain", "", Buffer.from("ciphertext-fixture"), 1, future);
	insert.run("mail.example.test", "session", "session-fixture", Buffer.alloc(0), 0, 0);
	insert.run("example.test", "host-only", "excluded-parent-secret", Buffer.alloc(0), 1, future);
	insert.run("other.example.test", "other", "excluded-sibling-secret", Buffer.alloc(0), 1, future);
	insert.run("evil-example.test", "lookalike", "excluded-lookalike-secret", Buffer.alloc(0), 1, future);
	insert.run("mail.example.test", "expired", "excluded-expired-secret", Buffer.alloc(0), 1, 1);
	await writeFile(join(root, "Local State"), JSON.stringify({ os_crypt: { key: "encrypted-fixture" }, accounts: "do-not-copy-account-info" }));
	await writeFile(join(root, "Default", "History"), "do-not-copy-history");
	try { await run(root, path, db, temp); }
	finally { db.close(); await rm(temp, { recursive: true, force: true }); }
}

const options = (sourceRoot: string, tempRoot: string) => ({ sourceRoot, tempRoot, executablePath: "/test/chromium", platform: "linux" as const });

test("Chromium default path follows config overrides; cookie matching respects domain boundaries", () => {
	assert.equal(defaultChromiumRoot({}, "/home/fixture"), "/home/fixture/.config/chromium");
	assert.equal(defaultChromiumRoot({ XDG_CONFIG_HOME: "/config" }), "/config/chromium");
	assert.equal(defaultChromiumRoot({ CHROME_CONFIG_HOME: "/chrome", XDG_CONFIG_HOME: "/config" }), "/chrome/chromium");
	for (const [domain, match] of [[".example.test", true], ["mail.example.test", true], ["example.test", false], [".evil-example.test", false], [".test.evil", false], [".", false]] as const) {
		assert.equal(cookieHostMatches(domain, ["mail.example.test"]), match, domain);
	}
	assert.ok(IMPORT_IGNORE_ARGS.includes("--password-store=basic"));
});

for (const network of [true, false]) test(`encrypted cookie snapshot includes WAL, scopes hosts and leaves source unchanged (Network=${network})`, async () => {
	await fixture(async (root, path, db, temp) => {
		const before = await readFile(path), walBefore = await readFile(`${path}-wal`);
		const imported = await createChromiumCookieImport(["https://mail.example.test"], options(root, temp));
		try {
			assert.equal(imported.cookieCount, 2);
			assert.equal(imported.executablePath, "/test/chromium");
			assert.equal((await stat(imported.userDataDir)).mode & 0o777, 0o700);
			const target = join(imported.userDataDir, "Default", ...(network ? ["Network"] : []), "Cookies");
			assert.equal((await stat(target)).mode & 0o777, 0o600);
			const copy = new DatabaseSync(target, { readOnly: true });
			try {
				const query = copy.prepare("SELECT * FROM cookies ORDER BY name");
				query.setReadBigInts(true);
				const rows = query.all();
				assert.deepEqual(rows.map((row) => row.name), ["domain", "session"]);
				assert.equal(Buffer.from(rows[0].encrypted_value as Uint8Array).toString(), "ciphertext-fixture");
				assert.equal(rows[0].is_httponly, 1n); assert.equal(rows[0].samesite, 2n);
				assert.equal(rows[0].expires_utc, future);
				assert.equal(rows[1].has_expires, 0n);
			} finally { copy.close(); }
			assert.ok(!(await readFile(target)).includes(Buffer.from("excluded-")), "deleted values must not survive in free pages");
			assert.deepEqual(JSON.parse(await readFile(join(imported.userDataDir, "Local State"), "utf8")), { os_crypt: { key: "encrypted-fixture" } });
			assert.ok(!(await readdir(join(imported.userDataDir, "Default"))).includes("History"));
			assert.equal(db.prepare("SELECT count(*) AS count FROM cookies").get()!.count, 6);
			assert.deepEqual(await readFile(path), before); assert.deepEqual(await readFile(`${path}-wal`), walBefore);
			assert.ok(!JSON.stringify(imported).includes("session-fixture"));
		} finally { await imported.cleanup(); }
		await assert.rejects(stat(imported.userDataDir), { code: "ENOENT" });
	}, network);
});

for (const network of [true, false]) test(`cookie site discovery reads only metadata, includes live WAL and preserves the source (Network=${network})`, async () => {
	await fixture(async (root, path, db, temp) => {
		// A schema without any cookie-value columns proves the inventory does not query them.
		db.exec("DROP TABLE cookies; CREATE TABLE cookies(host_key TEXT, has_expires INTEGER, expires_utc INTEGER)");
		const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?)");
		for (const host of [".google.com", "accounts.google.com", ".github.com", "github.com", "localhost", "127.0.0.1", "192.168.1.1", "metadata.google.internal", "printer.local", "bad.test/secret", "user:password@bad.test", "evil\x1b[31m.test", ".", "0x7f000001", "93.184.216.34"]) insert.run(host, 1, future);
		insert.run("session.example.test", 0, 0);
		insert.run("expired.example.test", 1, 1);
		await writeFile(join(root, "Local State"), "invalid-encryption-metadata-must-not-be-read");
		const before = await readFile(path), walBefore = await readFile(`${path}-wal`), filesBefore = await readdir(temp);
		const sites = await listChromiumCookieSites({ sourceRoot: root });
		assert.deepEqual(sites.map((site) => site.origin), ["https://93.184.216.34", "https://accounts.google.com", "https://github.com", "https://google.com", "https://mail.google.com", "https://session.example.test"]);
		assert.equal(sites.find((site) => site.origin === "https://mail.google.com")!.label, "Gmail");
		assert.deepEqual(await readFile(path), before); assert.deepEqual(await readFile(`${path}-wal`), walBefore);
		assert.deepEqual(await readdir(temp), filesBefore, "discovery does not create a cookie snapshot");
	}, network);
});

test("discovery does not invent Gmail options from an unrelated or host-only cookie domain", async () => {
	await fixture(async (root, _path, db) => {
		db.exec("DELETE FROM cookies; INSERT INTO cookies(host_key, has_expires, expires_utc) VALUES ('google.com', 0, 0), ('.notgoogle.com', 0, 0)");
		const sites = await listChromiumCookieSites({ sourceRoot: root });
		assert.deepEqual(sites.map((site) => site.origin), ["https://google.com", "https://notgoogle.com"]);
	});
});

test("discovery rejects symlinked databases and unexpected schemas without source details", async () => {
	await fixture(async (root, _path, db, temp) => {
		db.exec("CREATE TABLE unapproved_source_detail(secret TEXT)");
		await assert.rejects(listChromiumCookieSites({ sourceRoot: root }), (error: Error) => {
			assert.match(error.message, /Could not list/); assert.ok(!error.message.includes("unapproved_source_detail")); return true;
		});
		const other = join(temp, "other-root"); await mkdir(join(other, "Default"), { recursive: true });
		await symlink(join(root, "Default", "Network", "Cookies"), join(other, "Default", "Cookies"));
		await assert.rejects(listChromiumCookieSites({ sourceRoot: other }), /Could not list/);
	});
});

test("no matching cookies and malformed encryption metadata clean up without echoing secrets", async () => {
	await fixture(async (root, _path, _db, temp) => {
		const before = await readdir(temp);
		await assert.rejects(createChromiumCookieImport(["https://unrelated.test"], options(root, temp)), /No matching cookies/);
		assert.deepEqual(await readdir(temp), before);
		await writeFile(join(root, "Local State"), "private-secret-invalid-json");
		await assert.rejects(createChromiumCookieImport(["https://mail.example.test"], options(root, temp)), (err: Error) => {
			assert.match(err.message, /Could not import/);
			assert.ok(!err.message.includes("private-secret")); return true;
		});
		assert.deepEqual(await readdir(temp), before);
	});
});

test("expired-only cookies report no match without changing the source or retaining the copy", async () => {
	await fixture(async (root, path, _db, temp) => {
		const before = await readFile(path), walBefore = await readFile(`${path}-wal`), files = await readdir(temp);
		await assert.rejects(createChromiumCookieImport(["https://mail.example.test"], { ...options(root, temp), cookieNames: ["expired"] }), (error: Error) => {
			assert.ok(error instanceof CookieImportError);
			assert.equal(error.code, "no_matching_cookies");
			assert.match(error.message, /No matching cookies.*absent or expired/);
			assert.ok(!error.message.includes("excluded-expired-secret"));
			return true;
		});
		assert.deepEqual(await readFile(path), before);
		assert.deepEqual(await readFile(`${path}-wal`), walBefore);
		assert.deepEqual(await readdir(temp), files);
	});
});

test("unreadable profile paths are not mislabeled as missing and remain private", async () => {
	await fixture(async (_root, _path, _db, temp) => {
		const loop = join(temp, "private-profile-loop");
		await symlink(loop, loop);
		await assert.rejects(createChromiumCookieImport(["https://mail.example.test"], options(loop, temp)), (error: Error) => {
			assert.ok(!(error instanceof CookieImportError));
			assert.match(error.message, /Could not read Chromium's Default profile/);
			assert.ok(!error.message.includes("private-profile-loop"));
			return true;
		});
	});
});

test("name allowlist is exact, intersects the domain scope, and vacuums excluded values", async () => {
	await fixture(async (root, path, db, temp) => {
		// Even a database with a case-insensitive name column cannot widen a name grant.
		db.exec(`ALTER TABLE cookies RENAME TO old_cookies;
			CREATE TABLE cookies(host_key TEXT, name TEXT COLLATE NOCASE, value TEXT, encrypted_value BLOB, has_expires INTEGER, expires_utc INTEGER, is_httponly INTEGER, samesite INTEGER);
			INSERT INTO cookies SELECT * FROM old_cookies; DROP TABLE old_cookies;
			INSERT INTO cookies VALUES ('mail.example.test', 'Session', 'excluded-case-secret', X'', 0, 0, 1, 2);
			INSERT INTO cookies VALUES ('other.example.test', 'session', 'excluded-same-name-secret', X'', 0, 0, 1, 2)`);
		const before = await readFile(path), walBefore = await readFile(`${path}-wal`);
		const imported = await createChromiumCookieImport(["https://mail.example.test"], { ...options(root, temp), cookieNames: ["session"] });
		try {
			assert.equal(imported.cookieCount, 1);
			const target = join(imported.userDataDir, "Default", "Network", "Cookies");
			const copy = new DatabaseSync(target, { readOnly: true });
			try { assert.deepEqual(copy.prepare("SELECT name FROM cookies").all().map((row) => row.name), ["session"]); }
			finally { copy.close(); }
			const bytes = await readFile(target);
			assert.ok(!bytes.includes(Buffer.from("excluded-")));
			assert.ok(!bytes.includes(Buffer.from("ciphertext-fixture")));
			assert.deepEqual(await readFile(path), before);
			assert.deepEqual(await readFile(`${path}-wal`), walBefore);
		} finally { await imported.cleanup(); }
		const files = await readdir(temp);
		await assert.rejects(createChromiumCookieImport(["https://mail.example.test"], { ...options(root, temp), cookieNames: ["missing"] }), /No matching cookies/);
		assert.deepEqual(await readdir(temp), files);
	});
});

test("invalid cookie name filters never fall back to importing all cookies", async () => {
	assert.equal(parseCookieNames(undefined), undefined);
	assert.deepEqual(parseCookieNames(["SID", "SID", "__Secure-1PSID"]), ["SID", "__Secure-1PSID"]);
	for (const names of [[], "SID", [null], ["*"], ["SID="], ["SID\n"], ["bad name"], ["\x1b[31m"], ["x".repeat(MAX_COOKIE_NAME_CHARS + 1)], Array(MAX_COOKIE_NAMES + 1).fill("SID")]) {
		assert.throws(() => parseCookieNames(names), /cookieNames/);
		await assert.rejects(createChromiumCookieImport(["https://mail.example.test"], { cookieNames: names as any, platform: "linux" }), /cookieNames/);
	}
});

test("import requires explicit origins and Linux; source profile symlinks cannot escape the root", async () => {
	await assert.rejects(createChromiumCookieImport([], { platform: "linux" }), /Approve at least one/);
	await assert.rejects(createChromiumCookieImport(["https://mail.example.test"], { platform: "darwin" }), /Linux only/);
	await assert.rejects(createChromiumCookieImport(["file:///secret"], { platform: "linux" }), /exact HTTP/);
	await fixture(async (root, _path, _db, temp) => {
		await rm(join(root, "Local State"));
		const outside = join(temp, "outside.json"); await writeFile(outside, "{}");
		await symlink(outside, join(root, "Local State"));
		await assert.rejects(createChromiumCookieImport(["https://mail.example.test"], options(root, temp)), /Unsupported Chromium/);
	});
});
