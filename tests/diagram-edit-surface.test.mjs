import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSvgEditSurface } from '../public/diagram-edits.mjs';

class Element {
  constructor() { this.children = []; this.style = {}; this.events = new Map(); this.capture = new Set(); this.classList = { toggle() {} }; }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  remove() { this.removed = true; }
  getBoundingClientRect() { return { left: 10, top: 30 }; }
  setPointerCapture(id) { this.capture.add(id); }
  releasePointerCapture(id) { this.capture.delete(id); }
  hasPointerCapture(id) { return this.capture.has(id); }
  addEventListener(type, callback, options = {}) { const list = this.events.get(type) || []; list.push({ callback, capture: options.capture === true }); this.events.set(type, list); }
  send(type, options = {}) {
    const event = { type, pointerId: 1, isPrimary: true, button: 0, clientX: 250, clientY: 150, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...options };
    for (const listener of [...(this.events.get(type) || [])].sort((a,b) => Number(b.capture) - Number(a.capture))) { listener.callback(event); if (event.stopped) break; }
    return event;
  }
}

function fixture(t) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const viewport = new Element();
  const image = { naturalWidth: 200, naturalHeight: 100 };
  const transform = { scale: 2, x: 40, y: 20 };
  let repaint;
  const camera = { getTransform: () => transform, onPaint: callback => { repaint = callback; } };
  const targets = [];
  const controller = { selectTarget: value => targets.push(value) };
  const abort = new AbortController();
  const adapter = attachSvgEditSurface({ viewport, image, camera, controller, signal: abort.signal });
  adapter.setMode(true);
  return { viewport, targets, transform, adapter, abort, repaint: () => repaint() };
}

test('SVG point coordinates account for viewport offset, letterboxing and camera zoom', t => {
  const { viewport, targets } = fixture(t);
  viewport.send('pointerdown'); viewport.send('pointerup');
  assert.deepEqual(targets, [{ kind: 'point', x: .5, y: .5, width: 0, height: 0, view: 'all', nodeId: null, nodeLabel: null }]);
  assert.equal(viewport.capture.size, 0);
});

test('SVG region gestures preserve normalized bounds and horizontal drags never become point comments', t => {
  const { viewport, targets } = fixture(t);
  viewport.send('pointerdown', { clientX: 150, clientY: 100 });
  viewport.send('pointermove', { clientX: 350, clientY: 200 });
  viewport.send('pointerup', { clientX: 350, clientY: 200 });
  assert.deepEqual(targets, [{ kind: 'region', x: .25, y: .25, width: .5, height: .5, view: 'all', nodeId: null, nodeLabel: null }]);
  viewport.send('pointerdown', { clientX: 150, clientY: 100 });
  viewport.send('pointermove', { clientX: 350, clientY: 100 });
  viewport.send('pointerup', { clientX: 350, clientY: 100 });
  assert.equal(targets.length, 1);
});

test('SVG pins follow camera changes instead of staying at old screen coordinates', t => {
  const { viewport, transform, adapter, repaint } = fixture(t);
  adapter.setAnnotations([{ kind: 'point', x: .5, y: .5, width: 0, height: 0 }]);
  let pin = viewport.children[0].children[0];
  assert.equal(pin.style.left, '240px'); assert.equal(pin.style.top, '120px');
  transform.scale = 3; transform.x = -10; transform.y = 15; repaint();
  pin = viewport.children[0].children[0];
  assert.equal(pin.style.left, '290px'); assert.equal(pin.style.top, '165px');
});

test('secondary touch cancels annotation capture and never leaks into normal pan handlers', t => {
  const { viewport, targets } = fixture(t);
  let underlyingPanEvents = 0;
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) viewport.addEventListener(type, () => { underlyingPanEvents++; });
  viewport.send('pointerdown');
  assert.equal(viewport.capture.size, 1);
  viewport.send('pointerdown', { pointerId: 2, isPrimary: false });
  assert.equal(viewport.capture.size, 0);
  viewport.send('pointermove', { pointerId: 2, isPrimary: false, clientX: 300 });
  viewport.send('pointerup', { pointerId: 2, isPrimary: false });
  viewport.send('pointerup');
  assert.equal(targets.length, 0);
  assert.equal(underlyingPanEvents, 0);
});

test('mode exit releases capture and outside-image clicks do not invent a diagram point', t => {
  const { viewport, targets, adapter, abort } = fixture(t);
  viewport.send('pointerdown', { clientX: 20, clientY: 35 }); viewport.send('pointerup', { clientX: 20, clientY: 35 });
  assert.equal(targets.length, 0);
  viewport.send('pointerdown'); adapter.setMode(false);
  assert.equal(viewport.capture.size, 0);
  abort.abort(); assert.equal(viewport.children[0].removed, true);
});
