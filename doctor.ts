import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { findBrowser } from "./browser-bin.ts";
import { resolveMode, xvfbAvailable } from "./display.ts";
import type { DisplayMode } from "./constants.ts";
import { agentDir } from "./runtime.ts";

export function supportedNode(version: string): boolean {
	const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
	return major > 22 || major === 22 && minor >= 19;
}

/** Local capability checks only: no launches, network requests, cookie inventory or keyring access. */
export async function browserDoctor(options: {
	mode?: DisplayMode; network?: string; nodeVersion?: string; directory?: string;
	find?: typeof findBrowser; xvfb?: () => boolean;
} = {}): Promise<string> {
	const version = options.nodeVersion ?? process.version;
	const lines = [`Node: ${version} (${supportedNode(version) ? "supported" : "requires Node >=22.19.0"})`,
		`Mode: ${options.mode ?? resolveMode("auto")}`, `Xvfb: ${(options.xvfb ?? xvfbAvailable)() ? "available" : "not found; use headless"}`];
	try {
		const binary = await (options.find ?? findBrowser)();
		if (!(await stat(binary.executablePath)).isFile()) throw new Error("not a file");
		await access(binary.executablePath, constants.X_OK);
		lines.push(`Browser: executable (${binary.source}) ${binary.executablePath}`);
	} catch { lines.push("Browser: unavailable or not executable. Install Chromium/Chrome or check PI_BROWSER_EXECUTABLE."); }
	lines.push(`Agent directory: ${options.directory ?? agentDir()}`,
		`Network failures (current/last action): ${options.network ?? "none recorded"}`,
		"No browser was launched; cookies and the desktop keyring were not inspected.");
	return lines.join("\n");
}
