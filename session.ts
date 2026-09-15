import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "patchright-core";
import { validateAction, type BrowserParams } from "./actions.ts";
import { createChromiumCookieImport, type ChromiumCookieImport } from "./chromium-import.ts";
import {
	DEFAULT_TIMEOUT_MS,
	PROFILE_DIR_NAME,
	SHOTS_DIR_NAME,
	type DisplayMode,
} from "./constants.ts";
import { resolveMode, type XvfbHandle } from "./display.ts";
import { isAboutBlank, validateBrowserUrl } from "./gate.ts";
import { originAllowed, originOf } from "./grants.ts";
import type { PinProxy } from "./pin-proxy.ts";
import { fetchCookieless } from "./cookieless.ts";
import { redactUrl, sanitizeWithSecrets } from "./redact.ts";
import { formatUntrustedSnapshot, SnapshotCache, DEFAULT_SNAPSHOT_LINES } from "./snapshot.ts";
import { abortable, checkCancelled, Mutex } from "./cancellation.ts";
import { TabRegistry } from "./tabs.ts";
import { NetworkPolicy } from "./network-policy.ts";
import { closeRuntime, ensurePrivateDir, launchRuntime, RuntimeState } from "./runtime.ts";

export type SessionResult = {
	content: string;
	details?: Record<string, unknown>;
	image?: { data: string; mimeType: "image/png" };
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
	private readonly tabs = new TabRegistry<Page>();
	private readonly snapshots = new SnapshotCache();
	private readonly network = new NetworkPolicy();
	private readonly runtime = new RuntimeState();
	private get pages() { return this.tabs.pages; }
	private get activeTab() { return this.tabs.active; }
	private forcePersistent = false;
	private proxy: PinProxy | undefined;
	private cookieSecrets = new Set<string>();
	private importedProfile: ChromiumCookieImport | undefined;
	private importCleanup = new Set<ChromiumCookieImport>();

	private readonly resourceFetch: typeof fetchCookieless;
	private readonly cookieImporter: typeof createChromiumCookieImport;
	constructor(resourceFetch: typeof fetchCookieless = fetchCookieless, cookieImporter = createChromiumCookieImport) {
		this.resourceFetch = resourceFetch;
		this.cookieImporter = cookieImporter;
	}

	withLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.lock.run(fn, signal);
	}

	networkSummary(): string { return this.network.diagnostics.summary() || "none recorded"; }
	displayMode(): DisplayMode { return resolveMode(this.mode); }

	setMode(mode: DisplayMode): void {
		this.mode = mode;
	}

	grantList(): string[] {
		return [...this.grants].sort();
	}

	async clearGrants(): Promise<void> {
		const profile = this.importedProfile;
		if (profile) this.importCleanup.add(profile);
		try {
			// Keep restrictions until the authenticated context/proxy are closed.
			if (profile) await this.teardown();
		} finally {
			this.grants.clear();
			this.forcePersistent = false;
			this.importedProfile = undefined;
			await this.cleanupImports();
		}
	}

	private async cleanupImports(): Promise<void> {
		for (const profile of this.importCleanup) {
			try { await profile.cleanup(); this.importCleanup.delete(profile); }
			catch { /* retain the handle for /browser logout or shutdown to retry */ }
		}
		if (this.importCleanup.size) {
			throw new Error(`Temporary Chromium cookie cleanup failed: ${[...this.importCleanup].map((profile) => profile.userDataDir).join(", ")}. Retry /browser logout before reloading, or remove the directory manually once Chromium is closed.`);
		}
	}

	// Only UI-approved callers may enter here. Never returns raw cookies.
	async importChromiumCookies(origins: string[], options: { cookieNames?: string[]; signal?: AbortSignal } = {}): Promise<number> {
		if (this.context || this.grants.size || this.importedProfile || this.importCleanup.size) throw new Error("Close the browser and clear grants before importing");
		const checkCancelled = () => { if (options.signal?.aborted) throw new Error("Cookie import cancelled"); };
		try {
			checkCancelled();
			this.importedProfile = await this.cookieImporter(origins, { cookieNames: options.cookieNames, registerCleanup: (profile) => this.importCleanup.add(profile) });
			this.importCleanup.add(this.importedProfile);
			checkCancelled();
			await this.applyGrants(origins);
			checkCancelled();
			await this.ensureLaunched(options.signal);
			checkCancelled();
			const count = (await this.context!.cookies()).length;
			if (!count) throw new Error("No imported cookies loaded");
			await this.secretValues();
			checkCancelled();
			return count;
		} catch {
			try { await this.closeBrowser(); } finally { await this.clearGrants(); }
			throw new Error("Chromium cookie import failed. Check the Default profile, Node >=22.19.0, and your unlocked desktop keyring. You can also use /browser login.");
		}
	}

	armPersistentProfile(): void {
		this.forcePersistent = true;
	}

	async applyGrants(origins: string[]): Promise<void> {
		this.grants = new Set(origins);
		this.forcePersistent = true;
		this.proxy?.dropTunnels();
		if (!this.context) return;
		// The user may have closed the login tab, or its origin may now be denied.
		// Create a fresh blank keeper before closing old tabs instead of reusing one.
		const previous = [...this.pages.entries()];
		const keeper = await this.context.newPage();
		this.adoptPage(keeper, true);
		for (const [id, page] of previous) {
			try { await page.close(); } catch { /* already closed */ }
			this.tabs.remove(id);
		}
		this.invalidateSnapshot();
	}

	statusText(): string {
		const mode = resolveMode(this.mode);
		const url = this.activePage()?.url();
		const grants = this.grants.size ? this.grantList().join(" ") : "(none)";
		const running = this.context ? "up" : "down";
		const urlText = url ? sanitizeWithSecrets(redactUrl(url), [...this.cookieSecrets]) : "-";
		return `browser ${running} mode=${mode} persistent=${this.persistent} source=${this.importedProfile ? "chromium-copy" : "isolated"} url=${urlText} grants=${grants}`;
	}

	async reapStale(): Promise<void> { await this.runtime.reap(); }

	async shutdown(): Promise<void> {
		await this.withLock(async () => {
			this.closed = true;
			try {
				try { await this.teardown(); } finally { await this.clearGrants(); }
			} finally {
				this.closed = false;
				this.mode = "auto";
			}
		});
	}

	async closeBrowser(): Promise<string> {
		await this.teardown();
		return "Browser closed.";
	}

	async execute(params: BrowserParams, signal?: AbortSignal): Promise<SessionResult> {
		this.network.diagnostics.reset();
		try {
			checkCancelled(signal);
			const result = await this.executeInner(params, signal);
			checkCancelled(signal);
			const safe = await this.sanitizeResult(result, signal);
			checkCancelled(signal);
			return safe;
		} catch (err) {
			const message = signal?.aborted ? "Browser action cancelled" : err instanceof Error ? err.message : String(err);
			const secrets = signal?.aborted ? [...this.cookieSecrets] : await this.secretValues();
			const network = this.network.diagnostics.summary();
			throw new Error(sanitizeWithSecrets(message, secrets) + (network ? `\nNetwork: ${network}` : ""));
		}
	}

	private async executeInner(params: BrowserParams, signal?: AbortSignal): Promise<SessionResult> {
		if (this.closed) throw new Error("Browser session is shutting down");
		const action = validateAction(params);
		if (action.action === "close") {
			return { content: await this.closeBrowser() };
		}
		await this.ensureLaunched(signal);
		await this.secretValues(signal);
		checkCancelled(signal);
		const page = this.requirePage();
		const timeout = DEFAULT_TIMEOUT_MS;

		switch (action.action) {
			case "navigate":
				await this.goto(page, action.url, signal);
				return this.snapshotResult(page, undefined, signal);
			case "snapshot":
				this.assertPageAllowed(page, "snapshot");
				if (action.snapshotId !== undefined) {
					this.tabs.assertSnapshot(page, action.snapshotId);
					return this.snapshots.read(action.snapshotId, action.offset, action.limit);
				}
				return this.snapshotResult(page, undefined, signal, action.limit, action.depth);
			case "screenshot":
				this.assertPageAllowed(page, "screenshot");
				return this.screenshotResult(page, action.image, signal);
			case "click": {
				this.assertPageAllowed(page, "click");
				await this.locator(page, action.ref).click({ timeout, signal, steps: 8, delay: 25 });
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage(), undefined, signal);
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
				else { checkCancelled(signal); await page.keyboard.press(action.key); }
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage(), undefined, signal);
			}
			case "scroll": {
				this.assertPageAllowed(page, "scroll");
				const delta = action.direction === "up" ? -800 : 800;
				if (action.ref) await this.locator(page, action.ref).hover({ timeout, signal });
				checkCancelled(signal);
				await page.mouse.wheel(0, delta);
				return { content: `Scrolled ${action.direction}.` };
			}
			case "wait":
				await waitFor(action.timeoutMs, signal);
				return { content: `Waited ${action.timeoutMs}ms.` };
			case "back":
				this.assertPageAllowed(page, "back");
				await page.goBack({ timeout, waitUntil: "domcontentloaded", signal });
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage(), undefined, signal);
			case "select":
				this.assertPageAllowed(page, "select");
				await this.locator(page, action.ref).selectOption(action.value, { timeout, signal });
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage(), undefined, signal);
			case "check":
				this.assertPageAllowed(page, "check");
				if (action.checked) await this.locator(page, action.ref).check({ timeout, signal });
				else await this.locator(page, action.ref).uncheck({ timeout, signal });
				await this.enforceAfterNavigation(this.requirePage());
				return this.snapshotResult(this.requirePage(), undefined, signal);
			case "hover":
				this.assertPageAllowed(page, "hover");
				await this.locator(page, action.ref).hover({ timeout, signal });
				return { content: `Hovered ${action.ref}.` };
			case "tabs":
				return this.tabsAction(action, signal);
		}
	}

	private locator(page: Page, ref: string) {
		return page.locator(`aria-ref=${this.tabs.ref(page, ref)}`);
	}

	private async tabsAction(
		action: Extract<ReturnType<typeof validateAction>, { action: "tabs" }>,
		signal?: AbortSignal,
	): Promise<SessionResult> {
		await this.dropUngrantedTabs();
		checkCancelled(signal);
		if (action.tabAction === "list") return { content: this.tabSummary() };
		if (action.tabAction === "new") {
			const page = await this.context!.newPage();
			if (signal?.aborted) { await page.close(); checkCancelled(signal); }
			const id = this.adoptPage(page, true);
			if (action.url) await this.goto(page, action.url, signal);
			return this.snapshotResult(page, `Opened ${id}.`, signal);
		}
		if (action.tabAction === "switch") {
			const page = this.pages.get(action.tabId);
			if (!page) throw new Error(`Unknown tab ${action.tabId}`);
			this.assertPageAllowed(page, "tab switch");
			this.tabs.activate(action.tabId);
			await page.bringToFront();
			return this.snapshotResult(page, undefined, signal);
		}
		const tabId = action.tabId ?? this.activeTab;
		const page = this.pages.get(tabId);
		if (!page) throw new Error(`Unknown tab ${tabId}`);
		if (this.pages.size === 1) throw new Error("Cannot close the last tab. Use action close.");
		await page.close();
		this.tabs.remove(tabId);
		checkCancelled(signal);
		const next = this.requirePage();
		this.assertPageAllowed(next, "tab close");
		await next.bringToFront();
		return this.snapshotResult(next, `Closed ${tabId}.`, signal);
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
			this.tabs.remove(id);
		}
	}

	private async goto(page: Page, rawUrl: string, signal?: AbortSignal): Promise<void> {
		const url = await validateBrowserUrl(rawUrl, { signal });
		checkCancelled(signal);
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

	private async snapshotResult(page: Page, prefix?: string, signal?: AbortSignal, limit = DEFAULT_SNAPSHOT_LINES, depth?: number): Promise<SessionResult> {
		checkCancelled(signal);
		const revision = this.tabs.beginSnapshot(page);
		const yaml = await page.locator("html").ariaSnapshot({ mode: "ai", timeout: DEFAULT_TIMEOUT_MS, signal, depth });
		const title = await abortable(page.title(), signal);
		const secrets = await this.secretValues(signal);
		checkCancelled(signal);
		this.tabs.completeSnapshot(page, revision);
		const body = formatUntrustedSnapshot({ revision, url: redactUrl(page.url()), title, tabs: this.tabSummary(), yaml });
		this.snapshots.set(revision, body, secrets);
		const result = this.snapshots.read(revision, 1, limit);
		return { content: prefix ? `${prefix}\n\n${result.content}` : result.content,
			details: { ...result.details, url: redactUrl(page.url()), tab: this.activeTab } };
	}

	private async screenshotResult(page: Page, image = false, signal?: AbortSignal): Promise<SessionResult> {
		checkCancelled(signal);
		const dir = ensurePrivateDir(join(this.runtime.directory, SHOTS_DIR_NAME));
		const name = `${Date.now()}-${randomBytes(4).toString("hex")}.png`;
		const path = join(dir, name);
		const bytes = await page.screenshot({ path, type: "png", signal, timeout: DEFAULT_TIMEOUT_MS });
		checkCancelled(signal);
		try {
			chmodSync(path, 0o600);
		} catch {
			// best-effort
		}
		return {
			content: `Screenshot saved: ${path}` + (image ? "\nUNTRUSTED PAGE IMAGE. Visible page data is not secret-redacted." : "") +
				(image && bytes.length > 8 * 1024 * 1024 ? "\nImage attachment omitted: exceeds 8 MiB. Read the saved file if needed." : ""),
			details: { path, url: redactUrl(page.url()) },
			image: image && bytes.length <= 8 * 1024 * 1024 ? { data: bytes.toString("base64"), mimeType: "image/png" } : undefined,
		};
	}

	private invalidateSnapshot(): void {
		this.tabs.invalidate();
		this.snapshots.clear();
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
				if (active) this.tabs.activate(id);
				return id;
			}
		}
		this.watchPage(page);
		return this.tabs.add(page, active);
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
		checkCancelled(signal);
		if (this.closed) throw new Error("Browser session is shutting down");
		if (this.context) return;

		try {
			const wantPersistent = this.grants.size > 0 || this.forcePersistent;
			const resources = await launchRuntime({ mode: resolveMode(this.mode), persistent: wantPersistent,
				importedProfile: this.importedProfile, grants: () => this.grants, agentDirectory: this.runtime.directory,
				diagnostics: this.network.diagnostics, signal });
			this.context = resources.context;
			this.browser = resources.browser;
			this.proxy = resources.proxy;
			this.xvfb = resources.xvfb;
			this.persistent = wantPersistent;
			checkCancelled(signal);

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

			checkCancelled(signal);
			this.runtime.write({ context: this.context, browser: this.browser, proxy: this.proxy, xvfb: this.xvfb },
				this.persistent ? this.importedProfile?.userDataDir ?? join(this.runtime.directory, PROFILE_DIR_NAME) : undefined);
		} catch (err) {
			await this.teardown();
			throw err;
		}
	}

	private async installNetworkGate(context: BrowserContext): Promise<void> {
		await this.network.install(context, () => this.grants, this.resourceFetch);
	}

	private rememberSecrets(values: string[]): void {
		for (const value of values) {
			if (value.length >= 6) this.cookieSecrets.add(value);
		}
	}

	private async secretValues(signal?: AbortSignal): Promise<string[]> {
		checkCancelled(signal);
		if (this.context) {
			try {
				const cookies = await abortable(this.context.cookies(), signal);
				checkCancelled(signal);
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
		checkCancelled(signal);
		return [...this.cookieSecrets];
	}

	private async sanitizeResult(result: SessionResult, signal?: AbortSignal): Promise<SessionResult> {
		const secrets = await this.secretValues(signal);
		const network = this.network.diagnostics.summary();
		const content = sanitizeWithSecrets(result.content, secrets) + (network ? `\nNetwork: ${network}` : "");
		let details = network ? { ...result.details, network: this.network.diagnostics.snapshot() } : result.details;
		if (details) {
			try {
				details = JSON.parse(sanitizeWithSecrets(JSON.stringify(details), secrets)) as Record<string, unknown>;
			} catch {
				details = { redacted: true };
			}
		}
		return { ...result, content, details };
	}

	private async teardown(): Promise<void> {
		this.network.close();
		const xvfb = this.xvfb;
		const browser = this.browser;
		const context = this.context;
		const proxy = this.proxy;
		this.xvfb = undefined;
		this.browser = undefined;
		this.context = undefined;
		this.proxy = undefined;
		this.tabs.clear();
		this.snapshots.clear();
		this.persistent = false;
		this.cookieSecrets.clear();
		await closeRuntime({ context, browser, proxy, xvfb });
		this.runtime.remove();
	}
}

function safeOrigin(raw: string): string {
	try {
		return originOf(raw);
	} catch {
		return redactUrl(raw);
	}
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
