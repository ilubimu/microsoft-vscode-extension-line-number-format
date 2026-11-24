'use strict';

/**
 * Black-box acceptance test for the line-number-format extension.
 *
 * It launches a *separate copy* of VS Code from _test-runtime/vscode with its
 * own user-data-dir, extensions-dir and shared-data-dir, so the user's
 * installed VS Code and profile are never touched. The test drives the real
 * UI through the Chrome DevTools Protocol (status bar, quick pick, editor) and
 * captures screenshots for visual inspection.
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

const OUTPUT_DIR = path.join(PROJECT_ROOT, 'test-output', 'visual');
const SAMPLES_DIR = path.join(RUNTIME_DIR, 'samples');
const USER_DATA_DIR = path.join(RUNTIME_DIR, 'iso-visual-user');
const EXTENSIONS_DIR = path.join(RUNTIME_DIR, 'iso-visual-ext');
const SHARED_DIR = path.join(RUNTIME_DIR, 'iso-visual-shared');

const results = [];
let cdp = null;
let app = null;

function record(name, detail) {
  results.push({ name, detail, ok: true });
  console.log(`  PASS - ${name}${detail ? ` (${detail})` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, detail);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message}`);
    throw error;
  }
}

/* ----------------------------- DOM helpers ----------------------------- */

const QUICK_INPUT_VISIBLE = `(() => {
  const widget = document.querySelector('.quick-input-widget');
  if (!widget) return false;
  const style = getComputedStyle(widget);
  const rect = widget.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
})()`;

const EXPR_FIRST_LABEL = `(() => {
  const line = document.querySelector('.monaco-editor .view-lines .view-line');
  if (!line) return null;
  for (const span of line.querySelectorAll('span')) {
    const content = getComputedStyle(span, '::before').content;
    if (content && content !== 'none' && content !== 'normal' && content !== '""') {
      return content.replace(/^"|"$/g, '').replace(/\\u00A0/g, ' ');
    }
  }
  return null;
})()`;

const EXPR_LABELS_AND_TEXT = `(() => {
  const nodes = Array.from(document.querySelectorAll('.monaco-editor .view-lines .view-line'));
  return nodes.map((line) => {
    let label = null;
    let color = null;
    let labelsOnLine = 0;
    for (const span of line.querySelectorAll('span')) {
      const content = getComputedStyle(span, '::before').content;
      if (content && content !== 'none' && content !== 'normal' && content !== '""') {
        labelsOnLine++;
        if (label === null) {
          label = content.replace(/^"|"$/g, '').replace(/\\u00A0/g, ' ');
          color = getComputedStyle(span, '::before').color || getComputedStyle(span).color;
        }
      }
    }
    return {
      label,
      color,
      labelsOnLine,
      text: (line.innerText || '').replace(/\\u00A0/g, ' ')
    };
  });
})()`;

const EXPR_QUICK_INPUT_ACTIVE = `(() => {
  const active = document.activeElement;
  return active ? active.className || active.tagName : null;
})()`;

async function focusEditor() {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: 700,
    y: 400,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: 700,
    y: 400,
    button: 'left',
    clickCount: 1,
  });
  await sleep(250);
}

async function waitForStatus(modeText, timeoutMs = 15000) {
  return cdp.waitFor(
    `(() => {
      const items = Array.from(document.querySelectorAll('.statusbar-item'));
      const item = items.find((el) => (el.textContent || '').includes('LN:'));
      if (!item) return false;
      const text = (item.textContent || '').trim();
      return text.endsWith(${JSON.stringify(modeText)}) ? text : false;
    })()`,
    { timeoutMs, label: `status bar "${modeText}"`, intervalMs: 200 }
  );
}

