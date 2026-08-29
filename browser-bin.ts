import { existsSync } from "node:fs";
import { delimiter } from "node:path";

const PATH_NAMES = [
	"google-chrome-stable",
	"google-chrome",
	"chrome",
	"microsoft-edge",
	"msedge",
	"chromium",
	"chromium-browser",
];

const KNOWN_PATHS = [
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
	"/usr/bin/microsoft-edge",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export type BrowserBinary = {
	executablePath: string;
	source: "env" | "playwright" | "path" | "known";
};

function which(name: string, pathEnv: string): string | undefined {
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const candidate = `${dir.replace(/[/\\]$/, "")}/${name}`;
		if (existsSync(candidate)) return candidate;
		if (process.platform === "win32" && existsSync(`${candidate}.exe`)) return `${candidate}.exe`;
	}
	return undefined;
}

export async function playwrightChromiumPath(): Promise<string | undefined> {
	try {
		const { chromium } = await import("patchright-core");
		const path = chromium.executablePath();
		if (path && existsSync(path)) return path;
	} catch {
		// patchright browsers not installed
	}
	return undefined;
}

export async function findBrowser(
	env: NodeJS.ProcessEnv = process.env,
	options: { skipPlaywright?: boolean; knownPaths?: string[] } = {},
): Promise<BrowserBinary> {
	const fromEnv = env.PI_BROWSER_EXECUTABLE?.trim();
	if (fromEnv) {
		if (!existsSync(fromEnv)) throw new Error(`PI_BROWSER_EXECUTABLE not found: ${fromEnv}`);
		return { executablePath: fromEnv, source: "env" };
	}

	const pathEnv = env.PATH ?? "";
	for (const name of PATH_NAMES) {
		const found = which(name, pathEnv);
		if (found) return { executablePath: found, source: "path" };
	}

	for (const known of options.knownPaths ?? KNOWN_PATHS) {
		if (existsSync(known)) return { executablePath: known, source: "known" };
	}

	if (!options.skipPlaywright) {
		const playwrightPath = await playwrightChromiumPath();
		if (playwrightPath) return { executablePath: playwrightPath, source: "playwright" };
	}

	throw new Error(
		"No Chromium/Chrome found. Install Google Chrome or Chromium, set PI_BROWSER_EXECUTABLE, or run: npx patchright install chromium",
	);
}
