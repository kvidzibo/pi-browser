// Loaded only by load.test.ts through Pi's real peer-aware extension loader.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as ui from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createSitePicker, pickCookieSites, type SitePickerResult } from "../site-picker.ts";

const sites = [
	{ origin: "https://accounts.google.com", label: "Google sign-in" },
	{ origin: "https://github.com", label: "https://github.com" },
	{ origin: "https://mail.google.com", label: "Gmail" },
	...Array.from({ length: 80 }, (_, i) => ({ origin: `https://site-${i}.long-domain.example.test`, label: `https://site-${i}.long-domain.example.test` })),
];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

export default function fixture(pi: ExtensionAPI) {
	pi.registerTool({
		name: "site_picker_fixture", label: "Synthetic picker", description: "Test-only picker harness",
		parameters: Type.Object({ keys: Type.Array(Type.String()) }),
		async execute(_id, params: any) {
			const keybindings = new ui.KeybindingsManager(ui.TUI_KEYBINDINGS, params.remap ? {
				"tui.select.confirm": "alt+enter", "tui.select.down": "alt+j",
			} : undefined);
			const frames: Array<{ width: number; lines: string[]; widths: number[] }> = [];
			const frame = (component: any, width = 80) => {
				const lines = component.render(width); frames.push({ width, lines, widths: lines.map(ui.visibleWidth) });
			};
			let completed = false, result: SitePickerResult | undefined;
			const component = createSitePicker(sites, [], ui, theme, keybindings,
				(value) => { completed = true; result = value; }, () => {}, () => 3);
			component.focused = true;
			frame(component);
			for (const key of params.keys) {
				if (key === "mouse:first") {
					component.handleMouse?.({ type: "press", button: "left", x: 3, y: 4 } as any);
					component.handleMouse?.({ type: "click", button: "left", x: 3, y: 4 } as any);
				} else component.handleInput?.(key);
				frame(component);
			}
			for (const width of [1, 7, 8, 20, 40, 80]) frame(component, width);
			let manualResult: string[] | undefined;
			const notifications: string[] = [];
			let rounds = 0;
			if (params.rounds) {
				const inputs = [...(params.inputs ?? [])];
				manualResult = await pickCookieSites(sites, { mode: "tui", ui: {
					custom: async (factory: any) => {
						let output: SitePickerResult | undefined, done = false;
						const picker = factory({ terminal: { rows: 24 }, requestRender: () => {} }, theme, keybindings,
							(value: SitePickerResult | undefined) => { done = true; output = value; });
						frame(picker);
						for (const key of params.rounds[rounds++] ?? []) { picker.handleInput(key); frame(picker); }
						if (!done) throw new Error("Fixture did not finish its picker round");
						return output;
					},
					input: async () => inputs.shift() ?? undefined,
					notify: (message: string) => notifications.push(message),
				} } as any);
			}
			return { content: [{ type: "text", text: "Synthetic picker exercised" }],
				details: { completed, result: result ?? null, focused: component.focused, frames, manualResult: manualResult ?? null, rounds, notifications } };
		},
	});
}
