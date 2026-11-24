'use strict';

/**
 * Stress the renderer with rapid hex/both switches and repeated long jumps.
 * This is deliberately black-box: a tiny helper extension only fires the
 * public commands and editor.revealRange; it never reaches into the renderer.
 */

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  PROJECT_ROOT,
  RUNTIME_DIR,
  launchVSCode,
  standardSettings,
  sleep,
  ensureDir,
  rmrf,
  findExtensionHostLog,
  readTail,
  EXPR_STATUS_BAR,
  EXPR_NATIVE_NUMBERS,
} = require('./lib');

const OUTPUT_DIR = path.join(PROJECT_ROOT, 'test-output', 'stress');
const WORKSPACE_DIR = path.join(RUNTIME_DIR, 'stress-workspace');
const USER_DATA_DIR = path.join(RUNTIME_DIR, 'iso-stress-user');
const EXTENSIONS_DIR = path.join(RUNTIME_DIR, 'iso-stress-ext');
const SHARED_DIR = path.join(RUNTIME_DIR, 'iso-stress-shared');
const STRESS_EXT_SOURCE = path.join(PROJECT_ROOT, 'test', 'stress-helper');
const RESULT_PATH = path.join(WORKSPACE_DIR, 'stress-result.json');
const CONFIG_PATH = path.join(WORKSPACE_DIR, 'stress-config.json');

const CYCLES = Number(process.env.LNF_STRESS_CYCLES || 80);
const INTERVAL_MS = Number(process.env.LNF_STRESS_INTERVAL_MS || 2);
const A11Y = process.env.LNF_STRESS_A11Y === 'off' ? 'auto' : 'on';

const QUICK_INPUT_VISIBLE = `(() => {
  const widget = document.querySelector('.quick-input-widget');
  if (!widget) return false;
  const style = getComputedStyle(widget);
  const rect = widget.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
})()`;

const EXPR_LABELS_AND_TEXT = `(() => {
  const nodes = Array.from(document.querySelectorAll('.monaco-editor .view-lines .view-line'));
  return nodes.map((line) => {
    let label = null;
    let labelsOnLine = 0;
    for (const span of line.querySelectorAll('span')) {
      const content = getComputedStyle(span, '::before').content;
      if (content && content !== 'none' && content !== 'normal' && content !== '""') {
        labelsOnLine++;
        if (label === null) label = content.replace(/^"|"$/g, '').replace(/\\u00A0/g, ' ');
      }
    }
    return {
      label,
      labelsOnLine,
      text: (line.innerText || '').replace(/\\u00A0/g, ' '),
    };
  });
})()`;

let cdp = null;
let app = null;

function prepareWorkspace() {
  rmrf(WORKSPACE_DIR);
  ensureDir(WORKSPACE_DIR);
  ensureDir(OUTPUT_DIR);
  rmrf(USER_DATA_DIR);
  rmrf(EXTENSIONS_DIR);
  rmrf(SHARED_DIR);
  ensureDir(USER_DATA_DIR);
  ensureDir(EXTENSIONS_DIR);
  ensureDir(SHARED_DIR);

  const largePath = path.join(WORKSPACE_DIR, 'large.txt');
  const lines = [];
  for (let i = 1; i <= 200000; i++) {
    lines.push(`L${String(i).padStart(6, '0')}  payload=${i}  mov eax, ${i & 0xff}\n`);
    if (lines.length === 10000) {
      fs.appendFileSync(largePath, lines.join(''), 'utf8');
      lines.length = 0;
    }
  }
  if (lines.length) fs.appendFileSync(largePath, lines.join(''), 'utf8');

  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        cycles: CYCLES,
        intervalMs: INTERVAL_MS,
        settleMs: 0,
        seed: 20261124,
        modeSequence: ['hex', 'both'],
        jump: true,
      },
      null,
      2
    ),
    'utf8'
  );
  rmrf(RESULT_PATH);

  // Install the helper extension into the isolated extensions directory.
  const target = path.join(EXTENSIONS_DIR, 'test.lnf-stress-0.0.1');
  rmrf(target);
  ensureDir(target);
  for (const file of fs.readdirSync(STRESS_EXT_SOURCE)) {
    fs.copyFileSync(path.join(STRESS_EXT_SOURCE, file), path.join(target, file));
  }
  return largePath;
}

