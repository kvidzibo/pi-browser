import { ACTION_SET, MAX_TEXT_CHARS, MAX_URL_CHARS, MAX_WAIT_MS, TAB_ACTION_SET, type BrowserAction, type TabAction } from "./constants.ts";

export type BrowserParams = {
	action?: string;
	url?: string;
	ref?: string;
	text?: string;
	key?: string;
	value?: string;
	checked?: boolean;
	direction?: string;
	tabAction?: string;
	tabId?: string;
	timeoutMs?: number;
};

export type ValidatedAction =
	| { action: "navigate"; url: string }
	| { action: "snapshot" }
	| { action: "screenshot" }
	| { action: "click"; ref: string }
	| { action: "type"; ref: string; text: string }
	| { action: "press"; key: string; ref?: string }
	| { action: "scroll"; ref?: string; direction: "up" | "down" }
	| { action: "wait"; timeoutMs: number }
	| { action: "back" }
	| { action: "select"; ref: string; value: string }
	| { action: "check"; ref: string; checked: boolean }
	| { action: "hover"; ref: string }
	| { action: "tabs"; tabAction: "list" }
	| { action: "tabs"; tabAction: "new"; url?: string }
	| { action: "tabs"; tabAction: "switch"; tabId: string }
	| { action: "tabs"; tabAction: "close"; tabId?: string }
	| { action: "close" };

function req(value: string | undefined, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
	return value;
}

export function validateAction(params: BrowserParams): ValidatedAction {
	const action = params.action;
	if (typeof action !== "string" || !ACTION_SET.has(action)) {
		throw new Error(`Unknown action. Use one of: ${[...ACTION_SET].join(", ")}`);
	}
	const act = action as BrowserAction;

	if (params.url !== undefined && params.url.length > MAX_URL_CHARS) throw new Error("url too long");
	if (params.text !== undefined && params.text.length > MAX_TEXT_CHARS) throw new Error("text too long");

	switch (act) {
		case "navigate":
			return { action: "navigate", url: req(params.url, "url") };
		case "snapshot":
		case "screenshot":
		case "back":
		case "close":
			return { action: act };
		case "click":
		case "hover":
			return { action: act, ref: req(params.ref, "ref") };
		case "type":
			return { action: "type", ref: req(params.ref, "ref"), text: req(params.text, "text") };
		case "press":
			return { action: "press", key: req(params.key, "key"), ref: params.ref?.trim() || undefined };
		case "scroll": {
			const direction = params.direction === "up" ? "up" : "down";
			return { action: "scroll", ref: params.ref?.trim() || undefined, direction };
		}
		case "wait": {
			const timeoutMs = params.timeoutMs ?? 1000;
			if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
				throw new Error(`timeoutMs must be 0..${MAX_WAIT_MS}`);
			}
			return { action: "wait", timeoutMs };
		}
		case "select":
			return { action: "select", ref: req(params.ref, "ref"), value: req(params.value, "value") };
		case "check":
			return { action: "check", ref: req(params.ref, "ref"), checked: params.checked !== false };
		case "tabs": {
			const tabAction = params.tabAction;
			if (typeof tabAction !== "string" || !TAB_ACTION_SET.has(tabAction)) {
				throw new Error("tabs requires tabAction: list | new | switch | close");
			}
			const tab = tabAction as TabAction;
			if (tab === "list") return { action: "tabs", tabAction: "list" };
			if (tab === "new") return { action: "tabs", tabAction: "new", url: params.url };
			if (tab === "switch") return { action: "tabs", tabAction: "switch", tabId: req(params.tabId, "tabId") };
			return { action: "tabs", tabAction: "close", tabId: params.tabId };
		}
	}
}
