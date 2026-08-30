const OSC = "\x1b]";
const BEL = "\x07";

/** FNV-1a 32-bit hash. Deterministic across platforms; used only for color derivation, not security. */
export function hashString(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

const SESSION_HUE_SPREAD = 40; // session hue offset ranges over [-20, 20)

/** Hue bucket for a host. Dominant factor in tab color so different machines are visually distinct. */
export function hostHue(host: string): number {
	return hashString(`host:${host}`) % 360;
}

/** Small hue nudge for a session, layered on top of the host hue. */
export function sessionHueOffset(sessionId: string): number {
	return (hashString(`session:${sessionId}`) % SESSION_HUE_SPREAD) - SESSION_HUE_SPREAD / 2;
}

export type AgentStatus = "idle" | "working" | "waiting" | "error";

/** Saturation/lightness per status. Status is the least significant factor in tab color. */
const STATUS_STYLE: Record<AgentStatus, { saturation: number; lightness: number }> = {
	idle: { saturation: 45, lightness: 30 },
	working: { saturation: 65, lightness: 48 },
	waiting: { saturation: 55, lightness: 62 },
	error: { saturation: 85, lightness: 38 },
};

/** Fixed tab-title icon for the non-animated statuses. Idle has none, matching pi's own default title exactly. */
const STATIC_STATUS_ICON: Record<Exclude<AgentStatus, "working">, string> = {
	idle: "",
	waiting: "◆",
	error: "✖",
};

/** The four rotations of the same half-circle glyph, cycled for a spinning "working" indicator. */
export const WORKING_ICON_FRAMES = ["◐", "◓", "◑", "◒"] as const;

/** Which icon to show right now: a rotating frame while working, a fixed icon otherwise. */
export function statusIcon(status: AgentStatus, workingFrame: number): string {
	if (status === "working") return WORKING_ICON_FRAMES[workingFrame % WORKING_ICON_FRAMES.length]!;
	return STATIC_STATUS_ICON[status];
}

/**
 * Pi's own default tab title format, exactly: "π - session - cwd" when the session has an
 * explicit name (set via /name), or "π - cwd" when it doesn't — a raw session id is not a
 * useful title, so an unnamed session omits that segment entirely rather than showing one.
 * An icon is prefixed when one applies.
 */
export function buildTabTitle(icon: string, sessionName: string, cwdBasename: string): string {
	const base = sessionName ? `π - ${sessionName} - ${cwdBasename}` : `π - ${cwdBasename}`;
	return icon ? `${icon} ${base}` : base;
}

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Standard HSL -> RGB conversion. h in degrees [0,360), s/l as percentages [0,100]. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
	const sNorm = s / 100;
	const lNorm = l / 100;
	const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
	const hPrime = ((h % 360) + 360) % 360 / 60;
	const x = c * (1 - Math.abs((hPrime % 2) - 1));
	const m = lNorm - c / 2;

	let r1 = 0;
	let g1 = 0;
	let b1 = 0;
	if (hPrime < 1) [r1, g1, b1] = [c, x, 0];
	else if (hPrime < 2) [r1, g1, b1] = [x, c, 0];
	else if (hPrime < 3) [r1, g1, b1] = [0, c, x];
	else if (hPrime < 4) [r1, g1, b1] = [0, x, c];
	else if (hPrime < 5) [r1, g1, b1] = [x, 0, c];
	else [r1, g1, b1] = [c, 0, x];

	return {
		r: Math.round((r1 + m) * 255),
		g: Math.round((g1 + m) * 255),
		b: Math.round((b1 + m) * 255),
	};
}

/** Combine host, session, and status into one tab color: host sets hue, session nudges it, status sets brightness. */
export function computeTabColorRgb(host: string, sessionId: string, status: AgentStatus): Rgb {
	const hue = (hostHue(host) + sessionHueOffset(sessionId) + 360) % 360;
	const style = STATUS_STYLE[status];
	return hslToRgb(hue, style.saturation, style.lightness);
}

export interface StatusState {
	agentRunning: boolean;
	promptOpen: boolean;
	hadError: boolean;
}

/** Waiting on the user outranks a background run; a sticky error outranks idle. */
export function deriveStatus(state: StatusState): AgentStatus {
	if (state.promptOpen) return "waiting";
	if (state.agentRunning) return "working";
	if (state.hadError) return "error";
	return "idle";
}

/** Strip control bytes so cwd/host/user strings can't break out of a raw (non-base64) OSC payload. */
export function sanitizeOscText(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-byte strip
	return value.replace(/[\x00-\x1f\x7f]/g, "");
}

