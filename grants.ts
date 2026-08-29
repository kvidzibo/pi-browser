import { MAX_URL_CHARS } from "./constants.ts";
import { isAboutBlank, isPassthroughRequestUrl, validateBrowserUrl } from "./gate.ts";

export function originOf(raw: string): string {
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Cannot grant origin for scheme ${url.protocol.replace(":", "")}`);
	}
	return url.origin;
}

export function originAllowed(raw: string, grants: Iterable<string>): boolean {
	const origin = new URL(raw).origin;
	for (const grant of grants) {
		if (grant === origin) return true;
	}
	return false;
}

export type GrantNet = "allow" | "abort" | "strip-cookie";

export function classifyGrantedRequest(url: string, grants: Iterable<string>, resourceType: string): GrantNet {
	const grantSet = grants instanceof Set ? grants : new Set(grants);
	if (grantSet.size === 0) return "allow";
	if (isAboutBlank(url) || isPassthroughRequestUrl(url)) return "allow";
	try {
		if (originAllowed(url, grantSet)) return "allow";
	} catch {
		return "abort";
	}
	if (resourceType === "document" || resourceType === "websocket" || resourceType === "eventsource") return "abort";
	return "strip-cookie";
}

export async function parseGrantOrigins(
	input: string,
	lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>,
): Promise<string[]> {
	const parts = input.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
	if (parts.length === 0) throw new Error("No origins provided");
	const origins: string[] = [];
	for (const part of parts) {
		if (part.length > MAX_URL_CHARS) throw new Error("Origin too long");
		const candidate = part.includes("://") ? part : `https://${part}`;
		const url = await validateBrowserUrl(candidate, { lookup });
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`Blocked grant scheme: ${url.protocol.replace(":", "")}`);
		}
		origins.push(url.origin);
	}
	return [...new Set(origins)];
}
