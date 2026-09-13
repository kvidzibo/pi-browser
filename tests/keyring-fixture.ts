import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A fresh D-Bus and keyring using the synthetic HOME. Never connects to the desktop bus. */
export async function privateKeyring(dir: string): Promise<{ address: string; stop: () => Promise<void> }> {
	const children: ChildProcess[] = [];
	const stop = async () => {
		for (const child of [...children].reverse()) {
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
				child.once("exit", () => { clearTimeout(timer); resolve(); });
				child.kill("SIGTERM");
			});
		}
	};
	try {
		const bus = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "ignore"] });
		children.push(bus);
		const address = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Private test bus startup timed out")), 5000);
			bus.once("error", (err) => { clearTimeout(timer); reject(err); });
			bus.stdout!.once("data", (data) => { clearTimeout(timer); resolve(String(data).trim().split("\n")[0]); });
		});
		const control = join(dir, "keyring-control"); await mkdir(control, { mode: 0o700 });
		const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: address };
		const daemon = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets", `--control-directory=${control}`], { env, stdio: ["pipe", "ignore", "ignore"] });
		children.push(daemon);
		let spawnError: Error | undefined;
		daemon.on("error", (error) => { spawnError = error; });
		daemon.stdin!.on("error", () => {});
		daemon.stdin!.end("synthetic-keyring-password");
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			if (spawnError) throw spawnError;
			const { stdout } = await exec("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.secrets"], { env, timeout: 1000 });
			if (stdout.includes("true")) return { address, stop };
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error("Private test keyring startup timed out");
	} catch (error) { await stop(); throw error; }
}
