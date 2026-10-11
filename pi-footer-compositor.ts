/** pi-footer-compositor
 *
 * Purpose: relocate specially named extension statuses into composable slots
 * on the first line of Pi's built-in footer.
 *
 * Strategy: be the sole owner of the unsupported
 * `FooterComponent.prototype.render` patch. Producer extensions use the public
 * `ctx.ui.setStatus()` API with `footer-compositor:left|right:<order>:<id>`
 * keys. Preserve ordinary extension statuses, dim separator bullets, and drop
 * lower-order right segments first when the terminal is narrow.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (5.6)
 * License: MIT
 * Version: 0.1
 * Date: 2026-07-16
 * Last verified with Pi: 0.80.6
 */

import { FooterComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATUS_KEY_PATTERN = /^footer-compositor:(left|right):(-?\d+):(.+)$/;
const PATCH_KEY = "__piFooterCompositorRenderPatch";
const MIN_PADDING = 2;
const MIN_LEFT_WIDTH = 12;

type FooterRender = (this: FooterComponent, width: number) => string[];
type DimText = (text: string) => string;
type Slot = "left" | "right";

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
	owners: Set<DimText>;
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

function composeFirstLine(line: string, leftSegments: Segment[], rightSegments: Segment[], width: number, separator: string): string {
	if (width <= 0) return truncateToWidth(line, width, "");

	// Choose the right side before laying out the path and left markers, so
	// truncating a long path does not also truncate its appended markers.
	const visibleSegments = [...rightSegments];
	let right = visibleSegments.map((segment) => segment.text).join(` ${separator} `);
	while (visibleSegments.length > 0 && visibleWidth(right) + MIN_PADDING + MIN_LEFT_WIDTH > width) {
		visibleSegments.shift();
		right = visibleSegments.map((segment) => segment.text).join(` ${separator} `);
	}
	if (!right) return appendLeftSegments(line, leftSegments, width);

	const rightWidth = visibleWidth(right);
	const availableLeft = width - rightWidth - MIN_PADDING;
	const left = appendLeftSegments(line, leftSegments, availableLeft);
	const padding = " ".repeat(Math.max(MIN_PADDING, width - visibleWidth(left) - rightWidth));
	return truncateToWidth(left + padding + right, width, "");
}

function installPatch(dimText: DimText): () => void {
	const proto = FooterComponent.prototype as PatchedFooterPrototype;
	let patch = proto[PATCH_KEY];
	if (!patch) {
		const originalRender = proto.render as FooterRender;
		const owners = new Set<DimText>();
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

			// Only replace the known two-line footer plus its final status row.
			// Unknown layouts keep upstream output, including all producer statuses.
			const expectedStatus = truncateToWidth(formatStatusLine(statuses), width, "...");
			if (stripTerminalSequences(lines[2]!) !== stripTerminalSequences(expectedStatus)) return lines;
			const { segments, ordinary } = parseSegments(statuses);
			if (segments.length === 0) return lines;

			const dim = [...owners].at(-1)!;
			const result = lines.slice(0, 2);
			result[0] = composeFirstLine(
				result[0]!,
				segments.filter((segment) => segment.slot === "left"),
				segments.filter((segment) => segment.slot === "right"),
				width,
				dim("•"),
			);
			if (ordinary.length > 0) {
				result.push(truncateToWidth(formatStatusLine(ordinary), width, dim("...")));
			}
			return result;
		};
		patch = { originalRender, render, owners };
		proto[PATCH_KEY] = patch;
		proto.render = render;
	}

	const installedPatch = patch;
	installedPatch.owners.add(dimText);
	return () => {
		installedPatch.owners.delete(dimText);
		if (installedPatch.owners.size > 0) return;
		if (proto.render === installedPatch.render) proto.render = installedPatch.originalRender;
		if (proto[PATCH_KEY] === installedPatch) delete proto[PATCH_KEY];
	};
}

export default function (pi: ExtensionAPI) {
	let uninstall: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || uninstall) return;
		uninstall = installPatch((text) => ctx.ui.theme.fg("dim", text));
	});

	pi.on("session_shutdown", () => {
		uninstall?.();
		uninstall = undefined;
	});
}
