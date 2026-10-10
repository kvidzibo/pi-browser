import { randomUUID } from "node:crypto";
import { browserDoctor } from "../doctor.ts";
import { exactOrigins, requestCookieAccess } from "../cookie-access.ts";
import { listChromiumCookieSites, type CookieSite } from "../chromium-import.ts";
import { validateProfileName } from "../profiles.ts";
import { validateBrowserUrl } from "../gate.ts";
import type { BrowserSession } from "../session.ts";
import type { Control, View } from "./schema.ts";

/** Operator-only actions. No action here is registered as an MCP tool. The host
 * confirms controls before dispatch. Opaque host state never restores authority. */
export class BrowserApp {
	private session: BrowserSession;
	private revision = randomUUID();
	private origins: string[] = [];
	private sites?: CookieSite[];
	private siteOffset = 0;
	private profileOffset = 0;
	loginPending = false;
	private loginMode?: ReturnType<BrowserSession["displayMode"]>;

	constructor(session: BrowserSession) { this.session = session; }
	invalidate(): void { this.revision = randomUUID(); }
	reset(): void { this.origins = []; this.sites = undefined; this.siteOffset = 0; this.profileOffset = 0; this.loginPending = false; this.loginMode = undefined; this.invalidate(); }

	async view(): Promise<View> {
		const controls: Control[] = [];
		const action = (id: string, label: string, confirm?: string) => controls.push({ id, kind: "action", label, ...(confirm ? { confirm } : {}) });
		if (this.loginPending) {
			if (!this.session.profileName()) controls.push({ id: "origins", kind: "text", label: "Exact origins to grant after login", value: this.origins.join(", ") });
			action("finish-login", "Finished logging in — grant access", this.session.profileName()
				? "Allow the agent to use this saved profile on ALL public websites for this service session?"
				: `Grant the isolated login profile to these exact origins: ${this.origins.join(", ") || "(set origins first)"}?`);
			action("logout", "Cancel login and revoke access");
		} else if (this.sites) {
			controls.push({ id: "pick-site", kind: "select", label: "Add cookie site", value: "", options: this.sites.slice(this.siteOffset, this.siteOffset + 100).map((site) => ({ label: site.label, value: site.origin })) });
			if (this.siteOffset > 0) action("sites-prev", "Previous sites");
			if (this.siteOffset + 100 < this.sites.length) action("sites-next", "More sites");
			action("sites-done", "Back to browser");
		} else {
			action("doctor", "Check browser setup");
			controls.push({ id: "mode", kind: "select", label: "Display mode", value: this.session.displayMode(), options: ["xvfb", "headless", "host"].map((value) => ({ label: value, value })), confirm: "Close the current browser and change display mode? Host mode uses your real screen; Xvfb is isolated." });
			const profiles = await this.session.listProfiles();
			this.profileOffset = Math.min(this.profileOffset, Math.max(0, Math.floor((profiles.length - 1) / 100) * 100));
			if (profiles.length) controls.push({ id: "profile", kind: "select", label: "Select saved profile", value: this.session.profileName() ?? "", options: profiles.slice(this.profileOffset, this.profileOffset + 100).map((value) => ({ label: value, value })), confirm: "Close current tabs and allow the agent to act as you on ALL public websites using this profile for this service session? Saved logins remain on disk; LAN stays blocked." });
			if (this.profileOffset > 0) action("profiles-prev", "Previous profiles");
			if (this.profileOffset + 100 < profiles.length) action("profiles-next", "More profiles");
			controls.push({ id: "create-profile", kind: "text", label: "Create and select saved profile", value: "", confirm: "Create a separate persistent Chromium profile and authorize the agent on ALL public websites for this service session? Cookies/logins stay on disk after logout or shutdown. LAN remains blocked." });
			action("login", "Open browser for manual login", "Open an isolated Chromium window on your screen (not your everyday profile)? Log in yourself, then return here to finish or cancel. The agent is blocked while login is pending; saved site data remains on disk.");
			controls.push({ id: "origins", kind: "text", label: "Exact cookie-import origins (comma-separated)", value: this.origins.join(", ") });
			action("sites", "Choose Chromium cookie sites", "Read cookie-domain metadata from Chromium's Linux Default profile into this private menu? Values are not read; this does not approve import.");
			if (this.origins.length) action("import", "Import cookies for selected origins", `Copy ALL cookies matching these exact origins from Chromium's Linux Default profile: ${this.origins.join(", ")}. The agent can act as you there. This replaces current grants/profile and closes tabs. Source stays unchanged; cookie values are not shown to the model. Temporary copy is removed on logout, restart or shutdown. Name filters, when requested by the model, apply only to the imported snapshot.`);
			action("close", "Close browser (keep grants)");
			action("logout", "Use anonymous browser / revoke access");
		}
		return { version: 1, title: this.loginPending ? "Browser · Finish manual login" : this.sites ? "Browser · Chromium cookie sites" : "Browser", revision: this.revision, state: {},
			body: `${this.session.statusText()}\n${this.loginPending ? "Agent access is paused until you finish or cancel login." : "Profiles and approvals last only for this service session; never restored from conversation state."}\nSelected origins: ${this.origins.join(", ") || "none"}`.slice(0, 20_000), controls };
	}

