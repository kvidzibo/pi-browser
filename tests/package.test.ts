import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("npm package includes every local runtime module and the extension entrypoint", () => {
	const cache = mkdtempSync(join(tmpdir(), "pi-browser-pack-check-"));
	try {
		const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
			cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: cache, npm_config_offline: "true" },
		})) as { files: { path: string }[] }[];
		const paths = new Set(result[0].files.map((file) => file.path));
		assert.ok(paths.has("index.ts")); assert.ok(paths.has("README.md"));
		for (const file of paths) {
			assert.ok(!file.startsWith("tests/") && file !== "MEMORY.md");
			if (!file.endsWith(".ts")) continue;
			const source = readFileSync(join(root, file), "utf8");
			for (const match of source.matchAll(/["'](\.\.?\/[^"']+\.ts)["']/g)) {
				const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
				assert.ok(paths.has(target), `${file} requires unpacked module ${target}`);
			}
		}
	} finally { rmSync(cache, { recursive: true, force: true }); }
});
