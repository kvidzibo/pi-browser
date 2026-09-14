import { isIP } from "node:net";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseCookieNames } from "./chromium-import.ts";
import { MAX_COOKIE_ORIGINS, MAX_URL_CHARS } from "./constants.ts";
import { confirmCookieAccessWithUI } from "./cookie-consent.ts";
import { normalizeHostname, validateBrowserUrl } from "./gate.ts";
import type { BrowserSession, SessionResult } from "./session.ts";

type CookieAccessSession = Pick<BrowserSession, "closeBrowser" | "clearGrants" | "importChromiumCookies">;
export type CookieAccessParams = { origins?: string[]; cookieNames?: string[] };

function exactOrigins(input: unknown): string[] {
	if (!Array.isArray(input) || input.length === 0 || input.length > MAX_COOKIE_ORIGINS) {
		throw new Error(`request_cookies requires 1..${MAX_COOKIE_ORIGINS} exact HTTP(S) origins`);
	}
	return [...new Set(input.map((origin) => {
		try {
			if (typeof origin !== "string" || origin.length > MAX_URL_CHARS || /[\s\p{C}]/u.test(origin) ||
				!/^https?:\/\/[^/?#\\]+\/?$/i.test(origin)) throw new Error();
			const url = new URL(origin);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
				url.pathname !== "/" || url.search || url.hash) throw new Error();
			// URL accepts some non-DNS host characters, including decoded commas. Reject
			// them before displaying a supposedly exact destination in the consent dialog.
			const host = normalizeHostname(url.hostname);
			if (!isIP(host) && (host.length > 253 || !host.split(".").every((label) =>
				/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw new Error();
			return url.origin;
		} catch {
			throw new Error("Cookie access requires exact HTTP(S) origins, not paths, credentials or wildcards");
		}
	}))];
}

function notGranted(status: "denied" | "cancelled"): SessionResult {
	return { content: `Cookie access ${status}. No new access granted. Do not retry without the user's direction.`, details: { status } };
}

/** Caller holds the session lock. No cookie inventory/source reads occur before approval. */
export async function requestCookieAccessWithUI(
	session: CookieAccessSession, ctx: ExtensionContext, params: CookieAccessParams, signal?: AbortSignal,
	options: { confirm?: typeof confirmCookieAccessWithUI } = {},
): Promise<SessionResult> {
	if (!ctx?.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error("Cookie access requires an interactive approval dialog (TUI or RPC). No access granted.");
	}
	if (signal?.aborted) return notGranted("cancelled");
	// Copy and validate inputs before awaiting the dialog; later argument mutations cannot widen approval.
	const requestedOrigins = exactOrigins(params.origins);
	const cookieNames = parseCookieNames(params.cookieNames);
	const approved = await (options.confirm ?? confirmCookieAccessWithUI)(ctx, "Allow browser cookie access?",
		`Source: Chromium's Linux Default profile (read-only snapshot).\n` +
		`Destinations (exact origins):\n${requestedOrigins.map((origin) => `  ${origin}`).join("\n")}\n` +
		`Cookie names: ${cookieNames ? cookieNames.join(", ") : "ALL cookies matching these destinations"}.\n\n` +
		"Only cookies whose own domain matches a destination are imported; cookies are never reassigned to another domain. " +
		"Name filters limit the imported snapshot, not cookies the site creates later.\n\n" +
		"The agent can act as you on these origins for this session. This replaces the current browser profile/grants and closes its tabs. " +
		"Cookie values are not shown to the model. The temporary copy is deleted on /browser logout, /reload or shutdown.",
		signal);
	if (signal?.aborted) return notGranted("cancelled");
	if (approved !== true) return notGranted("denied");
	// Validate each approved origin directly; never reparse an array as comma-separated
	// command input, which could turn one displayed destination into multiple grants.
	for (const origin of requestedOrigins) {
		if (signal?.aborted) return notGranted("cancelled");
		const validated = await validateBrowserUrl(origin);
		if (validated.origin !== origin) throw new Error("Cookie access origin changed during validation");
	}
	const origins = requestedOrigins;
	if (signal?.aborted) return notGranted("cancelled");
	try {
		await session.closeBrowser();
		await session.clearGrants();
		if (signal?.aborted) throw new Error("cancelled");
		const count = await session.importChromiumCookies(origins, { cookieNames, signal });
		if (signal?.aborted) throw new Error("cancelled");
		return {
			content: `Cookie access granted for ${origins.join(", ")}. Loaded ${count} cookies into an isolated profile. Previous grants replaced. Ready for browser navigation.`,
			details: { status: "granted", origins, cookieNames, cookieCount: count },
		};
	} catch {
		try { try { await session.closeBrowser(); } finally { await session.clearGrants(); } }
		catch { throw new Error("Cookie access cleanup failed. Retry /browser logout before requesting access again."); }
		if (signal?.aborted) return notGranted("cancelled");
		// Never relay browser/SQLite/keyring errors or source details to the model.
		throw new Error("Chromium cookie access failed. Check Node 22.16+, matching Default-profile cookies and the unlocked desktop keyring, or use /browser login.");
	}
}
