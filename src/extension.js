'use strict';

const vscode = require('vscode');
const { formatLabel, labelColumnWidth } = require('./format');

const MODES = ['decimal', 'hex', 'both'];
const MODE_NAMES = {
  decimal: 'Decimal',
  hex: 'Hexadecimal',
  both: 'Decimal + Hexadecimal',
};
const MODE_SHORT = {
  decimal: 'Dec',
  hex: 'Hex',
  both: 'Dec+Hex',
};

// Coalesce bursts of scroll events into one update per frame. Cursor moves
// render immediately (selection events), so the current-line highlight stays
// responsive; only high-frequency visible-range events are throttled.
const RENDER_INTERVAL_MS = 16;
// Safety net for a missed/late visible-range event after a far mouse jump.
// This must run for unfocused windows too: Windows can scroll an inactive
// VS Code window under the pointer, and those visible-range events can be
// delayed or coalesced. Checking all visible editors also covers split views
// whose active editor is a different pane.
const VISIBLE_POLL_MS = 100;
// Keep a lead cushion in the scroll direction so the next frames are already
// labelled. 60/15 keeps the decoration set around 100 entries instead of 220.
const BUFFER_BEHIND = 15;
const BUFFER_AHEAD = 60;
// Never build a pathological decoration set if the editor reports a transient
// whole-document range during a jump. 400 covers 4K viewports plus buffers.
const MAX_DECORATED_LINES = 400;
// Immediate label window around the clicked line when visibleRanges is stale.
const FOCUS_WINDOW = 120;

/** @type {import('./format').LineNumberMode} */
let mode = 'decimal';
let style = null;
/** @type {vscode.TextEditorDecorationType | null} */
let baseDecorationType = null;
/** @type {vscode.StatusBarItem | null} */
let statusBar = null;
/** @type {NodeJS.Timeout | null} */
let renderTimer = null;
/** @type {NodeJS.Timeout | null} */
let visiblePoll = null;
/** Mode we just wrote; guards against stale configuration events. */
let pendingMode = null;
/** @type {NodeJS.Timeout | null} */
let pendingModeTimer = null;
const scheduled = new Set();

const tracked = new Set();
/** Editors whose native line numbers this extension switched off. */
const overridden = new WeakSet();
/**
 * Per-editor render cache. Options are reused for unchanged lines so that
 * scrolling and cursor movement only update the decorations that actually
 * changed. The cache is pruned to the current intervals on every render.
 */
const editorStates = new WeakMap();

const stats = {
  renders: 0,
  lastMs: 0,
  lastLines: 0,
  lastAt: 0,
  lastIntervalLines: 0,
  maxLines: 0,
  maxMs: 0,
  maxIntervalLines: 0,
  clamped: 0,
  errors: 0,
};

let normalColor = null;
let activeColor = null;

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function readStyle() {
  const config = vscode.workspace.getConfiguration('lineNumberFormat');
  const rawMode = config.get('mode', 'decimal');
  const gapValue = Number(config.get('gap', 2));
  return {
    mode: MODES.includes(rawMode) ? rawMode : 'decimal',
    hexPrefix: config.get('hexPrefix', true) !== false,
    hexUppercase: config.get('hexUppercase', true) !== false,
    hexPad: config.get('hexPad', true) !== false,
    showSeparators: config.get('showSeparators', true) !== false,
    activeLineHighlight: config.get('activeLineHighlight', true) !== false,
    gap: Number.isFinite(gapValue) ? Math.min(8, Math.max(0, Math.floor(gapValue))) : 2,
  };
}

function styleKey(value) {
  return [
    value.mode,
    value.hexPrefix ? 1 : 0,
    value.hexUppercase ? 1 : 0,
    value.hexPad ? 1 : 0,
    value.showSeparators ? 1 : 0,
    value.activeLineHighlight ? 1 : 0,
    value.gap,
  ].join('|');
}

