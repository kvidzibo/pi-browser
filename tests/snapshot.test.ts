import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUntrustedSnapshot, parseAgentRef, prefixRefs } from "../snapshot.ts";

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
