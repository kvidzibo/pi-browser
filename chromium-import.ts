import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { isBlockedAddress, normalizeHostname } from "./gate.ts";
import { isAbsolute, join, relative, sep } from "node:path";
import { findChromium } from "./browser-bin.ts";

// Keep Chromium's own desktop keyring backend. Patchright otherwise forces basic storage.
export const IMPORT_IGNORE_ARGS = ["--password-store=basic", "--use-mock-keychain"];
export const IMPORT_BROWSER_ARGS = ["--restore-last-session"];
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;

export type ChromiumCookieImport = {
	userDataDir: string;
	executablePath: string;
	cookieCount: number;
	cleanup: () => Promise<void>;
};

export function defaultChromiumRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.CHROME_CONFIG_HOME || env.XDG_CONFIG_HOME || join(home, ".config"), "chromium");
}

export function cookieHostMatches(host: string, hosts: string[]): boolean {
	if (host.startsWith(".")) {
		const domain = host.slice(1).toLowerCase();
		return domain.length > 0 && hosts.some((target) => target === domain || target.endsWith(`.${domain}`));
	}
	return hosts.includes(host.toLowerCase());
}

async function regularFile(root: string, name: string, maxBytes: number): Promise<string | undefined> {
	const path = join(root, name);
	let stat;
	try { stat = await lstat(path); }
	catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
	if (!stat.isFile() || stat.size > maxBytes) throw new Error("Unsupported Chromium profile file");
	const resolved = await realpath(path);
	const rel = relative(root, resolved);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Chromium profile file leaves its profile directory");
	return resolved;
}

async function cookieSource(sourceRoot?: string) {
	let root: string;
	try { root = await realpath(sourceRoot ?? defaultChromiumRoot()); }
	catch { throw new Error("Default Chromium profile not found. Open Chromium and sign in first, or use /browser login."); }
	const cookieName = await regularFile(root, "Default/Network/Cookies", MAX_DATABASE_BYTES)
		? "Default/Network/Cookies" : "Default/Cookies";
	const sourcePath = await regularFile(root, cookieName, MAX_DATABASE_BYTES);
	if (!sourcePath) throw new Error("No cookie database in Chromium's Default profile. Sign in there first.");
	await regularFile(root, `${cookieName}-wal`, MAX_DATABASE_BYTES);
	await regularFile(root, `${cookieName}-shm`, MAX_DATABASE_BYTES);
	return { root, cookieName, sourcePath };
}

function checkCookieDatabase(source: DatabaseSync): void {
	source.exec("PRAGMA trusted_schema=OFF; BEGIN");
	const tables = source.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
	if (tables.some((row) => row.name !== "cookies" && row.name !== "meta")) throw new Error("Unexpected cookie tables");
	const pageSize = Number(source.prepare("PRAGMA page_size").get()!.page_size);
	const pages = Number(source.prepare("PRAGMA page_count").get()!.page_count);
	if (pageSize * pages > MAX_DATABASE_BYTES) throw new Error("Cookie database too large");
}

export type CookieSite = { origin: string; label: string };

