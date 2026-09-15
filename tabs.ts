import { parseAgentRef } from "./snapshot.ts";

export interface TabPage {
	url(): string;
	mainFrame(): unknown;
	on(event: "close", listener: () => void): unknown;
	on(event: "framenavigated", listener: (frame: unknown) => void): unknown;
}

/** Tab identity and document lifetime are part of every snapshot capability. */
export class TabRegistry<P extends TabPage> {
	readonly pages = new Map<string, P>();
	private sequence = 0;
	private activeId = "";
	private snapshotPage?: P;
	revision = 0;

	get active(): string { return this.activeId; }
	get page(): P | undefined { return this.pages.get(this.activeId); }

	activate(id: string): void {
		if (!this.pages.has(id)) throw new Error(`Unknown tab ${id}`);
		if (id !== this.activeId) { this.activeId = id; this.invalidate(); }
	}

	add(page: P, active: boolean): string {
		for (const [id, existing] of this.pages) {
			if (existing === page) { if (active) this.activate(id); return id; }
		}
		const id = `t${++this.sequence}`;
		this.pages.set(id, page);
		if (active || !this.activeId) this.activate(id);
		page.on("close", () => this.remove(id));
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame() && (page === this.page || page === this.snapshotPage)) this.invalidate();
		});
		return id;
	}

	remove(id: string): void {
		const page = this.pages.get(id);
		if (!page) return;
		this.pages.delete(id);
		if (this.activeId === id) {
			this.activeId = this.pages.keys().next().value ?? "";
			this.invalidate();
		} else if (page === this.snapshotPage) this.invalidate();
	}

	clear(): void { this.pages.clear(); this.activeId = ""; this.invalidate(); }
	invalidate(): void { this.revision++; this.snapshotPage = undefined; }

	beginSnapshot(page: P): number {
		if (page !== this.page) throw new Error("Active tab changed. Call action snapshot first.");
		this.invalidate();
		return this.revision;
	}

	completeSnapshot(page: P, revision: number): void {
		if (page !== this.page || revision !== this.revision) throw new Error("Page changed during snapshot. Call action snapshot again.");
		this.snapshotPage = page;
	}

	assertSnapshot(page: P, revision: number): void {
		if (page !== this.page || page !== this.snapshotPage || revision !== this.revision) {
			throw new Error("Stale snapshot: tab or document changed. Call action snapshot first.");
		}
	}

	ref(page: P, ref: string): string {
		const parsed = parseAgentRef(ref, this.revision);
		this.assertSnapshot(page, this.revision);
		return parsed.playwrightRef;
	}
}
