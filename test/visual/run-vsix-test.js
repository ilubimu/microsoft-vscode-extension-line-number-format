'use strict';

/**
 * Installs the built VSIX into a brand-new isolated profile and verifies that
 * the installed extension activates and renders labels. No
 * --extensionDevelopmentPath is used here: this is exactly what a user gets
 * after "Install from VSIX".
 */

const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  PROJECT_ROOT,
  RUNTIME_DIR,
  VSCODE_DIR,
  CODE_EXE,
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

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const VSIX = path.join(PROJECT_ROOT, 'dist', `${pkg.name}-${pkg.version}.vsix`);
const USER_DATA_DIR = path.join(RUNTIME_DIR, 'iso-vsix2-user');
const EXTENSIONS_DIR = path.join(RUNTIME_DIR, 'iso-vsix2-ext');
const SHARED_DIR = path.join(RUNTIME_DIR, 'iso-vsix2-shared');
const SAMPLES_DIR = path.join(RUNTIME_DIR, 'samples');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'test-output', 'vsix');

const QUICK_INPUT_VISIBLE = `(() => {
  const widget = document.querySelector('.quick-input-widget');
  if (!widget) return false;
  const style = getComputedStyle(widget);
  const rect = widget.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0;
})()`;

async function typeQuickInput(cdp, text) {
  await cdp.waitFor(QUICK_INPUT_VISIBLE, { timeoutMs: 8000, label: 'quick input' });
  const focused = await cdp.evaluate(`(() => {
    const input = document.querySelector('.quick-input-widget input');
    if (!input) return false;
    input.focus();
    if (typeof input.select === 'function') input.select();
    return true;
  })()`);
  assert.ok(focused, 'quick input input element not found');
  await cdp.insertText(text);
  await sleep(350);
  const value = await cdp.evaluate(`(() => {
    const input = document.querySelector('.quick-input-widget input');
    return input ? input.value : null;
  })()`);
  assert.ok(value && value.includes(text), `quick input did not receive "${text}" (got ${JSON.stringify(value)})`);
}

function findCliJs() {
  for (const entry of fs.readdirSync(VSCODE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(VSCODE_DIR, entry.name, 'resources', 'app', 'out', 'cli.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find VS Code cli.js in the test runtime');
}

function installVsix() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const args = [
    findCliJs(),
    '--install-extension',
    VSIX,
    '--force',
    `--extensions-dir=${EXTENSIONS_DIR}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    `--shared-data-dir=${SHARED_DIR}`,
  ];
  const result = spawnSync(CODE_EXE, args, {
    env,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function listInstalledExtensions() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const result = spawnSync(
    CODE_EXE,
    [
      findCliJs(),
      '--list-extensions',
      '--show-versions',
      `--extensions-dir=${EXTENSIONS_DIR}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      `--shared-data-dir=${SHARED_DIR}`,
    ],
    { env, encoding: 'utf8', timeout: 120000, windowsHide: true }
  );
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: result.stderr || '' };
}

