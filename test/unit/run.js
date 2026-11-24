'use strict';

const assert = require('node:assert');
const {
  NBSP,
  SEPARATOR,
  decimalDigitWidth,
  hexDigitWidth,
  formatHex,
  formatLabel,
  labelColumnWidth,
} = require('../../src/format');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error && error.message ? error.message : error}`);
  }
}

function visible(value) {
  return String(value).replace(new RegExp(NBSP, 'g'), '·');
}

console.log('format: digit widths');
test('hex width for small documents', () => {
  assert.strictEqual(hexDigitWidth(1), 1);
  assert.strictEqual(hexDigitWidth(15), 1);
  assert.strictEqual(hexDigitWidth(16), 2);
  assert.strictEqual(hexDigitWidth(255), 2);
  assert.strictEqual(hexDigitWidth(256), 3);
  assert.strictEqual(hexDigitWidth(100000), 5);
});

test('decimal width for small documents', () => {
  assert.strictEqual(decimalDigitWidth(1), 1);
  assert.strictEqual(decimalDigitWidth(9), 1);
  assert.strictEqual(decimalDigitWidth(10), 2);
  assert.strictEqual(decimalDigitWidth(100000), 6);
});

test('width helpers tolerate invalid counts', () => {
  assert.strictEqual(hexDigitWidth(0), 1);
  assert.strictEqual(decimalDigitWidth(-4), 1);
  assert.strictEqual(hexDigitWidth(NaN), 1);
});

console.log('format: hexadecimal labels');
test('zero-pads to the document width', () => {
  assert.strictEqual(formatHex(10, 1000, {}), '0x00A');
  assert.strictEqual(formatHex(1, 16, {}), '0x01');
  assert.strictEqual(formatHex(16, 16, {}), '0x10');
});

test('uppercase can be disabled', () => {
  assert.strictEqual(formatHex(0xab, 1000, { hexUppercase: false }), '0x0ab');
});

test('prefix can be disabled', () => {
  assert.strictEqual(formatHex(10, 1000, { hexPrefix: false }), '00A');
});

test('padding can be disabled', () => {
  assert.strictEqual(formatHex(10, 1000, { hexPad: false }), '0xA');
});

console.log('format: full labels');
test('hex labels put a separator between the value and the code', () => {
  assert.strictEqual(
    formatLabel(10, 1000, { mode: 'hex', gap: 2 }),
    '0x00A' + NBSP + SEPARATOR + NBSP + NBSP
  );
});

test('separators can be disabled', () => {
  assert.strictEqual(
    formatLabel(10, 1000, { mode: 'hex', gap: 2, showSeparators: false }),
    '0x00A' + NBSP + NBSP
  );
});

test('both labels use separators between decimal, hex and code', () => {
  const label = formatLabel(5, 1000, { mode: 'both', gap: 2 });
  const expected =
    NBSP + NBSP + NBSP + '5' + NBSP + SEPARATOR + NBSP + '0x005' + NBSP + SEPARATOR + NBSP + NBSP;
  assert.strictEqual(visible(label), visible(expected));
});

test('both labels align without separators when disabled', () => {
  const label = formatLabel(5, 1000, { mode: 'both', gap: 2, showSeparators: false });
  const expected = NBSP + NBSP + NBSP + '5' + NBSP + NBSP + '0x005' + NBSP + NBSP;
  assert.strictEqual(visible(label), visible(expected));
});

test('decimal labels are right-aligned with non-breaking spaces', () => {
  const label = formatLabel(7, 1000, { mode: 'decimal', gap: 1 });
  assert.strictEqual(visible(label), '···7·');
});

test('every padded label has the column width', () => {
  const lineCount = 70000;
  for (const mode of ['hex', 'both']) {
    for (const showSeparators of [true, false]) {
      const options = { mode, gap: 2, showSeparators };
      const width = labelColumnWidth(lineCount, options);
      for (const line of [1, 2, 15, 16, 255, 256, 4095, 4096, 69999, 70000]) {
        const label = formatLabel(line, lineCount, options);
        assert.strictEqual(label.length, width, `${mode} line ${line}: ${visible(label)}`);
      }
    }
  }
});

test('labels never exceed the column width when padding is off', () => {
  const lineCount = 100000;
  const options = { mode: 'hex', gap: 2, hexPad: false };
  const width = labelColumnWidth(lineCount, options);
  for (const line of [1, 10, 4096, 65535, 100000]) {
    assert.ok(formatLabel(line, lineCount, options).length <= width);
  }
});

test('line numbers are clamped to the document', () => {
  assert.strictEqual(formatHex(0, 10, { hexPad: true }), '0x1');
  assert.strictEqual(formatHex(999, 10, { hexPad: true }), '0xA');
});

test('single-line documents work', () => {
  assert.strictEqual(formatLabel(1, 1, { mode: 'hex', gap: 0 }), '0x1' + NBSP + SEPARATOR);
  assert.strictEqual(
    formatLabel(1, 1, { mode: 'hex', gap: 0, showSeparators: false }),
    '0x1'
  );
  assert.strictEqual(labelColumnWidth(1, { mode: 'both', gap: 0 }), 9);
  assert.strictEqual(
    labelColumnWidth(1, { mode: 'both', gap: 0, showSeparators: false }),
    6
  );
});

test('large line counts stay exact', () => {
  assert.strictEqual(formatHex(0xffffff, 0x1000000, {}), '0x0FFFFFF');
  assert.strictEqual(labelColumnWidth(0x1000000, { mode: 'hex', gap: 2 }), 13);
  assert.strictEqual(
    labelColumnWidth(0x1000000, { mode: 'hex', gap: 2, showSeparators: false }),
    11
  );
});

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed, ${passed} passed.`);
  process.exitCode = 1;
} else {
  console.log(`All ${passed} formatting tests passed.`);
}
