import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager } from "@earendil-works/pi-tui";

type ConsentUI = Pick<typeof import("@earendil-works/pi-tui"), "Text" | "SelectList" | "truncateToWidth">;
type ConsentTheme = { fg: (color: "accent" | "dim" | "warning", text: string) => string; bold: (text: string) => string };

/** A normal Yes/No choice with bounded, scrollable access details. */
export function createCookieConsent(
	title: string, body: string, ui: ConsentUI, theme: ConsentTheme,
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">,
	done: (approved: boolean) => void, requestRender: () => void, terminalRows: () => number,
): Component {
	const text = new ui.Text(body, 0, 0);
	const choices = new ui.SelectList([{ value: "no", label: "No" }, { value: "yes", label: "Yes" }], 2, {
		selectedPrefix: (value) => theme.fg("accent", value), selectedText: (value) => theme.fg("accent", value),
		description: (value) => theme.fg("dim", value), scrollInfo: (value) => theme.fg("dim", value),
		noMatch: (value) => theme.fg("warning", value),
	});
	let lines: string[] = [], offset = 0, pageRows = 1;
	let previousWidth = 0, previousRows = 0, readable = false, finished = false;
	const finish = (approved: boolean) => { if (!finished) { finished = true; done(approved); } };
	const move = (delta: number) => { offset = Math.max(0, Math.min(Math.max(0, lines.length - pageRows), offset + delta)); };
	const keyLabels: Record<string, string> = { up: "↑", down: "↓", pageUp: "PgUp", pageDown: "PgDn", enter: "Enter", escape: "Esc" };
	const keys = (id: `tui.select.${"up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel"}`) => {
		// One configured shortcut per action keeps the controls legible in a narrow terminal.
		const key = keybindings.getKeys(id)[0] ?? "unbound";
		return keyLabels[key] ?? key;
	};
	return {
		render(width) {
			const rows = Math.max(1, Math.floor(terminalRows()));
			if (width !== previousWidth || rows !== previousRows) {
				previousWidth = width; previousRows = rows; offset = 0; choices.setSelectedIndex(0);
			}
			readable = width >= 40 && rows >= 13;
			if (!readable) return ["Resize to 40 columns / 13 rows to review.", `${keys("tui.select.cancel")} cancels; approval is disabled.`]
				.slice(0, rows).map((line) => ui.truncateToWidth(line, width));
			// Leave six terminal rows for Pi's own footer/editor framing.
			pageRows = Math.max(1, Math.min(16, rows - 11));
			lines = text.render(width);
			move(0);
			const visible = lines.slice(offset, offset + pageRows);
			const output = [theme.fg("accent", theme.bold(title)), ...visible,
				theme.fg("dim", `Lines ${offset + 1}-${offset + visible.length} of ${lines.length} · ${keys("tui.select.pageUp")}/${keys("tui.select.pageDown")} details`),
				...choices.render(width),
				theme.fg("dim", `${keys("tui.select.up")}/${keys("tui.select.down")} choose · ${keys("tui.select.confirm")} confirm · ${keys("tui.select.cancel")} cancel`)];
			return output.map((line) => ui.truncateToWidth(line, width));
		},
		invalidate() { text.invalidate(); choices.invalidate(); },
		handleInput(data) {
			if (finished) return;
			if (keybindings.matches(data, "tui.select.cancel")) finish(false);
			else if (keybindings.matches(data, "tui.select.confirm")) finish(readable && previousRows === terminalRows() && choices.getSelectedItem()?.value === "yes");
			// SelectList uses global input bindings; honor the manager injected by this UI instead.
			else if (readable && (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down"))) {
				choices.setSelectedIndex(choices.getSelectedItem()?.value === "no" ? 1 : 0);
			}
			else if (keybindings.matches(data, "tui.select.pageUp")) move(-pageRows);
			else if (keybindings.matches(data, "tui.select.pageDown")) move(pageRows);
			requestRender();
		},
	};
}

export async function confirmCookieAccessWithUI(ctx: ExtensionContext, title: string, body: string, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return false;
	if (ctx.mode !== "tui") return (await ctx.ui.confirm(title, body, { signal })) === true;
	const ui = await import("@earendil-works/pi-tui");
	if (signal?.aborted) return false;
	let onAbort: (() => void) | undefined;
	try {
		const approved = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
			let finished = false;
			const finish = (value: boolean) => { if (!finished) { finished = true; done(value); } };
			const component = createCookieConsent(title, body, ui, theme, keybindings, finish, () => tui.requestRender(), () => tui.terminal.rows);
			onAbort = () => finish(false);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) queueMicrotask(onAbort);
			return component;
		});
		return approved === true && !signal?.aborted;
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}