async function persistMode(next) {
  const editor = vscode.window.activeTextEditor;
  const scopeUri = editor && !editor.document.isClosed ? editor.document.uri : undefined;
  const config = vscode.workspace.getConfiguration('lineNumberFormat', scopeUri);
  const inspected = config.inspect('mode');

  let target = vscode.ConfigurationTarget.Global;
  if (
    inspected &&
    inspected.workspaceFolderValue !== undefined &&
    scopeUri &&
    vscode.workspace.getWorkspaceFolder(scopeUri)
  ) {
    target = vscode.ConfigurationTarget.WorkspaceFolder;
  } else if (inspected && inspected.workspaceValue !== undefined) {
    target = vscode.ConfigurationTarget.Workspace;
  }

  await config.update('mode', next, target);
}

/* ------------------------------------------------------------------ */
/* Native line numbers                                                 */
/* ------------------------------------------------------------------ */

function nativeLineNumberStyle(editor) {
  let raw = 'on';
  try {
    raw = vscode.workspace.getConfiguration('editor', editor.document).get('lineNumbers', 'on');
  } catch (_) {
    raw = 'on';
  }
  switch (raw) {
    case 'off':
      return vscode.TextEditorLineNumbersStyle.Off;
    case 'relative':
      return vscode.TextEditorLineNumbersStyle.Relative;
    case 'interval': {
      const interval = vscode.TextEditorLineNumbersStyle.Interval;
      return typeof interval === 'number' ? interval : vscode.TextEditorLineNumbersStyle.On;
    }
    default:
      return vscode.TextEditorLineNumbersStyle.On;
  }
}

function isAccessibilityModeOn() {
  try {
    return vscode.workspace.getConfiguration('editor').get('accessibilitySupport', 'auto') === 'on';
  } catch (_) {
    return false;
  }
}

function hideNativeLineNumbers(editor) {
  if (!editor || editor.document.isClosed) return;

  // In Screen Reader Optimized mode Monaco flushes line/decorations updates
  // through its accessibility path, which can lag for seconds on a 196k-line
  // file. Keep the native (accessible) gutter visible as a fallback; the hex
  // labels are still drawn inline when they update.
  if (isAccessibilityModeOn()) {
    restoreNativeLineNumbers(editor);
    return;
  }

  try {
    // Mark the editor even when it is already off. VS Code can reuse an
    // editor widget for a new document; that new TextEditor object inherits
    // the off state and still has to be restored when decimal mode returns.
    overridden.add(editor);
    if (editor.options.lineNumbers !== vscode.TextEditorLineNumbersStyle.Off) {
      editor.options = { lineNumbers: vscode.TextEditorLineNumbersStyle.Off };
    }
  } catch (err) {
    stats.errors++;
    console.error('[line-number-format] could not hide native line numbers:', err);
  }
}

function restoreNativeLineNumbers(editor) {
  if (!editor || editor.document.isClosed) return;
  if (!overridden.has(editor)) return;
  overridden.delete(editor);
  try {
    const target = nativeLineNumberStyle(editor);
    if (editor.options.lineNumbers !== target) {
      editor.options = { lineNumbers: target };
    }
  } catch (err) {
    stats.errors++;
    console.error('[line-number-format] could not restore native line numbers:', err);
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * One decoration type is enough: each line's label options are cached, so only
 * the options whose label or colour actually changed are new objects. Moving
 * the cursor therefore changes two options (old/new current line), not the
 * whole column, and the update is a single atomic setDecorations call.
 */
function getDecorationType() {
  if (!baseDecorationType) {
    baseDecorationType = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      before: {
        contentText: '',
        color: normalColor,
        textDecoration: 'none',
      },
    });
  }
  return baseDecorationType;
}

function mergeIntervals(spans) {
  if (spans.length === 0) return [];
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && span[0] <= previous[1] + 1) {
      if (span[1] > previous[1]) previous[1] = span[1];
    } else {
      merged.push(span.slice());
    }
  }
  return merged;
}

/**
 * Turn Monaco's visible ranges into a small set of line intervals. Folding can
 * make the visible ranges non-contiguous, and decorating the whole span
 * between them would be wasteful in a large file.
 */
