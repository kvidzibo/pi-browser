import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, isJSONRPCRequest, type RequestId, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BrowserSession, type SessionResult } from "../session.ts";
import { requestCookieAccess } from "../cookie-access.ts";
import { listCookieInventory } from "../cookie-inventory.ts";
import { BrowserApp } from "./app.ts";
import { ActionSchema, BrowserSchema, browserTool, UI_URI, UI_MIME } from "./schema.ts";

export function mcpResult(result: SessionResult): CallToolResult {
	const lines = result.content.split("\n").slice(0, 2000).join("\n");
	const text = Buffer.from(lines).subarray(0, 50 * 1024).toString("utf8");
	return { content: [{ type: "text", text: text + (text !== result.content ? "\n[Truncated. Use snapshot pagination.]" : "") }, ...(result.image ? [{ type: "image" as const, ...result.image }] : [])] };
}

/** One browser per stdio connection. The only model-callable surface is browser;
 * operator actions travel over native-ui/action, never tool arguments/results. */
export function createBrowserService(session = new BrowserSession()) {
	const server = new Server({ name: "pi-browser", version: "0.6.0" }, { capabilities: { tools: {}, resources: {}, experimental: { "native-ui-v1": {} } } });
	const app = new BrowserApp(session);
	const lifetime = new AbortController();
	const pending = new Map<RequestId, AbortController>();
	let closing: Promise<void> | undefined;
	let conversation: string | undefined;
	const changed = () => server.notification({ method: "notifications/native-ui/changed", params: { uri: UI_URI } }).catch(() => {});
	const signalFor = (id: RequestId, signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal, ...(pending.has(id) ? [pending.get(id)!.signal] : [])]);

	async function inSession<T>(meta: Record<string, unknown> | undefined, id: RequestId, original: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const signal = signalFor(id, original);
		try {
			return await session.withLock(async () => {
				signal.throwIfAborted();
				const context = meta?.["native-ui/context"] as { conversationId?: unknown } | undefined;
				const next = typeof context?.conversationId === "string" ? context.conversationId : undefined;
				// Missing context after a bound UI session must not reuse its authority.
				if (conversation !== next) { await app.revoke(); app.reset(); conversation = next; }
				try { return await run(signal); }
				catch (error) { if (signal.aborted) await app.revoke(); throw error; }
			}, signal);
		} finally { pending.delete(id); }
	}

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [browserTool] }));
	server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: UI_URI, name: "Browser", mimeType: UI_MIME }] }));
	server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
		if (request.params.uri !== UI_URI) throw new Error("Unknown browser resource");
		return inSession(request.params._meta, extra.requestId, extra.signal, async () => ({ contents: [{ uri: UI_URI, mimeType: UI_MIME, text: JSON.stringify(await app.view()) }] }));
	});
	server.setRequestHandler(ActionSchema, async (request, extra) => inSession(request.params._meta, extra.requestId, extra.signal, async (signal) => {
		try { return await app.act(request.params.revision, request.params.action, request.params.value, signal); }
		finally { void changed(); }
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		try {
			if (request.params.name !== "browser" || request.params.task) throw new Error("Unknown tool or unsupported task");
			const parsed = BrowserSchema.safeParse(request.params.arguments);
			if (!parsed.success) throw new Error("Invalid browser arguments");
			return await inSession(request.params._meta, extra.requestId, extra.signal, async (signal) => {
				const params = parsed.data;
				if (app.loginPending) throw new Error("Manual login is pending. Finish or cancel it in the browser app before using tools.");
				const confirm = async (title: string, message: string): Promise<boolean> => {
					if (!server.getClientCapabilities()?.elicitation?.form) throw new Error("Cookie access requires a host with interactive MCP form approval. No access granted.");
					signal.throwIfAborted();
					const result = await server.elicitInput({ mode: "form", message: `${title}\n\n${message}`, requestedSchema: {
						type: "object", properties: { approve: { type: "boolean", title: "Allow once", default: false } }, required: ["approve"],
					} }, { signal, timeout: 120_000, relatedRequestId: extra.requestId });
					signal.throwIfAborted();
					return result.action === "accept" && result.content?.approve === true;
				};
				try {
					const result = params.action === "request_cookies" ? await requestCookieAccess(session, params, confirm, signal)
						: params.action === "list_cookies" ? await listCookieInventory(params, confirm, signal)
						: await session.execute(params, signal);
					return mcpResult(result);
				} finally { app.invalidate(); void changed(); }
			});
		} catch (error) {
			return { isError: true, content: [{ type: "text", text: lifetime.signal.aborted ? "Browser service closed" : error instanceof Error ? error.message : "Browser request failed" }] };
		}
	});

	const close = (): Promise<void> => {
		closing ??= (async () => { lifetime.abort(); for (const controller of pending.values()) controller.abort(); await session.shutdown(); await server.close(); })();
		return closing;
	};
	server.onclose = () => { void close().catch(() => { process.stderr.write("Browser service cleanup failed\n"); }); };
	server.onerror = () => { process.stderr.write("Browser MCP protocol error\n"); };
	return {
		server, close,
		async connect(transport: Transport) {
			await session.reapStale();
			await server.connect(transport);
			// Track cancellation synchronously, including request id 0 (SDK 1.x
			// ignores that id in its own cancellation handler).
			const onmessage = transport.onmessage;
			const send = transport.send.bind(transport);
			transport.send = async (message, options) => {
				if (!("method" in message) && "id" in message && message.id !== undefined) pending.delete(message.id);
				await send(message, options);
			};
			transport.onmessage = (message, extra) => {
				if (isJSONRPCRequest(message) && ["tools/call", "resources/read", "native-ui/action"].includes(message.method)) pending.set(message.id, new AbortController());
				else if ("method" in message && message.method === "notifications/cancelled") {
					const id = message.params?.requestId;
					if (typeof id === "string" || typeof id === "number") pending.get(id)?.abort();
				}
				onmessage?.(message, extra);
			};
		},
	};
}
