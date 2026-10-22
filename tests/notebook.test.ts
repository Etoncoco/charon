import { describe, expect, it } from 'vitest';
import {
  cleanTerminalText, fenceCode, highlightLanguage, htmlNeedsScripts, joinSource, jupyterAnchor,
  parseNotebook, parseOutputs, pickMime, stripAnsi, type NbCell, type Notebook,
} from '../app/notebook';

// §14.111: Jupyter notebooks rendered as a document (NotebookViewer).

function nb(text: string): Notebook {
  const r = parseNotebook(text);
  if (!r.ok) throw new Error(r.error);
  return r.notebook;
}

const V4 = JSON.stringify({
  nbformat: 4, nbformat_minor: 5,
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3 (ipykernel)', language: 'python' },
    language_info: { name: 'python' },
  },
  cells: [
    { cell_type: 'markdown', id: 'a', metadata: {}, source: ['# Title\n', 'Some *text*'],
      attachments: { 'p.png': { 'image/png': 'iVBO\nRw0=' } } },
    { cell_type: 'code', id: 'b', metadata: {}, execution_count: 3, source: 'print(1)\n1 + 1',
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['1\n'] },
        { output_type: 'stream', name: 'stdout', text: '2\n' },
        { output_type: 'stream', name: 'stderr', text: 'warn\n' },
        { output_type: 'execute_result', execution_count: 3, metadata: {},
          data: { 'text/plain': ['2'], 'text/html': '<b>2</b>' } },
        { output_type: 'display_data', metadata: { 'image/png': { width: 320, height: 200 } },
          data: { 'image/png': 'iVBORw0K\nGgo=\n', 'text/plain': '<Figure>' } },
        { output_type: 'error', ename: 'ValueError', evalue: 'bad',
          traceback: ['\u001b[0;31m---------\u001b[0m', '\u001b[0;31mValueError\u001b[0m: bad'] },
      ] },
    { cell_type: 'raw', id: 'c', metadata: {}, source: 'raw text' },
    { cell_type: 'unknown', source: 'dropped' },
  ],
});

describe('nbformat 4', () => {
  it('reads cells, kernel and language', () => {
    const n = nb(V4);
    expect(n.nbformat).toBe(4);
    expect(n.kernel).toBe('Python 3 (ipykernel)');
    expect(n.language).toBe('python');
    expect(n.cells.map((c) => c.type)).toEqual(['markdown', 'code', 'raw']);
    expect(n.cells[0]).toMatchObject({ source: '# Title\nSome *text*' });
    expect(n.cells[2]).toEqual({ type: 'raw', source: 'raw text' });
  });

  it('turns markdown attachments into whitespace-free data URIs', () => {
    const cell = nb(V4).cells[0] as Extract<NbCell, { type: 'markdown' }>;
    expect(cell.attachments).toEqual({ 'p.png': 'data:image/png;base64,iVBORw0=' });
  });

  it('reads code cells: source, execution count, merged streams, chosen MIME', () => {
    const cell = nb(V4).cells[1] as Extract<NbCell, { type: 'code' }>;
    expect(cell.source).toBe('print(1)\n1 + 1');
    expect(cell.executionCount).toBe(3);
    expect(cell.outputs).toEqual([
      { kind: 'stream', name: 'stdout', text: '1\n2\n' },
      { kind: 'stream', name: 'stderr', text: 'warn\n' },
      { kind: 'data', mime: 'text/html', text: '<b>2</b>', result: true, executionCount: 3 },
      { kind: 'data', mime: 'image/png', text: 'iVBORw0KGgo=', result: false, executionCount: null, width: 320, height: 200 },
      { kind: 'error', ename: 'ValueError', evalue: 'bad', traceback: '---------\nValueError: bad' },
    ]);
  });

  it('falls back to kernel language_info, then python', () => {
    expect(nb(JSON.stringify({ nbformat: 4, metadata: { language_info: { name: 'Julia' } }, cells: [] })).language).toBe('julia');
    const bare = nb(JSON.stringify({ nbformat: 4, metadata: {}, cells: [] }));
    expect(bare.language).toBe('python');
    expect(bare.kernel).toBeNull();
  });

  it('says why a file is not a notebook', () => {
    expect(parseNotebook('')).toEqual({ ok: false, error: 'this notebook is empty' });
    const bad = parseNotebook('{"cells": [');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/^not valid JSON: /);
    expect(parseNotebook('[]')).toEqual({ ok: false, error: 'not a Jupyter notebook: the top level is not an object' });
    expect(parseNotebook('{"metadata": {}}')).toEqual({ ok: false, error: 'not a Jupyter notebook: no cells' });
  });
});

