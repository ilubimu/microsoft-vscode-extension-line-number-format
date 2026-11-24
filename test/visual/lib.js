'use strict';

/**
 * Small CDP/Electron harness used by the black-box tests. It launches a
 * *separate copy* of VS Code with its own user-data-dir and extensions-dir,
 * then drives the real UI and captures screenshots.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..');
const RUNTIME_DIR = path.join(WORKSPACE_ROOT, '_test-runtime');
const VSCODE_DIR = path.join(RUNTIME_DIR, 'vscode');
const CODE_EXE = path.join(VSCODE_DIR, 'Code.exe');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function writeUserSettings(userDataDir, settings) {
  const userDir = path.join(userDataDir, 'User');
  ensureDir(userDir);
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}

function readTail(file, maxBytes = 20000) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch (_) {
    return '';
  }
}

class CDP {
  constructor(webSocketUrl, targetId) {
    this.webSocketUrl = webSocketUrl;
    this.targetId = targetId;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
  }

  connect(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.webSocketUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch (_) {}
        reject(new Error('CDP websocket connection timed out'));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP websocket error: ${event.message || 'unknown'}`));
      });
      ws.addEventListener('message', (event) => {
        this._handleMessage(event.data);
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const [, pending] of this.pending) {
          pending.reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  _handleMessage(data) {
    let text;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString('utf8');
    } else if (Buffer.isBuffer(data)) {
      text = data.toString('utf8');
    } else {
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error(`CDP ${method}: connection is not open`));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method}: timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = false, timeoutMs = 30000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
      },
      timeoutMs
    );

    if (result.exceptionDetails) {
      const description =
        (result.exceptionDetails.exception && result.exceptionDetails.exception.description) ||
        result.exceptionDetails.text ||
        'evaluation failed';
      throw new Error(`Renderer exception: ${description}`);
    }
    return result.result ? result.result.value : undefined;
  }

  async waitFor(expression, { timeoutMs = 30000, intervalMs = 200, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async setWindowSize(width, height) {
    try {
      const { windowId } = await this.send('Browser.getWindowForTarget', {
        targetId: this.targetId,
      });
      await this.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width, height, windowState: 'normal' },
      });
    } catch (_) {
      /* not fatal for screenshots */
    }
  }

  async pressF1() {
    const key = { key: 'F1', code: 'F1', windowsVirtualKeyCode: 112, nativeVirtualKeyCode: 112 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  async pressEnter() {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  async pressEscape() {
    const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  async insertText(text) {
    await this.send('Input.insertText', { text });
  }

  async shortcut(key, code, virtualKeyCode, modifiers) {
    const event = {
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      modifiers,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  }

  close() {
    try {
      this.ws && this.ws.close();
    } catch (_) {}
  }
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools endpoint returned ${response.status}`);
  return response.json();
}

async function connectToWorkbench(port, { timeoutMs = 90000, titleHint = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no targets';

  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      let page;
      if (titleHint) page = pages.find((target) => (target.title || '').includes(titleHint));
      if (!page) page = pages.find((target) => (target.url || '').includes('workbench.html'));
      if (!page) page = pages[0];

      if (page) {
        const cdp = new CDP(page.webSocketDebuggerUrl, page.id);
        await cdp.connect();
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        return { cdp, target: page, targets };
      }
      lastError = `no page target (${targets.length} targets)`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }

  throw new Error(`Could not connect to the VS Code workbench: ${lastError}`);
}

/**
 * Launch the isolated VS Code copy.
 */
async function launchVSCode(options) {
  const {
    label,
    userDataDir,
    extensionsDir,
    sharedDataDir,
    openPath,
    developmentPath,
    settings,
    extraArgs = [],
    port: requestedPort,
    keepProfiles = false,
  } = options;

  if (!keepProfiles) {
    rmrf(userDataDir);
    rmrf(extensionsDir);
  }
  ensureDir(userDataDir);
  ensureDir(extensionsDir);
  const sharedDir = sharedDataDir || `${userDataDir}-shared`;
  ensureDir(sharedDir);
  writeUserSettings(userDataDir, settings || {});

  const port = requestedPort || (await getFreePort());
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--shared-data-dir=${sharedDir}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    '--new-window',
    ...extraArgs,
  ];
  if (developmentPath) args.push(`--extensionDevelopmentPath=${developmentPath}`);
  if (openPath) args.push(openPath);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(CODE_EXE, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  const output = [];
  child.stdout.on('data', (data) => output.push(data.toString()));
  child.stderr.on('data', (data) => output.push(data.toString()));

  let exited = false;
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  const result = await connectToWorkbench(port);
  result.child = child;
  result.port = port;
  result.output = output;
  result.isExited = () => exited;
  result.exitInfo = () => exitInfo;
  result.stop = async () => {
    result.cdp.close();
    if (!exited) {
      try {
        child.kill();
      } catch (_) {}
      await sleep(1500);
      if (!exited) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      }
    }
    await sleep(500);
  };
  result.label = label;
  return result;
}

function standardSettings(overrides = {}) {
  return {
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.welcomePage.walkthroughs.openOnInstall': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.disableAIFeatures': true,
    'chat.commandCenter.enabled': false,
    'security.workspace.trust.enabled': false,
    'window.restoreWindows': 'none',
    'window.titleBarStyle': 'custom',
    'git.enabled': false,
    'git.decorations.enabled': false,
    'editor.fontSize': 14,
    'editor.lineHeight': 20,
    'editor.minimap.enabled': true,
    'editor.wordWrap': 'off',
    'editor.lineNumbers': 'on',
    'lineNumberFormat.mode': 'decimal',
    ...overrides,
  };
}

function findExtensionHostLog(userDataDir) {
  const logsRoot = path.join(userDataDir, 'logs');
  if (!fs.existsSync(logsRoot)) return null;
  const stack = [logsRoot];
  const found = [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'exthost.log') found.push(full);
    }
  }
  found.sort();
  return found.length ? found[found.length - 1] : null;
}

/** Text content of the visible code area (includes inline decoration labels). */
const EXPR_EDITOR_TEXT = `(() => {
  const lines = document.querySelector('.monaco-editor .view-lines');
  return lines ? lines.innerText.replace(/\u00A0/g, ' ') : '';
})()`;

const EXPR_NATIVE_NUMBERS = `(() => {
  const nodes = Array.from(document.querySelectorAll('.monaco-editor .margin-view-overlays .line-numbers'));
  return nodes.map((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      text: (node.textContent || '').trim(),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      width: rect.width,
      height: rect.height
    };
  }).filter((entry) => entry.text && entry.display !== 'none' && entry.visibility !== 'hidden' && entry.opacity !== '0' && entry.width > 0);
})()`;

const EXPR_STATUS_BAR = `(() => {
  const items = Array.from(document.querySelectorAll('.statusbar-item'));
  return items.map((item) => (item.textContent || '').trim()).filter(Boolean).join(' | ');
})()`;

module.exports = {
  PROJECT_ROOT,
  WORKSPACE_ROOT,
  RUNTIME_DIR,
  VSCODE_DIR,
  CODE_EXE,
  sleep,
  rmrf,
  ensureDir,
  getFreePort,
  writeUserSettings,
  readTail,
  CDP,
  connectToWorkbench,
  launchVSCode,
  standardSettings,
  findExtensionHostLog,
  EXPR_EDITOR_TEXT,
  EXPR_NATIVE_NUMBERS,
  EXPR_STATUS_BAR,
};
