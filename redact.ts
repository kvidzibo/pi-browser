import { SENSITIVE_QUERY_KEYS } from "./constants.ts";

export function redactUrl(raw: string): string {
	try {
		const url = new URL(raw);
		if (url.username || url.password) {
			url.username = "";
			url.password = "";
		}
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, "REDACTED");
		}
		return url.toString();
	} catch {
		return raw;
	}
}

export function redactUrlsInText(text: string): string {
	return text.replace(/https?:\/\/[^\s"'<>\\]+/g, (match) => redactUrl(match));
}

export function sanitizeWithSecrets(text: string, secrets: string[]): string {
	let out = redactUrlsInText(text);
	const unique = [...new Set(secrets.filter((secret) => secret.length >= 6))].sort((a, b) => b.length - a.length);
	for (const secret of unique) {
		out = out.split(secret).join("[redacted]");
	}
	return out;
}
