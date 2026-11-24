'use strict';

/**
 * Pure formatting helpers for line-number labels. This module must not depend
 * on the `vscode` module so it can be unit-tested with plain Node.js.
 */

/** A non-breaking space keeps label columns aligned even if HTML collapses spaces. */
const NBSP = '\u00A0';
const DEFAULT_GAP = 2;
/** Vertical bar between decimal/hex values and between the label column and code. */
const SEPARATOR = '\u2502';

/** @typedef {'decimal' | 'hex' | 'both'} LineNumberMode */

/**
 * @typedef {Object} LabelOptions
 * @property {LineNumberMode} mode
 * @property {boolean} [hexPrefix]
 * @property {boolean} [hexUppercase]
 * @property {boolean} [hexPad]
 * @property {boolean} [showSeparators]
 * @property {number} [gap]
 */

function normalizeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function normalizeLine(value, lineCount) {
  const n = Number(value);
  const safe = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  return Math.min(safe, normalizeCount(lineCount));
}

/** Width, in hexadecimal digits, of the largest line number in the document. */
function hexDigitWidth(lineCount) {
  return Math.max(1, normalizeCount(lineCount).toString(16).length);
}

/** Width, in decimal digits, of the largest line number in the document. */
function decimalDigitWidth(lineCount) {
  return String(normalizeCount(lineCount)).length;
}

/**
 * Format one line number as hexadecimal, optionally zero-padded.
 * @returns {string}
 */
function formatHex(lineNumber, lineCount, options) {
  const opts = options || {};
  const n = normalizeLine(lineNumber, lineCount);
  let digits = n.toString(16);
  if (opts.hexPad !== false) {
    digits = digits.padStart(hexDigitWidth(lineCount), '0');
  }
  if (opts.hexUppercase !== false) {
    digits = digits.toUpperCase();
  }
  return (opts.hexPrefix !== false ? '0x' : '') + digits;
}

/**
 * Format the full label for a line, including any decimal/hex separator and
 * the trailing gap. Labels generated for the same document always have the
 * same length when `hexPad` is enabled (the default), which is what keeps the
 * column aligned in a monospace editor font.
 *
 * @param {number} lineNumber 1-based line number
 * @param {number} lineCount total number of lines in the document
 * @param {LabelOptions} options
 * @returns {string}
 */
function formatLabel(lineNumber, lineCount, options) {
  const opts = options || {};
  const mode = opts.mode || 'decimal';
  const n = normalizeLine(lineNumber, lineCount);
  const gap = typeof opts.gap === 'number' && opts.gap >= 0 ? Math.floor(opts.gap) : DEFAULT_GAP;
  const separator = opts.showSeparators === false ? '' : SEPARATOR;

  let label;
  if (mode === 'hex') {
    label = formatHex(n, lineCount, opts) + (separator ? NBSP + separator : '');
  } else {
    const dec = String(n).padStart(decimalDigitWidth(lineCount), NBSP);
    if (mode === 'both') {
      const hex = formatHex(n, lineCount, opts);
      label = separator
        ? dec + NBSP + separator + NBSP + hex + NBSP + separator
        : dec + NBSP + NBSP + hex;
    } else {
      label = dec;
    }
  }

  return label + NBSP.repeat(gap);
}

/**
 * Width of the label column in `ch` units for the document. This is used as
 * the inline decoration width so that every line starts at the same x offset.
 * The widest label always belongs to the largest line number, so measuring
 * that one label keeps the formatter and the layout in sync.
 *
 * @param {number} lineCount
 * @param {LabelOptions} options
 * @returns {number}
 */
function labelColumnWidth(lineCount, options) {
  return formatLabel(normalizeCount(lineCount), lineCount, options).length;
}

module.exports = {
  NBSP,
  DEFAULT_GAP,
  SEPARATOR,
  decimalDigitWidth,
  hexDigitWidth,
  formatHex,
  formatLabel,
  labelColumnWidth,
};
