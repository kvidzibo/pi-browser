export const MAX_URL_CHARS = 2_048;
export const MAX_TEXT_CHARS = 4_000;
export const MAX_WAIT_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export function browserNetworkArgs(persistent: boolean): string[] {
	return ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		...(persistent ? ["--disable-http2"] : [])];
}
export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
export const SHUTDOWN_GRACE_MS = 2_000;
export const XVFB_SCREEN = "1920x1080x24";
export const SENSITIVE_QUERY_KEYS =
	/^(token|secret|password|passwd|pwd|api[_-]?key|access[_-]?token|auth|session|cookie|code|jwt|key|sid)$/i;

export const ACTIONS = [
	"navigate",
	"snapshot",
	"screenshot",
	"click",
	"type",
	"press",
	"scroll",
	"wait",
	"back",
	"select",
	"check",
	"hover",
	"tabs",
	"close",
] as const;

export type BrowserAction = (typeof ACTIONS)[number];
export const ACTION_SET = new Set<string>(ACTIONS);

export const TAB_ACTIONS = ["list", "new", "switch", "close"] as const;
export type TabAction = (typeof TAB_ACTIONS)[number];
export const TAB_ACTION_SET = new Set<string>(TAB_ACTIONS);

export const DISPLAY_MODES = ["xvfb", "headless", "host"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];
export const DISPLAY_MODE_SET = new Set<string>(DISPLAY_MODES);

export const PROFILE_DIR_NAME = "browser-profile";
export const SHOTS_DIR_NAME = "browser-shots";
export const RUN_DIR_NAME = "browser-run";
