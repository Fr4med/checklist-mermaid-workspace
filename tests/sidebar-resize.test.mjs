import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSidebarResize } from '../public/sidebar-resize.mjs';

class Target {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  fire(name, values = {}) {
    const event = { preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false, ...values };
    for (const callback of this.listeners.get(name) || []) callback(event);
    return event;
  }
}

function fixture({ saved, unavailable = false, available = 1400, coarse = false } = {}) {
  const win = new Target();
  const media = new Target();
  win.innerWidth = available;
  let isCoarse = coarse;
  Object.defineProperty(media, 'matches', { get: () => win.innerWidth <= 700 || win.innerWidth <= 1000 && isCoarse });
  win.matchMedia = () => media;
  const frames = new Map();
  let frame = 0;
  win.requestAnimationFrame = callback => { frames.set(++frame, callback); return frame; };
  win.cancelAnimationFrame = id => frames.delete(id);
  win.flush = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
  const writes = [];
  const storage = {
    getItem: () => { if (unavailable) throw new Error('Storage disabled'); return saved ?? null; },
    setItem: (key, value) => { if (unavailable) throw new Error('Storage disabled'); writes.push([key, value]); saved = value; },
  };
  const handle = new Target();
  handle.attributes = new Map();
  handle.setAttribute = (key, value) => handle.attributes.set(key, value);
  handle.focus = () => { handle.focused = true; };
  const captures = new Set();
  handle.setPointerCapture = id => captures.add(id);
  handle.hasPointerCapture = id => captures.has(id);
  handle.releasePointerCapture = id => { captures.delete(id); handle.fire('lostpointercapture', { pointerId: id }); };
  const attributes = new Map();
  const styles = new Map();
  const workspace = {
    getBoundingClientRect: () => ({ width: win.innerWidth }),
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key),
    style: { setProperty: (key, value) => styles.set(key, value) },
  };
  const controller = attachSidebarResize({ workspace, handle, storage, window: win });
  const width = () => Number.parseInt(styles.get('--mermaid-sidebar-width'), 10);
  const pointer = (name, clientX, extra = {}) => handle.fire(name, { pointerId: 1, button: 0, clientX, ...extra });
  const resize = (next, pointerCoarse = isCoarse) => { win.innerWidth = next; isCoarse = pointerCoarse; win.fire('resize'); media.fire('change'); };
  return { win, media, handle, controller, width, pointer, resize, writes, captures, attributes, frames };
}

test('saved width fits the current canvas and returns when space becomes available', () => {
  const f = fixture({ saved: '450', available: 800 });
  assert.equal(f.width(), 380);
  assert.equal(f.handle.attributes.get('aria-valuemax'), '380');
  assert.equal(f.handle.attributes.get('aria-valuenow'), '380');
  f.resize(1400);
  assert.equal(f.width(), 450);
  assert.deepEqual(f.writes, [], 'viewport changes must not overwrite the saved preference');
  f.controller.cleanup();
});

test('keyboard adjustments, limits and reset remain usable when persistence is unavailable', () => {
  const f = fixture({ unavailable: true });
  assert.equal(f.width(), 232);
  assert.equal(f.handle.attributes.get('role'), 'separator');
  assert.equal(f.handle.attributes.get('aria-controls'), 'diagram-library');
  assert.equal(f.handle.tabIndex, 0);
  f.handle.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(f.width(), 272);
  f.handle.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(f.width(), 262);
  f.handle.fire('keydown', { key: 'End' });
  assert.equal(f.width(), 480);
  f.handle.fire('keydown', { key: 'Home' });
  assert.equal(f.width(), 200);
  f.handle.fire('keydown', { key: 'Enter' });
  assert.equal(f.width(), 232);
  assert.equal(f.handle.fire('keydown', { key: 'Tab' }).defaultPrevented, false);
  f.controller.cleanup();
});

