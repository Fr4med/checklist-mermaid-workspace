import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Exercise the real refresh coordinator and its response application, replacing
// network and DOM effects so the response order is under test control.
const source = readFileSync(new URL('../public/mermaid.js', import.meta.url), 'utf8');
const begin = source.indexOf('function refreshLibrary(');
const end = source.indexOf('\nasync function openDiagram(', begin);
assert.ok(begin >= 0 && end > begin, 'Mermaid library refresh functions are available');
const refreshSource = source.slice(begin, end);
const initial = { id: 'demo', title: 'Demo', revision: 1, projectKey: null, projectName: null, isTest: false, libraryRevision: 0 };
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const calls = [];
  const elements = new Map();
  const context = createContext({
    AbortController, URLSearchParams,
    location: { hash: '#diagram=demo' }, document: { title: 'Demo' },
    stage: { firstElementChild: {} },
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
    request: (path, options) => new Promise((resolve, reject) => { calls.push({ path, options, resolve, reject }); }),
    initial,
  });
  runInContext(`
    let libraryRefreshPromise = null;
    let libraryRequest = null;
    let diagrams = [{ ...initial }];
    let selected = { ...initial };
    const diagramId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    function notice() {}
    function message() {}
    function renderLibrary() {}
    function clearPreview() { stage.firstElementChild = null; }
    function showAuth() { diagrams = []; selected = null; }
    async function openDiagram(id) { selected = diagrams.find(item => item.id === id); }
    ${refreshSource}
    globalThis.refresh = refreshLibrary;
    globalThis.abortRefresh = () => { libraryRequest?.abort(); diagrams = []; selected = null; };
    globalThis.state = () => JSON.stringify({ diagrams, selected, loading: Boolean(libraryRequest), refreshing: Boolean(libraryRefreshPromise) });
  `, context);
  return { calls, context, state: () => JSON.parse(context.state()) };
}

test('post-delete refresh waits for a delayed pre-write GET and confirms deletion with a fresh GET', async () => {
  const { calls, context, state } = fixture();
  const before = context.refresh();
  assert.equal(context.refresh(), before, 'ordinary concurrent readers share their GET');
  let confirmed = false;
  const after = context.refresh({ afterWrite: true }).then(() => { confirmed = true; });
  assert.equal(calls.length, 1);
  calls[0].resolve({ diagrams: [initial] });
  await before; await turn();
  assert.equal(calls.length, 2, 'the pre-delete result cannot confirm deletion');
  assert.equal(confirmed, false);
  calls[1].resolve({ diagrams: [] });
  await after;
  assert.equal(confirmed, true);
  assert.equal(state().diagrams.length, 0);
  assert.equal(state().selected, null);
  assert.equal(state().refreshing, false);
});

test('post-organization refresh retains the fresh project and test state rather than the older response', async () => {
  const { calls, context, state } = fixture();
  const before = context.refresh();
  const after = context.refresh({ afterWrite: true });
  calls[0].resolve({ diagrams: [initial] });
  await before; await turn();
  assert.equal(calls.length, 2);
  calls[1].resolve({ diagrams: [{ ...initial, projectKey: 'studio', projectName: 'Studio', isTest: true, libraryRevision: 1 }] });
  await after;
  assert.equal(state().selected.projectName, 'Studio');
  assert.equal(state().selected.isTest, true);
  assert.equal(state().selected.libraryRevision, 1);
  assert.equal(state().selected.revision, 1, 'organization does not change the source baseline');
});

test('an aborted library read cannot repopulate the signed-out UI even if its response arrives', async () => {
  const { calls, context, state } = fixture();
  const refresh = context.refresh();
  context.abortRefresh();
  assert.equal(calls[0].options.signal.aborted, true);
  calls[0].resolve({ diagrams: [initial] });
  await refresh;
  assert.equal(state().diagrams.length, 0);
  assert.equal(state().selected, null);
  assert.equal(state().loading, false);
  assert.equal(state().refreshing, false);
});
