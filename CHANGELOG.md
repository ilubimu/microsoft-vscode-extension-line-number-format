# Changelog

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
