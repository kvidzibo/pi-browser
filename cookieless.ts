import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { DEFAULT_TIMEOUT_MS } from "./constants.ts";
import { normalizeHostname, resolvePinnedTarget, type Lookup } from "./gate.ts";

export const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

type ResourceRequest = { method: string; headers: Record<string, string>; body?: Buffer | null };
export type ResourceResponse = { status: number; headers: Record<string, string>; body: Buffer };
export type ResourceOptions = {
	signal?: AbortSignal;
	lookup?: Lookup;
	request?: typeof http.request;
	maxBytes?: number;
	timeoutMs?: number;
};

function cleanHeaders(headers: IncomingMessage["headers"] | Record<string, string>, request: boolean): Record<string, string> {
	const connection = Object.entries(headers).find(([key]) => key.toLowerCase() === "connection")?.[1];
	const blocked = new Set([...HOP_HEADERS, ...String(connection ?? "").toLowerCase().split(",").map((s) => s.trim()),
		"cookie", "cookie2", "set-cookie", "set-cookie2", "content-length",
		...(request ? ["authorization", "host", "accept-encoding"] : ["content-encoding"])]);
	return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) =>
		value === undefined || blocked.has(key.toLowerCase()) ? [] : [[key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]]));
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort!: () => void;
	try {
		return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
			abort = () => reject(signal.reason);
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally { signal.removeEventListener("abort", abort); }
}

async function readResponse(response: IncomingMessage, method: string, maxBytes: number, signal: AbortSignal): Promise<ResourceResponse> {
	const status = response.statusCode ?? 0;
	const headers = cleanHeaders(response.headers, false);
	if (status < 200 || status > 599) throw new Error("Unsupported resource status");
	// Chromium skips route handlers after redirects. Returning Location leaks cookies;
	// hiding a redirect behind the original URL bypasses URL/CSP/mixed-content checks.
	if (REDIRECTS.has(status)) throw new Error("Redirected ungranted resources are blocked");
	if (status === 304) throw new Error("Stateless resources cannot reuse cached responses");
	if (method === "HEAD" || [204, 205].includes(status)) {
		response.destroy();
		return { status, headers, body: Buffer.alloc(0) };
	}
	if (Number(response.headers["content-length"]) > maxBytes) throw new Error("Resource too large");
	const encodings = String(response.headers["content-encoding"] ?? "").toLowerCase().split(",").map((s) => s.trim()).filter((s) => s && s !== "identity");
	if (encodings.length > 3) throw new Error("Too many resource encodings");
	const decoders = encodings.reverse().map((encoding) => {
		if (encoding === "gzip") return createGunzip();
		if (encoding === "deflate") return createInflate();
		if (encoding === "br") return createBrotliDecompress();
		throw new Error("Unsupported resource encoding");
	});
	const chunks: Buffer[] = [];
	let size = 0, encodedSize = 0;
	await pipeline([response, new Transform({ transform(chunk, _encoding, done) {
		encodedSize += chunk.length;
		done(encodedSize > maxBytes ? new Error("Resource too large") : null, chunk);
	} }), ...decoders, new Writable({ write(chunk, _encoding, done) {
		size += chunk.length;
		if (size > maxBytes) return done(new Error("Resource too large"));
		chunks.push(Buffer.from(chunk)); done();
	} })], { signal });
	return { status, headers, body: Buffer.concat(chunks, size) };
}

/** Stateless single-hop HTTP: no cookie jar/auth cache; redirects fail closed. */
export async function fetchCookieless(rawUrl: string, input: ResourceRequest, options: ResourceOptions = {}): Promise<ResourceResponse> {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const url = new URL(rawUrl);
	const method = input.method.toUpperCase();
	const headers = cleanHeaders(input.headers, true);
	// Reads need a fresh complete entity, not a profile's cached/partial representation.
	// Preserve write preconditions (e.g. POST If-None-Match: *) rather than weakening them.
	if (method === "GET" || method === "HEAD") {
		for (const key of ["if-none-match", "if-modified-since", "if-range", "range"]) delete headers[key];
	}
	signal.throwIfAborted();
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Blocked resource scheme");
	const pinned = await abortable(resolvePinnedTarget(url, { lookup: options.lookup }), signal);
	signal.throwIfAborted();
	const request = options.request ?? (url.protocol === "https:" ? https.request : http.request);
	const hostname = normalizeHostname(url.hostname);
	const response = await new Promise<ResourceResponse>((resolve, reject) => {
		const requestOptions: RequestOptions = {
			method, headers: { ...headers, host: url.host, "accept-encoding": "identity" }, agent: false, signal,
			lookup: (_host, _opts, callback) => callback(null, pinned.address.address, pinned.address.family),
			family: pinned.address.family, autoSelectFamily: false,
			...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
		};
		const req = request(url, requestOptions, (res) => {
			void readResponse(res, method, options.maxBytes ?? MAX_RESOURCE_BYTES, signal).then(resolve, (error) => {
				res.destroy(); req.destroy(); reject(error);
			});
		});
		req.once("error", reject);
		req.once("upgrade", (_res, socket) => { socket.destroy(); req.destroy(); reject(new Error("Resource upgrades are blocked")); });
		req.end(input.body ?? undefined);
	});
	signal.throwIfAborted();
	return response;
}