	/** Caller holds the same lock as model tools. Only currently displayed actions
	 * and values are accepted, and every attempt invalidates the old revision. */
	async act(revision: string, id: string, value: unknown, signal: AbortSignal): Promise<{ view: View; preview?: string }> {
		signal.throwIfAborted();
		const current = await this.view();
		if (revision !== current.revision) throw new Error("Browser view changed; refresh before acting");
		const control = current.controls.find((item) => item.id === id);
		if (!control) throw new Error("Unknown or unavailable browser action");
		if (control.kind === "text" && typeof value !== "string") throw new Error("Expected text");
		if (control.kind === "select" && !control.options?.some((item) => item.value === value)) throw new Error("Invalid selection");
		this.invalidate();
		let preview: string | undefined;
		try {
			switch (id) {
				case "doctor": preview = await browserDoctor({ mode: this.session.displayMode(), profile: this.session.profileName(), network: this.session.networkSummary() }); break;
				case "origins": this.origins = value === "" ? [] : exactOrigins((value as string).split(",").map((origin) => origin.trim())); break;
				case "mode": await this.session.closeBrowser(); this.session.setMode(value as "xvfb" | "headless" | "host"); break;
				case "profile": await this.session.selectProfile(value as string); break;
				case "create-profile": { const name = validateProfileName(value as string); await this.session.createProfile(name); signal.throwIfAborted(); await this.session.selectProfile(name); break; }
				case "profiles-prev": this.profileOffset -= 100; break;
				case "profiles-next": this.profileOffset += 100; break;
				case "sites": this.sites = await listChromiumCookieSites(); this.siteOffset = 0; break;
				case "sites-prev": this.siteOffset -= 100; break;
				case "sites-next": this.siteOffset += 100; break;
				case "pick-site": this.origins = exactOrigins([...this.origins, value as string]); break;
				case "sites-done": this.sites = undefined; break;
				case "import": preview = (await requestCookieAccess(this.session, { origins: this.origins }, async () => true, signal, { refresh: true })).content; break;
				case "close": await this.session.closeBrowser(); break;
				case "logout": await this.revoke(); break;
				case "login": {
					const name = this.session.profileName();
					this.loginMode = this.session.displayMode();
					await this.session.closeBrowser(); await this.session.clearGrants();
					this.session.armPersistentProfile(name); this.session.setMode("host");
					this.loginPending = true;
					await this.session.ensureLaunched(signal);
					break;
				}
				case "finish-login": {
					if (this.session.profileName()) await this.session.resetTabs();
					else {
						const origins = exactOrigins(this.origins);
						for (const origin of origins) await validateBrowserUrl(origin, { signal });
						await this.session.applyGrants(origins);
					}
					signal.throwIfAborted();
					await this.session.closeBrowser();
					this.restoreMode(); this.loginPending = false;
					break;
				}
			}
			signal.throwIfAborted();
		} catch (error) {
			// Never leave an interrupted login/profile grant available to tools.
			if (this.loginPending || signal.aborted) await this.revoke();
			throw error;
		}
		return { view: await this.view(), ...(preview ? { preview } : {}) };
	}

	private restoreMode(): void { if (this.loginMode) this.session.setMode(this.loginMode); this.loginMode = undefined; }
	async revoke(): Promise<void> {
		try { await this.session.closeBrowser(); } finally { await this.session.clearGrants(); this.restoreMode(); this.loginPending = false; this.invalidate(); }
	}
}