(async () => {
  ensureDir(OUTPUT_DIR);
  assert.ok(fs.existsSync(VSIX), `VSIX not found: ${VSIX}. Run tools/build-vsix.js first.`);
  assert.ok(fs.existsSync(path.join(SAMPLES_DIR, 'sample.asm')), 'samples are missing; run run-visual-test.js first');

  console.log('VSIX:', VSIX, `${(fs.statSync(VSIX).size / 1024).toFixed(1)} KB`);
  rmrf(USER_DATA_DIR);
  rmrf(EXTENSIONS_DIR);
  rmrf(SHARED_DIR);
  ensureDir(USER_DATA_DIR);
  ensureDir(EXTENSIONS_DIR);
  ensureDir(SHARED_DIR);

  console.log('\n[1] Install into a clean profile');
  const install = installVsix();
  console.log(install.stdout.trim());
  if (install.stderr.trim()) console.log('stderr:', install.stderr.trim().split('\n')[0]);
  assert.strictEqual(install.status, 0, 'VSIX installation exited with a non-zero status');
  assert.match(install.stdout + install.stderr, /successfully installed/i);
  const installedFolder = path.join(EXTENSIONS_DIR, `${pkg.publisher}.${pkg.name}-${pkg.version}`);
  assert.ok(fs.existsSync(path.join(installedFolder, 'package.json')), 'installed package.json missing');
  assert.ok(fs.existsSync(path.join(installedFolder, 'src', 'extension.js')), 'installed extension.js missing');
  const installedPkg = JSON.parse(fs.readFileSync(path.join(installedFolder, 'package.json'), 'utf8'));
  assert.strictEqual(installedPkg.publisher, pkg.publisher);
  assert.strictEqual(installedPkg.name, pkg.name);
  assert.strictEqual(installedPkg.version, pkg.version);
  assert.strictEqual(installedPkg.icon, 'images/icon.png');
  assert.ok(fs.existsSync(path.join(installedFolder, 'images', 'icon.png')), 'installed icon missing');
  console.log('  PASS - VSIX installed (including icon):', path.basename(installedFolder));

  console.log('\n[2] CLI sees the installed extension');
  const list = listInstalledExtensions();
  assert.strictEqual(list.status, 0, '--list-extensions failed');
  assert.match(list.stdout, new RegExp(`${pkg.publisher}\\.${pkg.name}@${pkg.version.replace(/\./g, '\\.')}`));
  console.log('  PASS -', list.stdout.split(/\r?\n/).find((line) => line.includes('line-number-format')));

  console.log('\n[3] Launch the installed extension (no extensionDevelopmentPath)');
  const app = await launchVSCode({
    label: 'vsix-installed',
    userDataDir: USER_DATA_DIR,
    extensionsDir: EXTENSIONS_DIR,
    sharedDataDir: SHARED_DIR,
    keepProfiles: true,
    openPath: path.join(SAMPLES_DIR, 'sample.asm'),
    extraArgs: ['--disable-extension', 'GitHub.copilot-chat', '--disable-extension', 'GitHub.copilot'],
    settings: standardSettings({ 'lineNumberFormat.mode': 'hex' }),
  });

  try {
    await app.cdp.setWindowSize(1400, 900);
    const title = await app.cdp.waitFor(
      `document.querySelectorAll('.monaco-workbench').length > 0 ? document.title : ''`,
      { timeoutMs: 60000, label: 'workbench' }
    );
    assert.ok(!/Extension Development Host/i.test(title), `unexpected dev-host title: ${title}`);

    await app.cdp.waitFor(
      `(() => Array.from(document.querySelectorAll('.statusbar-item')).some((item) => (item.textContent || '').includes('LN:')))()`,
      { timeoutMs: 120000, label: 'installed extension activation', intervalMs: 400 }
    );
    console.log('  PASS - installed extension activated; window:', title);

    // The file is opened by the VS Code CLI at launch; no quick-open timing is
    // involved here.
    await app.cdp.waitFor(
      `(() => {
        const el = document.querySelector('.monaco-editor .view-lines');
        return !!el && el.innerText.replace(/\\u00A0/g, ' ').includes('section .data');
      })()`,
      { timeoutMs: 30000, label: 'sample.asm content' }
    );
    await sleep(500);
    await app.cdp.waitFor(
      `(() => {
        const line = document.querySelector('.monaco-editor .view-lines .view-line');
        if (!line) return false;
        for (const span of line.querySelectorAll('span')) {
          const content = getComputedStyle(span, '::before').content;
          if (content && content !== 'none' && content !== 'normal' && content !== '""') {
            return content.includes('0x01') && content.includes('│');
          }
        }
        return false;
      })()`,
      { timeoutMs: 10000, label: 'hex label from installed extension' }
    );

    const status = await app.cdp.evaluate(EXPR_STATUS_BAR);
    const natives = await app.cdp.evaluate(EXPR_NATIVE_NUMBERS);
    assert.match(status, /LN: Hex/);
    assert.strictEqual(natives.length, 0, 'native numbers are still visible');
    console.log('  PASS - installed VSIX renders hex labels; status:', status.split('|').find((part) => part.includes('LN:')).trim());
    await app.cdp.screenshot(path.join(OUTPUT_DIR, 'vsix-01-hex-asm.png'));

    // Switch back to decimal through the status bar to verify the installed copy
    // also restores native numbers.
    await app.cdp.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.statusbar-item')).find((el) => (el.textContent || '').includes('LN:'));
      if (!item) return false;
      (item.querySelector('a') || item).click();
      return true;
    })()`);
    await sleep(900);
    await typeQuickInput(app.cdp, 'Decimal only');
    await app.cdp.pressEnter();
    await sleep(1200);
    const restored = await app.cdp.evaluate(EXPR_NATIVE_NUMBERS);
    assert.ok(restored.length >= 10, `native numbers did not return (${restored.length})`);
    console.log('  PASS - installed VSIX restores native numbers');
    await app.cdp.screenshot(path.join(OUTPUT_DIR, 'vsix-02-decimal-restored.png'));
  } finally {
    await app.stop();
  }

  const logPath = findExtensionHostLog(USER_DATA_DIR);
  if (logPath) {
    const log = readTail(logPath, 200000);
    const errors = log
      .split(/\r?\n/)
      .filter((line) => /line-number-format/i.test(line) && /error|failed|exception/i.test(line));
    assert.strictEqual(errors.length, 0, errors.slice(0, 5).join(' | '));
    console.log('  PASS - no extension errors in the installed profile log');
  }

  console.log('\nVSIX test passed. Screenshots:', OUTPUT_DIR);
})().catch((error) => {
  console.error('\nVSIX test failed:', error);
  process.exitCode = 1;
});
