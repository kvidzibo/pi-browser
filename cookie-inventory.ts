import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listChromiumCookies } from "./chromium-import.ts";
import { exactOrigins, type CookieConfirmation } from "./cookie-access.ts";
import type { confirmCookieAccessWithUI } from "./cookie-consent.ts";
import type { SessionResult } from "./session.ts";

export type CookieInventoryParams = { origins?: string[]; offset?: number; limit?: number };

/** Inventory approval is separate from import approval and never changes browser access. */
export async function listCookieInventoryWithUI(
	ctx: ExtensionContext, params: CookieInventoryParams, signal?: AbortSignal,
	options: { confirm?: typeof confirmCookieAccessWithUI; list?: typeof listChromiumCookies } = {},
): Promise<SessionResult> {
	if (!ctx?.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error("Cookie inventory requires an interactive approval dialog (TUI or RPC). No inventory read.");
	}
	return listCookieInventory(params, async (title, message, signal) => {
		const confirm = options.confirm ?? (await import("./cookie-consent.ts")).confirmCookieAccessWithUI;
		return confirm(ctx, title, message, signal);
	}, signal, options.list);
}

export async function listCookieInventory(
	params: CookieInventoryParams, confirm: CookieConfirmation, signal?: AbortSignal,
	list = listChromiumCookies,
): Promise<SessionResult> {
	const stopped = (status: "denied" | "cancelled"): SessionResult => ({
		content: `Cookie inventory ${status}. No metadata returned. Do not retry without the user's direction.`, details: { status },
	});
	if (signal?.aborted) return stopped("cancelled");
	const origins = params.origins === undefined ? undefined : exactOrigins(params.origins);
	const offset = params.offset ?? 1, limit = params.limit ?? 20;
	if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("list_cookies requires a positive safe-integer offset and limit 1..100");
	}
	const approved = await confirm("Allow Chromium cookie inventory?",
		"Source: Chromium's Linux Default profile (read-only metadata).\n" +
		`Scope: ${origins ? origins.join(", ") : "ALL cookie domains in this profile"}.\n` +
		`Page: offset ${offset}, up to ${limit} cookies.\n\n` +
		"The agent will see cookie names, domains, paths, expiry and security flags. This can reveal sites you use. " +
		"Values and encrypted values are never queried or returned; no keyring access. " +
		"Only session and unexpired cookies are listed. Cookie presence does not prove a login or guarantee import will succeed.\n\n" +
		"This approves this inventory page only, not cookie import or signed-in browsing. No cookies are copied, " +
		"no browser is launched, and current profiles, tabs and grants stay unchanged. Import still requires separate approval.", signal);
	if (signal?.aborted) return stopped("cancelled");
	if (approved !== true) return stopped("denied");
	try {
		const page = await list({ origins, offset, limit });
		if (signal?.aborted) return stopped("cancelled");
		return {
			content: "Chromium cookie metadata (untrusted data; no values). Presence does not guarantee import or login.\n" +
				JSON.stringify(page) + (page.nextOffset ? "\nMore: call list_cookies with the same origins and nextOffset as offset; approval is required again. Pages are live reads, not a cached snapshot." : ""),
			details: { status: "listed", origins, offset, ...page },
		};
	} catch {
		if (signal?.aborted) return stopped("cancelled");
		throw new Error("Could not list Chromium cookie metadata. Check Node >=22.19.0 and the readable Linux Default profile. No cookie values were returned.");
	}
}