function visibleIntervals(ranges, lineCount, before, after) {
  if (!ranges || ranges.length === 0) return [];

  const spans = [];
  for (const range of ranges) {
    const start = Math.max(0, range.start.line - before);
    const end = Math.min(lineCount - 1, range.end.line + after);
    if (end >= start) spans.push([start, end]);
  }
  return mergeIntervals(spans);
}

function clearDecorations(editor) {
  if (!editor || editor.document.isClosed) return;
  editorStates.delete(editor);
  if (!baseDecorationType) return;
  try {
    editor.setDecorations(baseDecorationType, []);
  } catch (_) {
    /* editor may have been disposed */
  }
}

function renderEditor(editor, focusLine) {
  if (mode === 'decimal') {
    clearDecorations(editor);
    return;
  }
  if (!editor || editor.document.isClosed) return;

  const document = editor.document;
  const lineCount = Math.max(1, document.lineCount);
  const ranges = editor.visibleRanges;
  if (!ranges || ranges.length === 0) return;
  const visibleFirst = ranges[0].start.line;
  const visibleLast = ranges[ranges.length - 1].end.line;

  const activeLine = style.activeLineHighlight ? editor.selection.active.line + 1 : 0;
  const formatting = styleKey(style);

  let state = editorStates.get(editor);
  if (
    !state ||
    state.document !== document ||
    state.lineCount !== lineCount ||
    state.formatting !== formatting
  ) {
    state = {
      document,
      lineCount,
      formatting,
      width: labelColumnWidth(lineCount, style),
      options: new Map(),
      scratch: new Map(),
      decorations: [],
      renderKey: null,
      visibleFirst: null,
      visibleLast: null,
      direction: 1,
    };
    editorStates.set(editor, state);
  }

  let direction = state.direction || 1;
  if (state.visibleFirst !== null) {
    if (visibleFirst > state.visibleFirst) direction = 1;
    else if (visibleFirst < state.visibleFirst) direction = -1;
  }
  const before = direction >= 0 ? BUFFER_BEHIND : BUFFER_AHEAD;
  const after = direction >= 0 ? BUFFER_AHEAD : BUFFER_BEHIND;
  let intervals = visibleIntervals(ranges, lineCount, before, after);
  if (intervals.length === 0) return;

  const rawIntervalLines = intervals.reduce((sum, interval) => sum + interval[1] - interval[0] + 1, 0);
  if (rawIntervalLines > stats.maxIntervalLines) stats.maxIntervalLines = rawIntervalLines;

  // A selection event can arrive before visibleRanges reflects a far click.
  // Add a small window at the clicked line so its labels can appear at once.
  if (typeof focusLine === 'number' && focusLine >= 0) {
    const covered = intervals.some((interval) => focusLine >= interval[0] && focusLine <= interval[1]);
    if (!covered) {
      const half = Math.floor(FOCUS_WINDOW / 2);
      const start = Math.max(0, focusLine - half);
      const end = Math.min(lineCount - 1, start + FOCUS_WINDOW - 1);
      intervals = mergeIntervals([...intervals, [start, end]]);
    }
  }

  // Protect against a transient whole-document visible range during a jump.
  let intervalLines = intervals.reduce((sum, interval) => sum + interval[1] - interval[0] + 1, 0);
  if (intervalLines > MAX_DECORATED_LINES) {
    const anchor =
      typeof focusLine === 'number' ? focusLine : editor.selection.active.line;
    const half = Math.floor(FOCUS_WINDOW / 2);
    const start = Math.max(0, anchor - half);
    const end = Math.min(lineCount - 1, start + FOCUS_WINDOW - 1);
    intervals = [[start, end]];
    intervalLines = end - start + 1;
    stats.clamped++;
  }

  const intervalsKey = intervals.map((interval) => interval.join('-')).join(',');
  const renderKey = `${lineCount}|${formatting}|${intervalsKey}|${activeLine}`;
  stats.lastIntervalLines = intervalLines;
  state.visibleFirst = visibleFirst;
  state.visibleLast = visibleLast;
  state.direction = direction;
  if (state.renderKey === renderKey) return;

  const previousOptions = state.options;
  const nextOptions = state.scratch;
  nextOptions.clear();
  const decorations = state.decorations;
  decorations.length = 0;
  const started = performance.now();

  for (const interval of intervals) {
    for (let line = interval[0]; line <= interval[1]; line++) {
      const lineNumber = line + 1;
      let option = previousOptions.get(line);
      if (!option) {
        option = {
          range: new vscode.Range(line, 0, line, 0),
          renderOptions: {
            before: {
              contentText: formatLabel(lineNumber, lineCount, style),
              width: `${state.width}ch`,
              color: normalColor,
            },
          },
        };
      }
      nextOptions.set(line, option);

      if (lineNumber === activeLine) {
        // Only the current line's option gets a new colour; every other
        // option object is reused from the cache.
        decorations.push({
          range: option.range,
          renderOptions: {
            before: { ...option.renderOptions.before, color: activeColor },
          },
        });
      } else {
        decorations.push(option);
      }
    }
  }

  state.options = nextOptions;
  state.scratch = previousOptions;
  previousOptions.clear();
  state.renderKey = renderKey;

  const type = getDecorationType();
  // A single atomic update: the old active label turns normal and the new one
  // turns active in the same setDecorations call.
  editor.setDecorations(type, decorations);

  stats.renders++;
  stats.lastMs = performance.now() - started;
  stats.lastLines = decorations.length;
  stats.lastAt = Date.now();
  if (stats.lastLines > stats.maxLines) stats.maxLines = stats.lastLines;
  if (stats.lastMs > stats.maxMs) stats.maxMs = stats.lastMs;
}

