import type { BrowserContext } from "patchright-core";
import { fetchCookieless } from "./cookieless.ts";
import { NetworkDiagnostics, networkCode } from "./diagnostics.ts";
import { isPassthroughRequestUrl, validateBrowserUrl } from "./gate.ts";
import { classifyGrantedRequest } from "./grants.ts";

export class NetworkPolicy {
	private controller = new AbortController();
	readonly diagnostics = new NetworkDiagnostics();

	close(): void { this.controller.abort(); this.controller = new AbortController(); }

	async install(context: Pick<BrowserContext, "route">, grants: () => ReadonlySet<string>, resourceFetch = fetchCookieless): Promise<void> {
		const signal = this.controller.signal;
		await context.route("**/*", async (route) => {
			const request = route.request();
			const url = request.url();
			try {
				if (signal.aborted) { await route.abort("blockedbyclient"); return; }
				if (isPassthroughRequestUrl(url)) { await route.continue(); return; }
				const decision = classifyGrantedRequest(url, grants(), request.resourceType());
				if (decision === "abort") {
					this.diagnostics.record("origin_not_granted");
					await route.abort("blockedbyclient"); return;
				}
				if (decision === "strip-cookie") {
					const response = await resourceFetch(url, {
						method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
					}, { signal });
					if (signal.aborted) { await route.abort("blockedbyclient"); return; }
					await route.fulfill(response); return;
				}
				await validateBrowserUrl(url, { allowWebSocket: true, signal });
				if (signal.aborted) { await route.abort("blockedbyclient"); return; }
				await route.continue();
			} catch (error) {
				this.diagnostics.record(networkCode(error));
				await route.abort("blockedbyclient").catch(() => undefined);
			}
		});
	}
}
