export function checkCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Browser action cancelled", "AbortError");
}

/** Race read-only work; mutating operations must also cooperate/check at the I/O boundary. */
export async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return pending;
	let abort!: () => void;
	try {
		return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
			abort = () => reject(new DOMException("Browser action cancelled", "AbortError"));
			if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally { signal.removeEventListener("abort", abort); }
}

export class Mutex {
	private chain: Promise<void> = Promise.resolve();

	run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => { release = resolve; });
		const wait = this.chain;
		this.chain = wait.then(() => next, () => next);
		// Queued cancellation is immediate, but running mutations keep their lock until cleanup finishes.
		let started = false;
		const pending = wait.then(() => { checkCancelled(signal); started = true; return fn(); }).finally(release);
		if (!signal) return pending;
		return new Promise<T>((resolve, reject) => {
			const abort = () => { if (!started) reject(new DOMException("Browser action cancelled", "AbortError")); };
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
				(error) => { signal.removeEventListener("abort", abort); reject(error); });
		});
	}
}
