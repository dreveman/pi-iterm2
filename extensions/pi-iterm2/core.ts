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

export const DEFAULT_SESSION_HUE_SPREAD = 40; // session hue offset ranges over [-spread/2, spread/2)

/**
 * Hue bucket for a host, the dominant factor in tab color. An explicit pin for this host
 * wins; then a color this host already advertises elsewhere (see vsCodeHueFromSettings),
 * so the tab agrees with whatever else is colored per-machine; otherwise a palette, when
 * configured, constrains the choice to those hues instead of the whole wheel; otherwise the
 * hash spreads over the full 0-360 range.
 */
export function hostHue(host: string, palette: number[] = [], hostHues: Record<string, number> = {}, externalHue?: number): number {
	const pinned = hostHues[host];
	if (pinned !== undefined) return pinned;
	if (externalHue !== undefined) return externalHue;
	if (palette.length > 0) return palette[hashString(`host:${host}`) % palette.length]!;
	return hashString(`host:${host}`) % 360;
}

/** Small hue nudge for a session, layered on top of the host hue. A spread of 0 disables it. */
export function sessionHueOffset(sessionId: string, spread: number = DEFAULT_SESSION_HUE_SPREAD): number {
	if (spread <= 0) return 0;
	return (hashString(`session:${sessionId}`) % spread) - spread / 2;
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

/** Pi's default Working spinner frames, kept in the same order as its TUI loader. */
export const WORKING_ICON_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

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

/** Hue of an RGB color, in degrees [0,360). Grey has no meaningful hue, so it maps to 0. */
export function rgbToHue({ r, g, b }: Rgb): number {
	const rN = r / 255;
	const gN = g / 255;
	const bN = b / 255;
	const max = Math.max(rN, gN, bN);
	const delta = max - Math.min(rN, gN, bN);
	if (delta === 0) return 0;
	let hue: number;
	if (max === rN) hue = ((gN - bN) / delta) % 6;
	else if (max === gN) hue = (bN - rN) / delta + 2;
	else hue = (rN - gN) / delta + 4;
	return ((hue * 60) % 360 + 360) % 360;
}

/**
 * A configured color, given either as a hue in degrees or as a `#rrggbb` string. Only the
 * hue is taken from a hex color on purpose: saturation and lightness stay reserved for
 * conveying agent status, which is the point of the tab color in the first place.
 */
export function parseColorSpec(value: unknown): number | undefined {
	const wrap = (hue: number) => ((hue % 360) + 360) % 360;
	if (typeof value === "number") return Number.isFinite(value) ? wrap(value) : undefined;
	if (typeof value !== "string") return undefined;
	const text = value.trim();

	// Hex is matched before a plain number so a bare six-digit string stays a color
	// ("123456" is #123456, not hue 123456). Everything arriving from a slash command is a
	// string, so a hue typed as text has to parse here too, not just as a JSON number.
	const hex = /^#?([0-9a-fA-F]{6})$/.exec(text);
	if (hex) {
		const int = Number.parseInt(hex[1]!, 16);
		return rgbToHue({ r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff });
	}
	if (/^[+-]?\d+(\.\d+)?$/.test(text)) return wrap(Number(text));
	return undefined;
}

/**
 * Entries of VS Code's `workbench.colorCustomizations` that describe "the color of this
 * window", most specific first. The title bar is the primary signal; the activity bar is a
 * darker shade of the same color, so it only serves as a fallback for a settings file that
 * colors it alone.
 */
export const VSCODE_COLOR_KEYS = [
	"titleBar.activeBackground",
	"titleBar.inactiveBackground",
	"activityBar.background",
] as const;

/**
 * Hue of a CSS hex color in any of the forms VS Code accepts: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`. Alpha is discarded along with saturation and lightness, since only the hue
 * is ever taken from an external color.
 *
 * The leading `#` is required, unlike parseColorSpec's optional one, so that shorthand can
 * be supported here without changing what a bare number means there: "123" stays hue 123
 * rather than becoming #112233.
 */
export function hueFromCssHex(value: string): number | undefined {
	const digits = /^#([0-9a-fA-F]{3,8})$/.exec(value.trim())?.[1];
	if (digits === undefined) return undefined;
	// #rgb and #rgba are shorthand for doubled digits (#abc is #aabbcc); the 4th and 8th
	// digits are alpha, which is dropped.
	const sixDigits =
		digits.length === 3 || digits.length === 4
			? digits
					.slice(0, 3)
					.split("")
					.map((digit) => digit + digit)
					.join("")
			: digits.length === 6 || digits.length === 8
				? digits.slice(0, 6)
				: undefined;
	if (sixDigits === undefined) return undefined;
	const int = Number.parseInt(sixDigits, 16);
	return rgbToHue({ r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff });
}

/**
 * Strips `//` and block comments and trailing commas, so a hand-edited VS Code settings
 * file still parses. VS Code reads its own settings as JSONC; tools that write the file
 * emit strict JSON, but a human who has been in there may not have.
 *
 * Comment markers inside strings are left alone, which is what makes this worth a small
 * scanner rather than a regex.
 */
export function stripJsonComments(text: string): string {
	const out: string[] = [];
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	// Index in `out` of a comma that may turn out to be trailing, resolved when the next
	// meaningful character arrives: dropped if that character closes the object or array,
	// kept otherwise. Deciding it here, mid-scan, rather than with a regex over the finished
	// text is what keeps a string value containing ",}" from being rewritten -- the whole
	// point of scanning with string-awareness in the first place.
	let pendingComma: number | undefined;
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		const next = text[i + 1];
		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				// Kept so line numbers survive, and harmless to a pending comma: a newline is
				// whitespace, which never resolves one.
				out.push(char);
			}
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out.push(char);
			if (char === "\\") {
				// Copy the escaped character verbatim so an escaped quote can't end the string.
				if (next !== undefined) {
					out.push(next);
					i++;
				}
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		// Whitespace and comments are allowed to sit between a trailing comma and the bracket
		// that makes it trailing, so only a meaningful character resolves the pending comma.
		if (!/\s/.test(char)) {
			if (pendingComma !== undefined && (char === "}" || char === "]")) out[pendingComma] = "";
			pendingComma = char === "," ? out.length : undefined;
		}
		if (char === '"') inString = true;
		out.push(char);
	}
	return out.join("");
}

