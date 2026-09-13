import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const REPO = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(REPO, "package.json");

type LoadResult = {
	errors: Array<{ path: string; error: string }>;
	extensions: Array<{
		path: string;
		tools: Map<string, unknown>;
		handlers: Map<string, unknown>;
		commands: Map<string, any>;
	}>;
};

function resolvePiLoader(): string {
	const piBin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
	const dir = dirname(piBin);
	const candidates = [
		join(dir, "core", "extensions", "loader.js"),
		join(dir, "..", "core", "extensions", "loader.js"),
	];
	const loader = candidates.find((path) => existsSync(path));
	if (!loader) throw new Error(`Pi extension loader not found from ${piBin}`);
	return loader;
}

async function loadWithPi(paths: string[]): Promise<LoadResult> {
	const { loadExtensions } = await import(pathToFileURL(resolvePiLoader()).href);
	return loadExtensions(paths, REPO);
}

test("package manifest factory-loads browser tool without launching", async () => {
	const pkg = JSON.parse(readFileSync(MANIFEST, "utf8")) as { pi?: { extensions?: string[] } };
	assert.deepEqual(pkg.pi?.extensions, ["./index.ts"]);
	const paths = (pkg.pi?.extensions ?? []).map((rel) => join(REPO, rel));
	const result = await loadWithPi(paths);
	assert.deepEqual(
		result.errors,
		[],
		result.errors.map((item) => `${item.path}: ${item.error}`).join("\n"),
	);
	assert.equal(result.extensions.length, 1);
	assert.deepEqual([...result.extensions[0].tools.keys()], ["browser"]);
	const tool = (result.extensions[0].tools.get("browser") as any).definition;
	await assert.rejects(tool.execute("fixture", { action: "not-an-action" }), /Invalid|Unknown|Unsupported/i);
	assert.deepEqual([...result.extensions[0].commands.keys()], ["browser"]);
	const command = result.extensions[0].commands.get("browser");
	assert.ok(command.getArgumentCompletions("login").some((item: any) => item.value === "login --from-chromium"));
	const messages: string[] = [];
	const ctx = { hasUI: false, mode: "print", ui: { notify: (text: string) => messages.push(text) } };
	await command.handler("login --from-chromium", ctx);
	assert.deepEqual(messages, ["login needs interactive UI"]);
	messages.length = 0;
	await command.handler("login --from-chromium extra", { ...ctx, hasUI: true, mode: "tui" });
	assert.deepEqual(messages, ["Usage: /browser login [--from-chromium]"]);
});

test("native Pi multi-select UI: keyboard, filtering, scrolling, mouse, sizing and manual origins", async (t) => {
	const loaded = await loadWithPi([join(REPO, "tests", "site-picker.fixture.ts")]);
	assert.deepEqual(loaded.errors, []);
	const tool = (loaded.extensions[0].tools.get("site_picker_fixture") as any).definition;
	const run = async (params: any) => (await tool.execute("fixture", params)).details;
	const accounts = "https://accounts.google.com", github = "https://github.com", mail = "https://mail.google.com";
	for (const [name, params, expected] of [
		["filter with selections retained", { keys: [..."google", " ", "\x1b[B", " ", "\x15", ..."github", " ", "\r"] }, [accounts, github, mail]],
		["scrolling", { keys: [...Array(5).fill("\x1b[B"), " ", "\r"] }, ["https://site-2.long-domain.example.test"]],
		["injected keybindings", { keys: [" ", "\x1bj", " ", "\x1b\r"], remap: true }, [accounts, github]],
		["mouse checkbox", { keys: ["mouse:first", "\r"] }, [accounts]],
		["no match and cancel", { keys: [..."no-match", " ", "\r", "\x1b"] }, null],
	] as const) {
		await t.test(name, async () => {
			const result = await run(params);
			assert.equal(result.completed, true);
			assert.deepEqual(result.result?.origins ?? null, expected);
			assert.equal(result.focused, true);
			for (const frame of result.frames) {
				assert.ok(frame.widths.every((width: number) => width <= frame.width), `overflow at width ${frame.width}`);
				assert.ok(frame.lines.length <= 12, "visible list must stay bounded");
			}
		});
	}
	await t.test("empty selection cannot submit", async () => {
		const result = await run({ keys: [" ", " ", "\r"] });
		assert.equal(result.completed, false);
		assert.ok(result.frames.some((frame: any) => frame.lines.some((line: string) => line.includes("Check at least one"))));
	});
	await t.test("custom origins are added and selected before final approval", async () => {
		const result = await run({ keys: [], rounds: [[..."github", " ", "\x0e"], ["\r"]], inputs: ["https://93.184.216.34"] });
		assert.deepEqual(result.manualResult, ["https://93.184.216.34", github]);
		assert.equal(result.rounds, 2);
	});
	await t.test("invalid custom origins preserve earlier choices without granting private hosts", async () => {
		const result = await run({ keys: [], rounds: [[..."github", " ", "\x0e"], ["\r"]], inputs: ["http://127.0.0.1"] });
		assert.deepEqual(result.manualResult, [github]);
		assert.equal(result.notifications.length, 1);
	});
});
