import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDisplayMode } from "../display.ts";

test("parseDisplayMode accepts known modes", () => {
	assert.equal(parseDisplayMode("xvfb"), "xvfb");
	assert.equal(parseDisplayMode("headless"), "headless");
	assert.equal(parseDisplayMode("host"), "host");
	assert.throws(() => parseDisplayMode("stealth"), /mode must be/);
});
