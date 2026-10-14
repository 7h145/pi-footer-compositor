/** pi-footer-compositor
 *
 * Purpose: relocate specially named extension statuses into composable slots
 * on the first line of Pi's built-in footer.
 *
 * Strategy: be the sole owner of the unsupported
 * `FooterComponent.prototype.render` patch. Producers use public status keys
 * and optionally discover a width-aware renderer through `pi.events`.
 * Preserve ordinary statuses and drop lower-order right segments first.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (5.6)
 * License: MIT
 * Version: 0.1
 * Date: 2026-07-16
 * Last verified with Pi: 1.0.2 and 1.1.0
 */

import { randomUUID } from "node:crypto";
import { FooterComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATUS_KEY_PATTERN = /^footer-compositor:(left|right):(-?\d+):(.+)$/;
const PATCH_KEY = "__piFooterCompositorRenderPatch";
const MIN_PADDING = 2;
const MIN_LEFT_WIDTH = 12;
const DISCOVER = "footer-compositor:dynamic:discover";
const AVAILABLE = "footer-compositor:dynamic:available";
const UNAVAILABLE = "footer-compositor:dynamic:unavailable";
const SGR_PATTERN = /\x1b\[[0-9;:]*m/g;
const CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u;

type FooterRender = (this: FooterComponent, width: number) => string[];
type Slot = "left" | "right";
type DynamicRenderer = (input: { maxWidth: number; theme: Theme }) => string | undefined;

interface DynamicProducerCapabilityV1 {
	version: 1;
	instanceId: string;
	register(input: { key: string; render: DynamicRenderer }): () => void;
}

interface Registration {
	token: symbol;
	render: DynamicRenderer;
	diagnosed: Set<string>;
}

interface FooterOwner {
	active: boolean;
	getTheme: (() => Theme) | undefined;
	registry: Map<string, Registration>;
}

interface Segment {
	key: string;
	slot: Slot;
	order: number;
	text: string;
}

interface FooterDataLike {
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

interface RenderPatch {
	originalRender: FooterRender;
	render: FooterRender;
	owners: Set<FooterOwner>;
}

type PatchedFooterPrototype = typeof FooterComponent.prototype & {
	__piFooterCompositorRenderPatch?: RenderPatch;
};

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function parseSegments(statuses: ReadonlyMap<string, string>): { segments: Segment[]; ordinary: Array<[string, string]> } {
	const segments: Segment[] = [];
	const ordinary: Array<[string, string]> = [];

	for (const [key, rawText] of statuses) {
		const match = STATUS_KEY_PATTERN.exec(key);
		if (!match) {
			ordinary.push([key, rawText]);
			continue;
		}

		const text = sanitizeStatusText(rawText);
		if (!text) continue;
		segments.push({
			key,
			slot: match[1] as Slot,
			order: Number(match[2]),
			text,
		});
	}

	segments.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
	return { segments, ordinary };
}

function formatStatusLine(statuses: Iterable<[string, string]>): string {
	return [...statuses]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.join(" ");
}

function appendLeftSegments(line: string, segments: Segment[], width: number): string {
	if (segments.length === 0 || width <= 0) return truncateToWidth(line, width, "");

	const suffix = ` ${segments.map((segment) => segment.text).join(" ")}`;
	const suffixWidth = visibleWidth(suffix);
	if (suffixWidth >= width) return truncateToWidth(suffix.trimStart(), width, "");

	const left = truncateToWidth(line, width - suffixWidth, "...");
	return truncateToWidth(left + suffix, width, "");
}

function diagnose(owner: FooterOwner, key: string, registration: Registration, reason: string): void {
	if (registration.diagnosed.has(reason)) return;
	registration.diagnosed.add(reason);
	const token = registration.token;
	// Do not log producer data/errors or retain its callback in the queued task.
	const message = `[pi-footer-compositor] Dynamic renderer ${JSON.stringify(key.slice(0, 120))}: ${reason}`;
	queueMicrotask(() => {
		if (owner.active && owner.registry.get(key)?.token === token) console.warn(message);
	});
}

function renderDynamic(owner: FooterOwner, key: string, registration: Registration, maxWidth: number, theme: Theme): string {
	if (!owner.active || owner.registry.get(key) !== registration) return "";
	let reason: string;
	try {
		const output: unknown = registration.render({ maxWidth, theme });
		if (output === undefined || output === "") return "";
		if (typeof output !== "string") {
			// Also absorbs rejected Promises and thenables without awaiting them.
			if (output !== null && (typeof output === "object" || typeof output === "function")) {
				void Promise.resolve(output).catch(() => {});
			}
			reason = "expected a synchronous string or undefined";
		} else if (CONTROL_PATTERN.test(output.replace(SGR_PATTERN, ""))) {
			reason = "only single-line text and ANSI SGR styling are allowed";
		} else if (maxWidth === 0 || visibleWidth(output) > maxWidth) {
			reason = "output exceeds its allocated width";
		} else {
			// Keep producer styling from leaking into adjacent segments.
			return stripTerminalSequences(output) === "" ? "" : `\x1b[0m${output}\x1b[0m`;
		}
	} catch {
		reason = "renderer threw";
	}
	diagnose(owner, key, registration, reason);
	return maxWidth > 0 ? theme.fg("dim", "…") : "";
}

function composeDynamicLeft(line: string, segments: Segment[], width: number, owner: FooterOwner, theme: Theme): string {
	const entries = segments.map((segment) => ({ segment, registration: owner.registry.get(segment.key) }));
	const staticWidth = entries.reduce((sum, entry) => sum + (entry.registration ? 0 : visibleWidth(entry.segment.text)), 0);
	const separators = entries.length;
	const baseReservation = Math.min(visibleWidth(line), MIN_LEFT_WIDTH, Math.max(0, width - staticWidth - separators));
	let remaining = Math.max(0, width - baseReservation - staticWidth - separators);
	const rendered: Segment[] = [];
	for (const { segment, registration } of entries) {
		const text = registration ? renderDynamic(owner, segment.key, registration, remaining, theme) : segment.text;
		if (registration) remaining -= visibleWidth(text);
		if (text) rendered.push({ ...segment, text });
	}
	if (width <= 0) return "";
	const suffix = rendered.length > 0 ? ` ${rendered.map((segment) => segment.text).join(" ")}` : "";
	const suffixWidth = visibleWidth(suffix);
	// When static values overflow, all dynamic budgets were zero.
	if (suffixWidth > width) return truncateToWidth(suffix.trimStart(), width, "");
	return truncateToWidth(line, width - suffixWidth, "...") + suffix;
}

function composeDynamicRight(segments: Segment[], width: number, separator: string, owner: FooterOwner, theme: Theme): string {
	const joiner = ` ${separator} `;
	const separatorWidth = visibleWidth(joiner);
	let remaining = Math.max(0, width - MIN_LEFT_WIDTH - MIN_PADDING);
	const rendered: Segment[] = [];
	// Allocate highest priority first, then restore ascending display order.
	for (const segment of [...segments].reverse()) {
		const gap = rendered.length > 0 ? separatorWidth : 0;
		const budget = Math.max(0, remaining - gap);
		const registration = owner.registry.get(segment.key);
		const text = registration ? renderDynamic(owner, segment.key, registration, budget, theme) : segment.text;
		if (!text) continue;
		const textWidth = visibleWidth(text);
		// Static values are indivisible. As in the legacy policy, a value that
		// cannot fit also excludes everything with lower priority.
		if (textWidth + gap > remaining) break;
		rendered.push({ ...segment, text });
		remaining -= textWidth + gap;
	}
	return rendered.reverse().map((segment) => segment.text).join(joiner);
}

function composeFirstLine(line: string, leftSegments: Segment[], rightSegments: Segment[], width: number,
	separator: string, owner: FooterOwner, theme: Theme): string {
	const dynamicLeft = leftSegments.some((segment) => owner.registry.has(segment.key));
	const dynamicRight = rightSegments.some((segment) => owner.registry.has(segment.key));
	if (width <= 0 && !dynamicLeft && !dynamicRight) return truncateToWidth(line, width, "");

	let right: string;
	if (dynamicRight) {
		right = composeDynamicRight(rightSegments, width, separator, owner, theme);
	} else {
		// Preserve the exact legacy selection path without present right renderers.
		const visibleSegments = [...rightSegments];
		right = visibleSegments.map((segment) => segment.text).join(` ${separator} `);
		while (visibleSegments.length > 0 && visibleWidth(right) + MIN_PADDING + MIN_LEFT_WIDTH > width) {
			visibleSegments.shift();
			right = visibleSegments.map((segment) => segment.text).join(` ${separator} `);
		}
	}
	const availableLeft = Math.max(0, width - (right ? visibleWidth(right) + MIN_PADDING : 0));
	const left = dynamicLeft
		? composeDynamicLeft(line, leftSegments, availableLeft, owner, theme)
		: appendLeftSegments(line, leftSegments, availableLeft);
	if (!right) return left;
	const padding = " ".repeat(Math.max(MIN_PADDING, width - visibleWidth(left) - visibleWidth(right)));
	// Both allocation paths already fit. Never clip compliant dynamic output.
	const result = left + padding + right;
	return dynamicLeft || dynamicRight ? result : truncateToWidth(result, width, "");
}

function installPatch(owner: FooterOwner): () => void {
	const proto = FooterComponent.prototype as PatchedFooterPrototype;
	let patch = proto[PATCH_KEY];
	if (!patch) {
		const originalRender = proto.render as FooterRender;
		const owners = new Set<FooterOwner>();
		const render: FooterRender = function (width): string[] {
			const lines = originalRender.call(this, width);
			// A later patch can retain this renderer. Retired renderers must delegate
			// without using a stale context or adopting a newer installation's state.
			if (owners.size === 0 || lines.length !== 3) return lines;
			const footerData = (this as unknown as { footerData?: Partial<FooterDataLike> }).footerData;
			if (typeof footerData?.getExtensionStatuses !== "function") return lines;
			const statuses = footerData.getExtensionStatuses();
			if (!statuses || typeof statuses.size !== "number" || statuses.size === 0 ||
				typeof statuses[Symbol.iterator] !== "function") return lines;

			// Unknown layouts keep upstream output, including static fallbacks.
			const expectedStatus = truncateToWidth(formatStatusLine(statuses), width, "...");
			if (stripTerminalSequences(lines[2]!) !== stripTerminalSequences(expectedStatus)) return lines;
			const { segments, ordinary } = parseSegments(statuses);
			if (segments.length === 0) return lines;

			const currentOwner = [...owners].at(-1)!;
			// Cleanup can synchronously re-enter rendering through an unsubscribe.
			if (!currentOwner.active || !currentOwner.getTheme) return lines;
			const theme = currentOwner.getTheme();
			const result = lines.slice(0, 2);
			result[0] = composeFirstLine(
				result[0]!,
				segments.filter((segment) => segment.slot === "left"),
				segments.filter((segment) => segment.slot === "right"),
				width,
				theme.fg("dim", "•"),
				currentOwner,
				theme,
			);
			if (ordinary.length > 0) {
				result.push(truncateToWidth(formatStatusLine(ordinary), width, theme.fg("dim", "...")));
			}
			return result;
		};
		patch = { originalRender, render, owners };
		proto[PATCH_KEY] = patch;
		proto.render = render;
	}

	const installedPatch = patch;
	installedPatch.owners.add(owner);
	return () => {
		installedPatch.owners.delete(owner);
		if (installedPatch.owners.size > 0) return;
		if (proto.render === installedPatch.render) proto.render = installedPatch.originalRender;
		if (proto[PATCH_KEY] === installedPatch) delete proto[PATCH_KEY];
	};
}

function createCapability(owner: FooterOwner): DynamicProducerCapabilityV1 {
	return {
		version: 1,
		instanceId: randomUUID(),
		register(input) {
			if (!owner.active) throw new Error("Width-aware capability is retired");
			if (!input || typeof input.key !== "string" || typeof input.render !== "function") {
				throw new TypeError("Expected a compositor status key and callable renderer");
			}
			const match = STATUS_KEY_PATTERN.exec(input.key);
			if (!match || !Number.isFinite(Number(match[2]))) {
				throw new TypeError("Expected footer-compositor:left|right:<order>:<id> with a finite order");
			}
			const key = input.key;
			const token = Symbol(key);
			owner.registry.set(key, { token, render: input.render, diagnosed: new Set() });
			// Capture identity, not input or the callback, so retired handles are inert.
			return () => {
				if (owner.registry.get(key)?.token === token) owner.registry.delete(key);
			};
		},
	};
}

export default function (pi: ExtensionAPI) {
	let stop: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || stop) return;
		const owner: FooterOwner = { active: true, getTheme: () => ctx.ui.theme, registry: new Map() };
		const capability = createCapability(owner);
		const uninstall = installPatch(owner);
		const unsubscribe = pi.events.on(DISCOVER, (payload) => {
			if (!owner.active || !payload || typeof payload !== "object") return;
			const request = payload as { version?: unknown; accept?: unknown };
			if (request.version === 1 && typeof request.accept === "function") request.accept(capability);
		});
		stop = () => {
			if (!owner.active) return;
			owner.active = false;
			owner.getTheme = undefined;
			owner.registry.clear();
			unsubscribe();
			uninstall();
			stop = undefined;
			pi.events.emit(UNAVAILABLE, { version: 1, instanceId: capability.instanceId });
		};
		pi.events.emit(AVAILABLE, capability);
	});

	pi.on("session_shutdown", () => stop?.());
}