async function openFile(name, contentProbe) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await cdp.pressEscape();
      await sleep(150);
      await cdp.shortcut('p', 'KeyP', 80, 2);
      await cdp.waitFor(QUICK_INPUT_VISIBLE, { timeoutMs: 8000, label: 'quick open widget' });
      await cdp.evaluate(`(() => {
        const input = document.querySelector('.quick-input-widget input');
        if (!input) return false;
        input.focus();
        if (typeof input.select === 'function') input.select();
        return true;
      })()`);
      await cdp.insertText(name);
      await sleep(500);
      await cdp.waitFor(
        `(() => Array.from(document.querySelectorAll('.quick-input-widget .monaco-list-row')).some((row) => (row.textContent || '').includes(${JSON.stringify(
          name
        )})))()`,
        { timeoutMs: 5000, label: `quick open result for ${name}`, intervalMs: 100 }
      );
      await cdp.pressEnter();
      await cdp.waitFor(
        `(() => Array.from(document.querySelectorAll('.tab')).some((tab) => (tab.textContent || '').includes(${JSON.stringify(
          name
        )})))()`,
        { timeoutMs: 10000, label: `tab for ${name}` }
      );
      await sleep(600);
      if (contentProbe) {
        await cdp.waitFor(
          `(() => {
            const el = document.querySelector('.monaco-editor .view-lines');
            return !!el && el.innerText.replace(/\\u00A0/g, ' ').includes(${JSON.stringify(contentProbe)});
          })()`,
          { timeoutMs: 45000, label: `content of ${name}`, intervalMs: 200 }
        );
      }
      return;
    } catch (error) {
      try {
        await cdp.pressEscape();
      } catch (_) {}
      await sleep(300);
    }
  }
  throw new Error(`Could not open ${name}`);
}

async function clickStressButton() {
  const clicked = await cdp.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.statusbar-item'));
    const item = items.find((el) => (el.textContent || '').includes('LNF Stress'));
    if (!item) return false;
    const target = item.querySelector('a[role="button"]') || item.querySelector('a') || item;
    target.click();
    return true;
  })()`);
  assert.ok(clicked, 'stress status-bar button should be visible');
}

async function currentModeLabel() {
  return cdp.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.statusbar-item')).find((el) => (el.textContent || '').includes('LN:'));
    return item ? (item.textContent || '').trim() : '';
  })()`);
}

async function chooseMode(itemQuery) {
  const expected =
    itemQuery === 'Hexadecimal only'
      ? 'LN: Hex'
      : itemQuery === 'Decimal + Hexadecimal'
        ? 'LN: Dec+Hex'
        : 'LN: Dec';

  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await currentModeLabel()).endsWith(expected)) return;

    const clicked = await cdp.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.statusbar-item'));
      const item = items.find((el) => (el.textContent || '').includes('LN:'));
      if (!item) return false;
      const target = item.querySelector('a[role="button"]') || item.querySelector('a') || item;
      target.click();
      return true;
    })()`);
    assert.ok(clicked, 'line-number status-bar item should be present');
    await cdp.waitFor(QUICK_INPUT_VISIBLE, { timeoutMs: 8000, label: 'quick pick menu' });
    await sleep(200);
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.quick-input-widget input');
      if (!input) return false;
      input.focus();
      if (typeof input.select === 'function') input.select();
      return true;
    })()`);
    await cdp.insertText(itemQuery);
    await sleep(350);
    const value = await cdp.evaluate(`(() => {
      const input = document.querySelector('.quick-input-widget input');
      return input ? input.value : null;
    })()`);
    if (!value || !value.includes(itemQuery)) {
      await cdp.pressEscape();
      await sleep(250);
      continue;
    }
    await cdp.pressEnter();
    await sleep(350);

    if ((await currentModeLabel()).endsWith(expected)) return;
    await cdp.pressEscape();
    await sleep(250);
  }

  throw new Error(`Could not select "${itemQuery}"; current mode: ${(await currentModeLabel()) || 'unknown'}`);
}

