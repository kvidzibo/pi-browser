import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserSession } from "./session.ts";
import { parseGrantOrigins } from "./grants.ts";
import { listChromiumCookieSites } from "./chromium-import.ts";
import { pickCookieSites } from "./site-picker.ts";

type LoginSession = Pick<BrowserSession, "setMode" | "closeBrowser" | "clearGrants" | "armPersistentProfile" | "ensureLaunched" | "applyGrants">;

export async function loginWithUI(session: LoginSession, ctx: ExtensionContext): Promise<void> {
	const cancel = () => ctx.ui.notify("Login cancelled", "info");
	if (!await ctx.ui.confirm("Isolated browser login",
		"Open Chromium on your screen with an isolated profile (not your real Chrome). Log in yourself. Then grant origins for this session only.")) {
		cancel(); return;
	}
	let committed = false;
	try {
		session.setMode("host");
		await session.closeBrowser();
		await session.clearGrants();
		session.armPersistentProfile();
		await session.ensureLaunched();
		if (!await ctx.ui.confirm("Logged in?",
			"Use the Chromium window to log in. Confirm when finished. The agent still cannot use the profile until you grant origins.")) {
			cancel(); return;
		}
		const input = await ctx.ui.input("Origins to grant this session (comma-separated hosts)", "https://example.com");
		if (!input) { cancel(); return; }
		const origins = await parseGrantOrigins(input);
		if (!await ctx.ui.confirm("Grant these origins?",
			`${origins.join(", ")}\n\nThe agent can use the isolated profile for these origins until /reload or /browser logout.`)) {
			cancel(); return;
		}
		await session.applyGrants(origins);
		committed = true;
		ctx.ui.notify(`Login profile granted for ${origins.join(", ")}. Tabs reset to about:blank.`, "info");
	} finally {
		if (!committed) {
			try { await session.closeBrowser(); } finally { await session.clearGrants(); }
		}
	}
}

type ImportSession = Pick<BrowserSession, "closeBrowser" | "clearGrants" | "importChromiumCookies">;

export async function loginFromChromiumWithUI(
	session: ImportSession, ctx: ExtensionContext,
	options: { listSites?: typeof listChromiumCookieSites; pickSites?: typeof pickCookieSites } = {},
): Promise<void> {
	// The user's command permits a local, metadata-only site inventory. Actual cookie
	// copying and grants still require the final confirmation below.
	let selected: string[] | undefined;
	let usedPicker = false;
	if (ctx.mode === "tui") {
		let sites;
		try { sites = await (options.listSites ?? listChromiumCookieSites)(); }
		catch { ctx.ui.notify("Could not list Chromium cookie sites. Enter origins manually, or cancel and check your Default profile.", "warning"); }
		if (sites) {
			usedPicker = true;
			selected = await (options.pickSites ?? pickCookieSites)(sites, ctx);
		}
	}
	// RPC has dialogs but no custom TUI; preserve its existing manual-input flow.
	if (!usedPicker) {
		const input = await ctx.ui.input("Sites to import and grant (comma-separated origins)", "https://mail.google.com, https://accounts.google.com");
		if (input) selected = [input];
	}
	if (!selected?.length) { ctx.ui.notify("Cookie import cancelled", "info"); return; }
	// Validate only the selected hosts with real DNS, not the entire private inventory.
	const origins = await parseGrantOrigins(selected.join(", "));
	if (!await ctx.ui.confirm("Import cookies from Chromium's Default profile?",
		`Copy cookies matching ${origins.join(", ")} into a temporary isolated profile.\n\nThe agent can act as you on these origins for this session. Your source profile is not modified; cookie values are not shown. The copy is deleted on logout, reload or shutdown.`)) {
		ctx.ui.notify("Cookie import cancelled", "info"); return;
	}
	let committed = false;
	try {
		await session.closeBrowser();
		await session.clearGrants();
		const count = await session.importChromiumCookies(origins);
		committed = true;
		ctx.ui.notify(`Loaded ${count} Chromium cookies. Granted ${origins.join(", ")}. Ready for browser navigation.`, "info");
	} finally {
		if (!committed) {
			try { await session.closeBrowser(); } finally { await session.clearGrants(); }
		}
	}
}
