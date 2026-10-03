import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserSession } from "./session.ts";
import { confirmCookieAccessWithUI } from "./cookie-consent.ts";
import { parseGrantOrigins } from "./grants.ts";
import { validateProfileName } from "./profiles.ts";

type ProfileSession = Pick<BrowserSession, "listProfiles" | "createProfile" | "selectProfile" | "profileName" | "closeBrowser" | "clearGrants">;

/** Persistence and activation are user commands, never model-callable actions. */
export async function profilesWithUI(session: ProfileSession, ctx: ExtensionContext): Promise<void> {
	const names = await session.listProfiles();
	const labels = names.map((name) => `Profile: ${name}${name === session.profileName() ? " (selected)" : ""}`);
	const choice = await ctx.ui.select("Isolated browser profiles", ["Keep current browser", "Create profile", "Use anonymous browser", ...labels]);
	if (!choice || choice === "Keep current browser") return;
	if (choice === "Use anonymous browser") {
		await session.closeBrowser();
		await session.clearGrants();
		ctx.ui.notify("Anonymous browser selected. Saved profiles remain on disk.", "info");
		return;
	}
	let name: string;
	if (choice === "Create profile") {
		const input = await ctx.ui.input("Profile name (1–40 letters, digits, - or _)", "applications");
		if (!input) return;
		name = validateProfileName(input);
		if (!await confirmCookieAccessWithUI(ctx, "Create a persistent isolated profile?",
			`Profile: ${name}\n\nCookies, logins and site storage will remain on disk across visits, logout, reload and shutdown. This is a separate Chromium profile, not your everyday browser. Access still requires exact-origin approval each session. Creating it does not grant access. Delete its directory yourself when no longer needed.`)) return;
		await session.createProfile(name);
		ctx.ui.notify(`Profile ${name} created. It remains saved even if activation is cancelled.`, "info");
	} else {
		const index = labels.indexOf(choice);
		if (index < 0) return;
		name = names[index];
	}
	const input = await ctx.ui.input(`Origins for ${name} this session (comma-separated)`, "https://example.com");
	if (!input) return;
	const origins = await parseGrantOrigins(input);
	if (!await confirmCookieAccessWithUI(ctx, "Use this saved browser profile?",
		`Profile: ${name}\n\nExact origins:\n${origins.join("\n")}\n\nThe agent can act as you using saved cookies and site storage on these origins for this session. This replaces current grants and closes current tabs. Other public origins load only as cookieless subresources. Logout, reload and shutdown revoke access but leave saved cookies and site storage on disk. No everyday-browser cookies are imported.`)) return;
	await session.selectProfile(name, origins);
	ctx.ui.notify(`Profile ${name} selected for ${origins.join(", ")}. Next browser action launches it.`, "info");
}
