import assert from "node:assert/strict";
import { test } from "node:test";
import { abortable, Mutex } from "../cancellation.ts";
import { validateBrowserUrl } from "../gate.ts";

test("cancelled queued work never starts or releases a different caller's lock", async () => {
	const lock = new Mutex(), controller = new AbortController();
	let release!: () => void, ran = false, thirdRan = false;
	const first = lock.run(() => new Promise<void>((resolve) => { release = resolve; }));
	await Promise.resolve();
	const cancelled = lock.run(async () => { ran = true; }, controller.signal);
	controller.abort();
	await assert.rejects(cancelled, /cancelled/);
	const third = lock.run(async () => { thirdRan = true; });
	await Promise.resolve();
	assert.equal(thirdRan, false);
	release();
	await first; await third;
	assert.equal(ran, false); assert.equal(thirdRan, true);
});

test("running mutations retain the lock and caller until cleanup settles", async () => {
	const lock = new Mutex(), controller = new AbortController();
	let release!: () => void, settled = false, nextRan = false;
	const running = lock.run(() => new Promise<void>((resolve) => { release = resolve; }), controller.signal);
	void running.then(() => { settled = true; });
	await Promise.resolve(); controller.abort();
	const next = lock.run(async () => { nextRan = true; });
	await Promise.resolve();
	assert.equal(settled, false); assert.equal(nextRan, false);
	release(); await running; await next;
	assert.equal(settled, true); assert.equal(nextRan, true);
});

test("aborted read-only work consumes a late rejection", async () => {
	let reject!: (error: Error) => void;
	const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
	await assert.rejects(abortable(pending, AbortSignal.abort()), /cancelled/);
	reject(new Error("late fixture error"));
	await new Promise((resolve) => setImmediate(resolve));
});

test("navigation DNS validation can be cancelled without awaiting DNS", async () => {
	const controller = new AbortController();
	let finish!: (addresses: { address: string; family: number }[]) => void;
	const pending = validateBrowserUrl("https://example.com", { signal: controller.signal,
		lookup: () => new Promise((resolve) => { finish = resolve; }),
	});
	controller.abort();
	await assert.rejects(pending, /cancelled/);
	finish([{ address: "93.184.216.34", family: 4 }]);
});

test("DNS validation has a deadline even when the resolver stalls", async () => {
	// AbortSignal.timeout is unref'ed; keep the isolated test alive until the deadline.
	const keepAlive = setTimeout(() => {}, 500);
	try { await assert.rejects(validateBrowserUrl("https://example.com", { timeoutMs: 10, lookup: () => new Promise(() => {}) }), /timed out/); }
	finally { clearTimeout(keepAlive); }
});
