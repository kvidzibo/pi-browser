export const NETWORK_CODES = ["origin_not_granted", "private_address", "blocked_scheme", "dns", "tls", "redirect", "resource_limit", "timeout", "cancelled", "connection", "resource_error"] as const;
export type NetworkCode = typeof NETWORK_CODES[number];

export class NetworkPolicyError extends Error {
	readonly networkCode: NetworkCode;
	constructor(code: NetworkCode, message: string) { super(message); this.networkCode = code; }
}

/** Only fixed categories leave the transport; never retain URLs, headers, bodies or raw errors. */
export function networkCode(error: unknown): NetworkCode {
	if (error instanceof NetworkPolicyError) return error.networkCode;
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	const message = error instanceof Error ? error.message : "";
	if (error instanceof Error && error.name === "AbortError") return "cancelled";
	if (/CERT|SSL|TLS|SELF_SIGNED|VERIFY_LEAF/.test(code) || /certificate|Hostname\/IP does not match/i.test(message)) return "tls";
	if (/ENOTFOUND|EAI_AGAIN/.test(code) || /Failed to resolve/.test(message)) return "dns";
	if (/Blocked internal|non-canonical IP/.test(message)) return "private_address";
	if (/Blocked.*scheme|URLs with credentials/.test(message)) return "blocked_scheme";
	if (/Redirected ungranted/.test(message)) return "redirect";
	if (/too large|Too many resource encodings/.test(message)) return "resource_limit";
	if (/TIMEDOUT/.test(code) || /timeout|timed out/i.test(message)) return "timeout";
	if (/ECONN|EPIPE|ENET|EHOST/.test(code)) return "connection";
	return "resource_error";
}

export class NetworkDiagnostics {
	private counts: Partial<Record<NetworkCode, number>> = {};
	record(code: NetworkCode): void { this.counts[code] = Math.min(1_000_000, (this.counts[code] ?? 0) + 1); }
	reset(): void { this.counts = {}; }
	snapshot(): Partial<Record<NetworkCode, number>> { return { ...this.counts }; }
	summary(): string { return Object.entries(this.counts).map(([code, count]) => `${code}=${count}`).join(" "); }
}
