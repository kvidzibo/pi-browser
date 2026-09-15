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

test("snapshot continuation and screenshot attachment parameters are bounded", () => {
	assert.throws(() => validateAction({ action: "snapshot", offset: 2 }), /snapshotId/);
	for (const limit of [0, 1001, 1.5]) assert.throws(() => validateAction({ action: "snapshot", limit }), /limit/);
	assert.throws(() => validateAction({ action: "snapshot", snapshotId: 1, depth: 3 }), /fresh snapshot/);
	assert.throws(() => validateAction({ action: "snapshot", depth: 31 }), /depth/);
	assert.deepEqual(validateAction({ action: "snapshot", snapshotId: 2, offset: 201, limit: 100 }),
		{ action: "snapshot", snapshotId: 2, offset: 201, limit: 100, depth: undefined });
	assert.deepEqual(validateAction({ action: "screenshot", image: true }), { action: "screenshot", image: true });
});

test("wait bounds", () => {
	assert.throws(() => validateAction({ action: "wait", timeoutMs: 99_999 }), /timeoutMs/);
	assert.deepEqual(validateAction({ action: "wait" }), { action: "wait", timeoutMs: 1000 });
});
