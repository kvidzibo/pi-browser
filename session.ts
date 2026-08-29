import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "patchright-core";
import { validateAction, type BrowserParams } from "./actions.ts";
import { findBrowser } from "./browser-bin.ts";
import {
	DEFAULT_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	PROFILE_DIR_NAME,
	RUN_DIR_NAME,
	SHOTS_DIR_NAME,
	SHUTDOWN_GRACE_MS,
	type DisplayMode,
} from "./constants.ts";
import { cmdlineOf, killPid, resolveMode, startXvfb, stopXvfb, type XvfbHandle } from "./display.ts";
import { isAboutBlank, isPassthroughRequestUrl, validateBrowserUrl } from "./gate.ts";
import { classifyGrantedRequest, originAllowed, originOf } from "./grants.ts";
import { startPinProxy, type PinProxy } from "./pin-proxy.ts";
import { redactUrl, sanitizeWithSecrets } from "./redact.ts";
import { formatUntrustedSnapshot, parseAgentRef } from "./snapshot.ts";

const MARKER = "pi-browser";

type RunState = {
	marker: string;
	ownerPid: number;
	xvfbPid?: number;
	browserPid?: number;
	display?: string;
	userDataDir?: string;
};

class Mutex {
	private chain: Promise<void> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const wait = this.chain;
		this.chain = wait.then(
			() => next,
			() => next,
		);
		return wait.then(fn, fn).finally(() => release());
	}
}

function piAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

function ensurePrivateDir(path: string): string {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}

export type SessionResult = {
	content: string;
	isError?: boolean;
	details?: Record<string, unknown>;
};

export class BrowserSession {
	private readonly lock = new Mutex();
	private closed = false;
	private mode: DisplayMode | "auto" = "auto";
	private grants = new Set<string>();
	private xvfb: XvfbHandle | undefined;
	private browser: Browser | undefined;
	private context: BrowserContext | undefined;
	private persistent = false;
	private pages = new Map<string, Page>();
	private activeTab = "";
	private tabSeq = 0;
	private snapshotRev = 0;
	private abortLaunch: AbortController | undefined;
	private forcePersistent = false;
	private proxy: PinProxy | undefined;
	private cookieSecrets = new Set<string>();

	withLock<T>(fn: () => Promise<T>): Promise<T> {
		return this.lock.run(fn);
	}

	configuredMode(): DisplayMode | "auto" {
		return this.mode;
	}

	setMode(mode: DisplayMode): void {
		this.mode = mode;
	}

	grantList(): string[] {
		return [...this.grants].sort();
	}

	setGrants(origins: string[]): void {
		this.grants = new Set(origins);
	}

	clearGrants(): void {
		this.grants.clear();
		this.forcePersistent = false;
	}

	armPersistentProfile(): void {
		this.forcePersistent = true;
	}

	async applyGrants(origins: string[]): Promise<void> {
		this.grants = new Set(origins);
		this.forcePersistent = true;
		this.proxy?.dropTunnels();
		if (!this.context) return;
		const entries = [...this.pages.entries()];
		let keeper: Page | undefined;
		for (const [id, page] of entries) {
			if (!keeper) {
				keeper = page;
				this.activeTab = id;
				continue;
			}
			try {
				await page.close();
			} catch {
				// ignore
			}
		}
		if (keeper) {
			try {
				await keeper.goto("about:blank", { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
			} catch {
				// ignore
			}
		}
		this.invalidateSnapshot();
	}

	statusText(): string {
		const mode = resolveMode(this.mode);
		const url = this.activePage()?.url();
		const grants = this.grants.size ? this.grantList().join(" ") : "(none)";
		const running = this.context ? "up" : "down";
		const urlText = url ? sanitizeWithSecrets(redactUrl(url), [...this.cookieSecrets]) : "-";
		return `browser ${running} mode=${mode} persistent=${this.persistent} url=${urlText} grants=${grants}`;
	}

	async reapStale(): Promise<void> {
		const dir = join(piAgentDir(), RUN_DIR_NAME);
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.startsWith("state-") || !name.endsWith(".json")) continue;
			const path = join(dir, name);
			let state: RunState;
			try {
				state = JSON.parse(readFileSync(path, "utf8")) as RunState;
			} catch {
				continue;
			}
			if (state.marker !== MARKER) continue;
			if (state.ownerPid === process.pid && this.context) continue;
			if (state.ownerPid !== process.pid && pidAlive(state.ownerPid)) continue;
			await reapState(state);
			try {
				unlinkSync(path);
			} catch {
				// ignore
			}
		}
	}

