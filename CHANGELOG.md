# Changelog

## 0.4.4 — 2026-11-24 — Mode-switch responsiveness

- Rapid hexadecimal/both switches now coalesce into one render on the next
  frame instead of one synchronous full render per switch.
- Mode persistence is debounced and throttled, so a burst of switches writes
  `settings.json` once instead of once per click.
- Stale configuration events from earlier writes can no longer flip the
  display back to an older mode while a newer mode is settling.
- Selection and visible-range bursts share the same frame throttle, preventing
  drag-selection from bypassing the renderer limit.
- Full refreshes no longer cancel a pending scroll render; the newest visible
  range is kept and rendered on the next frame.
- Added a black-box stress test (200,000-line file, 80 rapid mode switches and
  far jumps, plus real scrollbar drags). On the test machine, the same workload
  improved from ~6 s command latency / ~0.5 s event-loop stalls to ~4 ms p95 and
  ~20 ms maximum event-loop lag, with labels settling in a few milliseconds.

## 0.4.3 — 2026-11-24 — First public release

- Decimal, hexadecimal, and combined line-number display modes.
- Status-bar mode picker and Command Palette commands; no keybindings.
- Zero-padded hex labels, optional `0x` prefix, uppercase/lowercase, and
  vertical-bar separators between decimal, hexadecimal, and code.
- Current-line label highlighting.
- Visible-range-only renderer with cached decorations, a one-frame update
  throttle, and a 60-line forward / 15-line backward cushion for large files.
- Screen Reader Optimized fallback: the native decimal gutter stays visible
  while hex labels are overlaid.
- Isolated black-box test suite (unit, UI, VSIX installation) and a
  dependency-free VSIX packager.
- Extension icon.
