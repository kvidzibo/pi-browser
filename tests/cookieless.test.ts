import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { fetchCookieless } from "../cookieless.ts";

export async function fixture(run: (options: any, seen: any[], origin: string) => Promise<void>) {
	const seen: any[] = [];
	const server = http.createServer((req, res) => {
		let body = ""; req.on("data", (data) => { body += data; });
		req.on("end", () => {
			seen.push({ url: req.url, method: req.method, headers: req.headers, body });
			if (req.url === "/warm") {
				res.setHeader("content-type", "text/html"); res.end('<script src="/cached.js"></script>');
			} else if (req.url === "/not-modified" || req.headers["x-fixture-304"]) {
				res.writeHead(304, { etag: '"private-fixture"' }); res.end();
			} else if (req.url === "/cached.js") {
				res.writeHead(200, { "content-type": "application/javascript", "cache-control": "private, max-age=600", etag: '"private-fixture"' });
				res.end(`document.documentElement.dataset.credentialed = ${JSON.stringify(req.headers.cookie ? "cached-private" : "anonymous")};`);
			} else if (req.url === "/redirect" || req.url === "/keep" || req.url?.startsWith("/redirect-")) {
				res.writeHead(req.url === "/keep" ? 307 : Number(req.url?.slice(10)) || 302, { location: req.url?.startsWith("/redirect-") ? "https://second.example/end" : "http://second.example/end", "set-cookie": "intermediate=secret" }); res.end();
			} else if (req.url === "/private") {
				res.writeHead(302, { location: "http://127.0.0.1/private" }); res.end();
			} else if (req.url === "/loop") {
				res.writeHead(302, { location: "/loop" }); res.end();
			} else if (req.url === "/hang") {
				res.writeHead(200); res.write("waiting");
			} else if (req.url === "/large-encoded") {
				const data = Buffer.concat(Array.from({ length: 100 }, () => gzipSync("")));
				res.writeHead(200, { "content-encoding": "gzip" }); res.write(data.subarray(0, 1)); res.end(data.subarray(1));
			} else if (req.url === "/bad-encoding") {
				res.writeHead(200, { "content-encoding": "unknown" }); res.end("bad");
			} else {
				const data = gzipSync(req.url === "/large" ? "x".repeat(4096) : "decoded fixture");
				res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "set-cookie": "final=secret", "content-length": data.length }); res.end(data);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as any).port;
	// Only the test connector redirects the validated public address to our fixture.
	const request = ((url: URL, options: any, callback: any) => {
		options.lookup(url.hostname, {}, (error: unknown, address: string, family: number) => {
			assert.equal(error, null); assert.equal(address, "93.184.216.34"); assert.equal(family, 4);
		});
		assert.equal(options.agent, false);
		return http.request(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...options, lookup: undefined }, callback);
	}) as typeof http.request;
	try { await run({ request, lookup: async () => [{ address: "93.184.216.34", family: 4 }], timeoutMs: 3000 }, seen, `http://127.0.0.1:${port}`); }
	finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("cookieless transport strips credentials and Set-Cookie, decodes and pins connections", async () => {
	await fixture(async (options, seen) => {
		const result = await fetchCookieless("http://first.example/end", { method: "POST", headers: {
			Cookie: "browser=secret", Authorization: "Bearer secret", "Proxy-Authorization": "secret", "Content-Type": "text/plain", Host: "stale",
		}, body: Buffer.from("post body") }, options);
		assert.equal(result.body.toString(), "decoded fixture");
		assert.equal(result.headers["content-encoding"], undefined);
		assert.equal(result.headers["set-cookie"], undefined);
		assert.equal(result.headers["content-length"], undefined);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].headers.cookie, undefined); assert.equal(seen[0].headers.authorization, undefined);
		assert.equal(seen[0].headers["proxy-authorization"], undefined);
		assert.equal(seen[0].method, "POST"); assert.equal(seen[0].body, "post body");
		assert.equal(seen[0].headers["content-type"], "text/plain"); assert.equal(seen[0].headers.host, "first.example");
	});
});

test("stateless reads discard cache/range validators and reject 304; write preconditions survive", async () => {
	await fixture(async (options, seen) => {
		const headers = { "If-None-Match": "*", "If-Modified-Since": "yesterday", Range: "bytes=0-10", "If-Range": "private-etag", "If-Match": "revision" };
		await fetchCookieless("http://first.example/end", { method: "GET", headers }, options);
		for (const key of ["if-none-match", "if-modified-since", "range", "if-range"]) assert.equal(seen[0].headers[key], undefined);
		await fetchCookieless("http://first.example/end", { method: "POST", headers }, options);
		assert.equal(seen[1].headers["if-none-match"], "*"); assert.equal(seen[1].headers["if-match"], "revision");
		await assert.rejects(fetchCookieless("http://first.example/not-modified", { method: "GET", headers }, options), /cannot reuse cached/);
	});
});

