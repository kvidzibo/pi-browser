import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { NetworkDiagnostics, NetworkPolicyError, networkCode, type NetworkCode } from "../diagnostics.ts";
import { browserDoctor, supportedNode } from "../doctor.ts";
import { agentDir, RuntimeState } from "../runtime.ts";

for (const [error, expected] of [
	[Object.assign(new Error("private TLS details"), { code: "CERT_HAS_EXPIRED" }), "tls"],
	[new Error("Failed to resolve private-host: private reason"), "dns"],
	[new Error("Blocked internal address for private-host: private-IP"), "private_address"],
	[new Error("Redirected ungranted resources are blocked"), "redirect"],
	[new Error("Resource too large"), "resource_limit"],
	[new Error("DNS resolution timed out"), "timeout"],
	[new NetworkPolicyError("origin_not_granted", "private reason"), "origin_not_granted"],
	[new DOMException("private reason", "AbortError"), "cancelled"],
	[new Error("Cookie: private-cookie Authorization: private-token"), "resource_error"],
] satisfies [Error, NetworkCode][]) test(`network diagnostics classify ${expected} without retaining private details`, () => {
	const diagnostics = new NetworkDiagnostics();
	diagnostics.record(networkCode(error));
	assert.deepEqual(diagnostics.snapshot(), { [expected]: 1 });
	assert.ok(!/private-host|private-token|private reason|Cookie|Authorization/.test(JSON.stringify(diagnostics.snapshot())));
	diagnostics.reset(); assert.equal(diagnostics.summary(), "");
});

test("agent directory respects Pi override, tilde expansion and default", () => {
	assert.equal(agentDir({}, "/synthetic/home"), "/synthetic/home/.pi/agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/synthetic/custom" }, "/synthetic/home"), "/synthetic/custom");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/custom" }, "/synthetic/home"), "/synthetic/home/custom");
	assert.equal(new RuntimeState("/synthetic/custom").directory, "/synthetic/custom");
});

test("doctor checks capabilities without launching a browser or reading a profile", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-browser-doctor-")), executablePath = join(dir, "browser");
	try {
		await writeFile(executablePath, "", { mode: 0o700 });
		const options = { directory: dir, nodeVersion: "22.19.0", mode: "headless" as const,
			xvfb: () => false, find: async () => ({ executablePath, source: "env" as const }), network: "tls=1" };
		const good = await browserDoctor(options);
		assert.match(good, /Browser: executable \(env\)/); assert.match(good, /tls=1/);
		assert.match(good, /cookies and the desktop keyring were not inspected/);
		await chmod(executablePath, 0o600);
		assert.match(await browserDoctor(options), /unavailable or not executable/);
		assert.equal(supportedNode("v22.18.0"), false);
		assert.equal(supportedNode("v22.19.0"), true);
		assert.equal(supportedNode("24.0.0"), true);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