async function dragScrollbar(fraction) {
  const geometry = await cdp.evaluate(`(() => {
    const scrollbar = document.querySelector('.monaco-editor .scrollbar.vertical');
    const slider = scrollbar && scrollbar.querySelector('.slider');
    if (!scrollbar || !slider) return null;
    const track = scrollbar.getBoundingClientRect();
    const thumb = slider.getBoundingClientRect();
    return {
      x: track.x + track.width / 2,
      top: track.y,
      height: track.height,
      thumbX: thumb.x + thumb.width / 2,
      thumbY: thumb.y + thumb.height / 2,
    };
  })()`);
  assert.ok(geometry, 'vertical scrollbar should be visible');

  const targetY = geometry.top + Math.max(0.02, Math.min(0.98, fraction)) * geometry.height;
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: geometry.thumbX,
    y: geometry.thumbY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 12; step++) {
    const y = geometry.thumbY + ((targetY - geometry.thumbY) * step) / 12;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: geometry.thumbX,
      y,
      button: 'left',
      buttons: 1,
    });
    await sleep(8);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: geometry.thumbX,
    y: targetY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  return targetY;
}

function labelNumber(label) {
  if (!label) return null;
  const match = String(label).match(/0x([0-9A-Fa-f]+)/);
  return match ? parseInt(match[1], 16) : null;
}

async function inspectLabels(expectedMode) {
  const snapshot = await cdp.evaluate(EXPR_LABELS_AND_TEXT);
  const codeLines = snapshot
    .map((entry) => {
      const match = /L(\d{6})/.exec(entry.text || '');
      return match ? { line: Number(match[1]), entry } : null;
    })
    .filter(Boolean);
  const missing = codeLines.filter(({ entry }) => !entry.label).length;
  const mismatched = codeLines.filter(({ line, entry }) => labelNumber(entry.label) !== line).length;
  const duplicates = codeLines.filter(({ entry }) => entry.labelsOnLine !== 1).length;
  const formatWrong = codeLines.filter(({ entry }) => {
    const label = entry.label || '';
    if (expectedMode === 'hex') return !/^0x[0-9A-F]+/.test(label.trim());
    return !/^\s*\d+\s*│\s*0x[0-9A-F]+/.test(label);
  }).length;
  return {
    visible: codeLines.length,
    labelled: codeLines.length - missing,
    missing,
    mismatched,
    duplicates,
    formatWrong,
    first: codeLines[0] ? { line: codeLines[0].line, label: codeLines[0].entry.label } : null,
    last: codeLines[codeLines.length - 1]
      ? { line: codeLines[codeLines.length - 1].line, label: codeLines[codeLines.length - 1].entry.label }
      : null,
  };
}

