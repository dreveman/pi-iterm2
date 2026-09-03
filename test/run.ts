import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildCurrentDirSequence,
	buildIdentitySequences,
	buildRemoteHostSequence,
	buildResetSequences,
	buildResetTabColorSequence,
	buildSetUserVarSequence,
	buildStatusSequences,
	buildTabColorSequence,
	buildTabTitle,
	colorSwatch,
	computeTabColorRgb,
	DEFAULT_CONFIG,
	defaultConfig,
	deriveStatus,
	hashString,
	hostHue,
	hueSwatch,
	parseColorSpec,
	tabColorForHue,
	rgbToHex,
	rgbToHue,
	hslToRgb,
	parseConfig,
	parseConfigText,
	sanitizeOscText,
	sessionHueOffset,
	shouldActivate,
	statusIcon,
	WORKING_ICON_FRAMES,
	wrapForTmux,
	hueFromCssHex,
	stripJsonComments,
	vsCodeHueFromSettings,
	VSCODE_COLOR_KEYS,
} from "../extensions/pi-iterm2/core.ts";
import { configureShellRc } from "../extensions/pi-iterm2/index.ts";
/** A VS Code machine settings file as the tools that colorize a window actually write it. */
function vscodeSettings(colors: Record<string, string> | undefined, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ...extra, ...(colors === undefined ? {} : { "workbench.colorCustomizations": colors }) }, null, 2);
}

/** The full block written for a preset, not just the one key, so the fallback order is exercised. */
const PRESET_COLORS = {
	"activityBar.background": "#1D4491",
	"activityBar.foreground": "#FFFFFF",
	"activityBar.inactiveForeground": "#CCCCCC",
	"titleBar.activeBackground": "#2250A8",
	"titleBar.activeForeground": "#CCCCCC",
	"titleBar.inactiveBackground": "#2250A8",
	"titleBar.inactiveForeground": "#CCCCCC",
};

let passed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (error) {
		console.error(`not ok - ${name}`);
		process.exitCode = 1;
		throw error;
	}
}

test("hashString is deterministic and varies with input", () => {
	assert.equal(hashString("host-a"), hashString("host-a"));
	assert.notEqual(hashString("host-a"), hashString("host-b"));
});

test("hostHue and sessionHueOffset stay within their ranges", () => {
	for (const host of ["laptop", "devserver-01", ""]) {
		const hue = hostHue(host);
		assert.ok(hue >= 0 && hue < 360, `hostHue(${host}) out of range: ${hue}`);
	}
	for (const session of ["abc", "session-123", ""]) {
		const offset = sessionHueOffset(session);
		assert.ok(offset >= -20 && offset < 20, `sessionHueOffset(${session}) out of range: ${offset}`);
	}
});

test("hslToRgb matches known primary colors", () => {
	assert.deepEqual(hslToRgb(0, 100, 50), { r: 255, g: 0, b: 0 });
	assert.deepEqual(hslToRgb(120, 100, 50), { r: 0, g: 255, b: 0 });
	assert.deepEqual(hslToRgb(240, 100, 50), { r: 0, g: 0, b: 255 });
	assert.deepEqual(hslToRgb(0, 0, 100), { r: 255, g: 255, b: 255 });
	assert.deepEqual(hslToRgb(0, 0, 0), { r: 0, g: 0, b: 0 });
	assert.deepEqual(hslToRgb(30, 45, 30), { r: 111, g: 77, b: 42 });
});

// shell/pi_iterm2_restore.sh repeats this derivation with shell builtins so an ordinary tab
// gets its host color without Python, on a Mac and on a remote host alike. These are the
// vectors test/daemon_test.py pins for that hook; the two implementations have to agree.
test("the resting host color agrees with the shell hook's golden vectors", () => {
	const palette = ["#8abeb7", "#81a2be", "#9575cd", "#b5bd68"].map((color) => parseColorSpec(color)!);
	assert.equal(hashString("host:golden-host"), 3016085159);
	assert.deepEqual(tabColorForHue(hostHue("golden-host")), { r: 43, g: 111, b: 42 });
	assert.deepEqual(tabColorForHue(hostHue("golden-host", palette)), { r: 104, g: 111, b: 42 });
	assert.deepEqual(tabColorForHue(parseColorSpec("#ff0000")!), { r: 111, g: 42, b: 42 });
	assert.deepEqual(tabColorForHue(hueFromCssHex("#3a7d44")!), { r: 42, g: 111, b: 52 });
});