describe('nbformat 3', () => {
  const V3 = JSON.stringify({
    nbformat: 3, nbformat_minor: 0, metadata: { name: '' },
    worksheets: [{
      metadata: {},
      cells: [
        { cell_type: 'heading', level: 2, metadata: {}, source: ['Results'] },
        { cell_type: 'code', collapsed: false, input: ["print 'hi'\n", 'x'], language: 'python', metadata: {},
          prompt_number: 7,
          outputs: [
            { output_type: 'stream', stream: 'stdout', text: ['hi\n'] },
            { output_type: 'pyout', prompt_number: 7, metadata: {}, text: ['42'], png: 'AAAA\nBBBB' },
            { output_type: 'pyerr', ename: 'NameError', evalue: "name 'y' is not defined", traceback: [] },
          ] },
        { cell_type: 'markdown', metadata: {}, source: 'plain' },
      ],
    }],
  });

  it('reads worksheets, `input`, prompt numbers and heading cells', () => {
    const n = nb(V3);
    expect(n.nbformat).toBe(3);
    expect(n.language).toBe('python');
    expect(n.cells[0]).toEqual({ type: 'markdown', source: '## Results', attachments: {} });
    const code = n.cells[1] as Extract<NbCell, { type: 'code' }>;
    expect(code.source).toBe("print 'hi'\nx");
    expect(code.executionCount).toBe(7);
    expect(code.outputs).toEqual([
      { kind: 'stream', name: 'stdout', text: 'hi\n' },
      { kind: 'data', mime: 'image/png', text: 'AAAABBBB', result: true, executionCount: 7 },
      { kind: 'error', ename: 'NameError', evalue: "name 'y' is not defined", traceback: "NameError: name 'y' is not defined" },
    ]);
  });

  it('takes the language from a code cell when the metadata has none', () => {
    const doc = { nbformat: 3, metadata: {}, worksheets: [{ cells: [{ cell_type: 'code', language: 'R', input: 'x' }] }] };
    expect(nb(JSON.stringify(doc)).language).toBe('r');
  });
});

describe('source and outputs', () => {
  it('joins string and string[] sources', () => {
    expect(joinSource('a\nb')).toBe('a\nb');
    expect(joinSource(['a\n', 'b'])).toBe('a\nb');
    expect(joinSource(['a', 1, null, 'b'])).toBe('ab');
    expect(joinSource(undefined)).toBe('');
  });

  it('prefers the richest MIME type', () => {
    expect(pickMime({ 'text/plain': 'x', 'image/png': 'y', 'text/html': 'z' })).toBe('image/png');
    expect(pickMime({ 'text/plain': 'x', 'image/jpeg': 'y' })).toBe('image/jpeg');
    expect(pickMime({ 'text/plain': 'x', 'image/svg+xml': '<svg/>', 'text/html': 'z' })).toBe('image/svg+xml');
    expect(pickMime({ 'text/plain': 'x', 'text/html': 'z', 'text/markdown': 'm' })).toBe('text/html');
    expect(pickMime({ 'text/plain': 'x', 'text/markdown': 'm' })).toBe('text/markdown');
    expect(pickMime({ 'text/plain': 'x', 'application/json': {} })).toBe('application/json');
    expect(pickMime({ 'text/plain': 'x', 'application/vnd.jupyter.widget-view+json': {} })).toBe('text/plain');
    expect(pickMime({ 'application/vnd.plotly.v1+json': {} })).toBeNull();
  });

  it('pretty-prints JSON, joins SVG, reports bundles it cannot show', () => {
    expect(parseOutputs([
      { output_type: 'display_data', data: { 'application/json': { a: [1, 2] } } },
      { output_type: 'display_data', data: { 'application/json': '{"b":1}' } },
      { output_type: 'display_data', data: { 'image/svg+xml': ['<svg>\n', '</svg>'] } },
      { output_type: 'display_data', data: { 'application/vnd.plotly.v1+json': {} } },
      { output_type: 'mystery' },
      'junk',
    ])).toEqual([
      { kind: 'data', mime: 'application/json', text: '{\n  "a": [\n    1,\n    2\n  ]\n}', result: false, executionCount: null },
      { kind: 'data', mime: 'application/json', text: '{\n  "b": 1\n}', result: false, executionCount: null },
      { kind: 'data', mime: 'image/svg+xml', text: '<svg>\n</svg>', result: false, executionCount: null },
      { kind: 'unsupported', mimes: ['application/vnd.plotly.v1+json'] },
    ]);
  });

  it('merges only ADJACENT chunks of the same stream, then applies carriage returns across them', () => {
    expect(parseOutputs([
      { output_type: 'stream', name: 'stderr', text: ' 10%\r' },
      { output_type: 'stream', name: 'stderr', text: ' 99%\r100%\n' },
      { output_type: 'stream', name: 'stdout', text: 'a' },
      { output_type: 'stream', name: 'stderr', text: 'b' },
      { output_type: 'stream', name: 'stdout', text: 'c' },
    ])).toEqual([
      { kind: 'stream', name: 'stderr', text: '100%\n' },
      { kind: 'stream', name: 'stdout', text: 'a' },
      { kind: 'stream', name: 'stderr', text: 'b' },
      { kind: 'stream', name: 'stdout', text: 'c' },
    ]);
  });
});

