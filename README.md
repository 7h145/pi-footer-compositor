# pi-footer-compositor

A small compositor for Pi's built-in two-line footer. It preserves the upstream
footer and relocates specially named extension statuses into slots on the first
line.

```text
/stage (ro)                                      clean • C W2%
↑278k ↓19k ...                         gpt-5.6-sol • medium
```

## Producer protocol

A producer is any Pi extension that publishes footer text. Use Pi's normal
`ctx.ui.setStatus()` API; do not import from this package or add it as an npm
dependency. You do not need to check whether the compositor is loaded or arrange
a particular extension load order. Users enable the compositor separately;
without it, Pi shows your values on its regular extension-status line.

Use a structured status key:

```text
footer-compositor:left:<order>:<id>
footer-compositor:right:<order>:<id>
```

- `<order>` is a signed decimal integer, such as `10`, `20` or `-10`. Within each
  slot, segments appear in ascending numeric order; equal orders are sorted by
  the full status key. On the right, larger orders also survive longer when space
  is limited.
- `<id>` is a non-empty, stable name unique to your producer's status. Include
  your extension's name to avoid overwriting another producer's value. Replace
  `my-extension` in the examples with your own extension's name.

For example:

```ts
ctx.ui.setStatus("footer-compositor:right:20:my-extension-state", "Ready");
ctx.ui.setStatus("footer-compositor:left:10:my-extension-read-only", "(ro)");
```

Left segments follow the path/session text, separated by spaces. Right segments
are right-aligned and separated by the dim `•` used by Pi's built-in footer.

On narrow terminals, lower-order right segments are removed first. The
path/session text is shortened to leave room for left markers and the surviving
right segments. Left markers are truncated if they exceed their available space.
Status text is kept on one line, and layout accounts for ANSI styles and Unicode
character widths.

Statuses with ordinary keys remain on Pi's normal extension-status line. Loading
the compositor alone causes no visible change; at least one producer must publish
a compositor status key.

Publish again under the same key to replace its value. Pass `undefined` to remove
it immediately, for example when a condition no longer applies. Use the same key
whether or not the compositor is installed; do not also publish a duplicate under
an ordinary status key.

```ts
ctx.ui.setStatus("footer-compositor:right:20:my-extension-state", "Working");
ctx.ui.setStatus("footer-compositor:right:20:my-extension-state", undefined);
```

Publish from an active TUI context and clear every owned key during
`session_shutdown`, whether or not the compositor is installed:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "footer-compositor:right:20:my-extension-state";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, "Ready");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
```

If your producer uses timers or asynchronous requests, stop its timers and cancel
pending requests where possible during `session_shutdown`. Ensure late results
cannot publish after shutdown. Clear keys using the context passed to the
shutdown handler; do not reuse a context from an earlier session.

## Optional width-aware producers

Use this capability when a left or right segment needs to choose its format from
its available space—for example, switching from per-item characters to counts. Static producers do not need it or any changes to their existing code.
Both sides use the same capability; the status key determines placement.

Discover the capability through Pi's public `pi.events` bus. Do not import this
package or depend on its installation path. The shared structural types are:

```ts
import type { Theme } from "@earendil-works/pi-coding-agent";

type DynamicRenderer = (input: {
  maxWidth: number;
  theme: Theme;
}) => string | undefined;

