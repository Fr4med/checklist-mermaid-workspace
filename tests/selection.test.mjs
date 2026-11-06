import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionActions } from '../public/selection.mjs';

class Target {
  listeners = new Map();
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  fire(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener(event); }
}

function fixture() {
  const window = new Target();
  window.innerWidth = 800;
  window.innerHeight = 600;
  window.frames = new Map();
  let nextFrame = 0;
  window.requestAnimationFrame = callback => { window.frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = frame => window.frames.delete(frame);
  window.flush = () => { const frames = [...window.frames.values()]; window.frames.clear(); for (const callback of frames) callback(); };
  window.MutationObserver = class {
    constructor(callback) { this.callback = callback; window.observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const document = new Target();
  document.defaultView = window;
  class Element extends Target {
    children = [];
    style = {};
    dataset = {};
    hidden = false;
    attributes = {};
    append(child) { this.children.push(child); child.parent = this; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    focus() { document.activeElement = this; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getBoundingClientRect() { return { width: 100, height: 32 }; }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  }
  document.createElement = () => new Element();
  document.body = new Element();
  document.activeElement = document.body;
  document.getSelection = () => selection;
  const textNode = {};
  const outside = {};
  const rows = [
    { dataset: { taskId: 'task-one' } },
    { dataset: { taskId: 'task-two' } },
    { dataset: { taskId: 'task-two' } },
    { dataset: { taskId: 'task-hidden' }, hidden: true },
  ];
  const root = {
    ownerDocument: document,
    isConnected: true,
    contains(node) { return node === this || node === textNode; },
    querySelectorAll(selector) { assert.equal(selector, '.task-row[data-task-id]'); return rows; },
  };
  const range = {
    startContainer: textNode,
    startOffset: 0,
    endContainer: textNode,
    endOffset: 30,
    collapsed: false,
    text: 'Explain this specific checkpoint.',
    rects: [{ left: 770, right: 790, top: 3, bottom: 23, width: 20, height: 20 }],
    toString() { return this.text; },
    cloneRange() { return { ...this }; },
    intersectsNode(node) { return rows.includes(node); },
    getClientRects() { return range.rects; },
  };
  const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range, toString: () => range.toString() };
  const context = { id: 'project-one', revision: 7, projectName: 'A project', checklistName: 'A specific chat', scope: 'chat', chatId: 'chat-one', chatTitle: 'Plan the work', originChatId: 'ignored-project-origin' };
  const received = [];
  const actions = createSelectionActions({ root, getContext: () => context, onAdd: value => received.push(value) });
  const toolbar = document.body.children[0];
  const button = toolbar.children[0];
  const select = () => { document.fire('selectionchange'); window.flush(); };
  return { actions, window, document, root, textNode, outside, rows, range, selection, context, received, toolbar, button, select };
}

test('keyboard selection produces an immutable quote with task and chat identity', () => {
  const f = fixture();
  assert.equal(f.actions.hasSelection(), true, 'refresh can preserve a selection before its toolbar frame');
  f.select();
  assert.equal(f.toolbar.hidden, false);
  assert.equal(f.button.textContent, 'Add to chat');
  f.button.fire('click');
  assert.deepEqual(f.received[0], {
    quote: 'Explain this specific checkpoint.', taskIds: ['task-one', 'task-two'],
    projectId: 'project-one', revision: 7, projectName: 'A project', checklistName: 'A specific chat',
    scope: 'chat', chatId: 'chat-one', chatTitle: 'Plan the work', originChatId: 'chat-one',
  });
  assert.equal(Object.isFrozen(f.received[0]), true);
  assert.equal(Object.isFrozen(f.received[0].taskIds), true);
  f.context.projectName = 'Changed later';
  assert.equal(f.received[0].projectName, 'A project');
  assert.equal(f.toolbar.hidden, true);
  assert.equal(f.actions.hasSelection(), false);
  f.button.fire('click');
  assert.equal(f.received.length, 1, 'a second click cannot add the same stale snapshot');
});

test('toolbar stays inside the viewport and repositions on scroll', () => {
  const f = fixture();
  f.select();
  assert.equal(f.toolbar.style.left, '692px');
  assert.equal(f.toolbar.style.top, '30px');
  f.range.rects = [{ left: 20, right: 140, top: 200, bottom: 220, width: 120, height: 20 }];
  f.window.fire('scroll');
  f.window.flush();
  assert.equal(f.toolbar.style.left, '20px');
  assert.equal(f.toolbar.style.top, '161px');
  f.range.rects = [{ left: 20, right: 140, top: -100, bottom: -80, width: 120, height: 20 }];
  f.window.fire('scroll');
  f.window.flush();
  assert.equal(f.toolbar.hidden, true);
});

test('Escape dismisses the toolbar without clearing the native text selection', () => {
  const f = fixture();
  f.select();
  let prevented = false;
  f.document.fire('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.toolbar.hidden, true);
  assert.equal(f.selection.isCollapsed, false);
  f.select();
  assert.equal(f.toolbar.hidden, true, 'unchanged selection stays dismissed');
  f.range.endOffset++;
  f.select();
  assert.equal(f.toolbar.hidden, false, 'a new selection can open the toolbar');
});

test('outside, empty, disconnected, and archived selections produce no action', () => {
  for (const change of [
    f => { f.range.endContainer = f.outside; },
    f => { f.range.text = '   '; },
    f => { f.selection.isCollapsed = true; },
    f => { f.selection.rangeCount = 2; },
    f => { f.root.isConnected = false; },
    f => { f.context.connected = false; },
    f => { f.context.disconnected = true; },
    f => { f.context.archivedAt = '2026-10-18'; },
    f => { f.context.revision = undefined; },
  ]) {
    const f = fixture();
    change(f);
    f.select();
    assert.equal(f.toolbar.hidden, true);
    assert.equal(f.actions.hasSelection(), false);
    f.button.fire('click');
    assert.equal(f.received.length, 0);
  }
});

test('a changed project or revision cannot relabel or send an old selection', () => {
  for (const field of ['id', 'revision', 'chatId', 'originChatId']) {
    const f = fixture();
    f.context.scope = 'project';
    f.select();
    f.context[field] = field === 'revision' ? 8 : 'new-value';
    assert.equal(f.actions.hasSelection(), false);
    f.select();
    f.button.fire('click');
    assert.equal(f.received.length, 0);
    assert.equal(f.toolbar.hidden, true);
  }
});

test('oversized quotes show an explicit shorter-selection prompt and cannot be added', () => {
  const f = fixture();
  f.range.text = 'x'.repeat(8001);
  f.select();
  assert.equal(f.toolbar.hidden, false);
  assert.equal(f.button.disabled, true);
  assert.equal(f.button.textContent, 'Select less text');
  assert.match(f.button.title, /longer than 8,000/);
  f.button.fire('click');
  assert.equal(f.received.length, 0);
  f.range.endOffset++;
  f.range.text = 'x'.repeat(8000);
  f.select();
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.textContent, 'Add to chat');
  f.button.fire('click');
  assert.equal(f.received[0].quote.length, 8000);
});

test('accepted quotation is exact and HTML-like content is kept as text', () => {
  const f = fixture();
  f.range.text = '  <img onerror=alert(1)>\n😀  ';
  f.select();
  f.button.fire('click');
  assert.equal(f.received[0].quote, f.range.text);
  assert.equal(f.toolbar.children.length, 1);
});

test('Tab reaches Add to chat and keeps the snapshot if focus collapses native selection', () => {
  const f = fixture();
  f.select();
  let prevented = false;
  f.document.fire('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.document.activeElement, f.button);
  f.selection.isCollapsed = true;
  f.select();
  assert.equal(f.toolbar.hidden, false);
  assert.equal(f.actions.hasSelection(), true);
  f.button.fire('click');
  assert.equal(f.received[0].quote, f.range.text);
  assert.equal(f.toolbar.hidden, true);
});

test('toolbar focus cannot retain a quote after a different selection is made outside the checklist', () => {
  const f = fixture();
  f.select();
  f.button.focus();
  f.range.endContainer = f.outside;
  f.select();
  assert.equal(f.toolbar.hidden, true);
  assert.equal(f.actions.hasSelection(), false);
  f.button.fire('click');
  assert.equal(f.received.length, 0);
});

test('click preserves selection, and destroy removes event hooks and pending work', () => {
  const f = fixture();
  let prevented = false;
  f.button.fire('pointerdown', { button: 0, isPrimary: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  f.document.fire('selectionchange');
  f.actions.destroy();
  f.actions.destroy();
  f.window.flush();
  assert.equal(f.document.body.children.length, 0);
  assert.equal(f.window.observer.disconnected, true);
  assert.equal(f.actions.hasSelection(), false);
  assert.equal([...f.document.listeners.values()].every(listeners => listeners.size === 0), true);
  assert.equal([...f.window.listeners.values()].every(listeners => listeners.size === 0), true);
});
