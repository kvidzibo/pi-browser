import { randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { Lookup } from "./gate.ts";
import { resolvePinnedTarget } from "./gate.ts";

export type PinProxy = {
	port: number;
	username: string;
	password: string;
	close(): Promise<void>;
	dropTunnels(): void;
};

const CONNECT_OK = "HTTP/1.1 200 Connection Established\r\n\r\n";
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const AUTH_REQUIRED =
	"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"pi-browser\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

export type PinProxyOptions = {
	lookup?: Lookup;
};

export async function startPinProxy(options: PinProxyOptions = {}): Promise<PinProxy> {
	const username = "pi-browser";
	const password = randomBytes(24).toString("base64url");
	const sockets = new Set<net.Socket>();
	const server = net.createServer((client) => {
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		void handleClient(client, options, sockets, username, password);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	const addr = server.address();
	if (!addr || typeof addr === "string") {
		server.close();
		throw new Error("pin proxy failed to bind");
	}

	const dropTunnels = () => {
		for (const socket of sockets) {
			try {
				socket.destroy();
			} catch {
				// ignore
			}
		}
	};
	return {
		port: addr.port,
		username,
		password,
		dropTunnels,
		close: () =>
			new Promise((resolve) => {
				dropTunnels();
				server.close(() => resolve());
			}),
	};
}

export function stripProxyHopHeaders(header: string): string {
	return header
		.split("\r\n")
		.filter((line) => !/^proxy-connection:/i.test(line) && !/^proxy-authorization:/i.test(line))
		.join("\r\n");
}

function proxyAuthOk(header: string, username: string, password: string): boolean {
	const line = header.split("\r\n").find((row) => /^proxy-authorization:\s*/i.test(row));
	if (!line) return false;
	const value = line.replace(/^proxy-authorization:\s*/i, "");
	const match = /^Basic\s+(\S+)/i.exec(value);
	if (!match) return false;
	const expected = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
	const got = Buffer.from(match[1]);
	const want = Buffer.from(expected);
	if (got.length !== want.length) return false;
	return timingSafeEqual(got, want);
}

async function handleClient(
	client: net.Socket,
	options: PinProxyOptions,
	sockets: Set<net.Socket>,
	username: string,
	password: string,
): Promise<void> {
	const lookup = options.lookup;
	try {
		const { header, rest } = await readHttpHead(client);
		client.pause();
		client.on("error", () => {
			try {
				client.destroy();
			} catch {
				// ignore
			}
		});
		if (!proxyAuthOk(header, username, password)) {
			client.end(AUTH_REQUIRED);
			return;
		}
		const first = header.split("\r\n")[0] ?? "";
		const connect = /^CONNECT\s+(\S+)\s+/i.exec(first);
		if (connect) {
			const target = parseHostPort(connect[1], 443);
			const pinned = await resolvePinnedTarget(`https://${target.host}/`, { lookup });
			const upstream = await connectPinned(pinned.address.address, target.port, pinned.address.family, sockets);
			pipe(client, upstream);
			client.write(CONNECT_OK);
			if (rest.length) upstream.write(rest);
			client.resume();
			return;
		}

		const abs = /^(GET|POST|PUT|DELETE|HEAD|PATCH|OPTIONS)\s+(https?:\/\/\S+)\s+/i.exec(first);
		if (!abs) {
			client.end(FORBIDDEN);
			return;
		}
		const url = new URL(abs[2]);
		const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
		const pinned = await resolvePinnedTarget(url, { lookup });
		const upstream = await connectPinned(pinned.address.address, port, pinned.address.family, sockets);
		const path = `${url.pathname}${url.search}`;
		const rewritten = stripProxyHopHeaders(header.replace(abs[2], path));
		pipe(client, upstream);
		upstream.write(`${rewritten}\r\n\r\n`);
		if (rest.length) upstream.write(rest);
		client.resume();
	} catch {
		try {
			client.end(FORBIDDEN);
		} catch {
			client.destroy();
		}
	}
}

function parseHostPort(hostPort: string, fallback: number): { host: string; port: number } {
	if (hostPort.startsWith("[")) {
		const end = hostPort.indexOf("]");
		const host = hostPort.slice(1, end);
		const port = hostPort.slice(end + 2) ? Number(hostPort.slice(end + 2)) : fallback;
		return { host, port };
	}
	const idx = hostPort.lastIndexOf(":");
	if (idx === -1) return { host: hostPort, port: fallback };
	return { host: hostPort.slice(0, idx), port: Number(hostPort.slice(idx + 1)) };
}

function connectPinned(address: string, port: number, family: number, sockets: Set<net.Socket>): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: address, port, family: family === 6 ? 6 : 4 });
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		const onTimeout = () => {
			socket.destroy();
			reject(new Error("upstream timeout"));
		};
		socket.setTimeout(10_000, onTimeout);
		socket.once("connect", () => {
			socket.setTimeout(0);
			socket.off("timeout", onTimeout);
			resolve(socket);
		});
		socket.once("error", reject);
	});
}

function pipe(a: net.Socket, b: net.Socket): void {
	a.pipe(b);
	b.pipe(a);
	const close = () => {
		a.destroy();
		b.destroy();
	};
	a.on("error", close);
	b.on("error", close);
	a.on("close", close);
	b.on("close", close);
}

function readHttpHead(socket: net.Socket): Promise<{ header: string; rest: Buffer }> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			const buf = Buffer.concat(chunks);
			const idx = buf.indexOf("\r\n\r\n");
			if (idx === -1) {
				if (buf.length > 64_000) {
					cleanup();
					reject(new Error("header too large"));
				}
				return;
			}
			cleanup();
			resolve({ header: buf.subarray(0, idx).toString("utf8"), rest: buf.subarray(idx + 4) });
		};
		const onErr = (err: Error) => {
			cleanup();
			reject(err);
		};
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("error", onErr);
			socket.off("end", onEnd);
		};
		const onEnd = () => {
			cleanup();
			reject(new Error("closed"));
		};
		socket.on("data", onData);
		socket.on("error", onErr);
		socket.on("end", onEnd);
	});
}