function base64Utf8(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

const USER_VAR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Set an iTerm2 user-defined variable (\(user.name) in badges/titles). Value is base64-encoded, so it needs no sanitizing. */
export function buildSetUserVarSequence(name: string, value: string): string {
	if (!USER_VAR_NAME_PATTERN.test(name)) throw new Error(`invalid user var name: ${JSON.stringify(name)}`);
	return `${OSC}1337;SetUserVar=${name}=${base64Utf8(value)}${BEL}`;
}

/** iTerm2's native cwd-tracking sequence (semantic history, new-tab/split directory inheritance). */
export function buildCurrentDirSequence(path: string): string {
	return `${OSC}1337;CurrentDir=${sanitizeOscText(path)}${BEL}`;
}

/** Companion to CurrentDir: who owns this session. */
export function buildRemoteHostSequence(user: string, host: string): string {
	return `${OSC}1337;RemoteHost=${sanitizeOscText(user)}@${sanitizeOscText(host)}${BEL}`;
}

/** Set the tab/title-bar background color, one escape sequence per RGB channel. */
export function buildTabColorSequence(rgb: Rgb): string {
	return (
		`${OSC}6;1;bg;red;brightness;${rgb.r}${BEL}` +
		`${OSC}6;1;bg;green;brightness;${rgb.g}${BEL}` +
		`${OSC}6;1;bg;blue;brightness;${rgb.b}${BEL}`
	);
}

/** Restore the tab/title-bar color to the profile default. */
export function buildResetTabColorSequence(): string {
	return `${OSC}6;1;bg;*;default${BEL}`;
}

/**
 * tmux swallows OSC sequences it doesn't recognize unless they're wrapped in its DCS
 * passthrough envelope: ESC Ptmux; <payload with every ESC doubled> ESC \. Apply once to
 * the whole batched write, not per inner OSC call.
 */
export function wrapForTmux(sequence: string, inTmux: boolean): string {
	if (!inTmux) return sequence;
	return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

export type EnabledSetting = boolean | "auto";

export interface PiIterm2Config {
	enabled: EnabledSetting;
	tabColor: boolean;
	tabTitle: boolean;
	currentDir: boolean;
	userVars: boolean;
}

export const DEFAULT_CONFIG: PiIterm2Config = {
	enabled: "auto",
	tabColor: true,
	tabTitle: true,
	currentDir: true,
	userVars: true,
};

export interface ConfigResult {
	config: PiIterm2Config;
	warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BOOLEAN_FIELDS = ["tabColor", "tabTitle", "currentDir", "userVars"] as const;

export function parseConfig(value: unknown): ConfigResult {
	// A fresh copy, never the shared DEFAULT_CONFIG reference, so a caller mutating a
	// returned config can't corrupt the defaults for the rest of the process.
	const fallback = { config: { ...DEFAULT_CONFIG } };
	if (!isRecord(value)) return { ...fallback, warning: "configuration must be a JSON object" };

	const knownKeys = new Set<string>(["enabled", ...BOOLEAN_FIELDS]);
	const unknownKeys = Object.keys(value).filter((key) => !knownKeys.has(key));
	if (unknownKeys.length > 0) {
		return { ...fallback, warning: `unknown configuration field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}` };
	}

	if (value.enabled !== undefined && value.enabled !== "auto" && typeof value.enabled !== "boolean") {
		return { ...fallback, warning: `enabled must be true, false, or "auto"` };
	}

	for (const field of BOOLEAN_FIELDS) {
		if (value[field] !== undefined && typeof value[field] !== "boolean") {
			return { ...fallback, warning: `${field} must be a boolean` };
		}
	}

	return {
		config: {
			enabled: (value.enabled as EnabledSetting | undefined) ?? DEFAULT_CONFIG.enabled,
			tabColor: (value.tabColor as boolean | undefined) ?? DEFAULT_CONFIG.tabColor,
			tabTitle: (value.tabTitle as boolean | undefined) ?? DEFAULT_CONFIG.tabTitle,
			currentDir: (value.currentDir as boolean | undefined) ?? DEFAULT_CONFIG.currentDir,
			userVars: (value.userVars as boolean | undefined) ?? DEFAULT_CONFIG.userVars,
		},
	};
}

export function parseConfigText(text: string): ConfigResult {
	try {
		return parseConfig(JSON.parse(text) as unknown);
	} catch (error) {
		return {
			config: { ...DEFAULT_CONFIG },
			warning: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Only iTerm2 understands these sequences; "auto" detects it via TERM_PROGRAM. */
export function shouldActivate(enabled: EnabledSetting, env: NodeJS.ProcessEnv): boolean {
	if (enabled === "auto") return env.TERM_PROGRAM === "iTerm.app";
	return enabled;
}

export interface SessionIdentity {
	cwd: string;
	sessionName: string;
	user: string;
	host: string;
}

/**
 * Everything that reflects live agent status. Tab color and the pi_status user var are
 * built together, in one place, so a status change can never update one and silently miss
 * the other. Returned as a single batched string: wrapForTmux then wraps the whole batch
 * once, per its contract, instead of once per inner OSC.
 */
export function buildStatusSequences(config: PiIterm2Config, identity: Pick<SessionIdentity, "host">, sessionId: string, status: AgentStatus): string {
	let out = "";
	if (config.tabColor) out += buildTabColorSequence(computeTabColorRgb(identity.host, sessionId, status));
	if (config.userVars) out += buildSetUserVarSequence("pi_status", status);
	return out;
}

/** Everything that identifies the session rather than its status; only changes at session start and rename. */
export function buildIdentitySequences(config: PiIterm2Config, identity: SessionIdentity): string {
	let out = "";
	if (config.userVars) {
		out += buildSetUserVarSequence("pi_cwd", identity.cwd);
		out += buildSetUserVarSequence("pi_session", identity.sessionName);
	}
	if (config.currentDir) {
		out += buildCurrentDirSequence(identity.cwd);
		out += buildRemoteHostSequence(identity.user, identity.host);
	}
	return out;
}

/** Clears everything this extension set, for session shutdown. */
export function buildResetSequences(config: PiIterm2Config): string {
	let out = "";
	if (config.tabColor) out += buildResetTabColorSequence();
	if (config.userVars) {
		out += buildSetUserVarSequence("pi_cwd", "");
		out += buildSetUserVarSequence("pi_session", "");
		out += buildSetUserVarSequence("pi_status", "");
	}
	return out;
}