test("redirects fail before any second connection, including HTTPS downgrades and private targets", async () => {
	await fixture(async (options, seen) => {
		const paths = ["redirect", "keep", "private", "loop", "redirect-301", "redirect-303", "redirect-308"];
		for (const path of paths) {
			await assert.rejects(fetchCookieless(`https://first.example/${path}`, { method: "GET", headers: {} }, options), /Redirected ungranted resources are blocked/);
		}
		assert.deepEqual(seen.map((req) => req.url), paths.map((path) => `/${path}`));
	});
});

test("decoded limits, unsupported encodings and cancellation fail closed", async () => {
	await fixture(async (options) => {
		await assert.rejects(fetchCookieless("http://first.example/large", { method: "GET", headers: {} }, { ...options, maxBytes: 128 }), /too large/);
		await assert.rejects(fetchCookieless("http://first.example/large-encoded", { method: "GET", headers: {} }, { ...options, maxBytes: 128 }), /too large/);
		await assert.rejects(fetchCookieless("http://first.example/bad-encoding", { method: "GET", headers: {} }, options), /Unsupported resource encoding/);
		await assert.rejects(fetchCookieless("http://first.example/hang", { method: "GET", headers: {} }, { ...options, timeoutMs: 30 }));
	});
});

test("local Chromium contract: fulfilled gzip is readable and cookies stay isolated", { skip: process.env.BROWSER_LOCAL_INTEGRATION !== "1" }, async () => {
	const { chromium } = await import("patchright-core");
	const { findBrowser } = await import("../browser-bin.ts");
	await fixture(async (options, seen) => {
		const browser = await chromium.launch({ executablePath: (await findBrowser()).executablePath, headless: false });
		try {
			const context = await browser.newContext();
			await context.addCookies([{ name: "synthetic", value: "private-fixture", url: "http://first.example" }]);
			await context.route("**/*", async (route) => {
				const req = route.request();
				const headers = await req.allHeaders();
				if (req.url().endsWith("/end")) assert.match(headers.cookie, /synthetic=private-fixture/);
				await route.fulfill(await fetchCookieless(req.url(), { method: req.method(), headers, body: req.postDataBuffer() }, options));
			});
			const page = await context.newPage();
			await page.goto("http://first.example/end");
			assert.equal(await page.textContent("body"), "decoded fixture");
			assert.ok(seen.length > 0); assert.ok(seen.every((req) => req.headers.cookie === undefined));
			assert.deepEqual((await context.cookies()).map((cookie) => cookie.name), ["synthetic"]);
		} finally { await browser.close(); }
	});
});

test("local Chromium cache contract: routing cannot reuse a warmed credentialed script", { skip: process.env.BROWSER_LOCAL_INTEGRATION !== "1" }, async () => {
	const { chromium } = await import("patchright-core");
	const { findBrowser } = await import("../browser-bin.ts");
	await fixture(async (options, seen, origin) => {
		const browser = await chromium.launch({ executablePath: (await findBrowser()).executablePath, headless: false });
		try {
			const context = await browser.newContext();
			await context.addCookies([{ name: "synthetic", value: "private", url: origin }]);
			for (let i = 0; i < 2; i++) {
				const page = await context.newPage(); await page.goto(`${origin}/warm`);
				assert.equal(await page.evaluate(() => document.documentElement.dataset.credentialed), "cached-private"); await page.close();
			}
			assert.equal(seen.filter((req) => req.url === "/cached.js").length, 1, "fixture must really warm/reuse HTTP cache");
			let force304 = false;
			// Enabling routing disables Chromium HTTP cache, including previously stored entries.
			await context.route("**/cached.js", async (route) => {
				try {
					const headers = await route.request().allHeaders();
					if (force304) headers["x-fixture-304"] = "1";
					await route.fulfill(await fetchCookieless("http://first.example/cached.js", { method: "GET", headers }, options));
				} catch { await route.abort("blockedbyclient"); }
			});
			const fresh = await context.newPage(); await fresh.goto(`${origin}/warm`);
			assert.equal(await fresh.evaluate(() => document.documentElement.dataset.credentialed), "anonymous");
			force304 = true;
			const rejected = await context.newPage(); await rejected.goto(`${origin}/warm`);
			assert.equal(await rejected.evaluate(() => document.documentElement.dataset.credentialed), undefined);
		} finally { await browser.close(); }
	});
});

