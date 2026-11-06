import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { installInteractiveEditsBridge } from '../scripts/interactive-edits-bridge.mjs';
import { packageDiagram } from '../scripts/package-diagram.mjs';

const ORIGIN = 'https://checklist.example';
const NONCE = '9ad9907b-122a-47e8-8368-2b0b3d22ccf7';
const plain = value => JSON.parse(JSON.stringify(value));

// The opaque iframe owns this DOM. Synthetic CTM includes SVG viewBox offsets,
// camera scaling and translation; no application or private diagram script runs.
function fixture({ topLevel = false } = {}) {
  const events = new Map(), messages = [], captures = new Set(), frames = new Map(), observers = [];
  let frameId = 0;
  const listen = target => (name, callback) => {
    const key = `${target}:${name}`;
    if (!events.has(key)) events.set(key, []);
    events.get(key).push(callback);
  };
  function emit(target, name, event = {}) {
    for (const callback of events.get(`${target}:${name}`) || []) callback(event);
    return event;
  }
  function element(name) {
    return {
      name, attributes: {}, children: [], parent: null, textContent: '',
      setAttribute(key, value) { this.attributes[key] = value; },
      append(child) { child.parent = this; this.children.push(child); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
    };
  }
  const svg = Object.assign(element('svg'), {
    viewBox: { baseVal: { x: 100, y: 200, width: 100, height: 50 } },
    getScreenCTM: () => ({ a: 2, b: 0, c: 0, d: 2, e: 50, f: 70,
      inverse: () => ({ a: .5, b: 0, c: 0, d: .5, e: -25, f: -35 }) }),
  });
  const canvas = {
    style: {}, addEventListener: listen('canvas'),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
  };
  const world = { querySelector: selector => selector === 'svg' ? svg : null };
  const view = { value: 'all', addEventListener: listen('view') };
  const parent = { postMessage: (message, origin) => messages.push({ message: plain(message), origin }) };
  const window = { parent, addEventListener: listen('window') };
  if (topLevel) window.parent = window;
  const context = {
    window, location: { href: `${ORIGIN}/diagram/interactive-example` }, URL,
    document: { getElementById: id => ({ canvas, world, view })[id], createElementNS: (_namespace, name) => element(name) },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target, options) { this.target = target; this.options = plain(options); } },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    DOMPoint: class { constructor(x, y) { this.x = x; this.y = y; } matrixTransform(matrix) { return { x: matrix.a * this.x + matrix.c * this.y + matrix.e, y: matrix.b * this.x + matrix.d * this.y + matrix.f }; } },
  };
  runInNewContext(`(${installInteractiveEditsBridge.toString()})();`, context);
  const send = (data, { source = parent, origin = ORIGIN } = {}) => emit('window', 'message', { data, source, origin });
  function mode(enabled = true, nonce = NONCE) { send({ type: 'mermaid-edit-mode', nonce, enabled }); }
  function pointer(name, { x = 350, y = 520, id = 1, primary = true, node = null, button = 0 } = {}) {
    const event = { button, isPrimary: primary, pointerId: id, clientX: x, clientY: y,
      target: { closest: () => node ? { getAttribute: () => node.id, textContent: node.label } : null },
      stopped: false, prevented: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; },
    };
    return emit('canvas', name, event);
  }
  function flush() {
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback();
    assert.equal(frames.size, 0, 'drawing pins does not schedule itself repeatedly');
  }
  return { events, messages, captures, observers, canvas, svg, world, view, send, mode, pointer, emit, flush };
}

test('opaque diagram bridge accepts mode only from its exact parent and origin with a valid nonce', () => {
  const f = fixture();
  f.send({ type: 'mermaid-edit-mode', nonce: NONCE, enabled: true }, { source: {} });
  assert.notEqual(f.canvas.style.cursor, 'crosshair');
  f.send({ type: 'mermaid-edit-mode', nonce: NONCE, enabled: true }, { origin: 'https://other.example' });
  assert.notEqual(f.canvas.style.cursor, 'crosshair');
  for (const nonce of [null, {}, 'bad', 'a'.repeat(37)]) {
    f.send({ type: 'mermaid-edit-mode', nonce, enabled: true });
    assert.notEqual(f.canvas.style.cursor, 'crosshair');
  }
  f.mode(); assert.equal(f.canvas.style.cursor, 'crosshair');
  assert.equal(f.pointer('pointerdown').stopped, true);
});

test('bridge maps camera and nonzero SVG viewBox coordinates and replies only to its parent origin', () => {
  const f = fixture(); f.mode();
  f.pointer('pointerdown', { node: { id: 'N01', label: ' First  node\n label ' } });
  f.pointer('pointerup');
  assert.deepEqual(f.messages, [{ origin: ORIGIN, message: { type: 'mermaid-edit-selection', nonce: NONCE,
    target: { kind: 'point', x: .5, y: .5, width: 0, height: 0, view: 'all', nodeId: 'N01', nodeLabel: 'First node label' } } }]);
  assert.equal(f.captures.size, 0);
});

