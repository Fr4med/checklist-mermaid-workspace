import test from 'node:test';
import assert from 'node:assert/strict';
import { createChangeComposer } from '../public/change-composer.mjs';

const CHAT_A = '867523d0-69d3-4e99-8198-7bbb32063e1f';
const CHAT_B = '6b0236bc-558b-48a9-814a-fb97a18a6722';
const CHAT_C = '8fc0de98-d20e-40ca-8fb2-2d74c12d124a';
const link = id => `codex://threads/${id}`;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// A small DOM facade exercises the real event handlers without a browser or dependencies.
class Element {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.open = false;
    this.children = [];
    this.navigations = [];
  }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  dispatch(name, values = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    const pending = [];
    for (const listener of this.listeners.get(name) || []) pending.push(listener(event));
    return { event, done: Promise.all(pending) };
  }
  async fire(name, values) { const result = this.dispatch(name, values); await result.done; return result.event; }
  async click() {
    if (this.disabled) return null;
    const result = this.dispatch('click');
    if (!result.event.defaultPrevented && this.hasAttribute('href')) this.navigations.push(this.href);
    await result.done;
    return result.event;
  }
  async input(value) {
    if (this.readOnly || this.disabled) return false;
    this.value = value;
    await this.fire('input');
    return true;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  set href(value) { this.setAttribute('href', value); }
  get href() { return this.getAttribute('href') || ''; }
  append(child) { this.children.push(child); }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selected = true; }
  showModal() { this.open = true; }
  close() { if (this.open) { this.open = false; void this.fire('close'); } }
  set innerHTML(value) {
    this.source = value;
    this.nodes = new Map();
    for (const selector of ['form', '#change-instruction', '#change-chat', '#change-output', '.change-feedback', '.change-open', '.change-close', '.change-copy', '.change-submit', '.change-context', '.change-quote', '.change-destination-help', 'details']) this.nodes.set(selector, new Element(this.ownerDocument));
  }
  querySelector(selector) {
    const node = this.nodes.get(selector);
    assert.ok(node, `Unexpected selector in the DOM facade: ${selector}`);
    return node;
  }
}

async function fixture(t, { saveOrigin, clipboard, scope = 'project', origin = CHAT_A } = {}) {
  const document = { createElement: () => new Element(document) };
  document.body = new Element(document);
  const globalDescriptors = new Map(['document', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const copies = [], saves = [];
  const holder = { current: { id: 'project-one', revision: 7, projectKey: 'project-group', projectName: 'Actual project', name: 'Actual project', scope, chatId: scope === 'chat' ? CHAT_A : null, chatTitle: scope === 'chat' ? 'Original chat' : null, originChatId: origin, archivedAt: null } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { copies.push(text); return clipboard?.(text); } } } });
  t.after(() => {
    for (const [name, descriptor] of globalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let closed = 0;
  const composer = createChangeComposer({
    getCurrent: () => holder.current,
    saveOrigin: async (project, id) => {
      saves.push({ project: { ...project }, id });
      if (saveOrigin) await saveOrigin(project, id, holder);
      else holder.current = { ...project, revision: project.revision + 1, originChatId: id };
    },
    onClose: () => closed++,
  });
  const dialog = document.body.children[0];
  const ui = {
    form: dialog.querySelector('form'),
    instruction: dialog.querySelector('#change-instruction'),
    destination: dialog.querySelector('#change-chat'),
    output: dialog.querySelector('#change-output'),
    feedback: dialog.querySelector('.change-feedback'),
    open: dialog.querySelector('.change-open'),
    copy: dialog.querySelector('.change-copy'),
    submit: dialog.querySelector('.change-submit'),
    close: dialog.querySelector('.change-close'),
    details: dialog.querySelector('details'),
  };
  const snapshot = { ...holder.current, projectId: holder.current.id, checklistName: 'Actual checklist', quote: 'Make this checkpoint specific.', taskIds: ['task-one-123'] };
  composer.open(snapshot);
  await ui.instruction.input('Name the exact report and completion check.');
  return { composer, dialog, ui, snapshot, holder, saves, copies, document, get closed() { return closed; }, submit: () => ui.form.fire('submit') };
}

test('a confirmed archive, project switch, scope change, or original chat change blocks sending the preserved quote', async t => {
  const mutations = [
    current => ({ ...current, archivedAt: '2026-10-18T12:00:00Z', revision: 8 }),
    current => ({ ...current, id: 'another-project', revision: 8 }),
    current => ({ ...current, scope: 'chat', chatId: CHAT_A, revision: 8 }),
    current => ({ ...current, originChatId: CHAT_B, revision: 8 }),
    () => null,
  ];
  for (const mutate of mutations) await t.test(String(mutate), async sub => {
    const f = await fixture(sub);
    f.holder.current = mutate(f.holder.current);
    await f.submit();
    assert.equal(f.copies.length, 0);
    assert.equal(f.saves.length, 0);
    assert.deepEqual(f.ui.open.navigations, []);
    assert.match(f.ui.feedback.textContent, /no longer active|linked chat changed/);
    const manualOpen = await f.ui.open.click();
    assert.equal(manualOpen.defaultPrevented, true);
    assert.deepEqual(f.ui.open.navigations, []);
    assert.equal(f.snapshot.quote, 'Make this checkpoint specific.');
  });
});

test('an explicit new project origin uses the latest revision while keeping the selected quote revision in its request', async t => {
  const f = await fixture(t);
  f.holder.current = { ...f.holder.current, revision: 9 };
  await f.ui.destination.input(link(CHAT_B));
  await f.submit();
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].project.revision, 9);
  assert.equal(f.saves[0].id, CHAT_B);
  assert.equal(f.holder.current.originChatId, CHAT_B);
  assert.match(f.copies[0], /Source revision when selected: 7/);
  assert.match(f.copies[0], /> Make this checkpoint specific\./);
  assert.deepEqual(f.ui.open.navigations, [link(CHAT_B)]);
});

