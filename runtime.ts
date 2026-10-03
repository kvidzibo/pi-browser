import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Browser, BrowserContext } from "patchright-core";
import { findBrowser } from "./browser-bin.ts";
import { checkCancelled } from "./cancellation.ts";
import { IMPORT_BROWSER_ARGS, IMPORT_IGNORE_ARGS, type ChromiumCookieImport } from "./chromium-import.ts";
import { browserNetworkArgs, DEFAULT_TIMEOUT_MS, PROFILE_DIR_NAME, RUN_DIR_NAME, SHUTDOWN_GRACE_MS, type DisplayMode } from "./constants.ts";
import type { NetworkDiagnostics } from "./diagnostics.ts";
import { killPid, startXvfb, stopXvfb, type XvfbHandle } from "./display.ts";
import { startPinProxy, type PinProxy } from "./pin-proxy.ts";

export function agentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const configured = env.PI_CODING_AGENT_DIR;
	return configured ? resolve(configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured) : join(home, ".pi", "agent");
}

export function ensurePrivateDir(path: string): string {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}

export type RuntimeResources = {
	context?: BrowserContext;
	browser?: Browser;
	xvfb?: XvfbHandle;
	proxy?: PinProxy;
};

type LaunchOptions = {
	mode: DisplayMode;
	persistent: boolean;
	importedProfile?: ChromiumCookieImport;
	profileDirectory?: string;
	grants: () => ReadonlySet<string>;
	agentDirectory: string;
	diagnostics: NetworkDiagnostics;
	signal?: AbortSignal;
};

/** Launch and partial-launch cleanup live together, independent of tabs or tool actions. */
export async function launchRuntime(options: LaunchOptions): Promise<RuntimeResources & { context: BrowserContext }> {
	const resources: RuntimeResources = {};
	try {
		checkCancelled(options.signal);
		if (options.mode === "host" && !process.env.DISPLAY) throw new Error("host mode needs DISPLAY");
		if (options.mode === "xvfb") resources.xvfb = await startXvfb();
		checkCancelled(options.signal);
		const imported = Boolean(options.importedProfile);
		resources.proxy = await startPinProxy({
			allowTarget: (url) => (!imported && options.grants().size === 0) || options.grants().has(url.origin),
			onFailure: (code) => options.diagnostics.record(code),
		});
		const binary = options.importedProfile ?? await findBrowser();
		checkCancelled(options.signal);
		const { chromium } = await import("patchright-core");
		checkCancelled(options.signal);
		const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
		if (resources.xvfb) env.DISPLAY = resources.xvfb.display;
		const proxy = { server: `http://127.0.0.1:${resources.proxy.port}`, username: resources.proxy.username, password: resources.proxy.password };
		const launchOptions = {
			executablePath: binary.executablePath, headless: options.mode === "headless",
			args: [...browserNetworkArgs(options.persistent), ...(options.importedProfile ? IMPORT_BROWSER_ARGS : [])],
			ignoreDefaultArgs: options.importedProfile ? IMPORT_IGNORE_ARGS : undefined,
			proxy, env, timeout: DEFAULT_TIMEOUT_MS,
		};
		const contextOptions = { viewport: null, acceptDownloads: false, serviceWorkers: "block" as const, ignoreHTTPSErrors: false, proxy };
		if (options.persistent) {
			const profile = options.importedProfile?.userDataDir ?? options.profileDirectory ?? ensurePrivateDir(join(options.agentDirectory, PROFILE_DIR_NAME));
			resources.context = await chromium.launchPersistentContext(profile, { ...launchOptions, ...contextOptions });
			resources.browser = resources.context.browser() ?? undefined;
		} else {
			resources.browser = await chromium.launch(launchOptions);
			checkCancelled(options.signal);
			resources.context = await resources.browser.newContext(contextOptions);
		}
		checkCancelled(options.signal);
		return { ...resources, context: resources.context };
	} catch (error) {
		await closeRuntime(resources);
		throw error;
	}
}

export async function closeRuntime(resources: RuntimeResources): Promise<void> {
	try { await resources.context?.close(); } catch { /* continue revocation */ }
	try { await resources.browser?.close(); } catch { /* continue revocation */ }
	try { await resources.proxy?.close(); } catch { /* continue revocation */ }
	await stopXvfb(resources.xvfb, SHUTDOWN_GRACE_MS);
}

