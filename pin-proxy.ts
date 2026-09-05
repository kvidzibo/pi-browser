import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { resolvePinnedTarget, type Lookup } from "./gate.ts";

export type PinProxy = {
	port: number;
	username: string;
	password: string;
	close(): Promise<void>;
	dropTunnels(): void;
};
const CONNECT_OK = "HTTP/1.1 200 Connection Established\r\n\r\n";
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const AUTH_REQUIRED = "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"pi-browser\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

export type PinProxyOptions = {
	lookup?: Lookup;
	allowTarget?: (url: URL) => boolean;
	connect?: (options: { host: string; port: number; family: number }) => net.Socket;
};

export async function startPinProxy(options: PinProxyOptions = {}): Promise<PinProxy> {
	const username = "pi-browser", password = randomBytes(24).toString("base64url");
	const sockets = new Set<Duplex>();
	const track = (socket: Duplex) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); return socket; };
	const authenticated = (req: IncomingMessage) => proxyAuthOk(req.headers["proxy-authorization"], username, password);
	const checkTarget = (url: URL, client: Duplex) => {
		if (client.destroyed || options.allowTarget?.(url) === false) throw new Error("Connection cancelled");
	};
	const pin = async (url: URL, client: Duplex) => {
		checkTarget(url, client);
		return resolvePinnedTarget(url, { lookup: options.lookup });
	};
	const connect = (address: string, port: number, family: number): Promise<net.Socket> => new Promise((resolve, reject) => {
		const socket = (options.connect ?? net.connect)({ host: address, port, family });
		track(socket);
		const timeout = () => { socket.destroy(); reject(new Error("upstream timeout")); };
		socket.setTimeout(10_000, timeout);
		socket.once("connect", () => { socket.setTimeout(0); socket.off("timeout", timeout); resolve(socket); });
		socket.once("error", reject);
		socket.once("close", () => reject(new Error("Connection closed")));
	});

	// Parse every ordinary HTTP request, including requests reusing a proxy connection.
	// A raw byte pipe after the first request would bypass the next origin's policy.
	const server = http.createServer({ maxHeaderSize: 64_000, headersTimeout: 10_000 }, (req, res) => {
		void forward(req, res);
	});
	server.on("connection", track);
	server.on("clientError", (_error, socket) => { if (!socket.destroyed) socket.end(FORBIDDEN); });
	server.on("connect", (req, client, head) => { void tunnel(req, client, head, true); });
	server.on("upgrade", (req, client, head) => { void tunnel(req, client, head, false); });

	async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const fail = () => {
			if (res.destroyed || res.writableEnded) return;
			if (res.headersSent) { res.destroy(); return; }
			res.writeHead(403, { connection: "close", "content-length": 0 }); res.end();
		};
		try {
			if (!authenticated(req)) {
				res.writeHead(407, { "proxy-authenticate": 'Basic realm="pi-browser"', connection: "close", "content-length": 0 }); res.end(); return;
			}
			const url = new URL(req.url ?? "");
			if (url.protocol !== "http:") throw new Error("HTTPS requires CONNECT");
			const pinned = await pin(url, req.socket);
			// Check in this continuation: returning from an async pin helper also yields.
			checkTarget(url, req.socket);
			const headers = { ...req.headers, host: url.host };
			delete headers["proxy-authorization"]; delete headers["proxy-connection"];
			const upstream = http.request(url, {
				method: req.method, headers, maxHeaderSize: 64_000,
				createConnection: (_opts, done) => {
					void connect(pinned.address.address, Number(url.port || 80), pinned.address.family).then((socket) => {
						try { checkTarget(url, req.socket); done(null, socket); }
						catch (error) { socket.destroy(); done(error as Error); }
					}, done);
					return undefined;
				},
			}, (response) => {
				res.writeHead(response.statusCode ?? 502, response.headers);
				response.on("error", () => res.destroy()); response.pipe(res);
			});
			upstream.on("error", fail);
			req.on("error", () => upstream.destroy());
			res.on("close", () => upstream.destroy());
			req.pipe(upstream);
		} catch { fail(); }
	}

	async function tunnel(req: IncomingMessage, client: Duplex, head: Buffer, isConnect: boolean): Promise<void> {
		client.pause(); client.on("error", () => client.destroy());
		try {
			if (!authenticated(req)) { client.end(AUTH_REQUIRED); return; }
			const url = new URL(isConnect ? `https://${req.url}/` : req.url ?? "");
			if (isConnect ? url.pathname !== "/" || Boolean(url.search || url.hash) : url.protocol !== "http:") throw new Error("Invalid tunnel target");
			const pinned = await pin(url, client);
			checkTarget(url, client);
			const upstream = await connect(pinned.address.address, Number(url.port || (isConnect ? 443 : 80)), pinned.address.family);
			if (client.destroyed || options.allowTarget?.(url) === false) { upstream.destroy(); return; }
			pipe(client, upstream);
			if (isConnect) client.write(CONNECT_OK);
			else {
				const headers = Object.entries({ ...req.headers, host: url.host }).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n");
				upstream.write(`${stripProxyHopHeaders(`${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers}`)}\r\n\r\n`);
			}
			if (head.length) upstream.write(head);
			client.resume();
		} catch { if (!client.destroyed) client.end(FORBIDDEN); }
	}

	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const addr = server.address();
	if (!addr || typeof addr === "string") { server.close(); throw new Error("pin proxy failed to bind"); }
	const dropTunnels = () => { for (const socket of sockets) socket.destroy(); };
	return { port: addr.port, username, password, dropTunnels,
		close: () => new Promise((resolve) => { dropTunnels(); server.close(() => resolve()); }),
	};
}

export function stripProxyHopHeaders(header: string): string {
	return header.split("\r\n").filter((line) => !/^proxy-connection:/i.test(line) && !/^proxy-authorization:/i.test(line)).join("\r\n");
}

function proxyAuthOk(value: string | undefined, username: string, password: string): boolean {
	const match = /^Basic\s+(\S+)/i.exec(value ?? "");
	if (!match) return false;
	const got = Buffer.from(match[1]), want = Buffer.from(Buffer.from(`${username}:${password}`, "utf8").toString("base64"));
	return got.length === want.length && timingSafeEqual(got, want);
}

function pipe(a: Duplex, b: Duplex): void {
	a.pipe(b); b.pipe(a);
	const close = () => { a.destroy(); b.destroy(); };
	a.on("error", close); b.on("error", close); a.on("close", close); b.on("close", close);
}
