import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	buildIdentitySequences,
	buildResetSequences,
	buildStatusSequences,
	buildTabTitle,
	deriveStatus,
	parseConfigText,
	shouldActivate,
	statusIcon,
	wrapForTmux,
	type ConfigResult,
	type SessionIdentity,
	type StatusState,
} from "./core.ts";

const WORKING_ICON_INTERVAL_MS = 1000;

const CONFIG_PATH = join(getAgentDir(), "pi-iterm2.json");

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DAEMON_SOURCE_PATH = join(PACKAGE_ROOT, "macos", "pi_iterm2_daemon.py");
const AUTOLAUNCH_DIR = join(homedir(), "Library", "Application Support", "iTerm2", "Scripts", "AutoLaunch");
const DAEMON_INSTALL_PATH = join(AUTOLAUNCH_DIR, "pi_iterm2_daemon.py");
const ITERM2_PYTHON_VERSIONS_DIR = join(homedir(), "Library", "Application Support", "iTerm2", "iterm2env", "versions");

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function loadConfig(): ConfigResult {
	try {
		const result = parseConfigText(readFileSync(CONFIG_PATH, "utf8"));
		return result.warning ? { ...result, warning: `${CONFIG_PATH}: ${result.warning}; using defaults` } : result;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return { config: parseConfigText("{}").config };
		return {
			config: parseConfigText("{}").config,
			warning: `Could not read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}; using defaults`,
		};
	}
}

function currentUser(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "unknown";
	}
}

// iTerm2 can leave more than one entry under versions/ (e.g. a stale one alongside a
// freshly (re)installed runtime), so pick whichever candidate actually has a python3
// binary and was modified most recently, rather than an arbitrary readdirSync() order.
function findIterm2Python(): string | undefined {
	let versions: string[];
	try {
		versions = readdirSync(ITERM2_PYTHON_VERSIONS_DIR);
	} catch {
		return undefined;
	}

	let newest: { path: string; mtimeMs: number } | undefined;
	for (const version of versions) {
		const candidate = join(ITERM2_PYTHON_VERSIONS_DIR, version, "bin", "python3");
		let mtimeMs: number;
		try {
			mtimeMs = statSync(candidate).mtimeMs;
		} catch {
			continue;
		}
		if (!newest || mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs };
	}
	return newest?.path;
}

