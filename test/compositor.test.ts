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
const runtimes: Array<{ stop(): void }> = [];

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
	const runtime = {
		start: () => handlers.get("session_start")!({}, ctx),
		stop: () => handlers.get("session_shutdown")!({}, ctx),
		invalidate: () => { active = false; },
		setColor: (value: string) => { color = value; },
	};
	runtimes.push(runtime);
	return runtime;
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
	try {
		for (const runtime of runtimes.splice(0)) runtime.stop();
		assert.equal((proto as unknown as Record<string, unknown>)[PATCH_KEY], undefined);
	} finally {
		proto.render = originalRender;
		delete (proto as unknown as Record<string, unknown>)[PATCH_KEY];
	}
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

test("fall back without removing rows when the footer layout changes", () => {
	for (const lines of [[], ["path"], ["path", "stats"], ["path", "stats", "extra", "C W2%"]]) {
		proto.render = () => [...lines];
		const component = footer(new Map([[USAGE, "C W2%"]]));
		const runtime = owner();
		runtime.start();
		assert.deepEqual(component.render(80), lines);
		runtime.stop();
	}
});

test("fall back when the last row is not the expected status row", () => {
	const lines = ["path", "stats", "other footer content"];
	proto.render = () => [...lines];
	const component = footer(new Map([[USAGE, "C W2%"]]));
	owner().start();
	assert.deepEqual(component.render(80), lines);
});

test("accept status-row styling differences without losing the upstream stats", () => {
	proto.render = () => ["path", "stats", "\x1b[31mC W2%\x1b[39m"];
	const component = footer(new Map([[USAGE, "C W2%"]]));
	owner().start();
	const rendered = plain(component.render(80));
	assert.equal(rendered.length, 2);
	assert.ok(rendered[0].endsWith("C W2%"));
	assert.equal(rendered[1], "stats");
});

test("fall back when the private status accessor or its return type changes", () => {
	const lines = ["path", "stats", "C W2%"];
	proto.render = () => [...lines];
	for (const data of [undefined, {}, { getExtensionStatuses: 42 }, { getExtensionStatuses: () => [] }]) {
		const component = footer(new Map([[USAGE, "C W2%"]]));
		Object.defineProperty(component, "footerData", { value: data });
		const runtime = owner();
		runtime.start();
		assert.deepEqual(component.render(80), lines);
		runtime.stop();
	}
});

test("preserve ordinary status spacing and use a themed truncation marker", () => {
	const ordinary = new Map([["a", ""], ["z", "long ordinary status ".repeat(10)]]);
	const expected = plain(footer(ordinary).render(40))[2];
	const component = footer(new Map([...ordinary, [USAGE, "C W2%"]]));
	owner().start();
	const rendered = component.render(40);
	assert.equal(plain(rendered)[2], expected);
	assert.ok(rendered[2].includes("\x1b[36m...\x1b[39m"));
});

test("separate left segments with spaces and sort them numerically", () => {
	const component = footer(new Map([
		["footer-compositor:left:20:second", "LEFT-B"],
		["footer-compositor:left:10:first", "LEFT-A"],
	]));
	owner().start();
	assert.ok(plain(component.render(100))[0].endsWith("LEFT-A LEFT-B"));
});

test("keep the patch until its last owner stops", () => {
	const first = owner();
	const second = owner();
	first.start();
	second.start();
	const patched = proto.render;
	first.stop();
	first.invalidate();
	assert.equal(proto.render, patched);
	assert.ok(plain(footer(new Map([[USAGE, "C W2%"]])).render(80))[0].endsWith("C W2%"));
	second.stop();
	assert.equal(proto.render, originalRender);
});

test("use a remaining owner's theme after the newest owner stops", () => {
	const first = owner();
	const second = owner();
	second.setColor("35");
	first.start();
	second.start();
	const component = footer(new Map([[GIT, "clean"], [USAGE, "C W2%"]]));
	assert.ok(component.render(80)[0].includes("\x1b[35m•\x1b[39m"));
	second.stop();
	second.invalidate();
	assert.ok(component.render(80)[0].includes("\x1b[36m•\x1b[39m"));
	first.stop();
	assert.equal(proto.render, originalRender);
});

test("make a retained renderer inert after its owner stops", () => {
	const component = footer(new Map([[GIT, "clean"], [USAGE, "C W2%"]]));
	const before = component.render(80);
	const runtime = owner();
	runtime.start();
	const retained = proto.render;
	runtime.stop();
	runtime.invalidate();
	assert.deepEqual(retained.call(component, 80), before);
});

test("preserve a later patch and avoid stale callbacks or recursion after reinstall", () => {
	const component = footer(new Map([[GIT, "clean"], [USAGE, "C W2%"]]));
	const before = component.render(80);
	const first = owner();
	first.start();
	const wrapped = proto.render;
	const foreign = function (this: FooterComponent, width: number) { return wrapped.call(this, width); };
	proto.render = foreign;
	first.stop();
	first.invalidate();
	assert.equal(proto.render, foreign);
	assert.deepEqual(component.render(80), before);

	for (let attempt = 0; attempt < 3; attempt++) {
		const runtime = owner();
		runtime.start();
		assert.match(plain(component.render(80))[0], /clean • C W2%$/);
		runtime.stop();
		runtime.invalidate();
		assert.equal(proto.render, foreign);
		assert.deepEqual(component.render(80), before);
	}
});

test("do not suppress upstream rendering errors", () => {
	proto.render = () => { throw new Error("upstream render failed"); };
	const component = footer(new Map([[USAGE, "C W2%"]]));
	owner().start();
	assert.throws(() => component.render(80), /upstream render failed/);
});
