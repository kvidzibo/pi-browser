import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeState } from "../runtime.ts";
import { RUN_DIR_NAME } from "../constants.ts";

// A test-owned sleep executable named chromium, never a browser or user's process.
test("stale cleanup requires exact profile-lock ownership and the original process start time", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-browser-reaper-"));
	const profile = join(directory, "browser-profiles", "applications", "user-data");
	await mkdir(profile, { recursive: true });
	const executable = join(directory, "chromium-runtime-fixture");
	await copyFile("/bin/sleep", executable);
	const child = spawn(executable, ["1000"], { stdio: "ignore", env: {} });
	const spawned = once(child, "spawn"), exited = once(child, "exit");
	try {
		await spawned;
		await symlink(`${hostname()}-${child.pid}`, join(profile, "SingletonLock"));
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
