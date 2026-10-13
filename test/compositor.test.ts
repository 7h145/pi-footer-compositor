import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	FooterComponent,
	createEventBus,
	initTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
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
const DISCOVER = "footer-compositor:dynamic-left:discover";
const AVAILABLE = "footer-compositor:dynamic-left:available";
const UNAVAILABLE = "footer-compositor:dynamic-left:unavailable";
const DYNAMIC = "footer-compositor:left:20:synthetic-monitor";
type Renderer = (input: { maxWidth: number; theme: Theme }) => string | undefined;
interface Capability {
	version: 1;
	instanceId: string;
	register(input: { key: string; render: Renderer }): () => void;
}

// Use Pi's actual event bus; count subscriptions to check cleanup.
function eventBus() {
	const bus = createEventBus();
	const counts = new Map<string, number>();
	return {
		on(channel: string, handler: (data: unknown) => void) {
			counts.set(channel, (counts.get(channel) ?? 0) + 1);
			const unsubscribe = bus.on(channel, handler);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				counts.set(channel, counts.get(channel)! - 1);
				unsubscribe();
			};
		},
		emit: bus.emit,
		count(channel: string) { return counts.get(channel) ?? 0; },
	};
}

function discover(bus: ReturnType<typeof eventBus>): Capability {
	let result: Capability | undefined;
	bus.emit(DISCOVER, { version: 1, accept: (capability: Capability) => { result = capability; } });
	assert.ok(result, "discovery must respond synchronously");
	return result;
}

