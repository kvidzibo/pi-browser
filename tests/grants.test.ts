import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGrantedRequest, originAllowed, originOf, parseGrantOrigins } from "../grants.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("originOf uses scheme+host+port", () => {
	assert.equal(originOf("https://Example.com/foo"), "https://example.com");
});

test("originAllowed is exact origin", () => {
	assert.equal(originAllowed("https://github.com/a", ["https://github.com"]), true);
	assert.equal(originAllowed("https://gist.github.com/", ["https://github.com"]), false);
	assert.equal(originAllowed("http://github.com/", ["https://github.com"]), false);
});

test("parseGrantOrigins validates and dedupes", async () => {
	const origins = await parseGrantOrigins("github.com, https://github.com/foo", publicLookup);
	assert.deepEqual(origins, ["https://github.com"]);
});

test("parseGrantOrigins rejects private hosts", async () => {
	await assert.rejects(
		() => parseGrantOrigins("http://127.0.0.1", publicLookup),
		/internal address/,
	);
});

test("classifyGrantedRequest aborts ungranted documents and strips cookies on subresources", () => {
	const grants = ["https://github.com"];
	assert.equal(classifyGrantedRequest("https://github.com/a", grants, "document"), "allow");
	assert.equal(classifyGrantedRequest("https://evil.example/", grants, "document"), "abort");
	assert.equal(classifyGrantedRequest("https://evil.example/cdn.js", grants, "script"), "strip-cookie");
	assert.equal(classifyGrantedRequest("https://evil.example/", [], "document"), "allow");
});
