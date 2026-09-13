import assert from "node:assert/strict";
import { test } from "node:test";
import { SiteSelection } from "../site-picker.ts";

const sites = [
	{ origin: "https://accounts.google.com", label: "Google sign-in" },
	{ origin: "https://github.com", label: "https://github.com" },
	{ origin: "https://mail.google.com", label: "Gmail" },
];

test("multiple checkbox choices survive filtering and can be individually unchecked", () => {
	const selection = new SiteSelection(sites);
	assert.deepEqual(selection.selected(), []);
	selection.filter("GOOGLE");
	assert.equal(selection.visible.length, 2);
	selection.toggle(); selection.move(1); selection.toggle();
	selection.filter("github"); selection.toggle();
	assert.deepEqual(selection.selected(), sites.map((site) => site.origin));
	selection.filter("gmail"); selection.toggle();
	assert.deepEqual(selection.selected(), ["https://accounts.google.com", "https://github.com"]);
});

test("selection filters labels and origins, handles no matches, and wraps navigation", () => {
	const selection = new SiteSelection(sites);
	selection.move(-1); assert.equal(selection.cursor, 2);
	selection.move(100); assert.equal(selection.cursor, 0);
	selection.filter("sign google"); assert.equal(selection.visible[0].origin, sites[0].origin);
	selection.filter("unmatched"); selection.move(-100); selection.toggle();
	assert.equal(selection.cursor, 0); assert.deepEqual(selection.selected(), []);
	selection.filter("  "); assert.equal(selection.visible.length, 3);
});

test("duplicate options and unknown prior selections cannot create hidden grants", () => {
	const selection = new SiteSelection([...sites, sites[0]], [sites[0].origin, "https://not-in-picker.test"]);
	assert.equal(selection.sites.length, 3);
	assert.deepEqual(selection.selected(), [sites[0].origin]);
});
