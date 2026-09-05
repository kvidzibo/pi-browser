import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserSession } from "./session.ts";
import { parseGrantOrigins } from "./grants.ts";

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
		session.clearGrants();
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
			session.clearGrants();
			await session.closeBrowser();
		}
	}
}
