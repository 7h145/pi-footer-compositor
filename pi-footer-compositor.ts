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
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATUS_KEY_PATTERN = /^footer-compositor:(left|right):(-?\d+):(.+)$/;
const PATCH_KEY = "__piFooterCompositorRenderPatch";
const MIN_PADDING = 2;
const MIN_LEFT_WIDTH = 12;

type FooterRender = (width: number) => string[];
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

type PatchedFooterPrototype = typeof FooterComponent.prototype & {
	__piFooterCompositorRenderPatch?: {
		originalRender: FooterRender;
		owners: number;
		getSeparator: () => string;
	};
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
	ordinary.sort(([a], [b]) => a.localeCompare(b));
	return { segments, ordinary };
}

function appendLeftSegments(line: string, segments: Segment[], width: number): string {
	if (segments.length === 0 || width <= 0) return truncateToWidth(line, width, "");

	const suffix = ` ${segments.map((segment) => segment.text).join(" ")}`;
	const suffixWidth = visibleWidth(suffix);
	if (suffixWidth >= width) return truncateToWidth(suffix.trimStart(), width, "");

	const left = truncateToWidth(line, width - suffixWidth, "...");
	return truncateToWidth(left + suffix, width, "");
}

function rightAlignSegments(line: string, segments: Segment[], width: number, separator: string): string {
	if (segments.length === 0 || width <= 0) return truncateToWidth(line, width, "");

	// Lower-order segments are less important. Drop them first until the right
	// side leaves a useful amount of room for Pi's path/session text.
	let visibleSegments = [...segments];
	let right = visibleSegments.map((segment) => segment.text).join(` ${separator} `);
	while (visibleSegments.length > 0 && visibleWidth(right) + MIN_PADDING + MIN_LEFT_WIDTH > width) {
		visibleSegments.shift();
		right = visibleSegments.map((segment) => segment.text).join(` ${separator} `);
	}
	if (!right) return truncateToWidth(line, width, "");

	const rightWidth = visibleWidth(right);
	const availableLeft = width - rightWidth - MIN_PADDING;
	const left = truncateToWidth(line, availableLeft, "...");
	const padding = " ".repeat(Math.max(MIN_PADDING, width - visibleWidth(left) - rightWidth));
	return truncateToWidth(left + padding + right, width, "");
}

function installPatch(getSeparator: () => string): void {
	const proto = FooterComponent.prototype as PatchedFooterPrototype;
	const existing = proto[PATCH_KEY];
	if (existing) {
		existing.owners++;
		existing.getSeparator = getSeparator;
		return;
	}

	const originalRender = proto.render as FooterRender;
	proto[PATCH_KEY] = { originalRender, owners: 1, getSeparator };

	proto.render = function patchedRender(width: number): string[] {
		const patch = (FooterComponent.prototype as PatchedFooterPrototype)[PATCH_KEY];
		const lines = (patch?.originalRender ?? originalRender).call(this, width);
		const footerData = (this as unknown as { footerData: FooterDataLike }).footerData;
		const statuses = footerData?.getExtensionStatuses();
		if (!statuses || statuses.size === 0 || lines.length === 0) return lines;

		const { segments, ordinary } = parseSegments(statuses);
		if (segments.length === 0) return lines;

		// Pi appends all extension statuses as one final line. Remove that line,
		// then restore only statuses that are not owned by this compositor.
		const result = lines.slice(0, -1);
		const leftSegments = segments.filter((segment) => segment.slot === "left");
		const rightSegments = segments.filter((segment) => segment.slot === "right");
		const separator = patch?.getSeparator() ?? "•";
		result[0] = rightAlignSegments(
			appendLeftSegments(result[0]!, leftSegments, width),
			rightSegments,
			width,
			separator,
		);

		if (ordinary.length > 0) {
			const statusLine = ordinary.map(([, text]) => sanitizeStatusText(text)).filter(Boolean).join(" ");
			if (statusLine) result.push(truncateToWidth(statusLine, width, "..."));
		}
		return result;
	};
}

function uninstallPatch(): void {
	const proto = FooterComponent.prototype as PatchedFooterPrototype;
	const patch = proto[PATCH_KEY];
	if (!patch) return;

	patch.owners--;
	if (patch.owners <= 0) {
		proto.render = patch.originalRender;
		delete proto[PATCH_KEY];
	}
}

export default function (pi: ExtensionAPI) {
	let installed = false;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || installed) return;
		installPatch(() => ctx.ui.theme.fg("dim", "•"));
		installed = true;
	});

	pi.on("session_shutdown", () => {
		if (!installed) return;
		uninstallPatch();
		installed = false;
	});
}
