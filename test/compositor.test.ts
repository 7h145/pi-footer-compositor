import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	FooterComponent,
	initTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import compositor from "../pi-footer-compositor.ts";

initTheme("dark", false);
const proto = FooterComponent.prototype;
const originalRender = proto.render;
const PATCH_KEY = "__piFooterCompositorRenderPatch";
const LEFT = "footer-compositor:left:10:workspace-read-only";
const GIT = "footer-compositor:right:10:workspace-git";
const USAGE = "footer-compositor:right:20:codex-usage";

function owner(mode: ExtensionContext["mode"] = "tui") {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let active = true;
	let color = "36";
	const ui = { theme: { fg: (_token: string, text: string) => `\x1b[${color}m${text}\x1b[39m` } };
	const ctx = {
		mode,
		get ui() {
			assert.ok(active, "stale extension context");
			return ui;
		},
	} as unknown as ExtensionContext;
	compositor({
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			handlers.set(event, handler);
			return () => { handlers.delete(event); };
		},
	} as unknown as ExtensionAPI);
	return {
		start: () => handlers.get("session_start")!({}, ctx),
		stop: () => handlers.get("session_shutdown")!({}, ctx),
		invalidate: () => { active = false; },
		setColor: (value: string) => { color = value; },
	};
}

// Exercise Pi's actual footer without an agent, credentials, Git watchers or TUI.
function footer(statuses: Map<string, string>, cwd = "/workspace") {
	const model = { provider: "test", id: "test-model", contextWindow: 100_000, reasoning: true };
	const entries = [{
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 100, output: 50, cacheRead: 25, cacheWrite: 0, totalTokens: 175,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
		},
	}];
	const session = {
		state: { model, thinkingLevel: "medium" },
		model,
		modelRuntime: { isUsingSubscription: () => false },
		sessionManager: {
			getCwd: () => cwd,
			getSessionName: () => "test-session",
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session-id",
			getLeafId: () => "test-leaf",
			getEntries: () => entries,
		},
		getContextUsage: () => ({ contextWindow: 100_000, percent: 75, tokens: 75_000 }),
	};
	const data = {
		getGitBranch: () => "main",
		getAvailableProviderCount: () => 2,
		getExtensionStatuses: () => statuses,
	};
	return new FooterComponent(
		session as unknown as ConstructorParameters<typeof FooterComponent>[0],
		data as unknown as ConstructorParameters<typeof FooterComponent>[1],
	);
}

function plain(lines: string[]): string[] {
	return lines.map(stripTerminalSequences);
}

afterEach(() => {
	proto.render = originalRender;
	delete (proto as unknown as Record<string, unknown>)[PATCH_KEY];
});

test("leave the footer unchanged without compositor statuses", () => {
	for (const statuses of [new Map<string, string>(), new Map([["z", "Z"], ["a", "A"]])]) {
		const component = footer(statuses);
		const before = component.render(100);
		const runtime = owner();
		runtime.start();
		assert.deepEqual(component.render(100), before);
		runtime.stop();
	}
});

test("relocate producer statuses while preserving statistics and ordinary statuses", () => {
	const component = footer(new Map([[USAGE, "C W2%"], [GIT, "clean"], [LEFT, "(ro)"], ["z", "Z"], ["a", "A"]]));
	const before = component.render(120);
	owner().start();
	const rendered = component.render(120);
	assert.equal(rendered.length, 3);
	assert.ok(plain(rendered)[0].includes("(ro)"));
	assert.match(plain(rendered)[0], /clean • C W2%$/);
	assert.equal(rendered[1], before[1]);
	assert.equal(plain(rendered)[2], "A Z");
});

test("keep left markers when truncating a long path for right statuses", () => {
	const component = footer(new Map([[LEFT, "(ro)"], [GIT, "clean"], [USAGE, "C W2%"]]), "/workspace/" + "long-directory/".repeat(10));
	owner().start();
	const first = plain(component.render(80))[0];
	assert.ok(first.includes("(ro)"), first);
	assert.match(first, /clean • C W2%$/);
	assert.ok(first.includes("..."), first);
});

test("drop lower-order right statuses first", () => {
	const component = footer(new Map([[GIT, "clean"], [USAGE, "C W2%"]]));
	owner().start();
	const first = plain(component.render(25))[0];
	assert.ok(!first.includes("clean"));
	assert.ok(first.includes("C W2%"));
});

test("keep each line within the terminal width with ANSI, Unicode and hyperlinks", () => {
	const contexts = [
		new Map([[LEFT, "(ro)"], [GIT, "clean"], [USAGE, "C W2%"]]),
		new Map([[LEFT, "\x1b[31m只读🔒\x1b[39m"], [USAGE, "宽字 👩‍💻 e\u0301"], ["ordinary", "\x1b]8;;https://example.invalid\x07linked\x1b]8;;\x07"]]),
		new Map([["footer-compositor:right:-10:first", "first\nsecond\tthird"], [USAGE, "C W2%"]]),
	];
	owner().start();
	for (const statuses of contexts) {
		const component = footer(statuses, "/workspace/" + "long-directory/".repeat(10));
		for (let width = 0; width <= 140; width++) {
			for (const line of component.render(width)) {
				assert.ok(visibleWidth(line) <= width, JSON.stringify({ width, line }));
				assert.doesNotMatch(line, /[\r\n\t]/);
			}
		}
	}
});

test("install and remove idempotently across session starts and shutdowns", () => {
	const runtime = owner();
	runtime.start();
	const patched = proto.render;
	runtime.start();
	assert.equal(proto.render, patched);
	runtime.stop();
	assert.equal(proto.render, originalRender);
	runtime.stop();
	assert.equal(proto.render, originalRender);
	runtime.start();
	assert.notEqual(proto.render, originalRender);
	runtime.stop();
	assert.equal(proto.render, originalRender);
});

test("do not patch outside TUI mode", () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const runtime = owner(mode);
		runtime.start();
		runtime.stop();
		assert.equal(proto.render, originalRender);
	}
});

test("use the current theme for right-side separators", () => {
	const component = footer(new Map([[GIT, "clean"], [USAGE, "C W2%"]]));
	const runtime = owner();
	runtime.start();
	assert.ok(component.render(80)[0].includes("\x1b[36m•\x1b[39m"));
	runtime.setColor("35");
	assert.ok(component.render(80)[0].includes("\x1b[35m•\x1b[39m"));
});
