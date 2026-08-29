import assert from "node:assert/strict";
import net from "node:net";
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