test('a captured drag paints once per frame and commits the final pointer position', () => {
  const f = fixture();
  f.pointer('pointerdown', 232);
  assert.equal(f.captures.has(1), true);
  assert.equal(f.handle.focused, true);
  assert.equal(f.attributes.get('data-sidebar-resizing'), 'true');
  f.pointer('pointermove', 300);
  f.pointer('pointermove', 320);
  assert.equal(f.frames.size, 1);
  assert.equal(f.width(), 232);
  f.win.flush();
  assert.equal(f.width(), 320);
  f.pointer('pointerup', 350);
  assert.equal(f.width(), 350);
  assert.deepEqual(f.writes, [['mermaid.sidebarWidth', '350']]);
  assert.equal(f.captures.size, 0);
  assert.equal(f.attributes.has('data-sidebar-resizing'), false);
  f.controller.cleanup();
});

test('cancelled or lost gestures restore the saved width and never persist a partial drag', () => {
  for (const cancel of [
    f => f.pointer('pointercancel', 400),
    f => f.pointer('lostpointercapture', 400),
    f => f.win.fire('blur'),
  ]) {
    const f = fixture({ saved: '280' });
    f.pointer('pointerdown', 280);
    f.pointer('pointermove', 400);
    f.win.flush();
    assert.equal(f.width(), 400);
    cancel(f);
    assert.equal(f.width(), 280);
    assert.equal(f.frames.size, 0);
    assert.deepEqual(f.writes, []);
    assert.equal(f.attributes.has('data-sidebar-resizing'), false);
    f.pointer('pointerup', 450);
    assert.equal(f.width(), 280, 'a stale pointerup must not commit after cancellation');
    f.controller.cleanup();
  }
});

test('entering phone or coarse-tablet layout cancels drag and keeps it out of the focus order', () => {
  const f = fixture({ saved: '300' });
  f.pointer('pointerdown', 300);
  f.pointer('pointermove', 450);
  f.resize(390);
  assert.equal(f.handle.hidden, true);
  assert.equal(f.handle.tabIndex, -1);
  assert.equal(f.captures.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.handle.fire('keydown', { key: 'End' }).defaultPrevented, false);
  f.pointer('pointerdown', 200);
  assert.equal(f.captures.size, 0);
  f.resize(1400);
  assert.equal(f.width(), 300);
  assert.equal(f.handle.hidden, false);
  f.resize(900, true);
  assert.equal(f.handle.hidden, true);
  assert.deepEqual(f.writes, []);
  f.controller.cleanup();
});

test('non-primary pointers do not interfere and cleanup removes active work and listeners', () => {
  const f = fixture();
  f.pointer('pointerdown', 232, { button: 2 });
  assert.equal(f.captures.size, 0);
  f.pointer('pointerdown', 232, { isPrimary: false });
  assert.equal(f.captures.size, 0);
  f.pointer('pointerdown', 232);
  f.pointer('pointermove', 400, { pointerId: 2 });
  assert.equal(f.frames.size, 0);
  f.pointer('pointermove', 400);
  assert.equal(f.frames.size, 1);
  f.controller.cleanup();
  assert.equal(f.frames.size, 0);
  assert.equal(f.captures.size, 0);
  f.handle.fire('keydown', { key: 'End' });
  f.pointer('pointerup', 400);
  f.win.flush();
  assert.equal(f.width(), 232);
  assert.deepEqual(f.writes, []);
  assert.equal([...f.handle.listeners.values(), ...f.win.listeners.values(), ...f.media.listeners.values()].every(listeners => listeners.size === 0), true);
});

test('double-click and explicit reset replace the saved width with the default', () => {
  const f = fixture({ saved: '420' });
  f.handle.fire('dblclick');
  assert.equal(f.width(), 232);
  assert.deepEqual(f.writes, [['mermaid.sidebarWidth', '232']]);
  f.handle.fire('keydown', { key: 'End' });
  f.controller.reset();
  assert.equal(f.width(), 232);
  assert.equal(f.writes.at(-1)[1], '232');
  f.controller.cleanup();
});