function cookieSiteOrigin(host: string): string | undefined {
	const domain = host.replace(/^\./, "").toLowerCase();
	if (!domain || domain.length > 253 || /[\s\x00-\x1f\x7f-\x9f/@?#\\%]/u.test(domain)) return undefined;
	try {
		const url = new URL(`https://${domain}`);
		if (url.hostname !== domain || url.port || url.username || url.password) return undefined;
		const hostname = normalizeHostname(url.hostname);
		if (isIP(hostname)) return isBlockedAddress(hostname) ? undefined : url.origin;
		if (!hostname.includes(".") || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return undefined;
		if (!hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
		return url.origin;
	} catch { return undefined; }
}

/** Metadata for the user-only picker; no values, keyring access, history or DNS lookups. */
export async function listChromiumCookieSites(options: { sourceRoot?: string; platform?: NodeJS.Platform } = {}): Promise<CookieSite[]> {
	if ((options.platform ?? process.platform) !== "linux") throw new Error("Chromium cookie sites currently support Linux only");
	try {
		const { sourcePath } = await cookieSource(options.sourceRoot);
		const { DatabaseSync } = await import("node:sqlite");
		const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 1000 });
		let hosts: string[];
		try {
			checkCookieDatabase(source);
			const now = BigInt(Date.now()) * 1000n + 11644473600000000n;
			const rows = source.prepare("SELECT DISTINCT host_key FROM cookies WHERE has_expires = 0 OR expires_utc > ? LIMIT 10001").all(now);
			if (rows.length > 10000) throw new Error("Too many cookie sites");
			hosts = rows.map((row) => row.host_key).filter((host): host is string => typeof host === "string");
		} finally { source.close(); }
		const sites = new Map<string, CookieSite>();
		for (const host of hosts) {
			const origin = cookieSiteOrigin(host);
			if (origin) sites.set(origin, { origin, label: origin });
		}
		// Domain cookies cannot enumerate every usable subdomain. Offer the Gmail
		// entrypoints explicitly when Google cookies cover them; never auto-select them.
		for (const [origin, label] of [["https://mail.google.com", "Gmail"], ["https://accounts.google.com", "Google sign-in"]]) {
			if (hosts.some((host) => cookieHostMatches(host, [new URL(origin).hostname]))) sites.set(origin, { origin, label });
		}
		return [...sites.values()].sort((a, b) => a.origin.localeCompare(b.origin));
	} catch {
		throw new Error("Could not list Chromium cookie sites. Check Node 22.16+ and the readable Default profile, or enter origins manually.");
	}
}

/** Called only by the confirmed /browser login --from-chromium command. Never returns cookie values. */
export async function createChromiumCookieImport(
	origins: string[],
	options: { sourceRoot?: string; executablePath?: string; tempRoot?: string; platform?: NodeJS.Platform;
		registerCleanup?: (profile: ChromiumCookieImport) => void } = {},
): Promise<ChromiumCookieImport> {
	if ((options.platform ?? process.platform) !== "linux") throw new Error("Chromium cookie import currently supports Linux only");
	if (!origins.length) throw new Error("Approve at least one origin before importing cookies");
	const hosts = [...new Set(origins.map((origin) => {
		const url = new URL(origin);
		if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
			throw new Error("Cookie import requires exact HTTP(S) origins");
		}
		return url.hostname.toLowerCase();
	}))];
	const executablePath = options.executablePath ?? (await findChromium()).executablePath;
	const { root, cookieName, sourcePath } = await cookieSource(options.sourceRoot);
	const statePath = await regularFile(root, "Local State", 16 * 1024 * 1024);
	const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "pi-browser-chromium-"));
	const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	const profile = { userDataDir: dir, executablePath, cookieCount: 0, cleanup };
	try {
		// Let the session retain a retry handle even if staging or cleanup later fails.
		options.registerCleanup?.(profile);
		await chmod(dir, 0o700);
		const { DatabaseSync, backup } = await import("node:sqlite");
		if (!backup) throw new Error("SQLite backup unavailable");
		const destination = join(dir, cookieName);
		await mkdir(join(dir, "Default"), { mode: 0o700 });
		if (cookieName.includes("Network/")) await mkdir(join(dir, "Default", "Network"), { mode: 0o700 });
		await writeFile(destination, "", { mode: 0o600, flag: "wx" });
		const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 1000 });
		try {
			// Read-only transaction includes committed WAL data from a running Chromium.
			checkCookieDatabase(source);
			await backup(source, destination, { rate: 4096 });
		} finally { source.close(); }

		let cookieCount = 0;
		const copy = new DatabaseSync(destination);
		try {
			copy.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON");
			const remove = copy.prepare("DELETE FROM cookies WHERE host_key = ?");
			for (const row of copy.prepare("SELECT DISTINCT host_key FROM cookies").all()) {
				if (typeof row.host_key !== "string" || !cookieHostMatches(row.host_key, hosts)) remove.run(row.host_key);
			}
			const now = BigInt(Date.now()) * 1000n + 11644473600000000n;
			copy.prepare("DELETE FROM cookies WHERE has_expires = 1 AND expires_utc <= ?").run(now);
			cookieCount = Number(copy.prepare("SELECT count(*) AS count FROM cookies").get()!.count);
			// Remove deleted cookies from free pages as well, before Chromium opens the copy.
			copy.exec("VACUUM");
		} finally { copy.close(); }
		if (!cookieCount) throw new Error("No matching cookies");
		await chmod(destination, 0o600);

		// Only encryption metadata, not account details, history, extensions, preferences,
		// passwords or tabs. Decryption stays inside Chromium using this user's keyring.
		const state = statePath ? JSON.parse(await readFile(statePath, "utf8")) : {};
		await writeFile(join(dir, "Local State"), JSON.stringify({ os_crypt: state.os_crypt ?? {} }), { mode: 0o600 });
		await writeFile(join(dir, "Default", "Preferences"), JSON.stringify({
			session: { restore_on_startup: 1 }, profile: { exit_type: "Normal" },
		}), { mode: 0o600 });
		profile.cookieCount = cookieCount;
		return profile;
	} catch {
		try { await cleanup(); }
		catch { throw new Error(`Temporary Chromium cookie cleanup failed: ${dir}. Retry /browser logout.`); }
		// Do not relay SQLite, keyring or profile-parser errors containing source data.
		throw new Error("Could not import matching Chromium cookies. Requires Node 22.16+ and a readable Default profile with unexpired cookies for the approved sites. If Chromium is busy, close it and retry.");
	}
}