interface DynamicProducerCapabilityV1 {
  version: 1;
  instanceId: string;
  register(input: {
    key: string;
    render: DynamicRenderer;
  }): () => void;
}
```

| Channel | Payload | Sender |
|---|---|---|
| `footer-compositor:dynamic:discover` | `{ version: 1, accept: (capability: DynamicProducerCapabilityV1) => void }` | Producer |
| `footer-compositor:dynamic:available` | `DynamicProducerCapabilityV1` | Compositor |
| `footer-compositor:dynamic:unavailable` | `{ version: 1, instanceId: string }` | Compositor |

The earlier `footer-compositor:dynamic-left:*` prototype channels are not handled.
Prototype producers must switch to the shared channels above; status keys and
static producers do not change.

Subscribe during `session_start`, then emit discover. An installed compositor
responds synchronously; its available announcement handles the opposite start
order. Ignore unsupported versions and malformed payloads. Repeated announcements
of the same instance must not create duplicate registrations. A different
instance replaces the producer's previous registration; an unavailable notice
only applies to its matching instance. Capability identities are session-scoped,
not package versions. Unsubscribe and release them during `session_shutdown`.

### Registration and fallback

Always publish a nonempty static fallback under the **same status key**.
Registration overrides that value's rendering; it does not add another status.
Clearing the status with `undefined` hides the segment even while registered.
Republish fallback after registration, cached-data updates and unregistration:
Pi's `setStatus()` requests a render even when its text has not changed. Registry
changes otherwise take effect on the next render.

`register()` accepts a valid left or right key with a finite numeric order and
a callable renderer. Invalid arguments throw `TypeError`; a retired capability
throws `Error`. Keep static fallback if registration fails. Re-registering a key replaces
its renderer. Disposers are idempotent and cannot remove a newer registration.

Without a compositor, or with an older compositor lacking this capability, the
fallback still follows the static protocol. The capability is advertised only in
TUI mode. If the upstream footer shape is unrecognized, the compositor does not
invoke dynamic renderers and leaves Pi's output, including fallbacks, unchanged.
Capability discovery therefore does not guarantee first-line placement on an
unsupported Pi footer or a custom replacement footer.

### Renderer and allocation rules

- `maxWidth` is a nonnegative integer number of **visible terminal columns**,
  not the terminal width. Use Pi's `visibleWidth()` for measurement.
- Render from cached data only. Do not perform filesystem, tmux, network or model
  calls, mutate state or registrations, publish statuses, or emit events here.
- Return a synchronous, single-line string fitting the budget, or empty/undefined.
  At a zero budget, return empty/undefined. The supplied theme is current for
  this render; do not reuse strings styled with an earlier theme.
- ANSI SGR color/style sequences (`ESC [ … m`) are allowed and isolated from
  neighboring text. Other terminal controls, including tabs, newlines, cursor
  commands and OSC hyperlinks, are rejected for dynamic output. This restriction
  does not change the existing static protocol.
- Throwing, non-string, async, unsafe or oversized output becomes a neutral `…`
  when one column is available, otherwise nothing. Diagnostics are deferred,
  bounded and deduplicated per registration and failure kind. Valid output is
  never truncated after formatting.

Allocation is **right first, then left**, without a second formatting pass:

1. **Right:** reserve the existing 12-column minimum left area and two-column
   left/right padding. Allocate the rest in descending numeric order, with the
   larger full key first on ties. Dynamic renderers receive the remaining budget
   after allowing for a separator when higher-priority right text is present.
   Nonempty output consumes its width and that separator; empty output consumes
   neither. Static right values are indivisible: if one cannot fit, it and all
   lower-priority segments are dropped, matching the existing priority rule.
   Retained right segments are displayed in ascending order with dim bullets.
2. **Left:** use the space left by the completed right side. Reserve static left
   values, separators and up to 12 columns of path/session text. Allocate the
   remaining pool in ascending numeric order, with the smaller full key first
   on ties. Each dynamic renderer receives what earlier left renderers left
   unused. Unused space expands the path/session text. Reservations for empty
   left segments' separators are not reassigned to dynamic renderers within
   that render. Impossible static layouts retain static clipping.

A high-priority right renderer may consume the entire right budget, displacing
lower-priority right statuses and leaving no budget for dynamic left values.
The 12-column right-side reservation protects the whole left area, not 12 columns
of base text plus every left marker. Empty right output frees space for the left
side; if all right output is empty, the left/right padding is also released.
A renderer's fallback length never determines its budget. Higher-priority output
can affect later budgets, but a renderer's own output does not change its budget.

Without a present dynamic status on a side, that side uses its unchanged static
layout. Registering a renderer alone does not make a status present.

### Complete producer example

This synthetic producer switches between a strip and counts. Replace the demo
command with your own observation code; update cached strings and publish outside
the renderer. Include the structural declarations above in your extension.
For right placement, change `KEY` to `footer-compositor:right:20:my-monitor`;
discovery and registration stay the same.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const KEY = "footer-compositor:left:20:my-monitor";
const PREFIX = "footer-compositor:dynamic:";

export default function (pi: ExtensionAPI) {
  let active = false;
  let strip = "WWII";
  let counts = "W2 I2";
  let capability: DynamicProducerCapabilityV1 | undefined;
  let unregister: (() => void) | undefined;
  let publish: (() => void) | undefined;
  let subscriptions: Array<() => void> = [];

  const render: DynamicRenderer = ({ maxWidth, theme }) => {
    const text = visibleWidth(strip) <= maxWidth ? strip
      : visibleWidth(counts) <= maxWidth ? counts
      : maxWidth > 0 ? "…" : "";
    return text ? theme.fg("accent", text) : undefined;
  };

  function accept(payload: unknown) {
    if (!active || !payload || typeof payload !== "object") return;
    const next = payload as DynamicProducerCapabilityV1;
    if (next.version !== 1 || typeof next.instanceId !== "string" ||
        !next.instanceId || typeof next.register !== "function" ||
        next.instanceId === capability?.instanceId) return;
    try {
      const remove = next.register({ key: KEY, render });
      unregister?.();
      unregister = remove;
      capability = next;
    } catch {
      // Retain any working registration, otherwise use static fallback.
    }
    publish?.();
  }

  function discover() {
    if (active) pi.events.emit(PREFIX + "discover", { version: 1, accept });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || active) return;
    active = true;
    publish = () => ctx.ui.setStatus(KEY, counts);
    subscriptions = [
      pi.events.on(PREFIX + "available", accept),
      pi.events.on(PREFIX + "unavailable", (payload) => {
        if (!active || !payload || typeof payload !== "object") return;
        const notice = payload as { version?: unknown; instanceId?: unknown };
        if (notice.version !== 1 || !capability ||
            notice.instanceId !== capability.instanceId) return;
        unregister?.();
        unregister = undefined;
        capability = undefined;
        publish?.();
        discover();
      }),
    ];
    publish();
    discover();
  });

  pi.registerCommand("monitor-demo", {
    description: "Toggle cached synthetic monitor data",
    handler: async () => {
      const large = strip.length === 4;
      strip = large ? "W".repeat(30) : "WWII";
      counts = large ? "W30 I0" : "W2 I2";
      publish?.();
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!active) return;
    active = false;
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions = [];
    unregister?.();
    unregister = undefined;
    capability = undefined;
    publish = undefined;
    ctx.ui.setStatus(KEY, undefined);
  });
}
```

## Dependencies and compatibility

This extension has no dependency on another Pi extension. It currently patches
`FooterComponent.prototype.render()` because Pi does not provide composable
first-line footer slots. That is an internal integration point and may require
updates when Pi changes its footer implementation.

If the footer layout or status accessor is not recognized, the compositor leaves
Pi's rendered output unchanged rather than removing an unknown row. Producer
values retain Pi's normal status placement. Changes to internal exports can still
require an extension update.

Automated checks cover Pi 1.0.2 and 1.1.0. The width-aware capability has also
been checked in isolated regular/fullscreen TUI sessions on Pi 1.1.0. Older Pi
versions have not been retested.

Pi has npm runtime dependencies for packages, but no manifest mechanism for
expressing extension-to-extension activation dependencies. Producer extensions
therefore use the public `setStatus()` API and degrade gracefully: without this
compositor, Pi simply shows their values on its regular extension-status line.

Only one extension should patch `FooterComponent.prototype.render()`. Cleanup
does not overwrite a later render patch, but competing footer patches are not
supported. Do not run the old standalone `footer-status.ts` patch alongside this
compositor.

## Installation

Install this extension from GitHub:

```bash
pi install git:github.com/7h145/pi-footer-compositor
```

This is a personal/global install. Add `-l` for a project-local install.
Run `/reload` after installing or updating while Pi is running.

Producer extensions, such as
[`pi-git-monitor`](https://github.com/7h145/pi-git-monitor) and
[`pi-codex-usage`](https://github.com/7h145/pi-codex-usage), are installed
separately. The compositor alone causes no visible change.

To try a local checkout without installing, run from its root:

```bash
pi --no-extensions -e .
```

This loads only the checkout's extension, avoiding a second installed copy
of the footer patch.

### Migrating from pi-assorted

If you have the legacy [`pi-assorted`](https://github.com/7h145/pi-assorted)
collection installed, turn off its pi-footer-compositor extension before
installing this standalone version. Otherwise Pi will try to load the same
extension twice.

Run `pi config` in a terminal. Under the `pi-assorted` package's Extensions
entries, select `pi-footer-compositor/pi-footer-compositor.ts` and press Space to
uncheck it (`[ ]`). Changes are saved immediately; press Esc to close.

For a project-local collection installation, run `pi config -l` from that
project and press Space until the entry shows `[-]` (project unload).

See Pi's [resource settings reference](https://pi.dev/docs/latest/settings#resources)
for configuration details.

## Development

Use Node.js 22.19 or newer. Development dependencies are pinned to Pi 1.1.0; Pi
provides the runtime packages when loading the extension.

```bash
npm ci
npm run check
```

`check` runs TypeScript checking and Node's built-in test runner. The tests cover
static and dynamic layout, discovery, invalid renderer output, ordinary statuses,
unknown footer shapes, theme changes and patch cleanup without starting an agent
or contacting a provider.

## Last confirmed working

| Date | Code revision | Pi | Node.js | Platform |
|---|---|---|---|---|
| 2026-10-11 | `9eeed0c` | `1.1.0` | `26.10.0` | Linux x64 |

**Checked:** isolated live TUI (regular/fullscreen) with synthetic producers:
status placement, resizing and reload/shutdown. Type checking and 19 automated
tests also pass.

One known-working configuration, not a supported-version range.