const MARKER = "pi-browser";
type RunState = { marker: string; ownerPid: number; xvfbPid?: number; xvfbStartTime?: string;
	browserPid?: number; browserStartTime?: string; display?: string; userDataDir?: string };

export class RuntimeState {
	readonly directory: string;
	private readonly path: string;
	constructor(directory = agentDir()) {
		this.directory = directory;
		this.path = join(directory, RUN_DIR_NAME, `state-${process.pid}-${randomBytes(4).toString("hex")}.json`);
	}
	write(resources: RuntimeResources, userDataDir?: string): void {
		ensurePrivateDir(join(this.directory, RUN_DIR_NAME));
		const browser = userDataDir ? browserIdentity(userDataDir) : undefined;
		const state: RunState = { marker: MARKER, ownerPid: process.pid,
			xvfbPid: resources.xvfb?.pid, xvfbStartTime: resources.xvfb ? processStartTime(resources.xvfb.pid) : undefined,
			browserPid: browser?.pid, browserStartTime: browser?.startTime, display: resources.xvfb?.display, userDataDir };
		writeFileSync(this.path, JSON.stringify(state), { mode: 0o600 });
	}
	remove(): void { try { unlinkSync(this.path); } catch { /* absent */ } }
	async reap(): Promise<void> {
		const dir = join(this.directory, RUN_DIR_NAME);
		let names: string[];
		try { names = readdirSync(dir); } catch { return; }
		for (const name of names) {
			if (!name.startsWith("state-") || !name.endsWith(".json")) continue;
			const path = join(dir, name);
			let state: RunState;
			try { state = JSON.parse(readFileSync(path, "utf8")) as RunState; } catch { continue; }
			if (state.marker !== MARKER || !Number.isSafeInteger(state.ownerPid) || state.ownerPid <= 0 || pidAlive(state.ownerPid)) continue;
			await reapState(state);
			try { unlinkSync(path); } catch { /* absent */ }
		}
	}
}

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function reapState(state: RunState): Promise<void> {
	// Old records without start times cannot prove ownership: leave their processes alone.
	if (state.xvfbPid && state.xvfbStartTime) {
		const pid = state.xvfbPid;
		await killPid(pid, SHUTDOWN_GRACE_MS, () => sameProcess(pid, state.xvfbStartTime) &&
			basename(commandLine(pid)[0] ?? "") === "Xvfb");
	}
	if (state.browserPid && state.browserStartTime && state.userDataDir) {
		const pid = state.browserPid;
		await killPid(pid, SHUTDOWN_GRACE_MS, () => sameProcess(pid, state.browserStartTime) &&
			profileOwnsBrowser(state.userDataDir!, pid));
	}
}

function commandLine(pid: number): string[] {
	try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); }
	catch { return []; }
}

function processStartTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm can contain spaces and parentheses; fields after its final ')' begin at field 3.
		const value = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		return value && /^\d+$/.test(value) ? value : undefined;
	} catch { return undefined; }
}

function sameProcess(pid: number, startTime?: string): boolean {
	return Number.isSafeInteger(pid) && pid > 0 && typeof startTime === "string" &&
		/^\d+$/.test(startTime) && processStartTime(pid) === startTime;
}

function profileBrowserPid(directory: string): number | undefined {
	try {
		const lock = readlinkSync(join(directory, "SingletonLock"));
		const prefix = `${hostname()}-`;
		const suffix = lock.startsWith(prefix) ? lock.slice(prefix.length) : "";
		const pid = Number(suffix);
		return /^\d+$/.test(suffix) && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
	} catch { return undefined; }
}

function profileOwnsBrowser(directory: string, pid: number): boolean {
	try {
		// Chromium flattens /proc/cmdline into its process title; splitting it cannot
		// safely recover argv (especially paths with spaces). Its exact profile lock
		// identifies the main process without path substring matching or /proc scans.
		return profileBrowserPid(directory) === pid &&
			/^(?:chromium|chrome|google-chrome|msedge)(?:-.*)?$/.test(basename(readlinkSync(`/proc/${pid}/exe`)));
	} catch { return false; }
}

function browserIdentity(directory: string): { pid: number; startTime: string } | undefined {
	const pid = profileBrowserPid(directory);
	if (!pid) return undefined;
	const startTime = processStartTime(pid);
	return startTime && profileOwnsBrowser(directory, pid) && sameProcess(pid, startTime) ? { pid, startTime } : undefined;
}
