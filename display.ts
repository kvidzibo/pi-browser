import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DISPLAY_MODE_SET, type DisplayMode, XVFB_SCREEN } from "./constants.ts";

export type XvfbHandle = {
	proc: ChildProcess;
	display: string;
	pid: number;
};

export function xvfbAvailable(): boolean {
	return existsSync("/usr/bin/Xvfb") || existsSync("/usr/X11/bin/Xvfb");
}

export function detectDefaultMode(): DisplayMode {
	if (process.platform === "linux" && xvfbAvailable()) return "xvfb";
	return "headless";
}

export function parseDisplayMode(raw: string): DisplayMode {
	const mode = raw.trim();
	if (!DISPLAY_MODE_SET.has(mode)) throw new Error("mode must be xvfb, headless, or host");
	return mode as DisplayMode;
}

export function resolveMode(configured: DisplayMode | "auto"): DisplayMode {
	return configured === "auto" ? detectDefaultMode() : configured;
}

function readDisplayFd(proc: ChildProcess, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Xvfb did not report a display number"));
		}, timeoutMs);
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			const text = Buffer.concat(chunks).toString("utf8");
			const line = text.split(/\r?\n/)[0];
			if (!line) return;
			const display = line.trim();
			if (!/^\d+$/.test(display)) {
				cleanup();
				reject(new Error(`Xvfb returned invalid display: ${display}`));
				return;
			}
			cleanup();
			resolve(`:${display}`);
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(new Error(`Xvfb exited before ready (code ${code ?? "?"})`));
		};
		const cleanup = () => {
			clearTimeout(timer);
			proc.stdout?.off("data", onData);
			proc.off("exit", onExit);
		};
		proc.stdout?.on("data", onData);
		proc.on("exit", onExit);
	});
}

export async function startXvfb(): Promise<XvfbHandle> {
	if (!xvfbAvailable()) throw new Error("Xvfb not found. Install xvfb or /browser mode headless");
	const proc = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", XVFB_SCREEN, "-nolisten", "tcp"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (!proc.pid) {
		proc.kill("SIGKILL");
		throw new Error("Failed to spawn Xvfb");
	}
	try {
		const display = await readDisplayFd(proc, 5000);
		return { proc, display, pid: proc.pid };
	} catch (err) {
		proc.kill("SIGKILL");
		throw err;
	}
}

export async function stopXvfb(handle: XvfbHandle | undefined, graceMs: number): Promise<void> {
	if (!handle?.pid) return;
	await killPid(handle.pid, graceMs);
}

export async function killPid(pid: number, graceMs: number): Promise<void> {
	try {
		process.kill(pid, 0);
	} catch {
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
			await new Promise((r) => setTimeout(r, 50));
		} catch {
			return;
		}
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

export function cmdlineOf(pid: number): string | undefined {
	try {
		if (!existsSync(`/proc/${pid}/cmdline`)) return undefined;
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
	} catch {
		return undefined;
	}
}