test("computeTabColorRgb varies by host, session, and status but is stable for the same inputs", () => {
	const cfg = DEFAULT_CONFIG;
	const base = computeTabColorRgb(cfg, "host-a", "session-1", "idle");
	assert.deepEqual(computeTabColorRgb(cfg, "host-a", "session-1", "idle"), base);
	assert.notDeepEqual(computeTabColorRgb(cfg, "host-b", "session-1", "idle"), base);
	assert.notDeepEqual(computeTabColorRgb(cfg, "host-a", "session-2", "idle"), base);
	assert.notDeepEqual(computeTabColorRgb(cfg, "host-a", "session-1", "working"), base);
});

test("deriveStatus prioritizes waiting, then running, then a sticky error, then idle", () => {
	assert.equal(deriveStatus({ agentRunning: false, promptOpen: false, hadError: false }), "idle");
	assert.equal(deriveStatus({ agentRunning: true, promptOpen: false, hadError: false }), "working");
	assert.equal(deriveStatus({ agentRunning: false, promptOpen: false, hadError: true }), "error");
	assert.equal(deriveStatus({ agentRunning: true, promptOpen: true, hadError: true }), "waiting");
	assert.equal(deriveStatus({ agentRunning: true, promptOpen: false, hadError: true }), "working");
});

test("sanitizeOscText strips control bytes but keeps normal text", () => {
	assert.equal(sanitizeOscText("/Users/dave/proj\x07\x1b]6;evil"), "/Users/dave/proj]6;evil");
	assert.equal(sanitizeOscText("plain text"), "plain text");
});

test("buildTabColorSequence emits one OSC 6 sequence per channel", () => {
	const seq = buildTabColorSequence({ r: 1, g: 2, b: 3 });
	assert.equal(seq, "\x1b]6;1;bg;red;brightness;1\x07\x1b]6;1;bg;green;brightness;2\x07\x1b]6;1;bg;blue;brightness;3\x07");
});

test("buildResetTabColorSequence restores the profile default", () => {
	assert.equal(buildResetTabColorSequence(), "\x1b]6;1;bg;*;default\x07");
});

test("buildTabTitle matches pi's own default format with no icon prefix", () => {
	assert.equal(buildTabTitle("", "my-session", "pi-iterm2"), "π - my-session - pi-iterm2");
});

test("buildTabTitle omits the session segment entirely when unnamed, matching pi's own bare title", () => {
	assert.equal(buildTabTitle("", "", "pi-iterm2"), "π - pi-iterm2");
	assert.equal(buildTabTitle("◆", "", "pi-iterm2"), "◆ π - pi-iterm2");
});

test("buildTabTitle prefixes whatever icon it's given", () => {
	assert.equal(buildTabTitle("◆", "s", "cwd"), "◆ π - s - cwd");
});

test("statusIcon is empty for idle and a fixed glyph for waiting/error", () => {
	assert.equal(statusIcon("idle", 0), "");
	assert.equal(statusIcon("waiting", 3), "◆");
	assert.equal(statusIcon("error", 3), "✖");
});

