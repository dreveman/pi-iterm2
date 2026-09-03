import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildIdentitySequences,
	buildResetSequences,
	buildStatusSequences,
	buildTabTitle,
	deriveStatus,
	hostHue,
	hueSwatch,
	parseColorSpec,
	parseConfigText,
	vsCodeHueFromSettings,
	shouldActivate,
	statusIcon,
	tabColorForHue,
	wrapForTmux,
	type ConfigResult,
	type SessionIdentity,
	type StatusState,
} from "./core.ts";
const WORKING_ICON_INTERVAL_MS = 80;

const CONFIG_PATH = join(getAgentDir(), "pi-iterm2.json");

// extensions/pi-iterm2/index.ts -> the package root is three levels up.
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DAEMON_SOURCE_PATH = join(PACKAGE_ROOT, "macos", "pi_iterm2_daemon.py");
const SHELL_HOOK_SOURCE_PATH = join(PACKAGE_ROOT, "shell", "pi_iterm2_restore.sh");
const AUTOLAUNCH_DIR = join(homedir(), "Library", "Application Support", "iTerm2", "Scripts", "AutoLaunch");
const DAEMON_INSTALL_PATH = join(AUTOLAUNCH_DIR, "pi_iterm2_daemon.py");
const STATE_DIR = join(homedir(), ".pi-iterm2");
const SHELL_HOOK_INSTALL_PATH = join(STATE_DIR, "shell.sh");
const SHELL_HELPER_INSTALL_PATH = join(STATE_DIR, "pi_iterm2.py");
const SHELL_IDENTITY_ENABLED_PATH = join(STATE_DIR, "shell-identity-enabled");
const REMOTE_LOCATION_ENABLED_PATH = join(STATE_DIR, "remote-location-enabled");
const RECORD_INDEX_PATH = join(STATE_DIR, "record-ids");
const PREVIOUS_STATE_PATH = join(STATE_DIR, "state.previous.json");
const SHELL_SOURCE_LINE = 'test -e "${HOME}/.pi-iterm2/shell.sh" && source "${HOME}/.pi-iterm2/shell.sh"';

const LEGACY_SHELL_SOURCE_LINES = new Set([
	'source "$HOME/.pi-iterm2/shell.sh"',
	"source ~/.pi-iterm2/shell.sh",
	'. "$HOME/.pi-iterm2/shell.sh"',
	". ~/.pi-iterm2/shell.sh",
]);