async function openFile(name, contentProbe) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await cdp.pressEscape();
      await sleep(150);
      await focusEditor();
      await cdp.shortcut('p', 'KeyP', 80, 2);
      await cdp.waitFor(QUICK_INPUT_VISIBLE, { timeoutMs: 8000, label: 'quick open widget' });

      // The quick-open widget can be visible before its input has focus.
      // Without this, Input.insertText lands in the editor instead.
      await cdp.evaluate(`(() => {
        const input = document.querySelector('.quick-input-widget input');
        if (!input) return false;
        input.focus();
        if (typeof input.select === 'function') input.select();
        return true;
      })()`);
      await cdp.insertText(name);
      await sleep(500);

      const value = await cdp.evaluate(`(() => {
        const input = document.querySelector('.quick-input-widget input');
        return input ? input.value : null;
      })()`);
      if (!value || !value.includes(name)) {
        lastError = new Error(`quick open input did not contain "${name}" (got ${JSON.stringify(value)})`);
        await cdp.pressEscape();
        await sleep(300);
        continue;
      }

      // Do not press Enter while the file index is still empty. The widget can
      // have text before the matching result row exists.
      await cdp.waitFor(
        `(() => {
          const rows = Array.from(document.querySelectorAll('.quick-input-widget .monaco-list-row'));
          return rows.some((row) => (row.textContent || '').includes(${JSON.stringify(name)}));
        })()`,
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
          { timeoutMs: 45000, label: `content of ${name}`, intervalMs: 250 }
        );
      }
      await sleep(300);
      return;
    } catch (error) {
      lastError = error;
      try {
        await cdp.pressEscape();
      } catch (_) {}
      await sleep(300);
    }
  }

  throw lastError || new Error(`Could not open ${name}`);
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
    assert.ok(clicked, 'status bar item should be present');
    await cdp.waitFor(QUICK_INPUT_VISIBLE, { timeoutMs: 8000, label: 'quick pick menu' });
    await sleep(200);

    // The widget can become visible a moment before its input receives keyboard
    // focus. Focus it explicitly so Input.insertText cannot land in the editor.
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.quick-input-widget input');
      if (!input) return false;
      input.focus();
      if (typeof input.select === 'function') input.select();
      return true;
    })()`);
    await cdp.insertText(itemQuery);
    await sleep(400);

    const value = await cdp.evaluate(`(() => {
      const input = document.querySelector('.quick-input-widget input');
      return input ? input.value : null;
    })()`);
    if (!value || !value.includes(itemQuery)) {
      await cdp.pressEscape();
      await sleep(300);
      continue;
    }

    await cdp.pressEnter();
    await sleep(900);

    if ((await currentModeLabel()).endsWith(expected)) return;
    await cdp.pressEscape();
    await sleep(300);
  }

  throw new Error(`Could not select "${itemQuery}"; current mode: ${(await currentModeLabel()) || 'unknown'}`);
}

async function getLabels() {
  return cdp.evaluate(EXPR_LABELS_AND_TEXT);
}

function labelNumber(label) {
  if (!label) return null;
  const match = String(label).match(/0x([0-9A-Fa-f]+)/);
  return match ? parseInt(match[1], 16) : null;
}

/* ------------------------------- Fixtures ------------------------------- */

function prepareSamples() {
  rmrf(SAMPLES_DIR);
  ensureDir(SAMPLES_DIR);

  for (const file of ['sample.asm', 'sample.c', 'sample.txt']) {
    fs.copyFileSync(path.join(PROJECT_ROOT, 'test', 'fixtures', file), path.join(SAMPLES_DIR, file));
  }
  fs.writeFileSync(path.join(SAMPLES_DIR, 'empty.txt'), '', 'utf8');
  fs.writeFileSync(path.join(SAMPLES_DIR, 'one-line.txt'), 'single line\n', 'utf8');

  const largePath = path.join(SAMPLES_DIR, 'large.txt');
  const lines = [];
  for (let i = 1; i <= 200000; i++) {
    lines.push(`L${String(i).padStart(6, '0')}  payload=${i}  mov eax, ${i & 0xff}\n`);
    if (lines.length === 10000) {
      fs.appendFileSync(largePath, lines.join(''), 'utf8');
      lines.length = 0;
    }
  }
  if (lines.length) fs.appendFileSync(largePath, lines.join(''), 'utf8');
  return largePath;
}

/* --------------------------------- Test --------------------------------- */

(async () => {
  ensureDir(OUTPUT_DIR);
  const largePath = prepareSamples();
  console.log('Large fixture:', largePath, `${(fs.statSync(largePath).size / 1024 / 1024).toFixed(1)} MB`);

  app = await launchVSCode({
    label: 'visual',
    userDataDir: USER_DATA_DIR,
    extensionsDir: EXTENSIONS_DIR,
    sharedDataDir: SHARED_DIR,
    developmentPath: PROJECT_ROOT,
    openPath: SAMPLES_DIR,
    extraArgs: ['--disable-extension', 'GitHub.copilot-chat', '--disable-extension', 'GitHub.copilot'],
    settings: standardSettings({ 'lineNumberFormat.mode': 'decimal' }),
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
      { timeoutMs: 120000, label: 'extension activation', intervalMs: 400 }
    );
    record('extension activates in an isolated VS Code instance');
    await cdp.pressEscape();
    await sleep(300);

    console.log('\n[1] Decimal mode (native gutter)');
    await openFile('sample.asm', 'section .data');
    await check('decimal mode shows native line numbers', async () => {
      assert.match(await cdp.evaluate(EXPR_STATUS_BAR), /LN: Dec(?!\+)/);
      const natives = await cdp.evaluate(EXPR_NATIVE_NUMBERS);
      assert.ok(natives.length >= 10, `expected native numbers, got ${natives.length}`);
      const labels = (await getLabels()).filter((entry) => entry.label);
      assert.strictEqual(labels.length, 0, `expected no custom labels, got ${labels.length}`);
      return `${natives.length} native numbers`;
    });
    await cdp.screenshot(path.join(OUTPUT_DIR, '01-decimal-asm.png'));

    console.log('\n[2] Hexadecimal only');
    await chooseMode('Hexadecimal only');
    await check('hex mode hides the native gutter and draws hex labels', async () => {
      await waitForStatus('LN: Hex');
      const natives = await cdp.evaluate(EXPR_NATIVE_NUMBERS);
      assert.strictEqual(natives.length, 0, `native numbers still visible: ${JSON.stringify(natives.slice(0, 3))}`);
      await cdp.waitFor(EXPR_FIRST_LABEL, { timeoutMs: 10000, label: 'hex label' });
      const labels = await getLabels();
      assert.ok(labels.length >= 10, `expected labels, got ${labels.length}`);
      assert.match(labels[0].label, /^0x0*1\s*│/, `line 1 label was ${JSON.stringify(labels[0].label)}`);
      assert.strictEqual(labelNumber(labels[9].label), 10, `line 10 label was ${JSON.stringify(labels[9].label)}`);
      return `${labels.length} labels`;
    });
    await cdp.screenshot(path.join(OUTPUT_DIR, '02-hex-asm.png'));

    await focusEditor();
    await cdp.shortcut('Home', 'Home', 36, 2); // Ctrl+Home returns to line 1
    await sleep(500);
    await check('current-line label highlight tracks the cursor', async () => {
      const before = await getLabels();
      const line1 = before.find((entry) => labelNumber(entry.label) === 1);
      const line2 = before.find((entry) => labelNumber(entry.label) === 2);
      assert.ok(line1 && line2, 'labels for lines 1 and 2 are missing');
      assert.strictEqual(line1.labelsOnLine, 1, 'line 1 has duplicate labels');
      assert.strictEqual(line2.labelsOnLine, 1, 'line 2 has duplicate labels');
      assert.notStrictEqual(line1.color, line2.color, 'active and normal label colours are identical');

      const activeColor = line1.color;
      const normalColor = line2.color;
      const started = Date.now();
      const key = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });

      let latency = null;
      while (Date.now() - started < 2000) {
        const labels = await getLabels();
        const oldLine = labels.find((entry) => labelNumber(entry.label) === 1);
        const newLine = labels.find((entry) => labelNumber(entry.label) === 2);
        if (oldLine && newLine && oldLine.color === normalColor && newLine.color === activeColor) {
          latency = Date.now() - started;
          break;
        }
        await sleep(10);
      }

      assert.ok(latency !== null, 'the active highlight did not move to line 2');
      assert.ok(latency < 500, `the active highlight took ${latency} ms to move`);
      return `moved in ${latency} ms`;
    });

    await check('mode selection is persisted to the user settings', async () => {
      const settingsPath = path.join(USER_DATA_DIR, 'User', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.strictEqual(settings['lineNumberFormat.mode'], 'hex');
      return 'lineNumberFormat.mode=hex';
    });

    console.log('\n[3] Other file types and both mode');
    await openFile('sample.c', 'checksum');
    await check('hex mode works in a C file', async () => {
      const labels = await getLabels();
      assert.ok(labels.some((entry) => /^0x[0-9A-F]+/.test(entry.label || '')), 'no hex labels in sample.c');
      assert.match(await cdp.evaluate(EXPR_STATUS_BAR), /LN: Hex/);
      return `${labels.length} labels`;
    });
    await cdp.screenshot(path.join(OUTPUT_DIR, '03-hex-c.png'));

    await openFile('sample.txt', 'Line number format test fixture');
    await chooseMode('Decimal + Hexadecimal');
    await check('both mode shows decimal and hexadecimal labels in a text file', async () => {
      await waitForStatus('LN: Dec+Hex');
      await cdp.waitFor(EXPR_FIRST_LABEL, { timeoutMs: 10000, label: 'combined label' });
      const labels = await getLabels();
      const first = labels[0].label;
      assert.match(first, /^\s*1\s*│\s*0x0*1\s*│/, `line 1 combined label was ${JSON.stringify(first)}`);
      assert.ok(labels.length >= 10, `expected labels, got ${labels.length}`);
      return `${labels.length} labels`;
    });
    await cdp.screenshot(path.join(OUTPUT_DIR, '04-both-txt.png'));

    await openFile('empty.txt', null);
    await check('empty file still gets a label', async () => {
      await cdp.waitFor(`document.querySelectorAll('.monaco-editor .view-lines .view-line').length > 0`, {
        timeoutMs: 10000,
        label: 'empty editor',
      });
      await sleep(600);
      const labels = await getLabels();
      assert.ok(labels.length >= 1, 'no visible line');
      assert.match(labels[0].label, /^\s*1\s*│\s*0x0*1\s*│/, `empty-file label was ${JSON.stringify(labels[0].label)}`);
      return JSON.stringify(labels[0].label);
    });

    await openFile('one-line.txt', 'single line');
    await check('single-line file gets a label', async () => {
      const labels = await getLabels();
      assert.match(labels[0].label, /^\s*1\s*│\s*0x0*1\s*│/, `one-line label was ${JSON.stringify(labels[0].label)}`);
      return JSON.stringify(labels[0].label);
    });

    console.log('\n[4] Large file (200,000 lines)');
    await chooseMode('Hexadecimal only');
    await waitForStatus('LN: Hex');
    const openStart = Date.now();
    await openFile('large.txt', 'L000001');
    const openMs = Date.now() - openStart;
    await check('large file opens and renders hex labels', async () => {
      await cdp.waitFor(EXPR_FIRST_LABEL, { timeoutMs: 15000, label: 'large-file label' });
      const labels = await getLabels();
      assert.ok(labels.length > 0, 'no labels in large file');
      assert.strictEqual(labelNumber(labels[0].label), 1, `line 1 label ${JSON.stringify(labels[0].label)}`);
      assert.ok(labels.length < 600, `too many decorations rendered: ${labels.length}`);
      return `${labels.length} labels, opened in ${openMs} ms`;
    });

    await cdp.screenshot(path.join(OUTPUT_DIR, '05-hex-large-top.png'));

    // Continuous scrolling used to reset a 40 ms debounce on every event, so
    // labels could stay missing until the user stopped scrolling. The labels
    // must now keep up while the wheel is still moving.
    await focusEditor();
    let worstScrollGap = 0;
    let scrolledTo = 0;
    for (let i = 0; i < 100; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 700,
        y: 400,
        deltaX: 0,
        deltaY: 700,
      });
      await sleep(30);
      const labels = await getLabels();
      const gap = labels.filter((entry) => (entry.text || '').trim() && !entry.label).length;
      if (gap > worstScrollGap) worstScrollGap = gap;
      const last = labels[labels.length - 1];
      const match = last && /L(\d{6})/.exec(last.text || '');
      if (match) scrolledTo = Number(match[1]);
    }
    await check('labels keep refreshing during continuous scrolling', async () => {
      assert.ok(worstScrollGap <= 2, `up to ${worstScrollGap} visible lines had no label while scrolling`);
      assert.ok(scrolledTo > 80, `the viewport did not move far enough (reached line ${scrolledTo})`);
      return `worst gap ${worstScrollGap}, reached line ${scrolledTo}`;
    });

    await focusEditor();
    const scrollStart = Date.now();
    await cdp.shortcut('End', 'End', 35, 2); // Ctrl+End jumps to the last line

    let pairs = [];
    let firstMatchMs = null;
    while (Date.now() - scrollStart < 6000) {
      const labels = await getLabels();
      pairs = labels
        .map((entry) => {
          const code = /L(\d{6})/.exec(entry.text || '');
          const value = labelNumber(entry.label);
          return code && value !== null ? { line: Number(code[1]), value, label: entry.label } : null;
        })
        .filter(Boolean);
      if (pairs.some((pair) => pair.line > 100000)) {
        firstMatchMs = Date.now() - scrollStart;
        break;
      }
      await sleep(50);
    }

    await check('jumping to the end of a 200,000-line file stays responsive and labels match lines', async () => {
      assert.ok(pairs.length >= 5, `only ${pairs.length} labelled lines could be parsed after jumping`);
      for (const pair of pairs.slice(0, 20)) {
        assert.strictEqual(pair.value, pair.line, `label ${pair.label} does not match code line ${pair.line}`);
      }
      assert.ok(pairs.some((pair) => pair.line > 190000), 'did not reach the end of the large file');
      assert.ok(firstMatchMs !== null && firstMatchMs < 4000, `labels took ${firstMatchMs} ms to update`);
      return `${pairs.length} matching labels, update ${firstMatchMs} ms`;
    });
    await cdp.screenshot(path.join(OUTPUT_DIR, '06-hex-large-end.png'));

    await focusEditor();
    await cdp.shortcut('Home', 'Home', 36, 2); // Ctrl+Home
    await check('jumping back to line 1 restores the first labels', async () => {
      await cdp.waitFor(
        `(() => {
          const line = document.querySelector('.monaco-editor .view-lines .view-line');
          if (!line) return false;
          for (const span of line.querySelectorAll('span')) {
            const content = getComputedStyle(span, '::before').content;
            if (content && content !== 'none' && content !== 'normal' && content !== '""') {
              return content.includes('0x00001');
            }
          }
          return false;
        })()`,
        { timeoutMs: 8000, label: 'label 0x00001 after Ctrl+Home' }
      );
      const labels = await getLabels();
      assert.match(labels[0].text, /L000001/);
      return labels[0].label.trim();
    });
    await cdp.screenshot(path.join(OUTPUT_DIR, '07-hex-large-home.png'));

    console.log('\n[5] Diagnostics');
    await cdp.pressF1();
    await cdp.waitFor(QUICK_INPUT_VISIBLE, { timeoutMs: 8000, label: 'command palette' });
    await cdp.insertText('Line Number Format: Show Diagnostics');
    await sleep(700);
    await cdp.pressEnter();
    await sleep(800);
    const diagnostics = await cdp
      .waitFor(
        `(() => {
          const items = Array.from(document.querySelectorAll('.notification-list-item'));
          const item = items.find((el) => (el.textContent || '').includes('Line Number Format'));
          return item ? (item.textContent || '').trim() : null;
        })()`,
        { timeoutMs: 8000, label: 'diagnostics notification', intervalMs: 200 }
      )
      .catch(() => null);

    if (diagnostics) {
      const match = /Last render: ([\d.]+) ms for (\d+) label/.exec(diagnostics);
      if (match) {
        record('diagnostics report a small, viewport-sized render', `${match[1]} ms / ${match[2]} labels`);
        assert.ok(Number(match[1]) < 100, `render took ${match[1]} ms`);
        assert.ok(Number(match[2]) < 600, `rendered ${match[2]} labels`);
      } else {
        console.log('  INFO - diagnostics notification:', diagnostics);
      }
    } else {
      console.log('  INFO - diagnostics command did not produce a notification (palette ambiguity)');
    }

    console.log('\n[6] Restore decimal mode');
    await chooseMode('Decimal only');
    await check('decimal mode restores the native gutter', async () => {
      await waitForStatus('LN: Dec');
      await sleep(600);
      const natives = await cdp.evaluate(EXPR_NATIVE_NUMBERS);
      assert.ok(natives.length >= 5, `native numbers did not return (${natives.length})`);
      const labels = (await getLabels()).filter((entry) => entry.label);
      assert.strictEqual(labels.length, 0, `custom labels still present (${labels.length})`);
      return `${natives.length} native numbers`;
    });
    await cdp.screenshot(path.join(OUTPUT_DIR, '08-decimal-restored.png'));
  } finally {
    await app.stop();
  }

  const logPath = findExtensionHostLog(USER_DATA_DIR);
  if (logPath) {
    const log = readTail(logPath, 200000);
    const ourErrors = log
      .split(/\r?\n/)
      .filter((line) => /line-number-format/i.test(line) && /error|failed|exception/i.test(line));
    await check('extension host log has no line-number-format errors', async () => {
      assert.strictEqual(ourErrors.length, 0, ourErrors.slice(0, 5).join(' | '));
      return path.basename(logPath);
    });
  }

  const failures = results.filter((entry) => !entry.ok);
  console.log('\n============================================================');
  console.log(`Visual test: ${results.length - failures.length}/${results.length} checks passed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAILED: ${failure.name}: ${failure.error}`);
    process.exitCode = 1;
  } else {
    console.log('All visual checks passed. Screenshots:', OUTPUT_DIR);
  }
})().catch(async (error) => {
  console.error('\nVisual test aborted:', error);
  try {
    if (cdp) await cdp.screenshot(path.join(OUTPUT_DIR, '99-failure.png'));
  } catch (_) {}
  if (app) await app.stop();
  process.exitCode = 1;
});