/** JSON first, JSONC only as a fallback, so a strict file never pays for the scanner. */
function parseJsonc(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		try {
			return JSON.parse(stripJsonComments(text)) as unknown;
		} catch {
			return undefined;
		}
	}
}

/**
 * Hue of the window color recorded in one VS Code machine-scope settings file, or undefined
 * when there is nothing usable there. Anything unexpected -- unparseable file, missing key,
 * an empty `workbench.colorCustomizations` (which is how the color gets turned off), a
 * value that isn't a hex color -- reads as "no color", because the caller's fallback is a
 * perfectly good color and a terminal tab is no place to report someone else's broken JSON.
 *
 * Note that a fully grey color has no hue and so resolves to 0, i.e. red, per rgbToHue.
 */
export function vsCodeHueFromSettings(text: string): number | undefined {
	const parsed = parseJsonc(text);
	if (!isRecord(parsed)) return undefined;
	const colors = parsed["workbench.colorCustomizations"];
	if (!isRecord(colors)) return undefined;
	for (const key of VSCODE_COLOR_KEYS) {
		const value = colors[key];
		if (typeof value !== "string") continue;
		const hue = hueFromCssHex(value);
		if (hue !== undefined) return hue;
	}
	return undefined;
}

/** The tab color a given hue produces at a given status, i.e. hue plus the status brightness. */
export function tabColorForHue(hue: number, status: AgentStatus = "idle"): Rgb {
	const style = STATUS_STYLE[status];
	return hslToRgb(hue, style.saturation, style.lightness);
}

