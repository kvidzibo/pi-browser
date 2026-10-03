import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserSession } from "./session.ts";
import { confirmCookieAccessWithUI } from "./cookie-consent.ts";
import { validateProfileName } from "./profiles.ts";

type ProfileSession = Pick<BrowserSession, "listProfiles" | "createProfile" | "selectProfile" | "profileName" | "closeBrowser" | "clearGrants">;

/** Persistence and activation are user commands, never model-callable actions. */
export async function profilesWithUI(session: ProfileSession, ctx: ExtensionContext): Promise<void> {
	const names = await session.listProfiles();
	const labels = names.map((name) => `Profile: ${name}${name === session.profileName() ? " (selected)" : ""}`);
	const choice = await ctx.ui.select("Saved profiles — access to all public sites", ["Keep current browser", "Create profile", "Use anonymous browser", ...labels]);
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
			`Profile: ${name}\n\nCookies, logins and site storage will remain on disk across visits, logout, reload and shutdown. This is a separate Chromium profile, not your everyday browser. Creating and selecting this profile lets the agent act as you on all public websites for this session. Localhost and private networks remain blocked. Delete its directory yourself when no longer needed.`)) return;
		await session.createProfile(name);
	} else {
		const index = labels.indexOf(choice);
		if (index < 0) return;
		name = names[index];
	}
	await session.selectProfile(name);
	ctx.ui.notify(`Profile ${name} selected: all public websites allowed. Saved logins are available to the agent; private networks remain blocked. Next browser action launches it.`, "info");
}
