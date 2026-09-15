import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUntrustedSnapshot, parseAgentRef, prefixRefs, SnapshotCache } from "../snapshot.ts";

test("prefixRefs rewrites playwright refs", () => {
	const yaml = '- heading "Example" [ref=e1]\n- link "More" [ref=e2]';
	assert.equal(prefixRefs(yaml, 3), '- heading "Example" [ref=r3e1]\n- link "More" [ref=r3e2]');
});

test("parseAgentRef rejects stale and malformed refs", () => {
	assert.deepEqual(parseAgentRef("r3e12", 3), { playwrightRef: "e12" });
	assert.throws(() => parseAgentRef("e12", 3), /Invalid ref/);
	assert.throws(() => parseAgentRef("r2e12", 3), /Stale ref/);
	assert.throws(() => parseAgentRef("css=div", 3), /Invalid ref/);
});

test("snapshot pagination returns all lines without changing revision", () => {
	const cache = new SnapshotCache();
	cache.set(7, Array.from({ length: 650 }, (_, i) => `- button \"item-${i}\" [ref=r7e${i}]`).join("\n"));
	let offset: number | undefined = 1, count = 0;
	while (offset !== undefined) {
		const page = cache.read(7, offset, 200);
		assert.match(page.content, /UNTRUSTED PAGE CONTENT/);
		assert.ok(Buffer.byteLength(page.content) < 50 * 1024);
		count += (page.content.match(/- button/g) ?? []).length;
		assert.equal(page.details.snapshot, 7);
		offset = page.details.nextOffset;
	}
	assert.equal(count, 650);
	assert.throws(() => cache.read(8), /Stale/);
	assert.throws(() => cache.read(7, 651), /range/);
	cache.clear(); assert.throws(() => cache.read(7), /Stale/);
});

test("secrets are redacted before long-line wrapping can split a cookie value", () => {
	const cache = new SnapshotCache(), secret = "fixture-cookie-secret-hidden";
	cache.set(12, "x".repeat(3993) + secret, [secret]);
	const page = cache.read(12);
	assert.match(page.content, /\[redacted\]/);
	assert.ok(!page.content.includes("secret-hidden"));
});

test("oversized UTF-8 lines remain fully reachable and pages stay byte bounded", () => {
	const cache = new SnapshotCache(), source = "😀".repeat(50_000);
	cache.set(9, source);
	let offset: number | undefined = 1, reconstructed = "";
	while (offset !== undefined) {
		const page = cache.read(9, offset, 1000);
		assert.ok(Buffer.byteLength(page.content) < 50 * 1024);
		reconstructed += page.content.split("\n\n")[1].replaceAll("\n", "");
		offset = page.details.nextOffset;
	}
	assert.equal(reconstructed, source);
	assert.throws(() => cache.set(10, "x".repeat(4 * 1024 * 1024 + 1)), /4 MiB/);
});

test("snapshot output marked untrusted", () => {
	const text = formatUntrustedSnapshot({
		revision: 1,
		url: "https://example.com/",
		title: "Example",
		tabs: "t1 (active)",
		yaml: '- heading "Example" [ref=e1]',
	});
	assert.match(text, /UNTRUSTED PAGE CONTENT/);
	assert.match(text, /\[ref=r1e1\]/);
	assert.match(text, /snapshot: r1/);
});