	async shutdown(): Promise<void> {
		await this.withLock(async () => {
			this.closed = true;
			this.abortLaunch?.abort();
			await this.teardown();
			this.closed = false;
			this.grants.clear();
			this.mode = "auto";
		});
	}

	async closeBrowser(): Promise<string> {
		await this.teardown();
		return "Browser closed.";
	}

	async execute(params: BrowserParams, signal?: AbortSignal): Promise<SessionResult> {
		try {
			return await this.sanitizeResult(await this.executeInner(params, signal));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const secrets = await this.secretValues();
			throw new Error(sanitizeWithSecrets(message, secrets));
		}
	}

	private async executeInner(params: BrowserParams, signal?: AbortSignal): Promise<SessionResult> {
		if (this.closed) throw new Error("Browser session is shutting down");
		const action = validateAction(params);
		if (action.action === "close") {
			return { content: await this.closeBrowser() };
		}
		await this.ensureLaunched(signal);
		await this.secretValues();
		const page = this.requirePage();
		const timeout = DEFAULT_TIMEOUT_MS;

		switch (action.action) {
			case "navigate":
				await this.goto(page, action.url, signal);
				return this.snapshotResult(page);
			case "snapshot":
				this.assertPageAllowed(page, "snapshot");
				return this.snapshotResult(page);
			case "screenshot":
				this.assertPageAllowed(page, "screenshot");
				return this.screenshotResult(page);
			case "click": {
				this.assertPageAllowed(page, "click");
				await this.locator(page, action.ref).click({ timeout, signal, steps: 8, delay: 25 });
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage());
			}
			case "type":
				this.assertPageAllowed(page, "type");
				await this.locator(page, action.ref).click({ timeout, signal, steps: 8, delay: 25 });
				if (action.text.length <= 120) {
					await this.locator(page, action.ref).fill("", { timeout, signal });
					await this.locator(page, action.ref).pressSequentially(action.text, { timeout, signal, delay: 18 });
				} else {
					await this.locator(page, action.ref).fill(action.text, { timeout, signal });
				}
				return { content: `Typed ${action.text.length} chars into ${action.ref}.` };
			case "press": {
				this.assertPageAllowed(page, "press");
				if (action.ref) await this.locator(page, action.ref).press(action.key, { timeout, signal });
				else await page.keyboard.press(action.key);
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage());
			}
			case "scroll": {
				this.assertPageAllowed(page, "scroll");
				const delta = action.direction === "up" ? -800 : 800;
				if (action.ref) await this.locator(page, action.ref).hover({ timeout, signal });
				await page.mouse.wheel(0, delta);
				return { content: `Scrolled ${action.direction}.` };
			}
			case "wait":
				await waitFor(action.timeoutMs, signal);
				return { content: `Waited ${action.timeoutMs}ms.` };
			case "back":
				this.assertPageAllowed(page, "back");
				await page.goBack({ timeout, waitUntil: "domcontentloaded" });
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage());
			case "select":
				this.assertPageAllowed(page, "select");
				await this.locator(page, action.ref).selectOption(action.value, { timeout, signal });
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage());
			case "check":
				this.assertPageAllowed(page, "check");
				if (action.checked) await this.locator(page, action.ref).check({ timeout, signal });
				else await this.locator(page, action.ref).uncheck({ timeout, signal });
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage());
			case "hover":
				this.assertPageAllowed(page, "hover");
				await this.locator(page, action.ref).hover({ timeout, signal });
				return { content: `Hovered ${action.ref}.` };
			case "tabs":
				return this.tabsAction(action, signal);
		}
	}

	private locator(page: Page, ref: string) {
		const { playwrightRef } = parseAgentRef(ref, this.snapshotRev);
		return page.locator(`aria-ref=${playwrightRef}`);
	}

	private async tabsAction(
		action: Extract<ReturnType<typeof validateAction>, { action: "tabs" }>,
		signal?: AbortSignal,
	): Promise<SessionResult> {
		await this.dropUngrantedTabs();
		if (action.tabAction === "list") return { content: this.tabSummary() };
		if (action.tabAction === "new") {
			const page = await this.context!.newPage();
			const id = this.adoptPage(page, true);
			if (action.url) await this.goto(page, action.url, signal);
			return this.snapshotResult(page, `Opened ${id}.`);
		}
		if (action.tabAction === "switch") {
			const page = this.pages.get(action.tabId);
			if (!page) throw new Error(`Unknown tab ${action.tabId}`);
			this.assertPageAllowed(page, "tab switch");
			this.activeTab = action.tabId;
			await page.bringToFront();
			return this.snapshotResult(page);
		}
		const tabId = action.tabId ?? this.activeTab;
		const page = this.pages.get(tabId);
		if (!page) throw new Error(`Unknown tab ${tabId}`);
		if (this.pages.size === 1) throw new Error("Cannot close the last tab. Use action close.");
		await page.close();
		this.pages.delete(tabId);
		if (this.activeTab === tabId) {
			this.activeTab = this.pages.keys().next().value ?? "";
			await this.activePage()?.bringToFront();
		}
		const next = this.requirePage();
		this.assertPageAllowed(next, "tab close");
		return this.snapshotResult(next, `Closed ${tabId}.`);
	}

	private async dropUngrantedTabs(): Promise<void> {
		if (!this.persistent || this.grants.size === 0) return;
		for (const [id, page] of [...this.pages.entries()]) {
			if (this.pageOriginOk(page.url())) continue;
			try {
				await page.close();
			} catch {
				// ignore
			}
			this.pages.delete(id);
			if (this.activeTab === id) this.activeTab = "";
		}
		if (!this.activeTab || !this.pages.has(this.activeTab)) {
			this.activeTab = this.pages.keys().next().value ?? "";
		}
	}

	private async goto(page: Page, rawUrl: string, signal?: AbortSignal): Promise<void> {
		const url = await validateBrowserUrl(rawUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:" && url.href !== "about:blank") {
			throw new Error(`Navigate blocked for scheme ${url.protocol.replace(":", "")}`);
		}
		if (this.persistent && url.href !== "about:blank") {
			if (this.grants.size === 0) {
				throw new Error("Login profile has no origin grants yet. Finish /browser login or /browser logout.");
			}
			if (!originAllowed(url.href, this.grants)) {
				throw new Error(
					`Origin ${originOf(url.href)} is not granted for the login profile. Use /browser login or /browser logout.`,
				);
			}
		}
		this.invalidateSnapshot();
		await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS, signal });
		await this.enforceAfterNavigation(page);
	}

	private pageOriginOk(raw: string): boolean {
		if (!raw || isAboutBlank(raw)) return true;
		if (!this.persistent) return true;
		if (this.grants.size === 0) return false;
		try {
			return originAllowed(raw, this.grants);
		} catch {
			return false;
		}
	}

	private assertPageAllowed(page: Page, what: string): void {
		const url = page.url();
		if (this.pageOriginOk(url)) return;
		if (this.persistent && this.grants.size === 0) {
			throw new Error(`Blocked ${what}: login profile has no origin grants yet.`);
		}
		throw new Error(`Blocked ${what}: ${safeOrigin(url)} is not granted.`);
	}

	private async enforceAfterNavigation(page: Page): Promise<void> {
		const url = page.url();
		if (this.pageOriginOk(url)) return;
		try {
			await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
		} catch {
			// ignore
		}
		this.invalidateSnapshot();
		throw new Error(`Left granted origins (${redactUrl(url)}). Tab reset to about:blank.`);
	}

	private async snapshotResult(page: Page, prefix?: string): Promise<SessionResult> {
		this.snapshotRev += 1;
		const yaml = await page.locator("html").ariaSnapshot({ mode: "ai", timeout: DEFAULT_TIMEOUT_MS });
		const body = formatUntrustedSnapshot({
			revision: this.snapshotRev,
			url: redactUrl(page.url()),
			title: await page.title(),
			tabs: this.tabSummary(),
			yaml,
		});
		return {
			content: prefix ? `${prefix}\n\n${body}` : body,
			details: { snapshot: this.snapshotRev, url: redactUrl(page.url()), tab: this.activeTab },
		};
	}

	private async screenshotResult(page: Page): Promise<SessionResult> {
		const dir = ensurePrivateDir(join(piAgentDir(), SHOTS_DIR_NAME));
		const name = `${Date.now()}-${randomBytes(4).toString("hex")}.png`;
		const path = join(dir, name);
		await page.screenshot({ path, type: "png" });
		try {
			chmodSync(path, 0o600);
		} catch {
			// best-effort
		}
		return {
			content: `Screenshot saved: ${path}`,
			details: { path, url: redactUrl(page.url()) },
		};
	}

	private invalidateSnapshot(): void {
		this.snapshotRev += 1;
	}

	private tabSummary(): string {
		const parts: string[] = [];
		for (const [id, page] of this.pages) {
			const mark = id === this.activeTab ? " (active)" : "";
			parts.push(`${id}${mark} ${redactUrl(page.url() || "about:blank")}`);
		}
		return parts.join(" | ") || "(none)";
	}

	private activePage(): Page | undefined {
		return this.pages.get(this.activeTab);
	}

	private requirePage(): Page {
		const page = this.activePage();
		if (!page) throw new Error("No active tab. Call action navigate first.");
		return page;
	}

	private adoptPage(page: Page, active: boolean): string {
		for (const [id, existing] of this.pages) {
			if (existing === page) {
				if (active) this.activeTab = id;
				return id;
			}
		}
		this.watchPage(page);
		return this.trackPage(page, active);
	}

	private trackPage(page: Page, active: boolean): string {
		this.tabSeq += 1;
		const id = `t${this.tabSeq}`;
		this.pages.set(id, page);
		if (active || !this.activeTab) this.activeTab = id;
		page.on("close", () => {
			this.pages.delete(id);
			if (this.activeTab === id) this.activeTab = this.pages.keys().next().value ?? "";
		});
		return id;
	}

	private watchPage(page: Page): void {
		page.on("dialog", (dialog) => {
			void dialog.dismiss();
		});
		page.on("download", (download) => {
			void download.cancel();
		});
		page.on("filechooser", (chooser) => {
			void chooser.setFiles([]);
		});
		page.on("popup", (popup) => {
			const check = async () => {
				try {
					const url = popup.url();
					if (this.persistent && this.grants.size > 0 && url && !this.pageOriginOk(url)) {
						await popup.close();
					}
				} catch {
					// ignore
				}
			};
			void check();
			popup.on("framenavigated", () => {
				void check();
			});
		});
	}

	async ensureLaunched(signal?: AbortSignal): Promise<void> {
		if (this.context) return;
		if (this.closed) throw new Error("Browser session is shutting down");
		this.abortLaunch = new AbortController();
		if (signal) {
			if (signal.aborted) throw new Error("aborted");
			signal.addEventListener("abort", () => this.abortLaunch?.abort(), { once: true });
		}

		try {
			const wantPersistent = this.grants.size > 0 || this.forcePersistent;
			const mode = resolveMode(this.mode);
			if (mode === "host" && !process.env.DISPLAY) throw new Error("host mode needs DISPLAY");
			if (mode === "xvfb") this.xvfb = await startXvfb();
			this.proxy = await startPinProxy();

			const binary = await findBrowser();
			const { chromium } = await import("patchright-core");
			const env: Record<string, string> = { ...process.env } as Record<string, string>;
			if (this.xvfb) env.DISPLAY = this.xvfb.display;

			const proxy = {
				server: `http://127.0.0.1:${this.proxy.port}`,
				username: this.proxy.username,
				password: this.proxy.password,
			};
			const launchOptions = {
				executablePath: binary.executablePath,
				headless: mode === "headless",
				args: ["--disable-webrtc", "--proxy-bypass-list=<-loopback>"],
				proxy,
				env,
				timeout: DEFAULT_TIMEOUT_MS,
			};

			const contextOptions = {
				viewport: DEFAULT_VIEWPORT,
				acceptDownloads: false,
				serviceWorkers: "block" as const,
				ignoreHTTPSErrors: false,
				proxy,
			};

			if (wantPersistent) {
				const userDataDir = ensurePrivateDir(join(piAgentDir(), PROFILE_DIR_NAME));
				this.context = await chromium.launchPersistentContext(userDataDir, {
					...launchOptions,
					...contextOptions,
				});
				this.persistent = true;
				this.browser = this.context.browser() ?? undefined;
			} else {
				this.browser = await chromium.launch(launchOptions);
				this.context = await this.browser.newContext(contextOptions);
				this.persistent = false;
			}

			this.context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
			await this.installNetworkGate(this.context);
			this.context.on("page", (page) => {
				const consider = () => {
					const url = page.url();
					if (!url) return;
					if (this.persistent && this.grants.size > 0 && !this.pageOriginOk(url)) {
						void page.close();
						return;
					}
					this.adoptPage(page, false);
				};
				consider();
				page.on("framenavigated", consider);
			});

			const existing = this.context.pages();
			if (existing.length === 0) {
				const page = await this.context.newPage();
				this.adoptPage(page, true);
			} else {
				for (const [i, page] of existing.entries()) {
					this.adoptPage(page, i === 0);
				}
			}
			if (this.persistent && this.grants.size > 0) {
				await this.applyGrants(this.grantList());
			} else {
				await this.dropUngrantedTabs();
			}

			this.writeRunState();
		} catch (err) {
			await this.teardown();
			throw err;
		}
	}

	private async installNetworkGate(context: BrowserContext): Promise<void> {
		await context.route("**/*", async (route) => {
			const url = route.request().url();
			if (isPassthroughRequestUrl(url)) {
				await route.continue();
				return;
			}
			try {
				await validateBrowserUrl(url, { allowWebSocket: true });
			} catch {
				await route.abort("blockedbyclient");
				return;
			}
			const decision = classifyGrantedRequest(url, this.grants, route.request().resourceType());
			if (decision === "abort") {
				await route.abort("blockedbyclient");
				return;
			}
			if (decision === "strip-cookie") {
				const headers = { ...route.request().headers() };
				delete headers.cookie;
				delete headers.Cookie;
				await route.continue({ headers });
				return;
			}
			await route.continue();
		});
	}

	private rememberSecrets(values: string[]): void {
		for (const value of values) {
			if (value.length >= 6) this.cookieSecrets.add(value);
		}
	}

	private async secretValues(): Promise<string[]> {
		if (this.context) {
			try {
				const cookies = await this.context.cookies();
				const out: string[] = [];
				for (const cookie of cookies) {
					if (!cookie.value || cookie.value.length < 6) continue;
					out.push(cookie.value);
					out.push(encodeURIComponent(cookie.value));
					try {
						out.push(decodeURIComponent(cookie.value));
					} catch {
						// ignore
					}
				}
				this.rememberSecrets(out);
			} catch {
				// keep previously seen secrets
			}
		}
		return [...this.cookieSecrets];
	}

	private async sanitizeResult(result: SessionResult): Promise<SessionResult> {
		const secrets = await this.secretValues();
		const content = sanitizeWithSecrets(result.content, secrets);
		let details = result.details;
		if (details) {
			try {
				details = JSON.parse(sanitizeWithSecrets(JSON.stringify(details), secrets)) as Record<string, unknown>;
			} catch {
				details = { redacted: true };
			}
		}
		return { ...result, content, details };
	}

	private writeRunState(): void {
		const dir = ensurePrivateDir(join(piAgentDir(), RUN_DIR_NAME));
		const state: RunState = {
			marker: MARKER,
			ownerPid: process.pid,
			xvfbPid: this.xvfb?.pid,
			display: this.xvfb?.display,
			userDataDir: this.persistent ? join(piAgentDir(), PROFILE_DIR_NAME) : undefined,
		};
		writeFileSync(join(dir, `state-${process.pid}.json`), JSON.stringify(state), { mode: 0o600 });
	}

	private async teardown(): Promise<void> {
		const xvfb = this.xvfb;
		const browser = this.browser;
		const context = this.context;
		const proxy = this.proxy;
		this.xvfb = undefined;
		this.browser = undefined;
		this.context = undefined;
		this.proxy = undefined;
		this.pages.clear();
		this.activeTab = "";
		this.tabSeq = 0;
		this.snapshotRev = 0;
		this.persistent = false;
		this.cookieSecrets.clear();

		try {
			await context?.close();
		} catch {
			// ignore
		}
		try {
			await browser?.close();
		} catch {
			// ignore
		}

		try {
			await proxy?.close();
		} catch {
			// ignore
		}
		await stopXvfb(xvfb, SHUTDOWN_GRACE_MS);

		try {
			unlinkSync(join(piAgentDir(), RUN_DIR_NAME, `state-${process.pid}.json`));
		} catch {
			// ignore
		}
	}
}

