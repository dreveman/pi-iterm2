import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_SOCKET_PATH = join(homedir(), ".pi-iterm2", "daemon.sock");
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type DaemonCommand = "check" | "check-all";

interface DaemonResponse {
	version: number;
	ok: boolean;
	output?: string;
	error?: string;
}

export function normalizeItermSessionId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const separator = value.lastIndexOf(":");
	return separator === -1 ? value : value.slice(separator + 1);
}

function parseResponse(line: string): string {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error("The companion daemon returned malformed data. Reinstall it and restart iTerm2.");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("The companion daemon returned an invalid response. Reinstall it and restart iTerm2.");
	}
	const response = value as Partial<DaemonResponse>;
	if (response.version !== DAEMON_PROTOCOL_VERSION) {
		throw new Error("The companion daemon uses an incompatible protocol. Reinstall it and restart iTerm2.");
	}
	if (response.ok === true && typeof response.output === "string") return response.output;
	if (response.ok === false && typeof response.error === "string") throw new Error(response.error);
	throw new Error("The companion daemon returned an invalid response. Reinstall it and restart iTerm2.");
}

/** Ask the already-authenticated AutoLaunch daemon for a read-only report. */
export function requestDaemonReport(
	command: DaemonCommand,
	itermSessionId: string | undefined,
	options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<string> {
	const socketPath = options.socketPath ?? DAEMON_SOCKET_PATH;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const request = `${JSON.stringify({
		version: DAEMON_PROTOCOL_VERSION,
		command,
		sessionId: normalizeItermSessionId(itermSessionId),
	})}\n`;

	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let response = Buffer.alloc(0);
		const timer = setTimeout(() => {
			finish(new Error("Timed out waiting for the companion daemon."));
		}, timeoutMs);

		const finish = (error?: Error, output?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(output ?? "");
		};

		socket.on("connect", () => socket.write(request));
		socket.on("data", (chunk: Buffer) => {
			response = Buffer.concat([response, chunk]);
			if (response.length > MAX_RESPONSE_BYTES) {
				finish(new Error("The companion daemon response was unexpectedly large."));
				return;
			}
			const newline = response.indexOf(0x0a);
			if (newline === -1) return;
			try {
				finish(undefined, parseResponse(response.subarray(0, newline).toString("utf8")));
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.on("end", () => {
			if (!settled) finish(new Error("The companion daemon closed the connection without a response."));
		});
		socket.on("error", (error) => finish(error));
	});
}
