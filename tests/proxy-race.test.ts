import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { startPinProxy } from "../pin-proxy.ts";

for (const connect of [false, true]) {
	test(`grant revocation between async pin return and caller continuation prevents late connect (CONNECT: ${connect})`, async () => {
		let allowed = true, checks = 0, lateConnects = 0;
		const proxy = await startPinProxy({
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			allowTarget: () => { if (++checks === 2) queueMicrotask(() => { allowed = false; }); return allowed; },
			connect: () => { if (!allowed) lateConnects++; throw new Error("synthetic connector"); },
		});
		try {
			const response = await new Promise<string>((resolve, reject) => {
				const socket = net.connect({ host: "127.0.0.1", port: proxy.port }, () => {
					const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
					socket.write(`${connect ? "CONNECT first.example:443" : "GET http://first.example/"} HTTP/1.1\r\nHost: first.example\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
				});
				socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("timeout")); });
				socket.on("error", reject); socket.on("data", (data) => { socket.destroy(); resolve(data.toString()); });
			});
			assert.match(response, /403/); assert.equal(lateConnects, 0);
		} finally { await proxy.close(); }
	});
}
