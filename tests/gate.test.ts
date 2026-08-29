import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isBlockedIPv4,
	isBlockedIPv6,
	isPassthroughRequestUrl,
	looksLikeNonCanonicalIp,
	validateBrowserUrl,
} from "../gate.ts";

test("blocks loopback and RFC1918 IPv4", () => {
	assert.equal(isBlockedIPv4("127.0.0.1"), true);
	assert.equal(isBlockedIPv4("10.0.0.1"), true);
	assert.equal(isBlockedIPv4("192.168.1.1"), true);
	assert.equal(isBlockedIPv4("172.16.0.1"), true);
	assert.equal(isBlockedIPv4("169.254.169.254"), true);
	assert.equal(isBlockedIPv4("0.0.0.0"), true);
	assert.equal(isBlockedIPv4("8.8.8.8"), false);
});

test("blocks IPv6 loopback and ULA", () => {
	assert.equal(isBlockedIPv6("::1"), true);
	assert.equal(isBlockedIPv6("fc00::1"), true);
	assert.equal(isBlockedIPv6("fe80::1"), true);
	assert.equal(isBlockedIPv6("::ffff:127.0.0.1"), true);
	assert.equal(isBlockedIPv6("2001:4860:4860::8888"), false);
});

test("non-canonical IP hostnames detected", () => {
	assert.equal(looksLikeNonCanonicalIp("2130706433"), true);
	assert.equal(looksLikeNonCanonicalIp("0x7f000001"), true);
	assert.equal(looksLikeNonCanonicalIp("example.com"), false);
});

test("validateBrowserUrl rejects credentials, file, localhost, dword IP", async () => {
	await assert.rejects(() => validateBrowserUrl("file:///etc/passwd"), /Blocked URL scheme/);
	await assert.rejects(() => validateBrowserUrl("javascript:alert(1)"), /Blocked URL scheme/);
	await assert.rejects(() => validateBrowserUrl("chrome://settings"), /Blocked URL scheme/);
	await assert.rejects(() => validateBrowserUrl("http://user:pass@example.com/"), /credentials/);
	await assert.rejects(() => validateBrowserUrl("http://localhost/"), /internal hostname/);
	await assert.rejects(() => validateBrowserUrl("http://127.0.0.1/"), /internal address/);
	await assert.rejects(() => validateBrowserUrl("http://169.254.169.254/latest"), /internal address/);
	await assert.rejects(() => validateBrowserUrl("http://2130706433/"), /internal address/);
	await assert.rejects(() => validateBrowserUrl("http://metadata.google.internal/"), /internal hostname/);
});

test("validateBrowserUrl rejects DNS to private IP", async () => {
	await assert.rejects(
		() => validateBrowserUrl("https://evil.example", {
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		}),
		/internal address/,
	);
});

test("validateBrowserUrl allows public DNS", async () => {
	const url = await validateBrowserUrl("https://example.com/path", {
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
	});
	assert.equal(url.hostname, "example.com");
});

test("about:blank allowed; websocket only when opted in", async () => {
	assert.equal((await validateBrowserUrl("about:blank")).href, "about:blank");
	await assert.rejects(() => validateBrowserUrl("wss://example.com/socket"), /Blocked URL scheme/);
	const ws = await validateBrowserUrl("wss://example.com/socket", {
		allowWebSocket: true,
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
	});
	assert.equal(ws.protocol, "wss:");
});

test("passthrough request urls", () => {
	assert.equal(isPassthroughRequestUrl("about:blank"), true);
	assert.equal(isPassthroughRequestUrl("blob:https://example.com/1"), true);
	assert.equal(isPassthroughRequestUrl("data:text/plain,hi"), true);
	assert.equal(isPassthroughRequestUrl("https://example.com/"), false);
});