test("local TLS and browser proxy contracts: certificate checks, redirects and WebSockets", { skip: process.env.BROWSER_LOCAL_INTEGRATION !== "1" }, async () => {
	const https = await import("node:https");
	const { createSecureServer } = await import("node:http2");
	const net = await import("node:net");
	const { execFileSync } = await import("node:child_process");
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "pi-browser-tls-"));
	try {
		const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=first.example", "-addext", "subjectAltName=DNS:first.example", "-days", "1"], { stdio: "ignore" });
		const ca = readFileSync(cert);
		const seen: any[] = [];
		const server = createSecureServer({ key: readFileSync(key), cert: ca, allowHTTP1: true }, (req, res) => {
			seen.push({ host: req.headers.host, cookie: req.headers.cookie, version: req.httpVersion });
			if (req.url === "/redirect") res.writeHead(302, { location: "https://second.example/end" });
			res.end("TLS fixture");
		});
		server.on("upgrade", (req, socket) => { seen.push({ host: req.headers.host, cookie: req.headers.cookie }); socket.destroy(); });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const port = (server.address() as any).port;
			let trustFixture = false;
			const request = ((url: URL, options: any, callback: any) => {
				assert.equal(options.servername, url.hostname); assert.notEqual(options.rejectUnauthorized, false);
				options.lookup(url.hostname, {}, (_error: unknown, address: string) => assert.equal(address, "93.184.216.34"));
				return https.request(url, { ...options, port, ...(trustFixture ? { ca } : {}),
					lookup: (_host: string, _opts: unknown, done: Function) => done(null, "127.0.0.1", 4),
				}, callback);
			}) as typeof http.request;
			const options = { request, lookup: async () => [{ address: "93.184.216.34", family: 4 }], timeoutMs: 3000 };
			await assert.rejects(fetchCookieless("https://first.example/", { method: "GET", headers: {} }, options), /self.signed/i);
			trustFixture = true;
			assert.equal((await fetchCookieless("https://first.example/", { method: "GET", headers: {} }, options)).body.toString(), "TLS fixture");
			await assert.rejects(fetchCookieless("https://wrong.example/", { method: "GET", headers: {} }, options), /Hostname\/IP does not match/);

			const { startPinProxy } = await import("../pin-proxy.ts");
			const { browserNetworkArgs } = await import("../constants.ts");
			const { chromium } = await import("patchright-core");
			const { findBrowser } = await import("../browser-bin.ts");
			const proxy = await startPinProxy({ lookup: options.lookup, allowTarget: (url) => url.origin === "https://first.example",
				connect: (target) => { assert.equal(target.host, "93.184.216.34"); return net.connect({ host: "127.0.0.1", port }); },
			});
			try {
				const browser = await chromium.launch({ executablePath: (await findBrowser()).executablePath, headless: false,
					args: browserNetworkArgs(true), proxy: { server: `http://127.0.0.1:${proxy.port}`, username: proxy.username, password: proxy.password },
				});
				try {
					// Only this synthetic certificate is untrusted. Production never ignores TLS errors.
					const context = await browser.newContext({ ignoreHTTPSErrors: true });
					await context.addCookies(["first", "second"].map((name) => ({ name, value: "synthetic-private", url: `https://${name}.example` })));
					await context.route("**/*", (route) => route.continue());
					const page = await context.newPage();
					await page.goto("https://first.example/");
					assert.equal(await page.evaluate(() => new Promise((resolve) => {
						const ws = new WebSocket("wss://second.example/ws");
						ws.onerror = () => resolve("blocked"); ws.onopen = () => { ws.close(); resolve("opened"); };
						setTimeout(() => resolve("timeout"), 2000);
					})), "blocked");
					await assert.rejects(page.goto("https://first.example/redirect"));
					assert.ok(seen.some((req) => req.cookie === "first=synthetic-private"));
					assert.ok(seen.every((req) => req.host !== "second.example"));
					assert.ok(seen.every((req) => req.version === "1.1"));
				} finally { await browser.close(); }
			} finally { await proxy.close(); }
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const lateReject of [false, true]) {
	test(`cancelled DNS cannot connect or produce an unhandled rejection (late reject: ${lateReject})`, async () => {
		const controller = new AbortController(); let finish!: (value: any) => void; let connects = 0;
		const promise = fetchCookieless("http://first.example/", { method: "GET", headers: {} }, {
			signal: controller.signal, lookup: () => new Promise((resolve, reject) => { finish = lateReject ? reject : resolve; }),
			request: (() => { connects++; throw new Error("must not connect"); }) as typeof http.request,
		});
		controller.abort(new Error("cancelled fixture"));
		await assert.rejects(promise, /cancelled fixture/);
		finish(lateReject ? new Error("late DNS failure") : [{ address: "93.184.216.34", family: 4 }]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(connects, 0); // node:test also fails on any unhandledRejection.
	});
}