function renderSafe(editor, focusLine) {
  try {
    renderEditor(editor, focusLine);
  } catch (err) {
    stats.errors++;
    console.error('[line-number-format] render failed:', err);
  }
}

function scheduleRender(editor) {
  if (mode === 'decimal') return;
  if (!editor || editor.document.isClosed) return;
  scheduled.add(editor);
  if (renderTimer === null) {
    renderTimer = setTimeout(flushScheduled, RENDER_INTERVAL_MS);
  }
}

function flushScheduled() {
  renderTimer = null;
  const editors = Array.from(scheduled);
  scheduled.clear();
  const visible = vscode.window.visibleTextEditors;
  for (const editor of editors) {
    if (editor.document.isClosed) continue;
    if (!visible.includes(editor)) continue;
    renderSafe(editor);
  }
}

function startVisiblePoll() {
  if (visiblePoll) return;
  visiblePoll = setInterval(() => {
    if (mode === 'decimal') return;
    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {
      if (editor.document.isClosed) continue;
      const ranges = editor.visibleRanges;
      if (!ranges || ranges.length === 0) continue;

      const state = editorStates.get(editor);
      if (!state) {
        scheduleRender(editor);
        continue;
      }
      const first = ranges[0].start.line;
      const last = ranges[ranges.length - 1].end.line;
      if (first !== state.visibleFirst || last !== state.visibleLast) {
        scheduleRender(editor);
      }
    }
  }, VISIBLE_POLL_MS);
}

/* ------------------------------------------------------------------ */
/* Mode switching                                                      */
/* ------------------------------------------------------------------ */

function syncVisibleEditors() {
  const visible = vscode.window.visibleTextEditors;
  const current = new Set(visible);

  for (const editor of Array.from(tracked)) {
    if (!current.has(editor)) tracked.delete(editor);
  }

  for (const editor of visible) {
    tracked.add(editor);
    if (mode === 'decimal') {
      restoreNativeLineNumbers(editor);
      clearDecorations(editor);
    } else {
      hideNativeLineNumbers(editor);
      renderSafe(editor);
    }
  }
}

function refreshAll() {
  updateStatusBar();

  scheduled.clear();
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  const editors = new Set(tracked);
  for (const editor of vscode.window.visibleTextEditors) editors.add(editor);

  for (const editor of editors) {
    if (editor.document.isClosed) {
      tracked.delete(editor);
      continue;
    }
    if (mode === 'decimal') {
      restoreNativeLineNumbers(editor);
      clearDecorations(editor);
    } else {
      hideNativeLineNumbers(editor);
      renderSafe(editor);
    }
  }
}

