// Real Pi TUI components, synthetic session/import only. Loaded by load.test.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as ui from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { requestCookieAccessWithUI } from "../cookie-access.ts";

export default function fixture(pi: ExtensionAPI) {
	pi.registerTool({
		name: "cookie_consent_fixture", label: "Synthetic consent", description: "Test-only cookie permission UI",
		parameters: Type.Object({ keys: Type.Array(Type.String()), large: Type.Optional(Type.Boolean()) }),
		async execute(_id, params: any) {
			const origins = Array.from({ length: params.large ? 8 : 1 }, (_, i) => `https://93.184.216.${34 + i}`);
			const cookieNames = params.large ? Array.from({ length: 32 }, (_, i) => "X".repeat(254) + String(i).padStart(2, "0")) : ["SID"];
			const controller = new AbortController();
			const keybindings = new ui.KeybindingsManager(ui.TUI_KEYBINDINGS, params.remap ? {
				"tui.select.confirm": "alt+enter", "tui.select.cancel": "alt+q", "tui.select.pageDown": "alt+j",
			} : undefined);
			let width = params.width ?? 80, rows = params.rows ?? 24, imported: unknown, completed = false;
			const frames: Array<{ width: number; rows: number; lines: string[]; widths: number[] }> = [];
			const viewed = new Map<number, string>();
			let totalLines = 0;
			const result = await requestCookieAccessWithUI({
				closeBrowser: async () => "closed", clearGrants: async () => {},
				importChromiumCookies: async (approvedOrigins, options) => { imported = { origins: approvedOrigins, cookieNames: options?.cookieNames }; return 1; },
			}, { mode: "tui", hasUI: true, ui: {
				custom: async (factory: any) => {
					if (params.unsupported) return undefined;
					return new Promise<boolean>((resolve) => {
						let component: ui.Component;
						const draw = () => {
							const lines = component.render(width);
							frames.push({ width, rows, lines, widths: lines.map(ui.visibleWidth) });
							const marker = lines.find((line) => /^Lines \d+-\d+ of \d+$/.test(line));
							if (marker) {
								const [start, end, total] = marker.match(/\d+/g)!.map(Number); totalLines = total;
								for (let n = start; n <= end; n++) viewed.set(n, lines[1 + n - start]);
							}
						};
						component = factory({ terminal: { get rows() { return rows; } }, requestRender: () => draw() },
							{ fg: (_color: string, text: string) => text, bold: (text: string) => text }, keybindings,
							(approved: boolean) => { completed = true; resolve(approved); });
						draw();
						for (const key of params.keys) {
							if (completed) break;
							if (key === "abort") controller.abort("synthetic-private-reason");
							else if (key.startsWith("resize:")) { [, width, rows] = key.split(":").map(Number); draw(); }
							else if (key === "read-all") {
								for (let n = 0; n < 400; n++) {
									if (frames.at(-1)!.lines.some((line) => line.includes("Full request displayed"))) break;
									if (n === 399) throw new Error("Could not review all request pages");
									component.handleInput!(params.remap ? "\x1bj" : "\x1b[6~");
								}
							} else component.handleInput!(key);
						}
						if (!completed) throw new Error("Fixture keys did not finish the approval dialog");
					});
				},
			} } as any, { origins, cookieNames }, controller.signal);
			return { content: [{ type: "text", text: "Synthetic cookie consent exercised" }],
				details: { result, imported, origins, cookieNames, frames, totalLines, viewedLines: viewed.size,
					viewedText: [...viewed].sort(([a], [b]) => a - b).map(([, text]) => text).join("") } };
		},
	});
}