export default function (pi: ExtensionAPI) {
	const loadedConfig = loadConfig();
	const config = loadedConfig.config;
	let configWarning = loadedConfig.warning;
	const active = shouldActivate(config.enabled, process.env);

	// Registered unconditionally (not gated on `active`): these install/check the macOS
	// daemon, which is useful whenever pi is running on a Mac, independent of whether the
	// current terminal happens to be recognized as iTerm2.
	pi.registerCommand("iterm2-daemon-install", {
		description: "Install (or update) the pi-iterm2 macOS companion daemon as an iTerm2 AutoLaunch script",
		handler: async (_args, ctx) => {
			if (process.platform !== "darwin") {
				ctx.ui.notify("The companion daemon only runs on macOS.", "error");
				return;
			}
			if (!existsSync(DAEMON_SOURCE_PATH)) {
				ctx.ui.notify(`Daemon source not found at ${DAEMON_SOURCE_PATH}. Reinstall the pi-iterm2 package.`, "error");
				return;
			}
			try {
				mkdirSync(AUTOLAUNCH_DIR, { recursive: true });
				copyFileSync(DAEMON_SOURCE_PATH, DAEMON_INSTALL_PATH);
				ctx.ui.notify(
					`Installed ${DAEMON_INSTALL_PATH}. Enable Settings -> General -> Magic -> Enable Python API, then restart iTerm2 for it to start.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Install failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	const runDaemonCheck = async (ctx: ExtensionContext, flag: "--check" | "--check-all") => {
		if (process.platform !== "darwin") {
			ctx.ui.notify("The companion daemon only runs on macOS.", "error");
			return;
		}
		if (!existsSync(DAEMON_INSTALL_PATH)) {
			ctx.ui.notify("Daemon isn't installed yet. Run /iterm2-daemon-install first.", "error");
			return;
		}
		const python = findIterm2Python();
		if (!python) {
			ctx.ui.notify("Could not find iTerm2's bundled Python. Run Scripts -> Install Python Runtime in iTerm2 first.", "error");
			return;
		}
		try {
			const { stdout, stderr } = await execFileAsync(python, [DAEMON_INSTALL_PATH, flag], { timeout: 15_000 });
			ctx.ui.notify((stdout || stderr || "(no output)").trim(), "info");
		} catch (error) {
			ctx.ui.notify(
				`Check failed (if this is the first run, approve iTerm2's connection prompt and try again): ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	};

	pi.registerCommand("iterm2-daemon-check", {
		description: "Preview what the pi-iterm2 macOS daemon would print if this tab were restored right now",
		handler: async (_args, ctx) => runDaemonCheck(ctx, "--check"),
	});

	pi.registerCommand("iterm2-daemon-check-all", {
		description: "Preview the pi-iterm2 macOS daemon's record for every live iTerm2 session",
		handler: async (_args, ctx) => runDaemonCheck(ctx, "--check-all"),
	});

	if (!active) return;

	const host = hostname();
	const user = currentUser();
	const status: StatusState = { agentRunning: false, promptOpen: false, hadError: false };
	let sessionId = "";
	let sessionDisplayName = ""; // empty when unnamed; used for the tab title only
	let identity: SessionIdentity = { cwd: "", sessionName: "", user, host };
	let workingFrame = 0;
	let workingTimer: NodeJS.Timeout | undefined;

	const stopWorkingTimer = () => {
		if (!workingTimer) return;
		clearInterval(workingTimer);
		workingTimer = undefined;
	};

	const write = (ctx: ExtensionContext, sequence: string) => {
		if (!sequence) return;
		if (ctx.mode !== "tui" || !process.stdout.isTTY) return;
		process.stdout.write(wrapForTmux(sequence, Boolean(process.env.TMUX)));
	};

	const renderTitle = (ctx: ExtensionContext) => {
		const icon = statusIcon(deriveStatus(status), workingFrame);
		ctx.ui.setTitle(buildTabTitle(icon, sessionDisplayName, basename(identity.cwd)));
	};

	// Pi only manages the tab title itself at session rebind, rename, and shutdown, never
	// during a turn, so setting it at these points doesn't fight with pi's own title. While
	// working, a timer spins the icon through its frames once a second; any other status
	// stops that timer so it can't keep ticking once idle. The interval is unref'd so it can
	// never by itself hold the process open on an exit path that skips session_shutdown.
	const pushTitle = (ctx: ExtensionContext) => {
		if (!config.tabTitle) return;
		if (deriveStatus(status) === "working") {
			if (!workingTimer) {
				workingFrame = 0;
				workingTimer = setInterval(() => {
					workingFrame++;
					renderTitle(ctx);
				}, WORKING_ICON_INTERVAL_MS);
				workingTimer.unref();
			}
		} else {
			stopWorkingTimer();
		}
		renderTitle(ctx);
	};

	/** Everything that reflects live status: tab color, the pi_status user var, and the title. */
	const pushStatus = (ctx: ExtensionContext) => {
		write(ctx, buildStatusSequences(config, identity, sessionId, deriveStatus(status)));
		pushTitle(ctx);
	};

	/** Session identity (cwd, name, host); only changes at session start and rename. */
	const pushIdentity = (ctx: ExtensionContext) => {
		write(ctx, buildIdentitySequences(config, identity));
	};

	pi.on("session_start", (_event, ctx) => {
		stopWorkingTimer();
		sessionId = ctx.sessionManager.getSessionId();
		sessionDisplayName = ctx.sessionManager.getSessionName() ?? "";
		identity = { cwd: ctx.cwd, sessionName: sessionDisplayName || sessionId, user, host };
		status.agentRunning = false;
		status.promptOpen = false;
		status.hadError = false;

		if (configWarning) {
			ctx.ui.notify(configWarning, "warning");
			configWarning = undefined;
		}

		pushIdentity(ctx);
		pushStatus(ctx);
	});

	pi.on("session_info_changed", (event, ctx) => {
		sessionDisplayName = event.name ?? "";
		identity = { ...identity, sessionName: sessionDisplayName || sessionId };
		pushIdentity(ctx);
		pushTitle(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		status.agentRunning = true;
		pushStatus(ctx);
	});

	pi.on("turn_start", () => {
		// Reset per turn, not per run: a later turn that fixes an earlier error
		// should clear the "error" status instead of leaving it stuck until agent_settled.
		// No push needed: the run is still active, so the derived status stays "working".
		status.hadError = false;
	});

	pi.on("tool_result", (event) => {
		// No push: status stays "working" until the run settles, which is when this surfaces.
		if (event.isError) status.hadError = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		status.agentRunning = false;
		pushStatus(ctx);
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		status.promptOpen = true;
		pushStatus(ctx);
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		status.promptOpen = false;
		pushStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopWorkingTimer();
		write(ctx, buildResetSequences(config));
		// Drop the status icon too, so a session killed mid-turn doesn't strand a spinner
		// frame in the title of a dead tab.
		if (config.tabTitle) ctx.ui.setTitle(buildTabTitle("", sessionDisplayName, basename(identity.cwd)));
	});
}
