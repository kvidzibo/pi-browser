import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { test } from "node:test";
import { startPinProxy, stripProxyHopHeaders } from "../pin-proxy.ts";

function proxyAuthHeader(username: string, password: string): string {
	return `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function connectStatus(port: number, request: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port }, () => {
			socket.write(request);
		});
		socket.setTimeout(3000, () => {
			socket.destroy();
			reject(new Error("timeout"));
		});
		socket.on("data", (chunk) => {
			resolve(chunk.toString("utf8"));
			socket.destroy();
		});
		socket.on("error", reject);
		socket.on("end", () => { socket.destroy(); reject(new Error("closed")); });
	});
}

test("stripProxyHopHeaders removes proxy auth even as the last header", () => {
	const last = "GET / HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: Basic secret";
	const strippedLast = stripProxyHopHeaders(last);
	assert.equal(strippedLast.includes("Proxy-Authorization"), false);
	assert.match(strippedLast, /Host: example.com/);

	const mid = "GET / HTTP/1.1\r\nProxy-Authorization: Basic secret\r\nProxy-Connection: keep-alive\r\nHost: example.com";
	const strippedMid = stripProxyHopHeaders(mid);
	assert.equal(strippedMid.includes("Proxy-Authorization"), false);
	assert.equal(strippedMid.includes("Proxy-Connection"), false);
	assert.match(strippedMid, /Host: example.com/);
});

test("pin proxy rejects CONNECT without proxy auth", async () => {
	const proxy = await startPinProxy({
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
	});
	try {
		const status = await connectStatus(
			proxy.port,
			"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
		);
		assert.match(status, /407/);
	} finally {
		await proxy.close();
	}
});

test("pin proxy rejects CONNECT with bad proxy auth", async () => {
	const proxy = await startPinProxy({
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
	});
	try {
		const status = await connectStatus(
			proxy.port,
			`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${proxyAuthHeader("pi-browser", "wrong")}\r\n\r\n`,
		);
		assert.match(status, /407/);
	} finally {
		await proxy.close();
	}
});

test("pin proxy rejects CONNECT to a host that resolves private", async () => {
	const proxy = await startPinProxy({
		lookup: async () => [{ address: "127.0.0.1", family: 4 }],
	});
	try {
		const status = await connectStatus(
			proxy.port,
			`CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n${proxyAuthHeader(proxy.username, proxy.password)}\r\n\r\n`,
		);
		assert.match(status, /403/);
	} finally {
		await proxy.close();
	}
});

test("HTTP requests reusing a proxy socket are individually gated, and proxy auth stays local", async () => {
	const seen: any[] = [], ports: number[] = [];
	const backend = http.createServer((req, res) => {
		let body = ""; req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => { seen.push({ url: req.url, headers: req.headers, body }); res.end("fixture"); });
	});
	await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
	const proxy = await startPinProxy({
		lookup: async () => [{ address: "93.184.216.34", family: 4 }], allowTarget: (url) => url.origin === "http://first.example",
		connect: (options) => { assert.equal(options.host, "93.184.216.34"); return net.connect({ host: "127.0.0.1", port: (backend.address() as any).port }); },
	});
	const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
	const request = (host: string) => new Promise<number | undefined>((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: proxy.port, agent, path: `http://${host}/path`, method: "POST",
			headers: { host, cookie: "synthetic=private", "proxy-authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}` },
		}, (res) => { ports.push(req.socket!.localPort!); res.resume(); res.on("end", () => resolve(res.statusCode)); });
		req.on("error", reject); req.end("body");
	});
	try {
		assert.equal(await request("first.example"), 200);
		assert.equal(await request("second.example"), 403);
		assert.equal(ports[0], ports[1]); assert.equal(seen.length, 1);
		assert.equal(seen[0].url, "/path"); assert.equal(seen[0].body, "body");
		assert.equal(seen[0].headers.cookie, "synthetic=private"); assert.equal(seen[0].headers["proxy-authorization"], undefined);
	} finally { agent.destroy(); await proxy.close(); backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); }
});

test("CONNECT origin grants include the port", async () => {
	const backend = net.createServer((socket) => { socket.on("error", () => {}); socket.resume(); });
	await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
	const proxy = await startPinProxy({
		lookup: async () => [{ address: "93.184.216.34", family: 4 }], allowTarget: (url) => url.origin === "https://first.example:8443",
		connect: (options) => { assert.equal(options.port, 8443); return net.connect({ host: "127.0.0.1", port: (backend.address() as any).port }); },
	});
	try {
		for (const [port, expected] of [[443, 403], [8443, 200]]) {
			assert.match(await connectStatus(proxy.port, `CONNECT first.example:${port} HTTP/1.1\r\nHost: first.example:${port}\r\n${proxyAuthHeader(proxy.username, proxy.password)}\r\n\r\n`), new RegExp(String(expected)));
		}
	} finally { await proxy.close(); await new Promise<void>((resolve) => backend.close(() => resolve())); }
});

for (const closeProxy of [false, true]) {
	test(`pending DNS cannot bypass a changed grant or closed proxy (close: ${closeProxy})`, async () => {
		let allow = true, connections = 0, finish!: (value: any) => void, started!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		const proxy = await startPinProxy({
			lookup: () => new Promise((resolve) => { finish = resolve; started(); }), allowTarget: () => allow,
			connect: () => { connections++; throw new Error("must not connect"); },
		});
		const pending = connectStatus(proxy.port, `CONNECT first.example:443 HTTP/1.1\r\nHost: first.example:443\r\n${proxyAuthHeader(proxy.username, proxy.password)}\r\n\r\n`);
		const result = closeProxy ? assert.rejects(pending) : pending.then((status) => assert.match(status, /403/));
		try {
			await ready;
			if (closeProxy) await proxy.close(); else allow = false;
			finish([{ address: "93.184.216.34", family: 4 }]); await result;
			await new Promise((resolve) => setImmediate(resolve)); assert.equal(connections, 0);
		} finally { if (!closeProxy) await proxy.close(); }
	});
}