function refreshRecordIndex(): void {
	const ids = new Set<string>();
	try {
		const value: unknown = JSON.parse(readFileSync(PREVIOUS_STATE_PATH, "utf8"));
		if (isPlainObject(value)) {
			for (const id of Object.keys(value)) {
				if (/^[A-Za-z0-9._-]+$/.test(id)) ids.add(id);
			}
		}
	} catch {
		// The recorder creates the recovery index on the next iTerm2 launch.
	}
	// A pid+uuid suffix matches the daemon's sync_record_index so two overlapping writers (e.g.
	// /iterm2-install in two sessions, or one racing the daemon's --refresh-record-index) can't
	// interleave into a shared temp file and rename a partial index into place.
	const temporaryPath = `${RECORD_INDEX_PATH}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporaryPath, [...ids].sort().map((id) => `${id}\n`).join(""), { encoding: "utf8", mode: 0o600 });
	chmodSync(temporaryPath, 0o600);
	renameSync(temporaryPath, RECORD_INDEX_PATH);
}

export function configureShellRc(path: string): "added" | "updated" | "already present" {
	let text = "";
	let exists = true;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
		exists = false;
	}
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.length > 0 ? text.split(/\r?\n/) : [];
	if (lines.at(-1) === "") lines.pop();
	const isSourceLine = (line: string) => line.trim() === SHELL_SOURCE_LINE || LEGACY_SHELL_SOURCE_LINES.has(line.trim());
	const hadSourceLine = lines.some(isSourceLine);
	const cleaned = lines.filter((line) => !isSourceLine(line));
	const instantPromptIndex = cleaned.findIndex(
		(line) => line.includes("Powerlevel10k instant prompt") || line.includes("p10k-instant-prompt-"),
	);
	cleaned.splice(instantPromptIndex >= 0 ? instantPromptIndex : cleaned.length, 0, SHELL_SOURCE_LINE);
	const updated = `${cleaned.join(newline)}${newline}`;
	if (updated === text) return "already present";

	const temporaryPath = `${path}.pi-iterm2.tmp-${process.pid}`;
	try {
		writeFileSync(temporaryPath, updated, {
			encoding: "utf8",
			mode: exists ? statSync(path).mode & 0o777 : 0o600,
		});
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
	return hadSourceLine ? "updated" : "added";
}

/**
 * VS Code's machine-scope settings, where a per-machine window color lives. Machine scope
 * is the right one: it describes the host, which is exactly what the tab hue conveys, and
 * unlike user or workspace scope it doesn't travel between machines. Both remote server
 * layouts are checked because the directory name differs by VS Code flavor.
 */
const VSCODE_SETTINGS_PATHS = [
	join(homedir(), ".vscode-remote", "data", "Machine", "settings.json"),
	join(homedir(), ".vscode-server", "data", "Machine", "settings.json"),
];

/**
 * Hue of the VS Code window color for this machine, or undefined when there isn't one.
 * Every failure -- no VS Code, no file, no color set, unreadable file -- is the same silent
 * undefined, since having no VS Code color is the normal case and the caller has a fallback.
 */
function readVsCodeHue(): number | undefined {
	for (const path of VSCODE_SETTINGS_PATHS) {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const hue = vsCodeHueFromSettings(text);
		if (hue !== undefined) return hue;
	}
	return undefined;
}

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read-modify-write of the user's config file, preserving every field this extension
 * doesn't touch. Returns an error message, or undefined on success. Deliberately refuses
 * to overwrite a file it can't parse, rather than silently discarding what's in it.
 */
function updateConfigFile(mutate: (raw: Record<string, unknown>) => void): string | undefined {
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (!isPlainObject(parsed)) return `${CONFIG_PATH} is not a JSON object; fix it by hand first`;
		raw = parsed;
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) {
			return `Could not read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	mutate(raw);
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	} catch (error) {
		return `Could not write ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`;
	}
	return undefined;
}

function currentUser(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "unknown";
	}
}

