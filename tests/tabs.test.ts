import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TabRegistry, type TabPage } from "../tabs.ts";

class PageFixture extends EventEmitter implements TabPage {
	private frame = {};
	url() { return "https://example.com"; }
	mainFrame() { return this.frame; }
	navigate() { this.emit("framenavigated", this.frame); }
	close() { this.emit("close"); }
}
function snapshot(tabs: TabRegistry<PageFixture>, page: PageFixture) {
	const revision = tabs.beginSnapshot(page);
	tabs.completeSnapshot(page, revision);
	return `r${revision}e1`;
}

test("refs are bound to the tab, not only a global revision", () => {
	const tabs = new TabRegistry<PageFixture>(), first = new PageFixture(), second = new PageFixture();
	tabs.add(first, true);
	const old = snapshot(tabs, first);
	tabs.add(second, true);
	const latest = snapshot(tabs, second);
	assert.throws(() => tabs.ref(first, latest), /Stale/);
	second.close();
	assert.equal(tabs.page, first);
	assert.throws(() => tabs.ref(first, latest), /Stale/);
	assert.throws(() => tabs.ref(first, old), /Stale/);
	assert.equal(tabs.ref(first, snapshot(tabs, first)), "e1");
});

test("main-frame navigation invalidates refs; unrelated iframe navigation does not", () => {
	const tabs = new TabRegistry<PageFixture>(), page = new PageFixture();
	tabs.add(page, true);
	const ref = snapshot(tabs, page);
	page.emit("framenavigated", {});
	assert.equal(tabs.ref(page, ref), "e1");
	page.navigate();
	assert.throws(() => tabs.ref(page, ref), /Stale/);
});

test("a navigation during capture cannot publish a valid snapshot", () => {
	const tabs = new TabRegistry<PageFixture>(), page = new PageFixture();
	tabs.add(page, true);
	const revision = tabs.beginSnapshot(page);
	page.navigate();
	assert.throws(() => tabs.completeSnapshot(page, revision), /changed/);
	assert.throws(() => tabs.ref(page, `r${tabs.revision}e1`), /Stale/);
});

test("close/reopen never reuses tab identifiers or snapshot revisions", () => {
	const tabs = new TabRegistry<PageFixture>(), page = new PageFixture();
	const firstId = tabs.add(page, true), firstRef = snapshot(tabs, page);
	tabs.clear();
	assert.notEqual(tabs.add(page, true), firstId);
	assert.notEqual(snapshot(tabs, page), firstRef);
});
