import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BrowserSession } from "../session.ts";
import { createBrowserService, mcpResult } from "../mcp/service.ts";
import { UI_URI } from "../mcp/schema.ts";

// No Chromium, home-directory writes or real cookie reads in this contract test.
class Session extends BrowserSession {
	imports = 0;
	revocations = 0;
	shutdowns = 0;
	selected?: string;
	names: string[] = [];
	scope: string[] = [];
	override async reapStale() {}
	override async shutdown() { this.shutdowns++; await this.clearGrants(); }
	override async closeBrowser() { return "Browser closed."; }
	override async clearGrants() { this.revocations++; this.scope = []; this.selected = undefined; }
	override hasCookieAccess(origins: string[]) { return origins.every((origin) => this.scope.includes(origin)); }
	override async importChromiumCookies(origins: string[]) { this.imports++; this.scope = [...origins]; return 2; }
	override async listProfiles() { return [...this.names]; }
	override async createProfile(name: string) { this.names.push(name); return name; }
	override async selectProfile(name: string) { this.selected = name; }
	override profileName() { return this.selected; }
	override async execute() { return { content: "UNTRUSTED PAGE CONTENT\nfixture", image: { data: "cG5n", mimeType: "image/png" as const } }; }
}

test("MCP keeps consent and operator actions off the model surface, cancels safely and revokes on context/connection changes", async () => {
	const session = new Session();
	const service = createBrowserService(session);
	const client = new Client({ name: "test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
	const [up, down] = InMemoryTransport.createLinkedPair();
	let decision: ElicitResult = { action: "decline" };
	let prompts = 0;
	let release: (() => void) | undefined;
	let promptSeen: (() => void) | undefined;
	client.setRequestHandler(ElicitRequestSchema, async (request) => {
		prompts++;
		assert.equal(request.params.mode, "form");
		assert.match(request.params.message, /Chromium/);
		if (promptSeen) { promptSeen(); await new Promise<void>((resolve) => { release = resolve; }); }
		return decision;
	});
	const meta = { "native-ui/context": { conversationId: "one", state: {} } };
	const call = (args: Record<string, unknown>, _meta = meta, signal?: AbortSignal) => client.callTool({ name: "browser", arguments: args, _meta }, undefined, { signal });
	const view = async (_meta = meta) => {
		const result = await client.readResource({ uri: UI_URI, _meta });
		return JSON.parse((result.contents[0] as { text: string }).text);
	};
	const action = (revision: string, id: string, value?: string) => client.request({ method: "native-ui/action", params: { uri: UI_URI, revision, action: id, value, _meta: meta } }, z.object({ view: z.any(), preview: z.string().optional() }));
	await service.connect(down); await client.connect(up);
	try {
		assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["browser"]);
		assert.equal((await call({ action: "selectProfile", name: "personal" })).isError, true);
		assert.equal((await call({ action: "close", approved: true })).isError, true);
		const screenshot = await call({ action: "screenshot", image: true });
		assert.equal((screenshot.content as { type: string }[])[1].type, "image");
		assert.match(JSON.stringify(await call({ action: "list_cookies" })), /denied/);
		assert.equal(session.imports, 0);
		const request = { action: "request_cookies", origins: ["https://8.8.8.8"] };
		decision = { action: "accept", content: { approve: false } };
		assert.match(JSON.stringify(await call(request)), /denied/);
		decision = { action: "accept", content: { approve: true } };
		assert.match(JSON.stringify(await call(request)), /granted/);
		assert.equal(session.imports, 1);
		const prior = prompts;
		await call(request); assert.equal(prompts, prior); assert.equal(session.imports, 1);
		decision = { action: "decline" };
		await call({ ...request, origins: ["https://1.1.1.1"] });
		assert.deepEqual(session.scope, ["https://8.8.8.8"]);

		let screen = await view();
		const created = await action(screen.revision, "create-profile", "work");
		assert.equal(session.selected, "work");
		await assert.rejects(action(screen.revision, "logout"), /changed/);
		assert.equal(created.view.state.selected, undefined);
		await view({ "native-ui/context": { conversationId: "two", state: { selected: "work" } } } as typeof meta);
		assert.equal(session.selected, undefined);
		screen = await view();
		await assert.rejects(action(screen.revision, "finish-login"), /unavailable/);

		decision = { action: "accept", content: { approve: true } };
		const shown = new Promise<void>((resolve) => { promptSeen = resolve; });
		const controller = new AbortController();
		const pending = call(request, meta, controller.signal);
		await shown; controller.abort();
		await assert.rejects(pending);
		release!();
		await view(); // Drain server queue after the late acceptance.
		assert.equal(session.imports, 1);
		assert.deepEqual(session.scope, []);
		assert.match((mcpResult({ content: "x".repeat(60_000) }).content[0] as { text: string }).text, /Truncated/);
	} finally { release?.(); await service.close(); await client.close(); }
	assert.equal(session.shutdowns, 1);

	const noUI = createBrowserService(new Session());
	const plain = new Client({ name: "no-ui", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await noUI.connect(b); await plain.connect(a);
	try {
		const result = await plain.callTool({ name: "browser", arguments: { action: "list_cookies" } });
		assert.equal(result.isError, true); assert.match(JSON.stringify(result), /interactive MCP form approval/);
	} finally { await plain.close(); await noUI.close(); }
});
