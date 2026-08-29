import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findBrowser } from "../browser-bin.ts";

test("findBrowser uses PI_BROWSER_EXECUTABLE", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-browser-"));
	const bin = join(dir, "chrome");
	writeFileSync(bin, "");
	chmodSync(bin, 0o755);
	const found = await findBrowser({ PI_BROWSER_EXECUTABLE: bin, PATH: "" });
	assert.equal(found.source, "env");
	assert.equal(found.executablePath, bin);
});

test("findBrowser searches PATH", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-browser-"));
	const bin = join(dir, "chromium");
	writeFileSync(bin, "");
	chmodSync(bin, 0o755);
	const found = await findBrowser({ PATH: dir }, { skipPlaywright: true, knownPaths: [] });
	assert.equal(found.source, "path");
	assert.equal(found.executablePath, bin);
});

test("findBrowser errors when nothing exists", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-browser-empty-"));
	mkdirSync(dir, { recursive: true });
	await assert.rejects(
		() => findBrowser({ PATH: dir }, { skipPlaywright: true, knownPaths: [] }),
		/No Chromium/,
	);
});
