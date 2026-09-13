import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeybindingsManager, SelectList, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { CookieSite } from "./chromium-import.ts";
import { parseGrantOrigins } from "./grants.ts";

type PickerUI = Pick<typeof import("@earendil-works/pi-tui"), "Input" | "SelectList" | "matchesKey" | "truncateToWidth">;
type PickerTheme = { fg: (color: "accent" | "dim" | "warning" | "muted", text: string) => string; bold: (text: string) => string };
export type SitePickerResult = { origins: string[]; manual: boolean };

/** Pure selection state: checkbox choices survive search and scrolling. No grants are made here. */
export class SiteSelection {
	readonly sites: CookieSite[];
	readonly checked: Set<string>;
	query = "";
	cursor = 0;
	visible: CookieSite[];

	constructor(sites: CookieSite[], selected: string[] = []) {
		this.sites = [...new Map(sites.map((site) => [site.origin, site])).values()];
		this.visible = this.sites;
		this.checked = new Set(selected.filter((origin) => this.sites.some((site) => site.origin === origin)));
	}
	filter(query: string): void {
		this.query = query;
		const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
		this.visible = this.sites.filter((site) => terms.every((term) => `${site.label} ${site.origin}`.toLowerCase().includes(term)));
		this.cursor = 0;
	}
	move(delta: number): void {
		if (!this.visible.length) return;
		this.cursor = (this.cursor + delta % this.visible.length + this.visible.length) % this.visible.length;
	}
	toggle(): void {
		const origin = this.visible[this.cursor]?.origin;
		if (!origin) return;
		if (this.checked.has(origin)) this.checked.delete(origin); else this.checked.add(origin);
	}
	selected(): string[] { return [...this.checked].sort(); }
}

export function createSitePicker(
	sites: CookieSite[], selected: string[], ui: PickerUI, theme: PickerTheme,
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">,
	done: (result: SitePickerResult | undefined) => void,
	requestRender: () => void,
	maxRows: () => number = () => 10,
): Component & Focusable {
	const state = new SiteSelection(sites, selected);
	const search = new ui.Input({ placeholder: "Type to filter cookie sites" });
	let list: SelectList;
	let rows = 0, listStart = 0, listEnd = 0, searchRow = 0;
	let error = "", finished = false;
	const finish = (value: SitePickerResult | undefined) => { if (!finished) { finished = true; done(value); } };
	const items = () => state.visible.map((site) => ({ value: site.origin,
		label: `[${state.checked.has(site.origin) ? "x" : " "}] ${site.label}`,
		description: site.label === site.origin ? undefined : site.origin,
	}));
	const rebuild = () => {
		rows = Math.max(1, Math.min(12, Math.floor(maxRows())));
		list = new ui.SelectList(items(), rows, {
			selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text),
			noMatch: () => theme.fg("warning", "  No matching sites. Ctrl+N adds an origin."),
		}, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 64 });
		list.setSelectedIndex(state.cursor);
		list.onSelectionChange = (item) => { state.cursor = state.visible.findIndex((site) => site.origin === item.value); };
		list.onSelect = (item) => {
			state.cursor = state.visible.findIndex((site) => site.origin === item.value);
			state.toggle(); error = ""; rebuild(); requestRender();
		};
	};
	rebuild();
	const keys = (id: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel") => keybindings.getKeys(id).join("/");

	return {
		get focused() { return search.focused; },
		set focused(value: boolean) { search.focused = value; },
		render(width) {
			if (width < 8) { listStart = listEnd = 0; return [ui.truncateToWidth("Widen terminal", width)]; }
			if (rows !== Math.max(1, Math.min(12, Math.floor(maxRows())))) rebuild();
			const lines = [theme.fg("accent", theme.bold("Choose Chromium cookie sites")),
				theme.fg("dim", "Cookie presence is not proof of a signed-in session.")];
			searchRow = lines.length;
			lines.push(...search.render(width), "");
			listStart = lines.length;
			lines.push(...list.render(width));
			listEnd = lines.length;
			lines.push("", error ? theme.fg("warning", error) : theme.fg("dim", `${state.checked.size} selected · ${state.visible.length}/${state.sites.length} shown`),
				theme.fg("dim", `${keys("tui.select.up")}/${keys("tui.select.down")} move · Space check · ${keys("tui.select.confirm")} continue · ${keys("tui.select.cancel")} cancel`),
				theme.fg("dim", "Ctrl+N add origins manually · Selection is retained while filtering"));
			return lines.map((line) => ui.truncateToWidth(line, width));
		},
		invalidate() { search.invalidate(); list.invalidate(); },
		handleInput(data) {
			if (finished) return;
			if (keybindings.matches(data, "tui.select.cancel")) finish(undefined);
			else if (keybindings.matches(data, "tui.select.confirm")) {
				if (state.checked.size) finish({ origins: state.selected(), manual: false });
				else error = "Check at least one site with Space, or Ctrl+N to add one.";
			} else if (ui.matchesKey(data, "ctrl+n")) finish({ origins: state.selected(), manual: true });
			else if (ui.matchesKey(data, "space")) { state.toggle(); error = ""; rebuild(); }
			else if (keybindings.matches(data, "tui.select.up")) { state.move(-1); list.setSelectedIndex(state.cursor); }
			else if (keybindings.matches(data, "tui.select.down")) { state.move(1); list.setSelectedIndex(state.cursor); }
			else if (keybindings.matches(data, "tui.select.pageUp")) { state.move(-rows); list.setSelectedIndex(state.cursor); }
			else if (keybindings.matches(data, "tui.select.pageDown")) { state.move(rows); list.setSelectedIndex(state.cursor); }
			else {
				const previous = search.getValue(); search.handleInput(data);
				if (search.getValue() !== previous) { state.filter(search.getValue()); error = ""; rebuild(); }
			}
			requestRender();
		},
		handleMouse(event: TuiMouseEvent) {
			if (finished) return undefined;
			if (event.y === searchRow) return search.handleMouse({ ...event, y: 0 });
			if (event.y >= listStart && event.y < listEnd) {
				const result = list.handleMouse({ ...event, y: event.y - listStart });
				if (result?.handled) requestRender();
				return result;
			}
			return undefined;
		},
	};
}

export async function pickCookieSites(sites: CookieSite[], ctx: ExtensionContext): Promise<string[] | undefined> {
	// Dynamic import keeps ordinary browsing and RPC/manual login independent of TUI components.
	const ui = await import("@earendil-works/pi-tui");
	const choices = new Map(sites.map((site) => [site.origin, site]));
	let selected: string[] = [];
	for (;;) {
		const result = await ctx.ui.custom<SitePickerResult | undefined>((tui, theme, keybindings, done) =>
			createSitePicker([...choices.values()], selected, ui, theme, keybindings, done, () => tui.requestRender(),
				() => Math.max(1, Math.min(12, tui.terminal.rows - 10))),
		);
		if (!result) return undefined;
		selected = result.origins;
		if (!result.manual) return selected;
		const input = await ctx.ui.input("Additional exact origins (comma-separated)", "https://mail.google.com, https://accounts.google.com");
		if (!input) continue;
		try {
			const origins = await parseGrantOrigins(input);
			for (const origin of origins) if (!choices.has(origin)) choices.set(origin, { origin, label: origin });
			selected = [...new Set([...selected, ...origins])];
		} catch {
			ctx.ui.notify("Origin not allowed or could not resolve. Use public HTTP(S) origins without credentials.", "warning");
		}
	}
}
