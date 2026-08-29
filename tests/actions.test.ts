import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAction } from "../actions.ts";

test("rejects unknown action", () => {
	assert.throws(() => validateAction({ action: "evaluate" }), /Unknown action/);
});

test("navigate requires url", () => {
	assert.throws(() => validateAction({ action: "navigate" }), /url is required/);
	assert.deepEqual(validateAction({ action: "navigate", url: "https://example.com" }), {
		action: "navigate",
		url: "https://example.com",
	});
});

test("click/type/select require refs", () => {
	assert.throws(() => validateAction({ action: "click" }), /ref is required/);
	assert.throws(() => validateAction({ action: "type", ref: "r1e1" }), /text is required/);
	assert.deepEqual(validateAction({ action: "click", ref: "r1e1" }), { action: "click", ref: "r1e1" });
	assert.deepEqual(validateAction({ action: "type", ref: "r1e1", text: "hi" }), {
		action: "type",
		ref: "r1e1",
		text: "hi",
	});
});

test("tabs requires tabAction", () => {
	assert.throws(() => validateAction({ action: "tabs" }), /tabAction/);
	assert.deepEqual(validateAction({ action: "tabs", tabAction: "list" }), { action: "tabs", tabAction: "list" });
	assert.throws(() => validateAction({ action: "tabs", tabAction: "switch" }), /tabId is required/);
});

test("wait bounds", () => {
	assert.throws(() => validateAction({ action: "wait", timeoutMs: 99_999 }), /timeoutMs/);
	assert.deepEqual(validateAction({ action: "wait" }), { action: "wait", timeoutMs: 1000 });
});