describe('terminal text', () => {
  it('strips colour, cursor, OSC and charset escapes', () => {
    expect(stripAnsi('\u001b[0;31mError\u001b[0m')).toBe('Error');
    expect(stripAnsi('\u001b[1;32m\u001b[2K\u001b[?25lok\u001b[?25h')).toBe('ok');
    expect(stripAnsi('\u001b]8;;https://x.y\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(stripAnsi('\u001b]0;title\u001b\\body')).toBe('body');
    expect(stripAnsi('\u001b(Bplain\u001b=')).toBe('plain');
    expect(stripAnsi('\u009b31mx')).toBe('x');
    expect(stripAnsi('no escapes [31m here')).toBe('no escapes [31m here');
  });

  it('applies carriage returns and backspaces like a terminal', () => {
    expect(cleanTerminalText('abc\rX')).toBe('Xbc');
    expect(cleanTerminalText('progress 10%\rprogress 100%\ndone')).toBe('progress 100%\ndone');
    expect(cleanTerminalText('line\r\nnext')).toBe('line\nnext');
    expect(cleanTerminalText('trailing\r')).toBe('trailing');
    expect(cleanTerminalText('ab\bc')).toBe('ac');
    expect(cleanTerminalText('a\n\bb')).toBe('a\nb');
    expect(cleanTerminalText('\u001b[32m 50%\u001b[0m\r\u001b[32m100%\u001b[0m')).toBe('100%');
  });

  it('cleans text/plain results too (rich reprs carry escapes)', () => {
    expect(parseOutputs([{ output_type: 'execute_result', execution_count: 1, data: { 'text/plain': '\u001b[1mbold\u001b[0m' } }]))
      .toEqual([{ kind: 'data', mime: 'text/plain', text: 'bold', result: true, executionCount: 1 }]);
  });
});

describe('code rendering helpers', () => {
  it('fences code with a fence longer than any backtick run inside', () => {
    expect(fenceCode('x = 1\n', 'python')).toBe('```python\nx = 1\n```');
    expect(fenceCode('s = """\n```\n"""', 'Python')).toBe('````python\ns = """\n```\n"""\n````');
    expect(fenceCode('a', 'c++')).toBe('```cpp\na\n```');
  });

  it('maps kernel languages to highlight.js names, safely', () => {
    expect(highlightLanguage('ipython3')).toBe('python');
    expect(highlightLanguage('R')).toBe('r');
    expect(highlightLanguage('C#')).toBe('csharp');
    expect(highlightLanguage('weird lang`x')).toBe('weirdlangx');
  });

  it('builds Jupyter heading anchors and spots script-driven HTML', () => {
    expect(jupyterAnchor(' Getting Started ')).toBe('Getting-Started');
    expect(htmlNeedsScripts('<div id="p"></div><SCRIPT type="text/javascript">x</script>')).toBe(true);
    expect(htmlNeedsScripts('<table><tr><td>scripted</td></tr></table>')).toBe(false);
  });
});