export default function (pi: ExtensionAPI) {
	const loadedConfig = loadConfig();
	const config = loadedConfig.config;
	let configWarning = loadedConfig.warning;
	const active = shouldActivate(config.enabled, process.env);

	// Registered unconditionally: installation is useful on any Mac, independent of
	// whether this particular Pi session is running inside iTerm2.
	pi.registerCommand("iterm2-install", {
		description: "Install or update the pi-iterm2 daemon and shell integration",
		handler: async (_args, ctx) => {
			const isDarwin = process.platform === "darwin";
			const confirm = (title: string, description: string) =>
				ctx.ui.confirm(title, `\n${ctx.ui.theme.fg("text", description)}`);
			const results: string[] = [];
			let daemonInstalled = false;
			let shellInstalled = false;
			let shellConfigured = false;
			let shellIdentityEnabled = false;
			// The Python helper is a Mac-only concern: off the Mac the hook resolves the host
			// color and publishes host and cwd with shell builtins alone.
			let shellAvailable = existsSync(SHELL_HOOK_INSTALL_PATH) && (!isDarwin || existsSync(SHELL_HELPER_INSTALL_PATH));
			if (isDarwin && (await confirm("Install pi-iterm2 recorder?", `This will copy the AutoLaunch recorder to ${DAEMON_INSTALL_PATH}.`))) {
				if (!existsSync(DAEMON_SOURCE_PATH)) {
					ctx.ui.notify(`Daemon source not found at ${DAEMON_SOURCE_PATH}. Reinstall the pi-iterm2 package.`, "error");
				} else {
					try {
						mkdirSync(AUTOLAUNCH_DIR, { recursive: true });
						rmSync(join(AUTOLAUNCH_DIR, "__pycache__"), { recursive: true, force: true });
						copyFileSync(DAEMON_SOURCE_PATH, DAEMON_INSTALL_PATH);
						results.push(`daemon: ${DAEMON_INSTALL_PATH}`);
						daemonInstalled = true;
					} catch (error) {
						ctx.ui.notify(`Daemon install failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
			}

			const installShell = await confirm(
				"Install pi-iterm2 shell integration?",
				isDarwin
					? `This will copy the shell integration, helper, and shell check commands to ${STATE_DIR}.`
					: `This will copy the host color and host/cwd publishing hook to ${SHELL_HOOK_INSTALL_PATH}.`,
			);
			if (installShell) {
				if (!existsSync(SHELL_HOOK_SOURCE_PATH) || (isDarwin && !existsSync(DAEMON_SOURCE_PATH))) {
					ctx.ui.notify("Shell integration source is missing. Reinstall the pi-iterm2 package.", "error");
				} else {
					try {
						mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
						chmodSync(STATE_DIR, 0o700);
						copyFileSync(SHELL_HOOK_SOURCE_PATH, SHELL_HOOK_INSTALL_PATH);
						results.push(`shell integration: ${SHELL_HOOK_INSTALL_PATH}`);
						if (isDarwin) {
							copyFileSync(DAEMON_SOURCE_PATH, SHELL_HELPER_INSTALL_PATH);
							refreshRecordIndex();
							results.push(`shell helper: ${SHELL_HELPER_INSTALL_PATH}`);
						} else {
							writeFileSync(REMOTE_LOCATION_ENABLED_PATH, "enabled\n", { encoding: "utf8", mode: 0o600 });
							results.push("remote host/cwd publishing: enabled");
						}
						shellInstalled = true;
						shellAvailable = true;
					} catch (error) {
						ctx.ui.notify(`Shell integration install failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}

				if (shellInstalled) {
					for (const [name, path, note] of [
						["zsh", join(homedir(), ".zshrc"), ""],
						["bash", join(homedir(), ".bashrc"), " Login bash must source ~/.bashrc from ~/.bash_profile."],
					] as const) {
						if (await confirm(`Configure ${name}?`, `This will add '${SHELL_SOURCE_LINE}' to ${path}.${note}`)) {
							try {
								results.push(`${path}: ${configureShellRc(path)}`);
								shellConfigured = true;
							} catch (error) {
								ctx.ui.notify(`Could not update ${path}: ${error instanceof Error ? error.message : String(error)}`, "error");
							}
						}
					}
				}
			}

			if (shellAvailable && (await confirm(
				"Apply host identity to ordinary shells?",
				"This will use the same resting host color for shell tabs that do not run Pi, on this host and on any remote host where the hook is installed.",
			))) {
				try {
					writeFileSync(SHELL_IDENTITY_ENABLED_PATH, "enabled\n", { encoding: "utf8", mode: 0o600 });
					results.push("ordinary shell host identity: enabled");
					shellIdentityEnabled = true;
				} catch (error) {
					ctx.ui.notify(`Shell identity install failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}

			if (isDarwin && shellAvailable && (await confirm(
				"Offer to run restore commands?",
				'This will ask "Run it now? [y/N]" after printing a restore command. Press y to run it immediately; any other key declines.',
			))) {
				const error = updateConfigFile((raw) => {
					raw.promptRestore = true;
				});
				if (error) ctx.ui.notify(error, "error");
				else results.push("restore execution prompt: enabled");
			}

			const nextSteps: string[] = [];
			if (daemonInstalled) {
				nextSteps.push("Enable the iTerm2 Python API, install its Python runtime, and restart iTerm2.");
			}
			if (shellInstalled) {
				nextSteps.push(
					shellConfigured
						? "Reload the configured shell file or open a new shell."
						: `Add '${SHELL_SOURCE_LINE}' to your shell rc file, then reload it.`,
				);
			} else if (shellIdentityEnabled) {
				nextSteps.push("Reload your shell rc file or open a new shell.");
			}
			const summary = results.length > 0 ? `Installed:\n${results.join("\n")}` : "Nothing installed.";
			ctx.ui.notify(nextSteps.length > 0 ? `${summary}\n\nNext:\n${nextSteps.join("\n")}` : summary, "info");
		},
	});

	if (!active) return;

	const host = hostname();
	const user = currentUser();
	const status: StatusState = { agentRunning: false, promptOpen: false, hadError: false };
	let sessionId = "";
	let sessionDisplayName = ""; // empty when unnamed; used for the tab title only
	let identity: SessionIdentity = { cwd: "", sessionId: "", sessionName: "", instanceId: "", user, host };
	let workingFrame = 0;
	let workingTimer: NodeJS.Timeout | undefined;
	// Read once per session rather than watched: the color is a property of the machine, so it
	// effectively never changes mid-session. /iterm2-color refresh re-reads it on demand.
	let vscodeHue = config.vscodeColor ? readVsCodeHue() : undefined;

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
	// working, a timer matches Pi's 80ms Working spinner; any other status
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
		write(ctx, buildStatusSequences(config, identity, sessionId, deriveStatus(status), vscodeHue));
		pushTitle(ctx);
	};

	/** Session identity, including the exact resting host color the local daemon records. */
	const pushIdentity = (ctx: ExtensionContext) => {
		const hue = hostHue(host, config.palette, config.hostColors, vscodeHue);
		write(ctx, buildIdentitySequences(config, identity, tabColorForHue(hue, "idle")));
	};

	const pushColorChange = (ctx: ExtensionContext) => {
		// Publish status before the identity sequence's snapshot triggers.
		pushStatus(ctx);
		pushIdentity(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		stopWorkingTimer();
		sessionId = ctx.sessionManager.getSessionId();
		sessionDisplayName = ctx.sessionManager.getSessionName() ?? "";
		identity = {
			cwd: ctx.cwd,
			sessionId,
			sessionName: sessionDisplayName || sessionId,
			instanceId: randomUUID(),
			user,
			host,
		};
		status.agentRunning = false;
		status.promptOpen = false;
		status.hadError = false;

		if (configWarning) {
			ctx.ui.notify(configWarning, "warning");
			configWarning = undefined;
		}

		// pi_status must be set before the identity sequence's snapshot triggers.
		pushStatus(ctx);
		pushIdentity(ctx);
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

	// Picking a color is a look-at-it task, so these apply to the live tab immediately and
	// persist to the config file, rather than making you edit JSON and /reload to see it.
	// The typed spec is stored verbatim ("#4a7ba7" stays "#4a7ba7"), not the derived hue.
	const spreadHint = () =>
		config.sessionHueSpread > 0
			? ` Sessions are still nudged ±${config.sessionHueSpread / 2}°; set sessionHueSpread to 0 for exactly this hue.`
			: "";

	/**
	 * A swatch plus the value behind it. The hue is always shown since that's the canonical
	 * stored form; the original spec is shown alongside when it was written as a hex, so
	 * "#4a7ba7" doesn't decay into a bare "208°" the moment you look at it again.
	 */
	const describeColor = (hue: number, spec?: unknown): string => {
		const degrees = `${Math.round(hue)}°`;
		// Only a hex spec adds information; a spec that is already a number would just
		// render as "120 (120°)", and reads differently depending on whether it came back
		// from JSON as a number or from a command as a string.
		const hex = typeof spec === "string" && !/^[+-]?\d+(\.\d+)?$/.test(spec.trim()) ? spec.trim() : undefined;
		return hex ? `${hueSwatch(hue)} ${hex} (${degrees})` : `${hueSwatch(hue)} ${degrees}`;
	};

	/** The config file as written, for recovering the specs the user actually typed. */
	const readRawConfig = (): Record<string, unknown> => {
		try {
			const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			return isPlainObject(parsed) ? parsed : {};
		} catch {
			return {};
		}
	};

	const storedSpecs = (key: "palette" | "hostColors"): unknown => readRawConfig()[key];

	/** Where the host's hue is coming from right now, for the no-argument report. */
	const hueSource = (): string => {
		if (vscodeHue !== undefined) return "the VS Code window color";
		return config.palette.length ? "palette" : "hash";
	};

	pi.registerCommand("iterm2-color", {
		description: "Show, set, or clear this host's pinned tab color (e.g. /iterm2-color #4a7ba7)",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const pinned = config.hostColors[host];
			if (!arg) {
				ctx.ui.notify(
					pinned === undefined
						? `${host} ${describeColor(hostHue(host, config.palette, config.hostColors, vscodeHue))} from ${hueSource()}, not pinned. Set one with /iterm2-color <#rrggbb|hue>.`
						: `${host} pinned to ${describeColor(pinned, (storedSpecs("hostColors") as Record<string, unknown> | undefined)?.[host])}, overriding ${hueSource()}. Clear it with /iterm2-color clear.`,
					"info",
				);
				return;
			}
			// Re-reads the VS Code color, for the case where it was changed while this session
			// was already running.
			if (arg === "refresh") {
				if (!config.vscodeColor) {
					ctx.ui.notify('VS Code color reading is off; set "vscodeColor": true to enable it.', "error");
					return;
				}
				vscodeHue = readVsCodeHue();
				pushColorChange(ctx);
				ctx.ui.notify(
					vscodeHue === undefined
						? `No VS Code window color set for ${host}; using ${config.palette.length ? "the palette" : "the hash"}.`
						: `VS Code window color for ${host} is now ${describeColor(vscodeHue)}${pinned === undefined ? "" : " (still overridden by the pinned color)"}.`,
					"info",
				);
				return;
			}
			if (arg === "clear" || arg === "none") {
				delete config.hostColors[host];
				const error = updateConfigFile((raw) => {
					if (isPlainObject(raw.hostColors)) delete raw.hostColors[host];
				});
				if (error) return ctx.ui.notify(error, "error");
				pushColorChange(ctx);
				ctx.ui.notify(`Cleared the pinned color for ${host}; back to ${hueSource()}.`, "info");
				return;
			}
			const hue = parseColorSpec(arg);
			if (hue === undefined) {
				ctx.ui.notify(`"${arg}" is not a hue 0-359 or a #rrggbb color.`, "error");
				return;
			}
			config.hostColors[host] = hue;
			const error = updateConfigFile((raw) => {
				const existing = isPlainObject(raw.hostColors) ? raw.hostColors : {};
				existing[host] = /^\d+$/.test(arg) ? Number(arg) : arg;
				raw.hostColors = existing;
			});
			if (error) return ctx.ui.notify(error, "error");
			pushColorChange(ctx);
			ctx.ui.notify(`${host} pinned to ${describeColor(hue, arg)}.${spreadHint()}`, "info");
		},
	});

	pi.registerCommand("iterm2-palette", {
		description: "Show, set, or clear the palette hosts are colored from (e.g. /iterm2-palette #4a7ba7 #a74a5c)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				ctx.ui.notify(
					config.palette.length === 0
						? "No palette set; host hues come from the full 0-360° wheel. Set one with /iterm2-palette <color> <color> ..."
						: `Palette: ${config.palette.map((hue, index) => describeColor(hue, (storedSpecs("palette") as unknown[] | undefined)?.[index])).join("  ")}. Clear it with /iterm2-palette clear.`,
					"info",
				);
				return;
			}
			if (parts.length === 1 && (parts[0] === "clear" || parts[0] === "none")) {
				config.palette = [];
				const error = updateConfigFile((raw) => {
					delete raw.palette;
				});
				if (error) return ctx.ui.notify(error, "error");
				pushColorChange(ctx);
				ctx.ui.notify("Cleared the palette; host hues use the full wheel again.", "info");
				return;
			}
			const hues: number[] = [];
			for (const part of parts) {
				const hue = parseColorSpec(part);
				if (hue === undefined) {
					ctx.ui.notify(`"${part}" is not a hue 0-359 or a #rrggbb color.`, "error");
					return;
				}
				hues.push(hue);
			}
			config.palette = hues;
			const error = updateConfigFile((raw) => {
				raw.palette = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : part));
			});
			if (error) return ctx.ui.notify(error, "error");
			pushColorChange(ctx);
			// The palette only decides hues for hosts that aren't already colored some other way,
			// so say so rather than leaving someone to wonder why this tab didn't change.
			const pinnedNote =
				config.hostColors[host] !== undefined
					? ` (${host} stays pinned; /iterm2-color clear to unpin)`
					: vscodeHue !== undefined
						? ` (${host} keeps its VS Code window color; set "vscodeColor": false in ${CONFIG_PATH} to use the palette here)`
						: "";
			ctx.ui.notify(`Palette set: ${hues.map((hue, index) => describeColor(hue, parts[index])).join("  ")}${pinnedNote}.${spreadHint()}`, "info");
		},
	});
}