(async () => {
  const largePath = prepareWorkspace();
  console.log(`Stress workspace: ${largePath} (${(fs.statSync(largePath).size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Cycles: ${CYCLES}, interval: ${INTERVAL_MS} ms, accessibilitySupport: ${A11Y}`);

  app = await launchVSCode({
    label: 'stress',
    userDataDir: USER_DATA_DIR,
    extensionsDir: EXTENSIONS_DIR,
    sharedDataDir: SHARED_DIR,
    developmentPath: PROJECT_ROOT,
    openPath: WORKSPACE_DIR,
    extraArgs: ['--disable-extension', 'GitHub.copilot-chat', '--disable-extension', 'GitHub.copilot'],
    settings: standardSettings({
      'lineNumberFormat.mode': 'decimal',
      'editor.accessibilitySupport': A11Y,
    }),
    keepProfiles: true,
  });
  cdp = app.cdp;

  try {
    await cdp.setWindowSize(1400, 900);
    await cdp.waitFor(`document.querySelectorAll('.monaco-workbench').length > 0`, {
      timeoutMs: 60000,
      label: 'VS Code workbench',
    });
    await cdp.waitFor(
      `(() => Array.from(document.querySelectorAll('.statusbar-item')).some((item) => (item.textContent || '').includes('LN:')))()`,
      { timeoutMs: 120000, label: 'main extension activation', intervalMs: 400 }
    );
    await cdp.waitFor(
      `(() => Array.from(document.querySelectorAll('.statusbar-item')).some((item) => (item.textContent || '').includes('LNF Stress')))()`,
      { timeoutMs: 120000, label: 'stress extension activation', intervalMs: 400 }
    );

    await openFile('large.txt', 'L000001');
    await cdp.pressEscape();
    await sleep(500);

    await clickStressButton();
    const clickAt = Date.now();
    while (!fs.existsSync(RESULT_PATH)) {
      if (Date.now() - clickAt > 180000) throw new Error('stress result file was not written within 180 s');
      await sleep(100);
    }
    const resultReadyMs = Date.now() - clickAt;
    const result = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
    fs.writeFileSync(path.join(OUTPUT_DIR, 'stress-result.json'), JSON.stringify(result, null, 2), 'utf8');

    if (result.error) throw new Error(result.error);

    console.log('\nResult:');
    console.log(JSON.stringify(
      {
        durationMs: Math.round(result.durationMs),
        dispatchMs: Math.round(result.dispatchMs),
        commandsDoneMs: Math.round(result.commandsDoneMs),
        resultReadyMs,
        maxLagMs: Math.round(result.maxLagMs),
        commandDurations: result.commandDurations,
        commandErrors: result.commandErrors,
        finalRequestedMode: result.finalRequestedMode,
        stateMode: result.state && result.state.mode,
        stats: result.state && result.state.stats,
        finalVisible: result.finalVisible,
      },
      null,
      2
    ));

    const status = await cdp.evaluate(EXPR_STATUS_BAR);
    const expectedStatus = result.finalRequestedMode === 'both' ? 'LN: Dec+Hex' : 'LN: Hex';
    assert.match(status, new RegExp(expectedStatus.replace('+', '\\+')), `status bar did not show ${expectedStatus}: ${status}`);
    assert.strictEqual(result.state && result.state.mode, result.finalRequestedMode, 'extension ended in the wrong mode');
    assert.strictEqual((result.commandErrors || []).length, 0, `command errors: ${result.commandErrors.join(' | ')}`);
    assert.strictEqual(result.state && result.state.stats.errors, 0, 'renderer reported errors');

    // The labels must catch up without another input event. Poll the DOM from
    // immediately after the stress result is available.
    let inspection = null;
    let settleMs = null;
    const settleStart = Date.now();
    while (Date.now() - settleStart < 8000) {
      inspection = await inspectLabels(result.finalRequestedMode);
      if (
        inspection.visible > 0 &&
        inspection.missing === 0 &&
        inspection.mismatched === 0 &&
        inspection.duplicates === 0 &&
        inspection.formatWrong === 0
      ) {
        settleMs = Date.now() - settleStart;
        break;
      }
      await sleep(50);
    }
    console.log('Labels:', inspection, `settled in ${settleMs === null ? '>8000' : settleMs} ms`);

    assert.ok(inspection && inspection.visible > 0, 'no visible code lines after stress');
    assert.strictEqual(inspection.missing, 0, `${inspection.missing} visible lines still had no label`);
    assert.strictEqual(inspection.mismatched, 0, `${inspection.mismatched} labels did not match their code line`);
    assert.strictEqual(inspection.duplicates, 0, `${inspection.duplicates} lines had duplicate labels`);
    assert.strictEqual(inspection.formatWrong, 0, `${inspection.formatWrong} labels did not use the final mode`);
    assert.ok(settleMs !== null && settleMs < 3000, `labels took ${settleMs} ms to catch up`);
    assert.ok(result.maxLagMs < 500, `extension host event loop lag peaked at ${result.maxLagMs.toFixed(0)} ms`);
    assert.ok(result.commandDurations.p95 < 1500, `p95 command latency was ${result.commandDurations.p95.toFixed(0)} ms`);

    const natives = await cdp.evaluate(EXPR_NATIVE_NUMBERS);
    if (A11Y === 'on') {
      assert.ok(natives.length > 0, 'native accessible gutter should remain visible in screen-reader mode');
    } else {
      assert.strictEqual(natives.length, 0, 'native gutter should be hidden when accessibility support is auto');
    }

    console.log('\n[2] Real scrollbar drag immediately after a mode switch');
    const fractions = [0.05, 0.95, 0.2, 0.8, 0.35, 0.65];
    const dragResults = [];
    for (let i = 0; i < fractions.length; i++) {
      const itemQuery = i % 2 === 0 ? 'Hexadecimal only' : 'Decimal + Hexadecimal';
      const expectedMode = i % 2 === 0 ? 'hex' : 'both';
      await chooseMode(itemQuery);
      await dragScrollbar(fractions[i]);
      const releaseAt = Date.now();

      let inspection = null;
      let settleMs = null;
      while (Date.now() - releaseAt < 2500) {
        inspection = await inspectLabels(expectedMode);
        if (
          inspection.visible > 0 &&
          inspection.missing === 0 &&
          inspection.mismatched === 0 &&
          inspection.duplicates === 0 &&
          inspection.formatWrong === 0
        ) {
          settleMs = Date.now() - releaseAt;
          break;
        }
        await sleep(40);
      }

      const status = await currentModeLabel();
      const expectedStatus = expectedMode === 'both' ? 'LN: Dec+Hex' : 'LN: Hex';
      dragResults.push({ itemQuery, fraction: fractions[i], settleMs, inspection, status });
      console.log(
        `  ${itemQuery} + drag ${fractions[i]}: ${settleMs === null ? 'NOT SETTLED' : `${settleMs} ms`}, ` +
          `${inspection ? `${inspection.labelled}/${inspection.visible} labelled, ${inspection.formatWrong} wrong format` : 'no labels'}, ` +
          `status=${status}`
      );

      assert.ok(status.endsWith(expectedStatus), `mode flipped after drag: ${status}`);
      assert.ok(inspection && inspection.visible > 0, 'no visible code lines after scrollbar drag');
      assert.strictEqual(inspection.missing, 0, `${inspection.missing} visible lines had no label after drag`);
      assert.strictEqual(inspection.mismatched, 0, `${inspection.mismatched} labels did not match after drag`);
      assert.strictEqual(inspection.formatWrong, 0, `${inspection.formatWrong} labels used the wrong mode after drag`);
      assert.ok(settleMs !== null && settleMs < 1500, `labels took ${settleMs} ms to update after drag`);
    }
    fs.writeFileSync(path.join(OUTPUT_DIR, 'stress-drags.json'), JSON.stringify(dragResults, null, 2), 'utf8');

    await cdp.screenshot(path.join(OUTPUT_DIR, `stress-final-${A11Y}.png`));
    console.log(`\nPASS - stress test (${A11Y}): max lag ${result.maxLagMs.toFixed(0)} ms, settle ${settleMs} ms`);
  } finally {
    await app.stop();
  }

  const logPath = findExtensionHostLog(USER_DATA_DIR);
  if (logPath) {
    const log = readTail(logPath, 300000);
    const ourErrors = log
      .split(/\r?\n/)
      .filter((line) => /line-number-format/i.test(line) && /error|failed|exception/i.test(line));
    assert.strictEqual(ourErrors.length, 0, ourErrors.slice(0, 5).join(' | '));
  }
})().catch(async (error) => {
  console.error('\nStress test aborted:', error);
  try {
    if (cdp) await cdp.screenshot(path.join(OUTPUT_DIR, 'stress-failure.png'));
  } catch (_) {}
  if (app) await app.stop();
  process.exitCode = 1;
});