test('empty canvas clicks outside the SVG cannot create clamped edge pins', () => {
  const f = fixture(); f.mode();
  for (const point of [{ x: 240, y: 520 }, { x: 460, y: 520 }, { x: 350, y: 460 }, { x: 350, y: 580 }]) {
    f.pointer('pointerdown', point); f.pointer('pointerup', point);
  }
  assert.equal(f.messages.length, 0);
  assert.equal(f.captures.size, 0);
});

test('region selection clips its end to the graph and keeps both dimensions positive', () => {
  const f = fixture(); f.mode();
  f.pointer('pointerdown');
  f.pointer('pointermove', { x: 500, y: 610 });
  f.pointer('pointerup', { x: 500, y: 610 });
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0].message.target, { kind: 'region', x: .5, y: .5, width: .5, height: .5, view: 'all', nodeId: null, nodeLabel: null });
  assert.equal(f.captures.size, 0);
});

test('straight horizontal and vertical drags cannot create invalid zero-area regions', () => {
  for (const end of [{ x: 390, y: 520 }, { x: 350, y: 540 }]) {
    const f = fixture(); f.mode();
    f.pointer('pointerdown'); f.pointer('pointermove', end); f.pointer('pointerup', end);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].message.target.kind, 'point');
    assert.equal(f.messages[0].message.target.width, 0);
    assert.equal(f.messages[0].message.target.height, 0);
  }
});

test('cancel, mode exit and view changes release pointer capture without emitting a target', () => {
  for (const cancel of [f => f.pointer('pointercancel'), f => f.mode(false), f => f.emit('view', 'change')]) {
    const f = fixture(); f.mode(); f.pointer('pointerdown');
    assert.equal(f.captures.size, 1); cancel(f);
    assert.equal(f.captures.size, 0);
    f.pointer('pointerup'); assert.equal(f.messages.length, 0);
  }
});

test('a secondary touch cancels annotation capture and cannot leak a partial pinch to the diagram', () => {
  const f = fixture(); f.mode(); f.pointer('pointerdown');
  assert.equal(f.pointer('pointerdown', { id: 2, primary: false }).stopped, true);
  assert.equal(f.captures.size, 0);
  assert.equal(f.pointer('pointermove', { id: 2, primary: false, x: 380, y: 540 }).stopped, true);
  assert.equal(f.pointer('pointerup', { id: 2, primary: false, x: 380, y: 540 }).stopped, true);
  f.pointer('pointerup'); assert.equal(f.messages.length, 0);
});

test('pin updates require the current nonce and redraw without observing the SVG subtree', () => {
  const f = fixture(); f.mode(); f.flush();
  assert.equal(f.observers.length, 1);
  assert.equal(f.observers[0].target, f.world);
  assert.deepEqual(f.observers[0].options, { childList: true, attributes: true, attributeFilter: ['style'] });
  const annotation = { kind: 'point', x: .5, y: .5, width: 0, height: 0, view: 'all' };
  f.send({ type: 'mermaid-edit-pins', nonce: 'f087253d-94b9-49b8-857f-9f0f0669b504', annotations: [annotation] });
  f.flush(); assert.equal(f.svg.children[0].children.length, 0);
  f.send({ type: 'mermaid-edit-pins', nonce: NONCE, annotations: [annotation] });
  f.flush(); assert.deepEqual(f.svg.children[0].children.map(child => child.name), ['circle', 'text']);
  assert.equal(f.svg.children[0].attributes['pointer-events'], 'none');
  f.view.value = 'setup'; f.emit('view', 'change'); f.flush();
  assert.equal(f.svg.children[0].children.length, 0, 'pins from another view are hidden');
});

test('bridge leaves a directly opened top-level diagram unchanged', () => {
  const f = fixture({ topLevel: true });
  assert.equal(f.events.size, 0); assert.equal(f.observers.length, 0);
});

test('diagram packaging signs the single bridged script and preserves the original file', async t => {
  const source = new URL('../examples/interactive-diagram.html', import.meta.url);
  let original;
  try { original = await readFile(source); } catch (error) { if (error.code === 'ENOENT') { t.skip('Optional example package is absent.'); return; } throw error; }
  const packaged = await packageDiagram(fileURLToPath(source));
  const html = gunzipSync(Buffer.from(packaged.gzip, 'base64')).toString('utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0][1].includes('installInteractiveEditsBridge'));
  assert.equal(createHash('sha256').update(scripts[0][1].replace(/\r\n?/g, '\n')).digest('base64'), packaged.scriptHash);
  assert.equal(createHash('sha256').update(html).digest('hex'), packaged.sha256);
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), createHash('sha256').update(original).digest('hex'));
});