/** Combine host, session, and status into one tab color: host sets hue, session nudges it, status sets brightness. */
export function computeTabColorRgb(
	config: PiIterm2Config,
	host: string,
	sessionId: string,
	status: AgentStatus,
	externalHue?: number,
): Rgb {
	const hue =
		(hostHue(host, config.palette, config.hostColors, externalHue) +
			sessionHueOffset(sessionId, config.sessionHueSpread) +
			360) %
		360;
	return tabColorForHue(hue, status);
}

/** Stable serialized form published so the local daemon knows a remote host's exact color. */
export function rgbToHex(rgb: Rgb): string {
	return `#${rgb.r.toString(16).padStart(2, "0")}${rgb.g.toString(16).padStart(2, "0")}${rgb.b.toString(16).padStart(2, "0")}`;
}

/**
 * A solid two-cell block in the given color, for previewing a color inline in command
 * output. Uses a truecolor background rather than a glyph so it renders as a filled swatch
 * in any font. Closes with a background-only reset (49) rather than a full reset (0) so it
 * cannot clobber the styling of whatever text it is embedded in.
 */
export function colorSwatch(rgb: Rgb): string {
	return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m  \x1b[49m`;
}

/** Swatch for a hue at its resting (idle) tab brightness, which is what a host's color "is". */
export function hueSwatch(hue: number): string {
	return colorSwatch(tabColorForHue(hue, "idle"));
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
	/** Ask before running a displayed restore command from the shell hook. */
	promptRestore: boolean;
	/** Hues hosts are assigned from. Empty means the full 0-360 wheel. */
	palette: number[];
	/** Hostname -> hue, pinning specific machines regardless of hash or palette. */
	hostColors: Record<string, number>;
	/** Take the host's hue from the VS Code window color, when one is set for this machine. */
	vscodeColor: boolean;
	/** Degrees of per-session hue nudge around the host hue; 0 pins every session to it exactly. */
	sessionHueSpread: number;
}

/** A fresh config every call: `palette` and `hostColors` are nested, so a shared constant
 *  would hand every caller the same array/object to mutate. */
export function defaultConfig(): PiIterm2Config {
	return {
		enabled: "auto",
		tabColor: true,
		tabTitle: true,
		currentDir: true,
		userVars: true,
		promptRestore: false,
		vscodeColor: true,
		palette: [],
		hostColors: {},
		sessionHueSpread: DEFAULT_SESSION_HUE_SPREAD,
	};
}

/** Convenience snapshot of the defaults; use defaultConfig() when a mutable copy is needed. */
export const DEFAULT_CONFIG: PiIterm2Config = defaultConfig();

export interface ConfigResult {
	config: PiIterm2Config;
	warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BOOLEAN_FIELDS = ["tabColor", "tabTitle", "currentDir", "userVars", "promptRestore", "vscodeColor"] as const;

const COLOR_HINT = "a hue 0-359 or a \"#rrggbb\" color";

export function parseConfig(value: unknown): ConfigResult {
	// A fresh config, never the shared DEFAULT_CONFIG, so a caller mutating a returned
	// config (or its nested palette/hostColors) can't corrupt the defaults process-wide.
	const fail = (warning: string): ConfigResult => ({ config: defaultConfig(), warning });
	if (!isRecord(value)) return fail("configuration must be a JSON object");

	const knownKeys = new Set<string>(["enabled", ...BOOLEAN_FIELDS, "palette", "hostColors", "sessionHueSpread"]);
	const unknownKeys = Object.keys(value).filter((key) => !knownKeys.has(key));
	if (unknownKeys.length > 0) {
		return fail(`unknown configuration field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`);
	}

	if (value.enabled !== undefined && value.enabled !== "auto" && typeof value.enabled !== "boolean") {
		return fail(`enabled must be true, false, or "auto"`);
	}

	for (const field of BOOLEAN_FIELDS) {
		if (value[field] !== undefined && typeof value[field] !== "boolean") {
			return fail(`${field} must be a boolean`);
		}
	}

	const config = defaultConfig();

	if (value.palette !== undefined) {
		if (!Array.isArray(value.palette)) return fail("palette must be an array of colors");
		if (value.palette.length === 0) return fail("palette must not be empty; omit it to use the full hue range");
		const hues: number[] = [];
		for (const entry of value.palette) {
			const hue = parseColorSpec(entry);
			if (hue === undefined) return fail(`palette entry ${JSON.stringify(entry)} must be ${COLOR_HINT}`);
			hues.push(hue);
		}
		config.palette = hues;
	}

	if (value.hostColors !== undefined) {
		if (!isRecord(value.hostColors)) return fail("hostColors must be an object mapping hostname to a color");
		for (const [host, entry] of Object.entries(value.hostColors)) {
			const hue = parseColorSpec(entry);
			if (hue === undefined) return fail(`hostColors["${host}"] must be ${COLOR_HINT}`);
			config.hostColors[host] = hue;
		}
	}

	if (value.sessionHueSpread !== undefined) {
		const spread = value.sessionHueSpread;
		if (typeof spread !== "number" || !Number.isFinite(spread) || spread < 0 || spread > 360) {
			return fail("sessionHueSpread must be a number between 0 and 360");
		}
		config.sessionHueSpread = spread;
	}

	config.enabled = (value.enabled as EnabledSetting | undefined) ?? config.enabled;
	for (const field of BOOLEAN_FIELDS) {
		config[field] = (value[field] as boolean | undefined) ?? config[field];
	}
	return { config };
}

export function parseConfigText(text: string): ConfigResult {
	try {
		return parseConfig(JSON.parse(text) as unknown);
	} catch (error) {
		return {
			config: defaultConfig(),
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
	sessionId: string;
	sessionName: string;
	instanceId: string;
	user: string;
	host: string;
}

/**
 * Everything that reflects live agent status. Tab color and the pi_status user var are
 * built together, in one place, so a status change can never update one and silently miss
 * the other. Returned as a single batched string: wrapForTmux then wraps the whole batch
 * once, per its contract, instead of once per inner OSC.
 */
export function buildStatusSequences(
	config: PiIterm2Config,
	identity: Pick<SessionIdentity, "host">,
	sessionId: string,
	status: AgentStatus,
	externalHue?: number,
): string {
	let out = "";
	if (config.tabColor) out += buildTabColorSequence(computeTabColorRgb(config, identity.host, sessionId, status, externalHue));
	if (config.userVars) out += buildSetUserVarSequence("pi_status", status);
	return out;
}

/** Everything that identifies the session rather than its status; only changes at session start and rename. */
export function buildIdentitySequences(config: PiIterm2Config, identity: SessionIdentity, hostColor?: Rgb): string {
	let out = "";
	if (config.userVars) {
		if (hostColor) out += buildSetUserVarSequence("pi_host_color", rgbToHex(hostColor));
		out += buildSetUserVarSequence("pi_session", identity.sessionName);
		out += buildSetUserVarSequence("pi_session_id", identity.sessionId);
	}
	if (config.currentDir) {
		out += buildCurrentDirSequence(identity.cwd);
		out += buildRemoteHostSequence(identity.user, identity.host);
	}
	// The daemon monitors both of these as snapshot triggers. The fresh per-Pi instance
	// token is deliberately last, after every value the resulting snapshot must contain.
	if (config.userVars) {
		out += buildSetUserVarSequence("pi_cwd", identity.cwd);
		out += buildSetUserVarSequence("pi_instance", identity.instanceId);
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
		out += buildSetUserVarSequence("pi_session_id", "");
		out += buildSetUserVarSequence("pi_instance", "");
		out += buildSetUserVarSequence("pi_status", "");
		out += buildSetUserVarSequence("pi_host_color", "");
	}
	return out;
}