test('saving a destination freezes the form and manual launch until its captured request is ready', async t => {
  const save = deferred();
  const f = await fixture(t, { saveOrigin: async (project, id, holder) => { await save.promise; holder.current = { ...project, revision: 8, originChatId: id }; } });
  await f.ui.destination.input(link(CHAT_B));
  const sending = f.submit();
  assert.equal(f.ui.instruction.readOnly, true);
  assert.equal(f.ui.destination.readOnly, true);
  assert.equal(f.ui.copy.disabled, true);
  assert.equal(f.ui.submit.disabled, true);
  assert.equal(f.ui.close.disabled, true);
  assert.equal(f.ui.open.getAttribute('aria-disabled'), 'true');
  assert.equal(await f.ui.destination.input(link(CHAT_C)), false);
  assert.equal(await f.ui.instruction.input('Replace with a different request.'), false);
  assert.equal((await f.ui.open.click()).defaultPrevented, true);
  assert.deepEqual(f.ui.open.navigations, []);
  await f.submit();
  assert.equal(f.saves.length, 1, 'a second submit cannot repeat a pending save');
  save.resolve();
  await sending;
  assert.equal(f.ui.instruction.readOnly, false);
  assert.equal(f.ui.destination.readOnly, false);
  assert.equal(f.ui.copy.disabled, false);
  assert.equal(f.ui.submit.disabled, false);
  assert.match(f.copies[0], /Name the exact report and completion check/);
  assert.doesNotMatch(f.copies[0], /different request/);
  assert.deepEqual(f.ui.open.navigations, [link(CHAT_B)]);
});

test('forced close during an origin save invalidates its callback before clipboard or native launch', async t => {
  const save = deferred();
  const f = await fixture(t, { saveOrigin: async () => save.promise });
  await f.ui.destination.input(link(CHAT_B));
  const sending = f.submit();
  f.holder.current = null;
  f.composer.close();
  assert.equal(f.composer.isOpen(), false);
  assert.equal(f.closed, 1);
  save.resolve();
  await sending;
  assert.equal(f.copies.length, 0);
  assert.deepEqual(f.ui.open.navigations, []);
  assert.equal(f.ui.output.value, '');
});

test('a newer authoritative archive or destination survives a delayed origin-save response', async t => {
  for (const change of ['archive', 'origin']) await t.test(change, async sub => {
    const save = deferred();
    const f = await fixture(sub, { saveOrigin: async () => save.promise });
    await f.ui.destination.input(link(CHAT_B));
    const sending = f.submit();
    assert.equal(f.saves[0].project.revision, 7);
    f.holder.current = { ...f.holder.current, revision: 9, ...(change === 'archive' ? { originChatId: CHAT_B, archivedAt: '2026-10-18T12:00:00Z' } : { originChatId: CHAT_C }) };
    // The host retains its newer revision when an earlier identity response arrives.
    save.resolve({ revision: 8, originChatId: CHAT_B, archivedAt: null });
    await sending;
    assert.equal(f.copies.length, 0);
    assert.deepEqual(f.ui.open.navigations, []);
    assert.match(f.ui.feedback.textContent, /no longer active|linked chat changed/);
  });
});

