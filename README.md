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

## Dependencies and compatibility

This extension has no dependency on another Pi extension. It currently patches
`FooterComponent.prototype.render()` because Pi does not provide composable
first-line footer slots. That is an internal integration point and may require
updates when Pi changes its footer implementation.

If the footer layout or status accessor is not recognized, the compositor leaves
Pi's rendered output unchanged rather than removing an unknown row. Producer
values retain Pi's normal status placement. Changes to internal exports can still
require an extension update.

Automated checks and isolated regular/fullscreen TUI checks cover Pi 1.0.2 and
1.1.0. Older Pi versions have not been retested.

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
[`pi-footer-workspace`](https://github.com/7h145/pi-footer-workspace) and
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
layout, ordinary statuses, unknown footer shapes, theme changes and patch cleanup
without starting an agent or contacting a provider.
