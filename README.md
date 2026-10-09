# pi-footer-compositor

A small compositor for Pi's built-in two-line footer. It preserves the upstream
footer and relocates specially named extension statuses into slots on the first
line.

```text
/stage (ro)                                      clean • C W2%
↑278k ↓19k ...                         gpt-5.6-sol • medium
```

## Producer protocol

Producer extensions use Pi's normal `ctx.ui.setStatus()` API with a structured
status key:

```text
footer-compositor:left:<order>:<id>
footer-compositor:right:<order>:<id>
```

For example:

```ts
ctx.ui.setStatus("footer-compositor:right:20:codex-usage", "C W2%");
ctx.ui.setStatus("footer-compositor:left:10:read-only", "(ro)");
```

Segments are displayed in ascending numeric order and separated with the same
dim `•` used by Pi's built-in footer. On narrow terminals, lower-order right
segments are removed first. Statuses with ordinary keys remain on Pi's normal
extension-status line. Loading the compositor alone causes no visible change;
at least one producer must publish a compositor status key.

Producers must clear their keys during `session_shutdown`:

```ts
ctx.ui.setStatus("footer-compositor:right:20:codex-usage", undefined);
```

## Dependencies and compatibility

This extension has no dependency on another Pi extension. It currently patches
`FooterComponent.prototype.render()` because Pi does not provide composable
first-line footer slots. That is an internal integration point and may require
updates when Pi changes its footer implementation. Last verified with Pi 0.80.6.

Pi has npm runtime dependencies for packages, but no manifest mechanism for
expressing extension-to-extension activation dependencies. Producer extensions
therefore use the public `setStatus()` API and degrade gracefully: without this
compositor, Pi simply shows their values on its regular extension-status line.

Only one extension should patch `FooterComponent.prototype.render()`. Do not
run the old standalone `footer-status.ts` patch alongside this compositor.

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

If you already use the compositor through `pi-assorted`, disable that copy
with `pi config` before installing the standalone package.

To try a local checkout without installing, run from its root:

```bash
pi --no-extensions -e .
```

This loads only the checkout's extension, avoiding a second installed copy
of the footer patch.