function owner(mode: ExtensionContext["mode"] = "tui", bus = eventBus()) {
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
		events: bus,
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			handlers.set(event, handler);
			return () => { handlers.delete(event); };
		},
	} as unknown as ExtensionAPI);
	const runtime = {
		bus,
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

function producer(bus: ReturnType<typeof eventBus>, statuses: Map<string, string>, render: Renderer, key = DYNAMIC) {
	let active = false;
	let capability: Capability | undefined;
	let remove: (() => void) | undefined;
	let subscriptions: Array<() => void> = [];
	let registrations = 0;
	function accept(payload: unknown) {
		if (!active || !payload || typeof payload !== "object") return;
		const candidate = payload as Capability;
		if (candidate.version !== 1 || typeof candidate.instanceId !== "string" || !candidate.instanceId ||
			typeof candidate.register !== "function" || candidate.instanceId === capability?.instanceId) return;
		try {
			const nextRemove = candidate.register({ key, render });
			remove?.();
			remove = nextRemove;
			capability = candidate;
			registrations++;
		} catch {}
		statuses.set(key, "fallback");
	}
	function request() { bus.emit(DISCOVER, { version: 1, accept }); }
	return {
		start() {
			active = true;
			subscriptions = [bus.on(AVAILABLE, accept), bus.on(UNAVAILABLE, (payload) => {
				if (!payload || typeof payload !== "object") return;
				const notice = payload as { version: number; instanceId: string };
				if (notice.version !== 1 || notice.instanceId !== capability?.instanceId) return;
				remove?.();
				remove = undefined;
				capability = undefined;
				statuses.set(key, "fallback");
				request();
			})];
			statuses.set(key, "fallback");
			request();
		},
		stop() {
			active = false;
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions = [];
			remove?.();
			remove = undefined;
			capability = undefined;
			statuses.delete(key);
		},
		get instanceId() { return capability?.instanceId; },
		get registrations() { return registrations; },
	};
}

test("discover in either start order and ignore duplicate and malformed advertisements", () => {
	for (const producerFirst of [false, true]) {
		const bus = eventBus();
		const statuses = new Map<string, string>();
		const client = producer(bus, statuses, () => "dynamic");
		const runtime = owner("tui", bus);
		if (producerFirst) { client.start(); runtime.start(); }
		else { runtime.start(); client.start(); }
		const capability = discover(bus);
		bus.emit(AVAILABLE, capability);
		for (const payload of [null, {}, { version: 2 }, { ...capability, version: 2 },
			{ version: 1, instanceId: "", register: capability.register }]) bus.emit(AVAILABLE, payload);
		assert.equal(client.registrations, 1);
		assert.equal(client.instanceId, capability.instanceId);
		assert.match(plain(footer(statuses).render(100))[0], /dynamic$/);
		client.stop();
		runtime.stop();
		assert.equal(bus.count(AVAILABLE), 0);
		assert.equal(bus.count(UNAVAILABLE), 0);
		assert.equal(bus.count(DISCOVER), 0);
	}
});

test("ignore unsupported discovery payloads and advertise only in TUI", () => {
	for (const mode of ["rpc", "json", "print", "tui"] as const) {
		const bus = eventBus();
		let advertisements = 0;
		bus.on(AVAILABLE, () => { advertisements++; });
		const runtime = owner(mode, bus);
		runtime.start();
		let accepted = 0;
		const accept = () => { accepted++; };
		for (const payload of [null, "bad", {}, { version: 2, accept }, { version: 1, accept: "bad" }]) {
			bus.emit(DISCOVER, payload);
		}
		assert.equal(accepted, 0);
		bus.emit(DISCOVER, { version: 1, accept });
		assert.equal(accepted, mode === "tui" ? 1 : 0);
		assert.equal(advertisements, mode === "tui" ? 1 : 0);
		runtime.stop();
	}
});

test("validate registrations and make replaced disposers harmless", () => {
	const runtime = owner();
	runtime.start();
	const capability = discover(runtime.bus);
	for (const input of [null, {}, { key: DYNAMIC }, { key: DYNAMIC, render: "bad" },
		...["ordinary", GIT, "footer-compositor:left:2:", "footer-compositor:left:x:id",
			`footer-compositor:left:${"9".repeat(400)}:id`].map((key) => ({ key, render: () => "bad" }))]) {
		assert.throws(() => capability.register(input as Parameters<Capability["register"]>[0]), TypeError);
	}
	const old = capability.register({ key: DYNAMIC, render: () => "OLD" });
	const current = capability.register({ key: DYNAMIC, render: () => "NEW" });
	const component = footer(new Map([[DYNAMIC, "fallback"]]));
	old(); old();
	assert.match(plain(component.render(100))[0], /NEW$/);
	current(); current();
	assert.match(plain(component.render(100))[0], /fallback$/);
	runtime.stop();
	assert.throws(() => capability.register({ key: DYNAMIC, render: () => "late" }), /retired/);
	assert.doesNotThrow(current);
});

test("invoke only present dynamic statuses and never duplicate their fallback", () => {
	const runtime = owner();
	runtime.start();
	let calls = 0;
	discover(runtime.bus).register({ key: DYNAMIC, render: () => { calls++; return "DYNAMIC"; } });
	const statuses = new Map([["ordinary", "ORDINARY"]]);
	const component = footer(statuses);
	const before = component.render(100);
	assert.equal(calls, 0);
	for (const empty of ["", " \t\n "]) {
		statuses.set(DYNAMIC, empty);
		component.render(100);
		assert.equal(calls, 0);
	}
	statuses.set(DYNAMIC, "FALLBACK");
	const lines = plain(component.render(100));
	assert.equal(calls, 1);
	assert.match(lines[0], /DYNAMIC$/);
	assert.equal(lines[2], "ORDINARY");
	assert.ok(!lines.join("\n").includes("FALLBACK"));
	statuses.delete(DYNAMIC);
	assert.deepEqual(component.render(100), before);
	assert.equal(calls, 1);
});

test("allocate the exact documented budget independently of fallback length", () => {
	const runtime = owner();
	runtime.start();
	const budgets: number[] = [];
	discover(runtime.bus).register({ key: DYNAMIC, render: ({ maxWidth }) => { budgets.push(maxWidth); return "123456789"; } });
	const statuses = new Map([[LEFT, "(ro)"], [USAGE, "0123456789"], [DYNAMIC, "short"]]);
	const component = footer(statuses, "/" + "long-directory/".repeat(30));
	const first = plain(component.render(80))[0];
	assert.equal(budgets.at(-1), 50);
	assert.equal(visibleWidth(first), 80);
	assert.match(first, /\(ro\) 123456789\s+0123456789$/);
	statuses.set(DYNAMIC, "long fallback ".repeat(50));
	assert.equal(plain(component.render(80))[0], first);
	assert.equal(budgets.at(-1), 50);
	component.render(70);
	assert.equal(budgets.at(-1), 40);
	statuses.set(LEFT, "12345678");
	component.render(80);
	assert.equal(budgets.at(-1), 46);
});

test("multiple dynamic producers share the pool in numeric order and key tie order", () => {
	const runtime = owner();
	runtime.start();
	const capability = discover(runtime.bus);
	const calls: Array<[string, number]> = [];
	const statuses = new Map<string, string>([[LEFT, "(ro)"], [USAGE, "0123456789"]]);
	for (const [key, text] of [["footer-compositor:left:20:z", "Z"],
		["footer-compositor:left:2:first", "FIRST"], ["footer-compositor:left:20:a", "AAA"]]) {
		statuses.set(key, "fallback");
		capability.register({ key, render: ({ maxWidth }) => { calls.push([text, maxWidth]); return text; } });
	}
	const first = plain(footer(statuses).render(80))[0];
	assert.deepEqual(calls, [["FIRST", 48], ["AAA", 43], ["Z", 40]]);
	assert.match(first, /FIRST \(ro\) AAA Z\s+0123456789$/);
});

test("empty dynamic outputs keep conservative separator budgets and free space for base text", () => {
	const runtime = owner();
	runtime.start();
	const capability = discover(runtime.bus);
	const later = "footer-compositor:left:30:later";
	const budgets: number[] = [];
	capability.register({ key: DYNAMIC, render: ({ maxWidth }) => { budgets.push(maxWidth); return ""; } });
	capability.register({ key: later, render: ({ maxWidth }) => { budgets.push(maxWidth); return undefined; } });
	const statuses = new Map([[DYNAMIC, "fallback"], [later, "fallback"], [LEFT, "(ro)"], [USAGE, "0123456789"]]);
	const first = plain(footer(statuses, "/" + "path/".repeat(30)).render(80))[0];
	assert.deepEqual(budgets, [49, 49]);
	assert.match(first, /\(ro\)\s+0123456789$/);
	assert.ok(visibleWidth(first.split(" (ro)")[0]) > 12);
	assert.equal(visibleWidth(first), 80);
});

test("zero and one-column budgets and impossible static layouts remain bounded", () => {
	const runtime = owner();
	runtime.start();
	const budgets: number[] = [];
	discover(runtime.bus).register({ key: DYNAMIC, render: ({ maxWidth }) => {
		budgets.push(maxWidth);
		return maxWidth ? "…" : "";
	} });
	const statuses = new Map([[DYNAMIC, "fallback"]]);
	const component = footer(statuses);
	for (const width of [0, 1, 13, 14]) {
		const first = plain(component.render(width))[0];
		assert.ok(visibleWidth(first) <= width);
		assert.equal(budgets.at(-1), width === 14 ? 1 : 0);
		assert.equal(first.includes("…"), width === 14);
	}
	statuses.set(LEFT, "STATIC".repeat(40));
	for (let width = 0; width < 140; width++) {
		assert.ok(visibleWidth(component.render(width)[0]) <= width);
		assert.equal(budgets.at(-1), 0);
	}
});

test("preserve compliant dynamic text with ANSI and Unicode across widths and theme changes", () => {
	const runtime = owner();
	runtime.start();
	let expected = "";
	discover(runtime.bus).register({ key: DYNAMIC, render: ({ maxWidth, theme }) => {
		expected = maxWidth >= visibleWidth("只读 👩‍💻 e\u0301") ? "只读 👩‍💻 e\u0301" : maxWidth ? "…" : "";
		return expected ? theme.fg("warning", expected) : undefined;
	} });
	const statuses = new Map([[DYNAMIC, "fallback"], [LEFT, "(ro)"], [USAGE, "C W2%"], ["ordinary", "ordinary"]]);
	const component = footer(statuses, "/" + "long-path/".repeat(40));
	for (let width = 0; width <= 180; width++) {
		const lines = component.render(width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}`);
		if (expected) assert.ok(plain(lines)[0].includes(expected), `complete dynamic text at width ${width}`);
	}
	assert.ok(component.render(100)[0].includes("\x1b[36m只读"));
	runtime.setColor("35");
	assert.ok(component.render(100)[0].includes("\x1b[35m只读"));
});

test("isolate producer SGR styling without altering its text", () => {
	const runtime = owner();
	runtime.start();
	discover(runtime.bus).register({ key: DYNAMIC, render: () => "\x1b[38;2;1;2;3mRED" });
	const component = footer(new Map([[DYNAMIC, "fallback"], [USAGE, "RIGHT"]]));
	const first = component.render(100)[0];
	assert.ok(first.includes("\x1b[0m\x1b[38;2;1;2;3mRED\x1b[0m"));
	assert.match(plain([first])[0], /RED\s+RIGHT$/);
});

test("contain malformed, unsafe, throwing, oversized and async output with deferred bounded diagnostics", async () => {
	const runtime = owner();
	runtime.start();
	const capability = discover(runtime.bus);
	const messages: string[] = [];
	const warn = console.warn;
	console.warn = (message: string) => { messages.push(message); };
	try {
		const invalid: Array<() => unknown> = [
			() => "x".repeat(200), () => "tab\there", () => "new\nline", () => "return\rhere",
			() => "\x1b[2Jclear", () => "\x1b]0;title\x07", () => "\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07",
			() => "bell\x07", () => "\x9b31mC1", () => "next\u2028line", () => null,
			() => ({ value: "object" }), () => { throw new Error("must not log producer data"); },
			() => Promise.reject(new Error("rejected renderer")), () => Promise.resolve("async"),
			() => ({ then: (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("thenable")) }),
			() => Object.defineProperty({}, "then", { get() { throw new Error("then getter"); } }),
		];
		for (const render of invalid) {
			const start = messages.length;
			capability.register({ key: DYNAMIC, render: render as Renderer });
			const component = footer(new Map([[DYNAMIC, "fallback"], [LEFT, "(ro)"], [USAGE, "RIGHT"], ["ordinary", "ORDINARY"]]));
			for (let frame = 0; frame < 3; frame++) {
				const lines = plain(component.render(80));
				assert.match(lines[0], /\(ro\) …\s+RIGHT$/);
				assert.equal(lines[2], "ORDINARY");
			}
			assert.equal(messages.length, start, "no logging inside render");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(messages.length, start + 1, "one diagnostic per identical failure");
			assert.ok(messages.at(-1)!.length < 300);
			assert.ok(!messages.at(-1)!.includes("must not log"));
		}
	} finally { console.warn = warn; }
});

test("invalid output at zero budget stays empty and does not consume a later producer's pool", async () => {
	const runtime = owner();
	runtime.start();
	const capability = discover(runtime.bus);
	const later = "footer-compositor:left:30:later";
	let laterBudget = -1;
	capability.register({ key: DYNAMIC, render: () => "oversized".repeat(100) });
	capability.register({ key: later, render: ({ maxWidth }) => { laterBudget = maxWidth; return ""; } });
	const component = footer(new Map([[DYNAMIC, "fallback"], [later, "fallback"]]));
	assert.equal(visibleWidth(component.render(0)[0]), 0);
	assert.equal(laterBudget, 0);
	component.render(80);
	assert.equal(laterBudget, 65); // 80 - base 12 - separators 2 - omission 1
	runtime.stop(); // Pending diagnostics cannot outlive the session.
	await new Promise<void>((resolve) => setImmediate(resolve));
});

test("unknown footer shapes preserve static fallback without invoking dynamic callbacks", () => {
	for (const lines of [["path", "stats"], ["path", "stats", "unexpected"], ["path", "stats", "extra", "fallback"]]) {
		proto.render = () => [...lines];
		const runtime = owner();
		runtime.start();
		let called = false;
		discover(runtime.bus).register({ key: DYNAMIC, render: () => { called = true; return "dynamic"; } });
		assert.deepEqual(footer(new Map([[DYNAMIC, "fallback"]])).render(80), lines);
		assert.equal(called, false);
		runtime.stop();
	}
});

test("retire before unavailable dispatch and obtain a fresh capability on session restart", () => {
	const runtime = owner();
	runtime.start();
	const old = discover(runtime.bus);
	let rejected = false;
	let rediscovered = false;
	const unsubscribe = runtime.bus.on(UNAVAILABLE, () => {
		try { old.register({ key: DYNAMIC, render: () => "late" }); } catch { rejected = true; }
		runtime.bus.emit(DISCOVER, { version: 1, accept: () => { rediscovered = true; } });
	});
	runtime.stop();
	assert.equal(rejected, true);
	assert.equal(rediscovered, false);
	assert.equal(runtime.bus.count(DISCOVER), 0);
	runtime.start();
	const fresh = discover(runtime.bus);
	assert.notEqual(fresh.instanceId, old.instanceId);
	const current = fresh.register({ key: DYNAMIC, render: () => "FRESH" });
	assert.throws(() => old.register({ key: DYNAMIC, render: () => "OLD" }), /retired/);
	assert.match(plain(footer(new Map([[DYNAMIC, "fallback"]])).render(80))[0], /FRESH$/);
	unsubscribe();
	current();
});

test("new instances replace registrations and old unavailable events cannot retire them", () => {
	const bus = eventBus();
	const statuses = new Map<string, string>();
	const client = producer(bus, statuses, () => "DYNAMIC");
	const first = owner("tui", bus);
	const second = owner("tui", bus);
	client.start();
	first.start();
	const oldId = client.instanceId;
	const oldCapability = discover(bus);
	second.start();
	const currentId = client.instanceId;
	assert.notEqual(currentId, oldId);
	assert.equal(client.registrations, 2);
	first.stop(); first.invalidate();
	assert.equal(client.instanceId, currentId);
	bus.emit(AVAILABLE, oldCapability); // A retired advertisement cannot displace working support.
	assert.equal(client.instanceId, currentId);
	assert.equal(client.registrations, 2);
	bus.emit(UNAVAILABLE, { version: 2, instanceId: currentId });
	assert.equal(client.instanceId, currentId);
	assert.match(plain(footer(statuses).render(80))[0], /DYNAMIC$/);
	second.stop(); second.invalidate();
	assert.equal(client.instanceId, undefined);
	assert.ok(plain(footer(statuses).render(80))[2].includes("fallback"));
	client.stop();
});

test("rediscovery after the newest patch owner stops uses the remaining owner", () => {
	const bus = eventBus();
	const statuses = new Map<string, string>();
	const client = producer(bus, statuses, () => "DYNAMIC");
	const first = owner("tui", bus);
	const second = owner("tui", bus);
	client.start(); first.start();
	const firstId = client.instanceId;
	second.start(); second.stop(); second.invalidate();
	assert.equal(client.instanceId, firstId);
	assert.equal(client.registrations, 3);
	assert.match(plain(footer(statuses).render(80))[0], /DYNAMIC$/);
	client.stop(); first.stop();
});

test("retained old wrappers never invoke callbacks or adopt a newer registry", () => {
	const statuses = new Map([[DYNAMIC, "fallback"]]);
	const component = footer(statuses);
	const before = component.render(80);
	const first = owner(); first.start();
	let oldCalls = 0;
	const old = discover(first.bus);
	const removeOld = old.register({ key: DYNAMIC, render: () => { oldCalls++; return "OLD"; } });
	const retained = proto.render;
	proto.render = function (width) { return retained.call(this, width); };
	component.render(80);
	assert.equal(oldCalls, 1);
	first.stop(); first.invalidate();
	assert.deepEqual(retained.call(component, 80), before);
	const second = owner(); second.start();
	let newCalls = 0;
	discover(second.bus).register({ key: DYNAMIC, render: () => { newCalls++; return "NEW"; } });
	removeOld();
	assert.deepEqual(retained.call(component, 80), before);
	assert.equal(newCalls, 0);
	assert.match(plain(component.render(80))[0], /NEW$/);
	assert.equal(oldCalls, 1);
	assert.equal(newCalls, 1);
	second.stop(); second.invalidate();
	assert.deepEqual(component.render(80), before);
});

test("synthetic strip/count producer adapts to resize and coexists with static producers", () => {
	const runtime = owner(); runtime.start();
	const modes: string[] = [];
	const strip = "W".repeat(30);
	discover(runtime.bus).register({ key: DYNAMIC, render: ({ maxWidth, theme }) => {
		const text = maxWidth >= strip.length ? strip : maxWidth >= 6 ? "W30 I0" : maxWidth ? "…" : "";
		modes.push(text);
		return text ? theme.fg("accent", text) : undefined;
	} });
	const component = footer(new Map([[DYNAMIC, "fallback"], [LEFT, "(ro)"], [GIT, "clean"], [USAGE, "C W2%"]]));
	for (const [width, expected] of [[100, strip], [50, "W30 I0"], [100, strip]] as const) {
		const first = plain(component.render(width))[0];
		assert.equal(modes.at(-1), expected);
		assert.ok(first.includes(expected));
		assert.match(first, /\(ro\).+clean • C W2%$/);
		assert.ok(!first.includes("fallback"));
	}
});

test("preserve a producer that fills the budget when base text is empty", () => {
	proto.render = () => ["", "stats", "x"];
	const runtime = owner(); runtime.start();
	let expected = "";
	discover(runtime.bus).register({ key: DYNAMIC, render: ({ maxWidth }) => {
		expected = "X".repeat(maxWidth);
		return expected;
	} });
	const component = footer(new Map([[DYNAMIC, "x"]]));
	for (let width = 1; width <= 50; width++) {
		const first = plain(component.render(width))[0];
		assert.equal(expected.length, width - 1);
		assert.equal(first, expected ? ` ${expected}` : "");
		assert.ok(visibleWidth(first) <= width);
	}
});

test("a disposed dynamic key returns exactly to the legacy static layout", () => {
	const statuses = new Map([[DYNAMIC, "fallback"], [LEFT, "(ro)"], [GIT, "clean"], [USAGE, "C W2%"]]);
	const runtime = owner(); runtime.start();
	const component = footer(statuses, "/" + "long-directory/".repeat(20));
	const baseline = Array.from({ length: 141 }, (_, width) => component.render(width));
	const remove = discover(runtime.bus).register({ key: DYNAMIC, render: ({ maxWidth }) => maxWidth ? "…" : "" });
	component.render(80);
	remove();
	for (let width = 0; width <= 140; width++) assert.deepEqual(component.render(width), baseline[width]);
});