async function setMode(next, persist = true) {
  if (!MODES.includes(next)) {
    throw new Error(`Unknown line number mode: ${next}`);
  }

  const changed = next !== mode;
  mode = next;

  const fresh = readStyle();
  style = {
    ...fresh,
    mode,
  };

  if (changed) {
    refreshAll();
  } else {
    updateStatusBar();
  }

  if (persist) {
    pendingMode = next;
    if (pendingModeTimer !== null) {
      clearTimeout(pendingModeTimer);
      pendingModeTimer = null;
    }
    pendingModeTimer = setTimeout(() => {
      if (pendingMode === next) pendingMode = null;
      pendingModeTimer = null;
    }, 1500);
    try {
      await persistMode(next);
    } catch (err) {
      console.error('[line-number-format] could not save the mode setting:', err);
      vscode.window.showErrorMessage(
        `Line Number Format: could not save the setting (${err instanceof Error ? err.message : String(err)}).`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function updateStatusBar() {
  if (!statusBar) return;
  statusBar.text = `$(symbol-numeric) LN: ${MODE_SHORT[mode]}`;
  const accessibilitySuffix =
    mode !== 'decimal' && isAccessibilityModeOn()
      ? ' Native decimal gutter stays visible in screen-reader mode.'
      : '';
  statusBar.tooltip = `Line numbers: ${MODE_NAMES[mode]}. Click to change.${accessibilitySuffix}`;
  statusBar.show();
}

async function showMenu() {
  const current = mode;
  const items = [
    {
      label: '$(symbol-numeric) Decimal only',
      description: current === 'decimal' ? 'Current — VS Code native gutter' : 'VS Code native gutter',
      mode: 'decimal',
    },
    {
      label: '$(symbol-numeric) Hexadecimal only',
      description: current === 'hex' ? 'Current — zero-padded 0x labels' : 'Zero-padded 0x labels',
      mode: 'hex',
    },
    {
      label: '$(symbol-numeric) Decimal + Hexadecimal',
      description: current === 'both' ? 'Current — both values per line' : 'Both values on every line',
      mode: 'both',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Line Number Format',
    placeHolder: 'Choose how line numbers are displayed',
    matchOnDescription: true,
  });

  if (picked) await setMode(picked.mode, true);
}

function showDiagnostics() {
  const editor = vscode.window.activeTextEditor;
  const documentLines = editor ? editor.document.lineCount : 0;
  const renderInfo =
    mode === 'decimal'
      ? 'Native VS Code line numbers are in use; no custom labels are rendered.'
      : `Last render: ${stats.lastMs.toFixed(2)} ms for ${stats.lastLines} label(s); peak: ${stats.maxMs.toFixed(2)} ms / ${stats.maxLines} label(s), ${stats.maxIntervalLines} interval line(s), ${stats.clamped} clamped; ${stats.renders} render(s) total.`;

  vscode.window.showInformationMessage(
    `Line Number Format — mode: ${MODE_NAMES[mode]}; active document: ${documentLines.toLocaleString()} line(s). ${renderInfo}`
  );
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function onConfigurationChanged(event) {
  if (event.affectsConfiguration('lineNumberFormat')) {
    const next = readStyle();

    // VS Code can emit a configuration event with the previous value while a
    // mode update is still settling. Ignore that stale mode so a fast mode
    // switch followed by a far click cannot flip the display back mid-jump.
    if (pendingMode && next.mode !== pendingMode) {
      next.mode = mode;
    } else if (pendingMode && next.mode === pendingMode) {
      pendingMode = null;
      if (pendingModeTimer !== null) {
        clearTimeout(pendingModeTimer);
        pendingModeTimer = null;
      }
    }

    const modeChanged = next.mode !== mode;
    const formattingChanged = styleKey(next) !== styleKey(style);

    mode = next.mode;
    style = next;

    if (modeChanged || formattingChanged) {
      refreshAll();
    } else {
      updateStatusBar();
    }
  }

  // Keep native numbers hidden if the user changes "editor.lineNumbers"
  // while a custom format is active.
  if (mode !== 'decimal' && event.affectsConfiguration('editor.lineNumbers')) {
    for (const editor of vscode.window.visibleTextEditors) {
      hideNativeLineNumbers(editor);
    }
  }

  if (event.affectsConfiguration('editor.accessibilitySupport')) {
    refreshAll();
  }
}

/* ------------------------------------------------------------------ */
/* Activation                                                          */
/* ------------------------------------------------------------------ */

function getState() {
  const editor = vscode.window.activeTextEditor;
  return {
    mode,
    style: { ...style },
    activeDocument: editor
      ? {
          uri: editor.document.uri.toString(),
          lineCount: editor.document.lineCount,
          lineNumbersOption: editor.options.lineNumbers,
        }
      : null,
    visibleEditors: vscode.window.visibleTextEditors.slice(0, 20).map((visible) => {
      const state = editorStates.get(visible);
      return {
        uri: visible.document.uri.toString(),
        lineCount: visible.document.lineCount,
        lineNumbersOption: visible.options.lineNumbers,
        signature: state ? state.renderKey : null,
      };
    }),
    trackedEditors: tracked.size,
    stats: { ...stats },
  };
}

function cleanup() {
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  if (visiblePoll !== null) {
    clearInterval(visiblePoll);
    visiblePoll = null;
  }
  if (pendingModeTimer !== null) {
    clearTimeout(pendingModeTimer);
    pendingModeTimer = null;
  }
  pendingMode = null;
  scheduled.clear();

  for (const editor of Array.from(tracked)) {
    clearDecorations(editor);
    restoreNativeLineNumbers(editor);
  }
  tracked.clear();

  if (baseDecorationType) {
    baseDecorationType.dispose();
    baseDecorationType = null;
  }
}

function activate(context) {
  normalColor = new vscode.ThemeColor('editorLineNumber.foreground');
  activeColor = new vscode.ThemeColor('editorLineNumber.activeForeground');

  style = readStyle();
  mode = style.mode;

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'lineNumberFormat.showMenu';
  context.subscriptions.push(statusBar);
  updateStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand('lineNumberFormat.showMenu', showMenu),
    vscode.commands.registerCommand('lineNumberFormat.decimal', () => setMode('decimal', true)),
    vscode.commands.registerCommand('lineNumberFormat.hex', () => setMode('hex', true)),
    vscode.commands.registerCommand('lineNumberFormat.both', () => setMode('both', true)),
    vscode.commands.registerCommand('lineNumberFormat.showDiagnostics', showDiagnostics),
    vscode.window.onDidChangeVisibleTextEditors(syncVisibleEditors),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      tracked.add(editor);
      if (mode === 'decimal') {
        restoreNativeLineNumbers(editor);
      } else {
        hideNativeLineNumbers(editor);
        renderSafe(editor);
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused || mode === 'decimal') return;
      // An inactive window can scroll under the pointer. Refresh every visible
      // editor immediately when focus returns instead of waiting for the next
      // visible-range notification.
      for (const editor of vscode.window.visibleTextEditors) renderSafe(editor);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      scheduleRender(event.textEditor);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (mode !== 'decimal') {
        // The focus line lets a far click get labels immediately even if
        // visibleRanges has not caught up yet.
        renderSafe(event.textEditor, event.textEditor.selection.active.line);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (mode === 'decimal') return;
      for (const editor of tracked) {
        if (editor.document !== event.document) continue;
        const state = editorStates.get(editor);
        // Label content depends only on line numbers. Typing inside a line
        // cannot change them; only a line-count change needs a repaint.
        if (state && state.document === editor.document && state.lineCount === editor.document.lineCount) {
          continue;
        }
        scheduleRender(editor);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(onConfigurationChanged)
  );

  syncVisibleEditors();
  startVisiblePoll();

  return {
    getState,
    setMode: (next) => setMode(next, true),
    refresh: refreshAll,
  };
}

function deactivate() {
  cleanup();
}

module.exports = { activate, deactivate };