function safeOrigin(raw: string): string {
	try {
		return originOf(raw);
	} catch {
		return redactUrl(raw);
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function reapState(state: RunState): Promise<void> {
	if (state.xvfbPid) {
		const cmd = cmdlineOf(state.xvfbPid) ?? "";
		if (cmd.includes("Xvfb") && (!state.display || cmd.includes(state.display.replace(":", "")) || cmd.includes("-displayfd"))) {
			await killPid(state.xvfbPid, SHUTDOWN_GRACE_MS);
		}
	}
	if (state.browserPid) {
		const cmd = cmdlineOf(state.browserPid) ?? "";
		const ours = cmd.includes("chrom") || cmd.includes("msedge");
		const dirOk = !state.userDataDir || cmd.includes(state.userDataDir);
		if (ours && dirOk) await killPid(state.browserPid, SHUTDOWN_GRACE_MS);
	}
	if (state.userDataDir) {
		for (const pid of pidsWithCmdline(state.userDataDir)) {
			const cmd = cmdlineOf(pid) ?? "";
			if (cmd.includes("chrom") || cmd.includes("msedge")) await killPid(pid, SHUTDOWN_GRACE_MS);
		}
	}
}

function pidsWithCmdline(needle: string): number[] {
	const out: number[] = [];
	try {
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			const pid = Number(name);
			const cmd = cmdlineOf(pid) ?? "";
			if (cmd.includes(needle)) out.push(pid);
		}
	} catch {
		// not linux or /proc unreadable
	}
	return out;
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
