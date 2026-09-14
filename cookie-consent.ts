import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager } from "@earendil-works/pi-tui";

type ConsentUI = Pick<typeof import("@earendil-works/pi-tui"), "Text" | "matchesKey" | "truncateToWidth">;
type ConsentTheme = { fg: (color: "accent" | "dim" | "warning", text: string) => string; bold: (text: string) => string };

/** Bounded, scrollable disclosure. Never hide destinations above an unscrollable Yes button. */
export function createCookieConsent(
	title: string, body: string, ui: ConsentUI, theme: ConsentTheme,
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">,
	done: (approved: boolean) => void, requestRender: () => void, terminalRows: () => number,
): Component {
	const text = new ui.Text(body, 0, 0);
	let lines: string[] = [], offset = 0, pageRows = 1, reviewedThrough = 0;
	let previousWidth = 0, previousRows = 0, readable = false, allowSelected = false, finished = false;
	const finish = (approved: boolean) => { if (!finished) { finished = true; done(approved); } };
	const ready = () => readable && lines.length > 0 && reviewedThrough >= lines.length;
	const move = (delta: number) => { offset = Math.max(0, Math.min(Math.max(0, lines.length - pageRows), offset + delta)); };
	const keys = (id: "tui.select.pageUp" | "tui.select.pageDown" | "tui.select.confirm" | "tui.select.cancel") => keybindings.getKeys(id).join("/");
	return {
		render(width) {
			const rows = Math.max(1, Math.floor(terminalRows()));
			if (width !== previousWidth || rows !== previousRows) {
				previousWidth = width; previousRows = rows; offset = reviewedThrough = 0; allowSelected = false;
			}
			readable = width >= 40 && rows >= 13;
			if (!readable) return ["Resize to 40 columns / 13 rows to review.", `${keys("tui.select.cancel")} cancels; approval is disabled.`]
				.slice(0, rows).map((line) => ui.truncateToWidth(line, width));
			// Leave six terminal rows for Pi's own footer/editor framing.
			pageRows = Math.max(1, Math.min(16, rows - 11));
			lines = text.render(width);
			move(0);
			const visible = lines.slice(offset, offset + pageRows);
			// Only contiguous displayed pages count. Skipping ahead cannot unlock approval.
			if (offset <= reviewedThrough) reviewedThrough = Math.max(reviewedThrough, offset + visible.length);
			const output = [theme.fg("accent", theme.bold(title)), ...visible,
				...Array(Math.max(0, pageRows - visible.length)).fill(""),
				theme.fg("dim", `Lines ${offset + 1}-${offset + visible.length} of ${lines.length}`),
				ready() ? theme.fg("dim", "Full request displayed. Choose Deny or Allow.") : theme.fg("warning", "Read all pages to enable Allow."),
				`${allowSelected ? "  " : "> "}Deny    ${allowSelected ? "> " : "  "}Allow${ready() ? "" : " (disabled)"}`,
				theme.fg("dim", `${keys("tui.select.pageUp")}/${keys("tui.select.pageDown")} scroll · Tab choose · ${keys("tui.select.confirm")} confirm · ${keys("tui.select.cancel")} cancel`)];
			return output.map((line) => ui.truncateToWidth(line, width));
		},
		invalidate() { text.invalidate(); },
		handleInput(data) {
			if (finished) return;
			if (keybindings.matches(data, "tui.select.cancel")) finish(false);
			else if (keybindings.matches(data, "tui.select.confirm")) finish(allowSelected && ready());
			else if (ui.matchesKey(data, "tab") || ui.matchesKey(data, "shift+tab")) { if (ready()) allowSelected = !allowSelected; }
			else if (keybindings.matches(data, "tui.select.up")) move(-1);
			else if (keybindings.matches(data, "tui.select.down")) move(1);
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