test("statusIcon cycles through Pi's Working spinner frames and wraps around", () => {
	assert.deepEqual(WORKING_ICON_FRAMES, ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
	const seen = WORKING_ICON_FRAMES.map((_, i) => statusIcon("working", i));
	assert.deepEqual(seen, [...WORKING_ICON_FRAMES]);
	assert.equal(statusIcon("working", WORKING_ICON_FRAMES.length), WORKING_ICON_FRAMES[0]);
	assert.equal(statusIcon("working", WORKING_ICON_FRAMES.length + 1), WORKING_ICON_FRAMES[1]);
});

test("buildSetUserVarSequence base64-encodes the value and validates the name", () => {
	const seq = buildSetUserVarSequence("pi_cwd", "/tmp/x");
	assert.equal(seq, `\x1b]1337;SetUserVar=pi_cwd=${Buffer.from("/tmp/x").toString("base64")}\x07`);
	assert.throws(() => buildSetUserVarSequence("bad name", "x"));
	assert.throws(() => buildSetUserVarSequence("1leading-digit", "x"));
});

test("buildCurrentDirSequence and buildRemoteHostSequence sanitize raw payloads", () => {
	assert.equal(buildCurrentDirSequence("/tmp/x\x07evil"), "\x1b]1337;CurrentDir=/tmp/xevil\x07");
	assert.equal(buildRemoteHostSequence("dave\x1b", "host\x07"), "\x1b]1337;RemoteHost=dave@host\x07");
});

test("parseConfig applies defaults, validates types, and rejects unknown fields", () => {
	assert.deepEqual(parseConfig({}), { config: DEFAULT_CONFIG });
	assert.deepEqual(parseConfig({ enabled: true, tabColor: false }).config, {
		...DEFAULT_CONFIG,
		enabled: true,
		tabColor: false,
	});
	assert.ok(parseConfig(null).warning);
	assert.ok(parseConfig({ enabled: "sometimes" }).warning);
	assert.ok(parseConfig({ tabColor: "yes" }).warning);
	assert.ok(parseConfig({ typo: true }).warning);
	assert.ok(parseConfigText("{").warning);
});

const IDENTITY = {
	cwd: "/proj",
	sessionId: "session-id",
	sessionName: "sess",
	instanceId: "instance-1",
	user: "dave",
	host: "box",
};

test("buildStatusSequences publishes pi_status for every status, not just idle", () => {
	// Regression guard: the status var was previously only written from the session-start
	// and settle paths, so a badge bound to \(user.pi_status) read "idle" for a whole run.
	for (const status of ["idle", "working", "waiting", "error"] as const) {
		const seq = buildStatusSequences(DEFAULT_CONFIG, IDENTITY, "s1", status);
		assert.equal(
			seq.includes(buildSetUserVarSequence("pi_status", status)),
			true,
			`status ${status} did not publish pi_status`,
		);
	}
});

test("buildStatusSequences batches tab color and pi_status into one string", () => {
	const seq = buildStatusSequences(DEFAULT_CONFIG, IDENTITY, "s1", "working");
	assert.equal(seq.includes(buildTabColorSequence(computeTabColorRgb(DEFAULT_CONFIG, "box", "s1", "working"))), true);
	// One batch means wrapForTmux wraps once, per its documented contract.
	assert.equal(wrapForTmux(seq, true).match(/\x1bPtmux;/g)?.length, 1);
});

test("buildStatusSequences honors the tabColor and userVars toggles independently", () => {
	assert.equal(buildStatusSequences({ ...DEFAULT_CONFIG, tabColor: false }, IDENTITY, "s1", "working").includes("]6;1;bg"), false);
	assert.equal(buildStatusSequences({ ...DEFAULT_CONFIG, userVars: false }, IDENTITY, "s1", "working").includes("pi_status"), false);
	assert.equal(buildStatusSequences({ ...DEFAULT_CONFIG, tabColor: false, userVars: false }, IDENTITY, "s1", "working"), "");
});

test("buildIdentitySequences emits cwd/session/color vars and CurrentDir/RemoteHost per config", () => {
	const hostColor = { r: 1, g: 2, b: 3 };
	const full = buildIdentitySequences(DEFAULT_CONFIG, IDENTITY, hostColor);
	assert.equal(full.includes(buildSetUserVarSequence("pi_cwd", "/proj")), true);
	assert.equal(full.includes(buildSetUserVarSequence("pi_session", "sess")), true);
	assert.equal(full.includes(buildSetUserVarSequence("pi_session_id", "session-id")), true);
	assert.equal(full.includes(buildSetUserVarSequence("pi_instance", "instance-1")), true);
	assert.equal(full.includes(buildSetUserVarSequence("pi_host_color", "#010203")), true);
	assert.equal(full.includes(buildCurrentDirSequence("/proj")), true);
	assert.equal(full.includes(buildRemoteHostSequence("dave", "box")), true);
	const trigger = full.indexOf("pi_instance");
	assert.equal(full.indexOf("pi_host_color") < trigger, true);
	assert.equal(full.indexOf("pi_session") < trigger, true);
	assert.equal(full.indexOf("pi_session_id") < trigger, true);
	assert.equal(full.indexOf("pi_cwd") < trigger, true);
	assert.equal(full.indexOf("RemoteHost") < trigger, true);

	// currentDir off must not disturb the user vars the daemon depends on.
	const noDir = buildIdentitySequences({ ...DEFAULT_CONFIG, currentDir: false }, IDENTITY);
	assert.equal(noDir.includes("CurrentDir"), false);
	assert.equal(noDir.includes("RemoteHost"), false);
	assert.equal(noDir.includes(buildSetUserVarSequence("pi_cwd", "/proj")), true);
});

test("buildResetSequences clears every var it sets and restores the default tab color", () => {
	const seq = buildResetSequences(DEFAULT_CONFIG);
	assert.equal(seq.includes(buildResetTabColorSequence()), true);
	for (const name of ["pi_cwd", "pi_session", "pi_session_id", "pi_instance", "pi_status", "pi_host_color"]) {
		assert.equal(seq.includes(buildSetUserVarSequence(name, "")), true, `${name} not cleared`);
	}
	assert.equal(buildResetSequences({ ...DEFAULT_CONFIG, tabColor: false, userVars: false }), "");
});

test("parseConfig never hands back the shared DEFAULT_CONFIG reference", () => {
	const warned = parseConfig({ typo: true }).config;
	assert.notEqual(warned, DEFAULT_CONFIG);
	warned.tabColor = false;
	assert.equal(DEFAULT_CONFIG.tabColor, true);
	const invalid = parseConfigText("{").config;
	assert.notEqual(invalid, DEFAULT_CONFIG);
	// The nested containers must be fresh too; a shallow copy would share them.
	const a = parseConfig({}).config;
	const b = parseConfig({}).config;
	a.palette.push(123);
	a.hostColors.x = 5;
	assert.deepEqual(b.palette, []);
	assert.deepEqual(b.hostColors, {});
	assert.deepEqual(DEFAULT_CONFIG.palette, []);
});

test("parseColorSpec accepts hues and #rrggbb, and rejects junk", () => {
	assert.equal(parseColorSpec(210), 210);
	assert.equal(parseColorSpec(-30), 330); // wraps into range
	assert.equal(parseColorSpec(400), 40);
	assert.equal(parseColorSpec("#ff0000"), 0);
	assert.equal(parseColorSpec("00ff00"), 120); // leading # optional
	assert.equal(parseColorSpec("#0000FF"), 240);
	assert.equal(parseColorSpec("#808080"), 0); // grey has no hue
	// Slash-command args arrive as strings, so a hue typed as text must parse as a hue...
	assert.equal(parseColorSpec("120"), 120);
	assert.equal(parseColorSpec(" 400 "), 40);
	assert.equal(parseColorSpec("-30"), 330);
	// ...but a bare six-digit string stays a hex color, not a huge hue.
	assert.equal(parseColorSpec("123456"), rgbToHue({ r: 0x12, g: 0x34, b: 0x56 }));
	for (const junk of ["red", "#fff", "#gggggg", "", null, undefined, {}, true]) {
		assert.equal(parseColorSpec(junk), undefined, `should reject ${JSON.stringify(junk)}`);
	}
});

test("rgbToHex serializes a host color for the daemon", () => {
	assert.equal(rgbToHex({ r: 0, g: 15, b: 255 }), "#000fff");
});

test("colorSwatch renders a truecolor block that can't clobber surrounding styling", () => {
	assert.equal(colorSwatch({ r: 1, g: 2, b: 3 }), "\x1b[48;2;1;2;3m  \x1b[49m");
	// A full reset (0) would kill the caller's foreground style; only the background resets.
	assert.equal(colorSwatch({ r: 1, g: 2, b: 3 }).includes("\x1b[0m"), false);
});

test("hueSwatch previews a hue at its resting tab brightness", () => {
	assert.equal(hueSwatch(120), colorSwatch(tabColorForHue(120, "idle")));
	assert.deepEqual(tabColorForHue(0, "idle"), hslToRgb(0, 45, 30));
	// Same hue, different status = different swatch, matching what the tab actually shows.
	assert.notDeepEqual(tabColorForHue(120, "idle"), tabColorForHue(120, "working"));
});

test("palette constrains host hues to the configured set", () => {
	const { config } = parseConfig({ palette: ["#ff0000", 120, "#0000ff"] });
	assert.deepEqual(config.palette, [0, 120, 240]);
	for (const host of ["a", "b", "c", "nvidia", "mbp", "prod-box"]) {
		assert.equal(config.palette.includes(hostHue(host, config.palette, config.hostColors)), true);
	}
});

test("hostColors pins a specific host and outranks the palette", () => {
	const { config } = parseConfig({ palette: ["#ff0000"], hostColors: { nvidia: "#0000ff" } });
	assert.equal(hostHue("nvidia", config.palette, config.hostColors), 240);
	assert.equal(hostHue("other", config.palette, config.hostColors), 0);
});

test("sessionHueSpread 0 pins every session to the host hue exactly", () => {
	const { config } = parseConfig({ hostColors: { h: 200 }, sessionHueSpread: 0 });
	const a = computeTabColorRgb(config, "h", "session-1", "idle");
	const b = computeTabColorRgb(config, "h", "session-2", "idle");
	assert.deepEqual(a, b);
	assert.deepEqual(a, hslToRgb(200, 45, 30));
	// The default spread keeps them distinguishable.
	const spread = parseConfig({ hostColors: { h: 200 } }).config;
	assert.notDeepEqual(
		computeTabColorRgb(spread, "h", "session-1", "idle"),
		computeTabColorRgb(spread, "h", "session-2", "idle"),
	);
});

test("status still modulates brightness on top of a pinned host color", () => {
	const { config } = parseConfig({ hostColors: { h: 200 }, sessionHueSpread: 0 });
	const idle = computeTabColorRgb(config, "h", "s", "idle");
	const working = computeTabColorRgb(config, "h", "s", "working");
	assert.notDeepEqual(idle, working);
	assert.equal(rgbToHue(idle), rgbToHue(working)); // same hue, different brightness
});

test("palette/hostColors/sessionHueSpread reject invalid input with a warning", () => {
	assert.ok(parseConfig({ palette: [] }).warning);
	assert.ok(parseConfig({ palette: "blue" }).warning);
	assert.ok(parseConfig({ palette: ["nope"] }).warning);
	assert.ok(parseConfig({ hostColors: [] }).warning);
	assert.ok(parseConfig({ hostColors: { h: "nope" } }).warning);
	assert.ok(parseConfig({ sessionHueSpread: -1 }).warning);
	assert.ok(parseConfig({ sessionHueSpread: 361 }).warning);
	assert.ok(parseConfig({ sessionHueSpread: "wide" }).warning);
});

test("shouldActivate honors explicit true/false and auto-detects iTerm2 via TERM_PROGRAM", () => {
	assert.equal(shouldActivate(true, {}), true);
	assert.equal(shouldActivate(false, { TERM_PROGRAM: "iTerm.app" }), false);
	assert.equal(shouldActivate("auto", { TERM_PROGRAM: "iTerm.app" }), true);
	assert.equal(shouldActivate("auto", { TERM_PROGRAM: "Apple_Terminal" }), false);
	assert.equal(shouldActivate("auto", {}), false);
});

test("wrapForTmux passes sequences through untouched outside tmux", () => {
	const seq = buildResetTabColorSequence();
	assert.equal(wrapForTmux(seq, false), seq);
});

test("wrapForTmux wraps in a DCS envelope and doubles inner ESC bytes inside tmux", () => {
	const seq = buildTabColorSequence({ r: 1, g: 2, b: 3 });
	const wrapped = wrapForTmux(seq, true);
	assert.equal(wrapped, `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`);
	assert.equal(wrapped.startsWith("\x1bPtmux;"), true);
	assert.equal(wrapped.endsWith("\x1b\\"), true);
});

test("hueFromCssHex accepts every hex form VS Code writes and ignores alpha", () => {
	assert.equal(hueFromCssHex("#2250A8"), rgbToHue({ r: 0x22, g: 0x50, b: 0xa8 }));
	// Shorthand doubles each digit, so #25a is #2255aa.
	assert.equal(hueFromCssHex("#25a"), hueFromCssHex("#2255aa"));
	// The 4th and 8th digits are alpha and must not change the hue.
	assert.equal(hueFromCssHex("#25af"), hueFromCssHex("#2255aa"));
	assert.equal(hueFromCssHex("#2250A866"), hueFromCssHex("#2250A8"));
	assert.equal(hueFromCssHex(" #2250A8 "), hueFromCssHex("#2250A8"));
	assert.equal(hueFromCssHex("#2250a8"), hueFromCssHex("#2250A8"));
});

test("hueFromCssHex requires a leading # so a bare hue keeps its meaning", () => {
	// parseColorSpec must keep reading "123" as hue 123; that only holds if this parser,
	// which supports 3-digit shorthand, never sees a value without the #.
	assert.equal(hueFromCssHex("123"), undefined);
	assert.equal(parseColorSpec("123"), 123);
	assert.equal(hueFromCssHex("#12"), undefined);
	assert.equal(hueFromCssHex("#123456789"), undefined);
	assert.equal(hueFromCssHex("#nothex"), undefined);
	assert.equal(hueFromCssHex(""), undefined);
});

test("a grey window color has no hue and lands on 0, per rgbToHue", () => {
	// The charcoal presets are fully desaturated, so there is no hue to match. Documented
	// rather than special-cased: rgbToHue maps grey to 0.
	assert.equal(hueFromCssHex("#212121"), 0);
	assert.equal(hueFromCssHex("#2A2A2A"), 0);
});

test("vsCodeHueFromSettings reads the title bar color out of a real settings file", () => {
	const hue = vsCodeHueFromSettings(vscodeSettings(PRESET_COLORS));
	assert.equal(hue, hueFromCssHex("#2250A8"));
});

test("vsCodeHueFromSettings ignores unrelated settings in the same file", () => {
	const text = vscodeSettings(PRESET_COLORS, { "editor.fontSize": 13, "files.autoSave": "off" });
	assert.equal(vsCodeHueFromSettings(text), hueFromCssHex("#2250A8"));
});

test("vsCodeHueFromSettings falls back through the color keys in order", () => {
	assert.deepEqual(
		[...VSCODE_COLOR_KEYS],
		["titleBar.activeBackground", "titleBar.inactiveBackground", "activityBar.background"],
	);
	assert.equal(
		vsCodeHueFromSettings(vscodeSettings({ "titleBar.inactiveBackground": "#2250A8" })),
		hueFromCssHex("#2250A8"),
	);
	assert.equal(
		vsCodeHueFromSettings(vscodeSettings({ "activityBar.background": "#1D4491" })),
		hueFromCssHex("#1D4491"),
	);
	// A non-string or unparseable value is skipped rather than ending the search.
	assert.equal(
		vsCodeHueFromSettings(
			JSON.stringify({
				"workbench.colorCustomizations": { "titleBar.activeBackground": 42, "activityBar.background": "#1D4491" },
			}),
		),
		hueFromCssHex("#1D4491"),
	);
});

test("vsCodeHueFromSettings treats anything unusable as no color", () => {
	// An empty object is how turning the color off is recorded.
	assert.equal(vsCodeHueFromSettings(vscodeSettings({})), undefined);
	assert.equal(vsCodeHueFromSettings(vscodeSettings(undefined)), undefined);
	assert.equal(vsCodeHueFromSettings("{}"), undefined);
	assert.equal(vsCodeHueFromSettings(""), undefined);
	assert.equal(vsCodeHueFromSettings("not json at all {"), undefined);
	assert.equal(vsCodeHueFromSettings("[1,2,3]"), undefined);
	assert.equal(vsCodeHueFromSettings('{"workbench.colorCustomizations": "blue"}'), undefined);
	assert.equal(vsCodeHueFromSettings(vscodeSettings({ "titleBar.activeBackground": "red" })), undefined);
});

test("stripJsonComments leaves a trailing-comma sequence inside a string alone", () => {
	// The comma here is data, not syntax. A regex pass over the finished text would eat it
	// and silently corrupt the value.
	assert.equal(stripJsonComments('{"a": "foo,}"}'), '{"a": "foo,}"}');
	assert.equal(stripJsonComments('{"a": "bar,]"}'), '{"a": "bar,]"}');
	assert.equal(stripJsonComments('{"a": "x,   }"}'), '{"a": "x,   }"}');
	assert.deepEqual(JSON.parse(stripJsonComments('{"a": "foo,}", /* c */ "b": 1,}')), { a: "foo,}", b: 1 });
});

test("stripJsonComments drops a trailing comma even with comments or whitespace after it", () => {
	assert.equal(stripJsonComments('{"a": 1, /* c */ }'), '{"a": 1  }');
	assert.equal(stripJsonComments('{"a": 1, // c\n}'), '{"a": 1 \n}');
	assert.equal(stripJsonComments('[1, 2,\n\t]'), "[1, 2\n\t]");
	// Nested closers each resolve their own pending comma.
	assert.equal(stripJsonComments('{"a": [1,],}'), '{"a": [1]}');
});

test("stripJsonComments removes comments and trailing commas but not string contents", () => {
	assert.equal(stripJsonComments('{"a": 1} // trailing'), '{"a": 1} ');
	assert.equal(stripJsonComments('{"a": 1, /* mid */ "b": 2}'), '{"a": 1,  "b": 2}');
	assert.equal(stripJsonComments('{"a": [1, 2,],}'), '{"a": [1, 2]}');
	// A // or /* inside a string is data, not a comment.
	assert.equal(stripJsonComments('{"url": "https://x/y"}'), '{"url": "https://x/y"}');
	assert.equal(stripJsonComments('{"a": "/* not a comment */"}'), '{"a": "/* not a comment */"}');
	// An escaped quote must not be read as the end of the string.
	assert.equal(stripJsonComments('{"a": "x\\"//y"}'), '{"a": "x\\"//y"}');
});

test("vsCodeHueFromSettings parses a hand-edited JSONC file", () => {
	const text = `{
		// set by hand
		"workbench.colorCustomizations": {
			/* the blue one */
			"titleBar.activeBackground": "#2250A8",
		},
	}`;
	assert.equal(vsCodeHueFromSettings(text), hueFromCssHex("#2250A8"));
});

test("hostHue precedence: pin beats VS Code color beats palette beats hash", () => {
	const palette = [10, 20, 30];
	const external = 188;
	assert.equal(hostHue("host-a", palette, { "host-a": 300 }, external), 300);
	assert.equal(hostHue("host-a", palette, {}, external), external);
	assert.ok(palette.includes(hostHue("host-a", palette, {}, undefined)));
	const hashed = hostHue("host-a", [], {}, undefined);
	assert.ok(hashed >= 0 && hashed < 360);
	// A pin for a different host must not capture this one.
	assert.equal(hostHue("host-a", [], { "host-b": 300 }, external), external);
});

test("the VS Code color reaches the tab color, and the pin still overrides it", () => {
	const cfg = { ...defaultConfig(), sessionHueSpread: 0 };
	const external = 188;
	assert.deepEqual(
		computeTabColorRgb(cfg, "host-a", "session-1", "idle", external),
		tabColorForHue(external, "idle"),
	);
	const pinned = { ...cfg, hostColors: { "host-a": 300 } };
	assert.deepEqual(
		computeTabColorRgb(pinned, "host-a", "session-1", "idle", external),
		tabColorForHue(300, "idle"),
	);
	// Omitting it leaves the previous behavior untouched.
	assert.deepEqual(
		computeTabColorRgb(cfg, "host-a", "session-1", "idle"),
		computeTabColorRgb(cfg, "host-a", "session-1", "idle", undefined),
	);
});

test("buildStatusSequences applies the VS Code hue to the tab color", () => {
	const cfg = { ...defaultConfig(), sessionHueSpread: 0, userVars: false };
	const external = 188;
	assert.equal(
		buildStatusSequences(cfg, { host: "host-a" }, "session-1", "idle", external),
		buildTabColorSequence(tabColorForHue(external, "idle")),
	);
});

test("promptRestore is a boolean config field, off by default", () => {
	assert.equal(defaultConfig().promptRestore, false);
	assert.equal(parseConfig({ promptRestore: true }).config.promptRestore, true);
	assert.match(String(parseConfig({ promptRestore: "yes" }).warning), /promptRestore must be a boolean/);
});

test("vscodeColor is a boolean config field, on by default", () => {
	assert.equal(defaultConfig().vscodeColor, true);
	assert.equal(parseConfig({ vscodeColor: false }).config.vscodeColor, false);
	assert.equal(parseConfig({ vscodeColor: false }).warning, undefined);
	assert.match(String(parseConfig({ vscodeColor: "yes" }).warning), /vscodeColor must be a boolean/);
	// Left at its default it stays out of the way of every other setting.
	assert.equal(parseConfig({ palette: ["#8abeb7"] }).config.vscodeColor, true);
});

test("configureShellRc appends or migrates guarded source lines idempotently", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-iterm2-rc-test-"));
	const guarded = 'test -e "${HOME}/.pi-iterm2/shell.sh" && source "${HOME}/.pi-iterm2/shell.sh"';
	try {
		const missing = join(directory, "missing-rc");
		assert.equal(configureShellRc(missing), "added");
		assert.equal(readFileSync(missing, "utf8"), `${guarded}\n`);
		assert.equal(configureShellRc(missing), "already present");

		const existing = join(directory, "existing-rc");
		writeFileSync(existing, "export BEFORE=1", "utf8");
		assert.equal(configureShellRc(existing), "added");
		assert.equal(readFileSync(existing, "utf8"), `export BEFORE=1\n${guarded}\n`);
		assert.equal(configureShellRc(existing), "already present");

		const variant = join(directory, "variant-rc");
		writeFileSync(variant, "source ~/.pi-iterm2/shell.sh\n", "utf8");
		assert.equal(configureShellRc(variant), "updated");
		assert.equal(readFileSync(variant, "utf8"), `${guarded}\n`);
		assert.equal(configureShellRc(variant), "already present");

		const p10k = join(directory, "p10k-rc");
		writeFileSync(
			p10k,
			'# Enable Powerlevel10k instant prompt. Should stay close to the top.\nif [[ -r "p10k-instant-prompt-user.zsh" ]]; then\n  source "p10k-instant-prompt-user.zsh"\nfi\nsource "$HOME/.pi-iterm2/shell.sh"\n',
			"utf8",
		);
		assert.equal(configureShellRc(p10k), "updated");
		assert.equal(readFileSync(p10k, "utf8").split("\n")[0], guarded);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

console.log(`${passed} synchronous tests passed`);

export default async function (_pi: ExtensionAPI): Promise<void> {
	console.log(`${passed} tests passed`);
}
