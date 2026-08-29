import assert from "node:assert/strict";
import { test } from "node:test";
import { redactUrl, sanitizeWithSecrets } from "../redact.ts";

test("redacts sensitive query keys and userinfo", () => {
	assert.equal(
		redactUrl("https://user:pass@example.com/x?token=abc&q=1"),
		"https://example.com/x?token=REDACTED&q=1",
	);
	assert.equal(redactUrl("https://example.com/x?q=1"), "https://example.com/x?q=1");
});

test("sanitizeWithSecrets redacts cookie values and urls", () => {
	const text = "cookie=supersecretvalue title https://ex.com/?token=abc";
	const out = sanitizeWithSecrets(text, ["supersecretvalue"]);
	assert.equal(out.includes("supersecretvalue"), false);
	assert.match(out, /\[redacted\]/);
	assert.match(out, /token=REDACTED/);
});

test("sanitizeWithSecrets ignores secrets shorter than 6 chars", () => {
	assert.equal(sanitizeWithSecrets("id=ab12", ["ab12"]), "id=ab12");
});
