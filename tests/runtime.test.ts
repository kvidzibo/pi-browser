import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeState } from "../runtime.ts";
import { RUN_DIR_NAME } from "../constants.ts";

// A test-owned Node child with Chromium-like argv, never a real browser or user's process.
test("stale cleanup requires an exact profile argument and the original process start time", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-browser-reaper-"));
	const profile = join(directory, "browser-profiles", "applications", "user-data");
	const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`], {
		argv0: "chromium-runtime-fixture", stdio: ["ignore", "pipe", "ignore"], env: {},
	});
	const exited = once(child, "exit");
	try {
		await once(child.stdout!, "data");
		const runtime = new RuntimeState(directory);
		runtime.write({}, profile);
		const runDirectory = join(directory, RUN_DIR_NAME);
		const path = join(runDirectory, (await readdir(runDirectory))[0]);
		const state = JSON.parse(await readFile(path, "utf8"));
		assert.equal(state.browserPid, child.pid);
		assert.match(state.browserStartTime, /^\d+$/);
		const stale = { ...state, ownerPid: 2_147_483_647 };
		for (const record of [
			{ ...stale, userDataDir: join(directory, "browser-profile") },
			{ ...stale, browserStartTime: undefined },
			{ ...stale, browserStartTime: "0" },
		]) {
			await writeFile(path, JSON.stringify(record));
			await runtime.reap();
			assert.equal(child.exitCode, null, "another live browser must not be terminated");
			process.kill(child.pid!, 0);
		}
		await writeFile(path, JSON.stringify(stale));
		await runtime.reap();
		await exited;
		assert.equal(child.signalCode, "SIGTERM", "verified orphan process is still cleaned up");
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		await rm(directory, { recursive: true, force: true });
	}
});