test('authentication loss or forced close during clipboard writing never launches a chat', async t => {
  for (const forceClose of [false, true]) await t.test(`forced close: ${forceClose}`, async sub => {
    const clipboard = deferred();
    const f = await fixture(sub, { clipboard: () => clipboard.promise });
    const sending = f.submit();
    assert.equal(f.copies.length, 1);
    f.holder.current = null;
    if (forceClose) f.composer.close();
    clipboard.resolve();
    await sending;
    assert.deepEqual(f.ui.open.navigations, []);
    if (!forceClose) assert.match(f.ui.feedback.textContent, /no longer active/);
  });
});

test('an archive or reroute discovered during clipboard writing prevents launch', async t => {
  for (const change of ['archive', 'origin']) await t.test(change, async sub => {
    const clipboard = deferred();
    const f = await fixture(sub, { clipboard: () => clipboard.promise });
    const sending = f.submit();
    f.holder.current = { ...f.holder.current, revision: 8, ...(change === 'archive' ? { archivedAt: '2026-10-18T12:00:00Z' } : { originChatId: CHAT_B }) };
    clipboard.resolve();
    await sending;
    assert.deepEqual(f.ui.open.navigations, []);
    assert.match(f.ui.feedback.textContent, /no longer active|linked chat changed/);
    assert.equal(f.ui.instruction.readOnly, false);
  });
});

test('clipboard rejection preserves a selected manual-copy request and allows a separate verified chat launch', async t => {
  const f = await fixture(t, { clipboard: () => Promise.reject(new Error('Clipboard denied.')) });
  await f.submit();
  assert.equal(f.ui.details.open, true);
  assert.equal(f.ui.output.selected, true);
  assert.equal(f.document.activeElement, f.ui.output);
  assert.match(f.ui.output.value, /Name the exact report and completion check/);
  assert.match(f.ui.feedback.textContent, /Ctrl\+C/);
  assert.deepEqual(f.ui.open.navigations, []);
  assert.equal(f.ui.copy.disabled, false);
  assert.equal(f.ui.submit.disabled, false);
  assert.equal((await f.ui.open.click()).defaultPrevented, false);
  assert.deepEqual(f.ui.open.navigations, [link(CHAT_A)]);
});

test('a clipboard rejection after forced close cannot overwrite or focus a newly opened request', async t => {
  const clipboard = deferred();
  const f = await fixture(t, { clipboard: () => clipboard.promise });
  const sending = f.submit();
  assert.equal(f.copies.length, 1);
  f.composer.close();
  f.holder.current = { ...f.holder.current, id: 'project-two', revision: 4, projectName: 'Second project', originChatId: CHAT_B };
  f.composer.open({ ...f.snapshot, projectId: 'project-two', revision: 4, projectName: 'Second project', checklistName: 'Second checklist', quote: 'A separate selected passage.', originChatId: CHAT_B });
  await f.ui.instruction.input('Change only the second checklist.');
  const newOutput = f.ui.output.value;
  const newFocus = f.document.activeElement;
  clipboard.reject(new Error('Delayed clipboard permission failure.'));
  await sending;
  assert.equal(f.ui.output.value, newOutput);
  assert.equal(f.ui.details.open, false);
  assert.equal(f.document.activeElement, newFocus);
  assert.equal(f.ui.instruction.readOnly, false);
  assert.equal(f.ui.destination.value, link(CHAT_B));
  assert.deepEqual(f.ui.open.navigations, []);
});

test('chat-scoped destinations stay read-only after sending and never save a separate origin', async t => {
  const f = await fixture(t, { scope: 'chat', origin: CHAT_B });
  assert.equal(f.ui.destination.value, link(CHAT_A));
  assert.equal(f.ui.destination.readOnly, true);
  await f.submit();
  assert.equal(f.saves.length, 0);
  assert.deepEqual(f.ui.open.navigations, [link(CHAT_A)]);
  assert.equal(f.ui.destination.readOnly, true);
});
