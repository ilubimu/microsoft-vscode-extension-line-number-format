'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workspaceRoot() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) throw new Error('LNF stress requires an open workspace folder');
  return folder.uri.fsPath;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentiles(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] || 0;
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    avg: sorted.length ? sum / sorted.length : 0,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

async function runStress() {
  const root = workspaceRoot();
  const configPath = path.join(root, 'stress-config.json');
  const resultPath = path.join(root, 'stress-result.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error('LNF stress requires an active editor');

  const lineCount = editor.document.lineCount;
  const cycles = Math.max(1, Number(config.cycles) || 60);
  const intervalMs = Math.max(0, Number(config.intervalMs) || 0);
  const settleMs = Math.max(0, Number(config.settleMs) || 800);
  const sequence = Array.isArray(config.modeSequence) && config.modeSequence.length
    ? config.modeSequence
    : ['hex', 'both'];
  const random = lcg(Number(config.seed) || 123456789);

  const errors = [];
  const commandDurations = [];
  const jumps = [];
  const requestedModes = [];
  const pending = [];
  let maxLagMs = 0;
  let lastTick = performance.now();

  const lagTimer = setInterval(() => {
    const now = performance.now();
    const gap = now - lastTick;
    if (gap > 50) maxLagMs = Math.max(maxLagMs, gap - 50);
    lastTick = now;
  }, 50);

  const started = performance.now();

  // Fire the commands without awaiting them: this is the same overlap a user
  // creates by clicking the status-bar picker again before the previous
  // settings write has finished.
  for (let i = 0; i < cycles; i++) {
    const mode = sequence[i % sequence.length];
    requestedModes.push(mode);
    const commandStarted = performance.now();
    pending.push(
      vscode.commands.executeCommand(`lineNumberFormat.${mode}`).then(
        () => commandDurations.push(performance.now() - commandStarted),
        (error) => errors.push(`mode ${mode}: ${error && error.message ? error.message : String(error)}`)
      )
    );

    if (config.jump !== false) {
      let line;
      if (i % 6 === 0) line = 0;
      else if (i % 6 === 1) line = lineCount - 1;
      else line = Math.floor(random() * lineCount);
      jumps.push(line + 1);
      editor.revealRange(
        new vscode.Range(line, 0, line, 0),
        vscode.TextEditorRevealType.InCenter
      );
    }

    if (intervalMs > 0) await sleep(intervalMs);
  }

  const dispatchMs = performance.now() - started;
  await Promise.allSettled(pending);
  const commandsDoneMs = performance.now() - started;
  await sleep(settleMs);

  clearInterval(lagTimer);

  const extension = vscode.extensions.getExtension('local-tools.line-number-format');
  const state = extension && extension.exports ? extension.exports.getState() : null;
  const finalVisible = editor.visibleRanges.map((range) => ({
    start: range.start.line + 1,
    end: range.end.line + 1,
  }));

  const result = {
    testedAt: new Date().toISOString(),
    cycles,
    intervalMs,
    settleMs,
    durationMs: performance.now() - started,
    dispatchMs,
    commandsDoneMs,
    maxLagMs,
    commandDurations: percentiles(commandDurations),
    commandErrors: errors,
    requestedModes,
    finalRequestedMode: requestedModes[requestedModes.length - 1],
    jumps,
    activeLine: editor.selection.active.line + 1,
    lineCount,
    finalVisible,
    lineNumbersOption: editor.options.lineNumbers,
    state,
  };

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  vscode.window.showInformationMessage(
    `LNF stress done: ${cycles} cycles, max event-loop lag ${maxLagMs.toFixed(0)} ms`
  );
  return result;
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  item.text = '$(beaker) LNF Stress';
  item.tooltip = 'Run the line-number-format mode-switch/scroll stress test';
  item.command = 'lnfStress.run';
  item.show();
  context.subscriptions.push(item);

  context.subscriptions.push(
    vscode.commands.registerCommand('lnfStress.run', async () => {
      if (item.text.includes('Running')) return;
      item.text = '$(sync~spin) LNF Stress';
      try {
        await runStress();
        item.text = '$(beaker) LNF Stress';
      } catch (error) {
        item.text = '$(beaker) LNF Stress';
        const resultPath = path.join(workspaceRoot(), 'stress-result.json');
        fs.writeFileSync(
          resultPath,
          JSON.stringify({ error: error && error.stack ? error.stack : String(error) }, null, 2),
          'utf8'
        );
        vscode.window.showErrorMessage(`LNF stress failed: ${error && error.message ? error.message : error}`);
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
