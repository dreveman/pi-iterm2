import assert from "node:assert/strict";
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
	computeTabColorRgb,
	DEFAULT_CONFIG,
	deriveStatus,
	hashString,
	hostHue,
	hslToRgb,
	parseConfig,
	parseConfigText,
	sanitizeOscText,
	sessionHueOffset,
	shouldActivate,
	statusIcon,
	WORKING_ICON_FRAMES,
	wrapForTmux,
} from "../extensions/core.ts";

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
});

test("computeTabColorRgb varies by host, session, and status but is stable for the same inputs", () => {
	const base = computeTabColorRgb("host-a", "session-1", "idle");
	assert.deepEqual(computeTabColorRgb("host-a", "session-1", "idle"), base);
	assert.notDeepEqual(computeTabColorRgb("host-b", "session-1", "idle"), base);
	assert.notDeepEqual(computeTabColorRgb("host-a", "session-2", "idle"), base);
	assert.notDeepEqual(computeTabColorRgb("host-a", "session-1", "working"), base);
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

test("statusIcon cycles through the working frames and wraps around", () => {
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

const IDENTITY = { cwd: "/proj", sessionName: "sess", user: "dave", host: "box" };

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
	assert.equal(seq.includes(buildTabColorSequence(computeTabColorRgb("box", "s1", "working"))), true);
	// One batch means wrapForTmux wraps once, per its documented contract.
	assert.equal(wrapForTmux(seq, true).match(/\x1bPtmux;/g)?.length, 1);
});

test("buildStatusSequences honors the tabColor and userVars toggles independently", () => {
	assert.equal(buildStatusSequences({ ...DEFAULT_CONFIG, tabColor: false }, IDENTITY, "s1", "working").includes("]6;1;bg"), false);
	assert.equal(buildStatusSequences({ ...DEFAULT_CONFIG, userVars: false }, IDENTITY, "s1", "working").includes("pi_status"), false);
	assert.equal(buildStatusSequences({ ...DEFAULT_CONFIG, tabColor: false, userVars: false }, IDENTITY, "s1", "working"), "");
});

test("buildIdentitySequences emits cwd/session vars and CurrentDir/RemoteHost per config", () => {
	const full = buildIdentitySequences(DEFAULT_CONFIG, IDENTITY);
	assert.equal(full.includes(buildSetUserVarSequence("pi_cwd", "/proj")), true);
	assert.equal(full.includes(buildSetUserVarSequence("pi_session", "sess")), true);
	assert.equal(full.includes(buildCurrentDirSequence("/proj")), true);
	assert.equal(full.includes(buildRemoteHostSequence("dave", "box")), true);

	// currentDir off must not disturb the user vars the daemon depends on.
	const noDir = buildIdentitySequences({ ...DEFAULT_CONFIG, currentDir: false }, IDENTITY);
	assert.equal(noDir.includes("CurrentDir"), false);
	assert.equal(noDir.includes("RemoteHost"), false);
	assert.equal(noDir.includes(buildSetUserVarSequence("pi_cwd", "/proj")), true);
});

test("buildResetSequences clears every var it sets and restores the default tab color", () => {
	const seq = buildResetSequences(DEFAULT_CONFIG);
	assert.equal(seq.includes(buildResetTabColorSequence()), true);
	for (const name of ["pi_cwd", "pi_session", "pi_status"]) {
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

console.log(`${passed} tests passed`);

export default function (_pi: ExtensionAPI): void {}
