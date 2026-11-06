import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import worker from '../src/worker.mjs';
import { interactiveDiagram } from '../src/assets.mjs';
import { parseTasks, ensureTaskIds, effectiveMarkdown } from '../src/tasks.mjs';

const ORIGIN = 'https://checklist.example';
const ADMIN = 'local-test-administrator-key-' + 'a'.repeat(48);
const TASK = 'task_alpha_123';
const SOURCE = 'source-test-123';
const MARKDOWN = `# First project\n\n- [ ] Keep the original task <!-- checklist:${TASK} -->\n`;

// Executes the production SQL against real SQLite, exposing only the D1 calls used here.
class LocalD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); for (const file of ['0001_initial.sql', '0002_hierarchy_archive.sql', '0003_origin_chat.sql', '0004_mermaid.sql', '0005_password.sql', '0006_diagram_edits.sql']) this.db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')); }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    const bound = args => ({
      all: async () => ({ results: statement.all(...args), success: true }),
      run: async () => ({ success: true, meta: { changes: statement.run(...args).changes } }),
      _run: () => ({ success: true, meta: { changes: statement.run(...args).changes } })
    });
    return { ...bound([]), bind: (...args) => bound(args) };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const results = statements.map(statement => statement._run()); this.db.exec('COMMIT'); return results; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

function setup(t) {
  const DB = new LocalD1(); t.after(() => DB.close());
  const env = { DB, ADMIN_KEY: ADMIN, PASSWORD_PEPPER: 'local-test-password-pepper-' + 'p'.repeat(48) };
  async function request(path, { method = 'GET', data, token, cookie, origin, raw, headers = {} } = {}) {
    if (token) headers.Authorization = `Bearer ${token}`;
    if (path === '/api/password' && method === 'PUT' && token && origin === undefined) headers.Origin = ORIGIN;
    if (cookie) headers.Cookie = cookie;
    if (origin !== undefined) headers.Origin = origin;
    if (data !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: raw ?? (data === undefined ? undefined : JSON.stringify(data)) }), env);
    const value = method !== 'HEAD' && response.headers.get('Content-Type')?.startsWith('application/json') ? await response.json() : await response.text();
    return { response, value, status: response.status };
  }
  async function create(id = 'project-one', markdown = MARKDOWN, metadata = {}) {
    const result = await request('/api/projects', { method: 'POST', token: ADMIN, data: { id, name: id, sourceId: SOURCE, markdown, ...metadata } });
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return result.value;
  }
  async function login() {
    const result = await request('/api/session', { method: 'POST', origin: ORIGIN, data: { key: ADMIN } });
    assert.equal(result.status, 200);
    return result.response.headers.get('Set-Cookie').split(';')[0];
  }
  return { DB, env, request, create, login };
}

test('diagram requires the owner session or owner key and retains isolation headers', async t => {
  const { request, create, login } = setup(t);
  const path = '/diagram/interactive-example';
  for (const method of ['GET', 'HEAD']) {
    const denied = await request(path, { method });
    assert.equal(denied.status, 401);
    assert.equal(denied.response.headers.get('Cache-Control'), 'no-store');
  }
  const { token } = await create();
  assert.equal((await request(path, { token })).status, 403);
  const cookie = await login();
  const head = await request(path, { method: 'HEAD', cookie });
  if (!interactiveDiagram) { assert.equal(head.status, 404); return; }
  assert.equal(head.status, 200);
  assert.equal(head.value, '');
  assert.equal(head.response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  const csp = head.response.headers.get('Content-Security-Policy');
  assert.ok(csp.includes(`script-src 'sha256-${interactiveDiagram.scriptHash}'`));
  assert.match(csp, /frame-ancestors 'self'; sandbox allow-scripts$/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.equal(head.response.headers.get('Cache-Control'), 'no-store');
  const owner = await request(path, { cookie });
  assert.equal(owner.status, 200);
  assert.equal(createHash('sha256').update(owner.value).digest('hex'), interactiveDiagram.sha256);
  assert.equal((await request(path, { method: 'POST', cookie })).status, 405);
  assert.equal((await request('/')).response.headers.get('X-Frame-Options'), 'DENY');
  await request('/api/session', { method: 'DELETE', cookie, origin: ORIGIN });
  assert.equal((await request(path, { cookie })).status, 401);
});

const diagramSource = 'flowchart TD\n  A[First] --> B[Second]\n';
const diagramSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const diagramInput = { title: 'Independent flow', source: diagramSource, svg: diagramSvg, baseRevision: 0 };

test('Mermaid has a private library independent of checklist registration and archive', async t => {
  const { request, create, login } = setup(t);
  const index = '/api/diagrams';
  const entry = `${index}/independent-flow`;
  const preview = '/diagram/independent-flow';
  const initial = (await request(index, { token: ADMIN })).value.diagrams;
  assert.deepEqual(initial.map(diagram => diagram.id), interactiveDiagram ? ['interactive-example'] : []);
  if (interactiveDiagram) {
    assert.equal(initial[0].kind, 'interactive');
    assert.equal((await request(`${index}/interactive-example`, { token: ADMIN })).value.diagram.source, null);
  }
  const { token, project } = await create('independent-flow');
  assert.deepEqual((await request(index, { token: ADMIN })).value.diagrams, initial);
  for (const path of [index, entry, preview]) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, { token })).status, 403);
  }
  assert.equal((await request(entry, { method: 'PUT', data: diagramInput, token })).status, 403);
  const cookie = await login();
  assert.equal((await request(entry, { method: 'PUT', data: diagramInput, cookie })).status, 403);
  assert.equal((await request(entry, { method: 'PUT', data: diagramInput, cookie, origin: 'https://example.invalid' })).status, 403);
  const created = await request(entry, { method: 'PUT', data: diagramInput, cookie, origin: ORIGIN });
  assert.equal(created.status, 201);
  assert.deepEqual(created.value.diagram, {
    id: 'independent-flow', title: diagramInput.title, source: diagramSource, revision: 1,
    updatedAt: created.value.diagram.updatedAt, kind: 'svg',
  });
  const { diagrams } = (await request(index, { cookie })).value;
  assert.equal(diagrams.length, initial.length + 1);
  assert.equal(diagrams[0].id, 'independent-flow');
  assert.ok(!Object.hasOwn(diagrams[0], 'source') && !Object.hasOwn(diagrams[0], 'svg'));
  assert.deepEqual((await request(entry, { cookie })).value, created.value);
  assert.equal((await request(entry)).status, 401);
  assert.equal((await request(entry, { token })).status, 403);
  assert.equal((await request(preview, { token })).status, 403);
  const image = await request(preview, { cookie });
  assert.equal(image.status, 200);
  assert.equal(image.value, diagramSvg);
  assert.match(image.response.headers.get('Content-Type'), /^image\/svg\+xml/);
  assert.equal(image.response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(image.response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(image.response.headers.get('Cache-Control'), 'no-store');
  assert.match(image.response.headers.get('Content-Security-Policy'), /^default-src 'none';.*frame-ancestors 'none'; sandbox$/);
  assert.doesNotMatch(image.response.headers.get('Content-Security-Policy'), /allow-scripts|allow-same-origin/);
  const head = await request(preview, { method: 'HEAD', cookie });
  assert.equal(head.status, 200);
  assert.equal(head.value, '');
  assert.equal((await request(preview, { method: 'POST', cookie })).status, 405);

  const path = '/api/projects/independent-flow';
  assert.deepEqual((await request(path, { token })).value.project, project);
  assert.equal((await request(`${path}/archive`, { method: 'POST', token: ADMIN, data: { baseRevision: project.revision } })).status, 200);
  assert.deepEqual((await request(entry, { cookie })).value, created.value);
  assert.equal((await request(preview, { cookie })).value, diagramSvg);
  await request('/api/session', { method: 'DELETE', cookie, origin: ORIGIN });
  assert.equal((await request(index, { cookie })).status, 401);
  assert.equal((await request(preview, { cookie })).status, 401);
});

test('Mermaid writes reject stale revisions, reserved names and unsafe or oversized preview inputs', async t => {
  const { request } = setup(t);
  const put = (id, data) => request(`/api/diagrams/${id}`, { method: 'PUT', token: ADMIN, data });
  const id = 'editable-flow';
  assert.equal((await put('interactive-example', diagramInput)).status, 409);
  assert.equal((await put('bad%2Fpath', diagramInput)).status, 400);
  assert.equal((await put(id, { ...diagramInput, baseRevision: 2 })).status, 404);
  assert.equal((await put(id, { ...diagramInput, source: 'ก'.repeat(22000) })).status, 413);
  assert.equal((await put(id, { ...diagramInput, svg: `<svg>${' '.repeat(500 * 1024)}</svg>` })).status, 413);
  assert.equal((await put(id, { ...diagramInput, svg: '<html>not SVG</html>' })).status, 400);
  assert.equal((await put(id, { ...diagramInput, svg: '<svg><!DOCTYPE test></svg>' })).status, 400);
  assert.equal((await put(id, diagramInput)).status, 201);
  assert.equal((await put(id, diagramInput)).status, 409);
  const competing = await Promise.all([
    put(id, { ...diagramInput, title: 'Version 2A', baseRevision: 1 }),
    put(id, { ...diagramInput, title: 'Version 2B', baseRevision: 1 }),
  ]);
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  const winner = competing.find(result => result.status === 200);
  assert.equal(winner.value.diagram.revision, 2);
  assert.deepEqual((await request(`/api/diagrams/${id}`, { token: ADMIN })).value, winner.value);
});

test('task IDs remain stable; fenced rows are ignored and source line numbers survive', () => {
  const markdown = '# Checklist\r\n\r\n```md\r\n- [ ] Example\r\n```\r\n- [ ] Actual task  \r\n  - [X] Nested task <!-- checklist:already_123 -->\r\n';
  const normalized = ensureTaskIds(markdown);
  const tasks = parseTasks(normalized);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].line, 5);
  assert.equal(tasks[1].line, 6);
  assert.equal(tasks[1].sourceChecked, true);
  assert.equal(tasks[1].id, 'already_123');
  assert.equal(normalized, ensureTaskIds(normalized));
  assert.ok(normalized.includes('- [ ] Example\r\n'));
  assert.ok(normalized.includes('-->  \r\n'));
  const exported = effectiveMarkdown(normalized, { [tasks[0].id]: true, already_123: false });
  assert.equal(parseTasks(exported)[0].sourceChecked, true);
  assert.equal(parseTasks(exported)[1].sourceChecked, false);
});

test('duplicate IDs, malformed IDs, and more than 1000 task rows are rejected', () => {
  assert.throws(() => parseTasks(MARKDOWN + MARKDOWN), /Duplicate task ID/);
  assert.throws(() => parseTasks('- [ ] Bad <!-- checklist:short -->'), /Invalid task ID/);
  assert.throws(() => parseTasks('- [ ] Bad <!-- checklist:never-closed'), /Invalid task ID/);
  assert.throws(() => parseTasks('- [ ] Bad <!-- checklist:first_123 --> <!-- checklist:second_123 -->'), /Invalid task ID/);
  assert.throws(() => ensureTaskIds(Array.from({ length: 1001 }, () => '- [ ] Task').join('\n')), /at most 1000/);
  assert.equal(parseTasks('~~~\n- [ ] Ignored <!-- checklist:x -->\n~~~~\n- [ ] Visible').length, 1);
});

test('shared helpers preserve mixed line endings byte-for-byte apart from IDs and checks', () => {
  const mixed = '# Heading\r\n- [ ] First <!-- checklist:first_123 -->\n- [x] Second <!-- checklist:second_123 -->\r\n';
  assert.equal(ensureTaskIds(mixed), mixed);
  assert.equal(effectiveMarkdown(mixed, { first_123: true }), mixed.replace('- [ ] First', '- [x] First'));
  const withoutId = '# Heading\r\n- [ ] First\n- [x] Second <!-- checklist:second_123 -->\r\n';
  assert.equal(ensureTaskIds(withoutId).replace(/ <!-- checklist:[0-9a-f-]{36} -->/, ''), withoutId);
});

test('task parsing follows GFM for quoted, nested, ordered, indented-code and fenced-code rows', () => {
  const markdown = [
    '    - [ ] Code row <!-- checklist:task_code_123 -->',
    '',
    '> - [ ] Quoted task <!-- checklist:task_quote_123 -->',
    '>',
    '> ~~~md',
    '> - [ ] Quoted code <!-- checklist:quoted_code_123 -->',
    '> ~~~',
    '',
    '- [ ] Parent <!-- checklist:parent_123 -->',
    '  - [x] Child <!-- checklist:child_123 -->',
    '',
    '1. [ ] Ordered <!-- checklist:ordered_123 -->',
    '',
    '- > - [ ] Quote inside a list <!-- checklist:inner_quote_123 -->',
    '',
    '- - [ ] List inside a list <!-- checklist:inner_list_123 -->',
    '',
    '```',
    '- [ ] Fenced example <!-- checklist:fenced_123 -->',
    '```'
  ].join('\n');
  const tasks = parseTasks(markdown);
  assert.deepEqual(tasks.map(task => [task.id, task.line]), [['task_quote_123', 2], ['parent_123', 8], ['child_123', 9], ['ordered_123', 11], ['inner_quote_123', 13], ['inner_list_123', 15]]);
  const exported = effectiveMarkdown(markdown, { task_quote_123: true, inner_quote_123: true, inner_list_123: true });
  assert.equal(parseTasks(exported).filter(task => task.sourceChecked).length, 4);
  assert.ok(exported.includes('    - [ ] Code row'));
  assert.ok(exported.includes('> - [x] Quoted task'));
  assert.ok(exported.includes('- > - [x] Quote inside a list'));
});

test('code examples with the same words as real tasks never take their source position', () => {
  const markdown = '    - [ ] Identical words\n\n> - [ ] Identical words\n';
  const normalized = ensureTaskIds(markdown);
  assert.deepEqual(parseTasks(normalized).map(task => task.line), [2]);
  assert.ok(normalized.startsWith('    - [ ] Identical words\n'));
  assert.equal(parseTasks('- [ ]').length, 0);
});

test('parser callers cannot mutate a cached task result', () => {
  const task = parseTasks(MARKDOWN)[0];
  task.id = 'changed_id_123'; task.sourceChecked = true;
  assert.equal(parseTasks(MARKDOWN)[0].id, TASK);
  assert.equal(parseTasks(MARKDOWN)[0].sourceChecked, false);
});

test('health is public, data requires authentication, and security headers are present', async t => {
  const { request } = setup(t);
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.value, { ok: true });
  assert.equal(health.response.headers.get('Cache-Control'), 'no-store');
  assert.equal(health.response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(health.response.headers.get('X-Frame-Options'), 'DENY');
  assert.match(health.response.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal((await request('/api/projects')).status, 401);
});

test('project creation normalizes task IDs, hashes scoped tokens, and lists summaries', async t => {
  const { request, create, DB } = setup(t);
  const { project, token } = await create('project-one', '- [ ] New task\n- [x] Complete task');
  assert.equal(project.revision, 1);
  assert.equal(project.total, 2);
  assert.equal(project.done, 1);
  assert.ok(project.tasks.every(task => task.id));
  assert.equal(project.tasks[0].manual, false);
  const saved = DB.db.prepare('SELECT token_hash FROM projects').get();
  assert.notEqual(saved.token_hash, token);
  assert.match(saved.token_hash, /^[a-f0-9]{64}$/);
  const list = await request('/api/projects', { token: ADMIN });
  assert.equal(list.value.projects.length, 1);
  assert.equal(list.value.projects[0].markdown, undefined);
  assert.equal(list.value.projects[0].token_hash, undefined);
  assert.equal(list.value.projects[0].tasks, undefined);
});

test('manual checkbox choices persist through source updates and can return to source state', async t => {
  const { request, create, login } = setup(t);
  const { token } = await create(); const cookie = await login();
  const checked = await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', cookie, origin: ORIGIN, data: { checked: true, baseRevision: 1 } });
  assert.equal(checked.status, 200);
  assert.equal(checked.value.project.tasks[0].checked, true);
  assert.equal(checked.value.project.tasks[0].sourceChecked, false);
  assert.equal(checked.value.project.tasks[0].manual, true);
  const markdown = MARKDOWN.replace('original', 'renamed') + '- [ ] Another task <!-- checklist:task_beta_123 -->\n';
  const synced = await request('/api/projects/project-one/sync', { method: 'PUT', token, data: { markdown, name: 'Renamed project', sourceId: SOURCE, baseRevision: 2 } });
  assert.equal(synced.status, 200);
  assert.equal(synced.value.project.tasks[0].checked, true);
  assert.equal(synced.value.project.done, 1);
  assert.equal(synced.value.project.total, 2);
  const loaded = await request('/api/projects/project-one', { cookie });
  assert.equal(loaded.value.project.tasks[0].manual, true);
  const reset = await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', cookie, origin: ORIGIN, data: { checked: null, baseRevision: 3 } });
  assert.equal(reset.status, 200);
  assert.equal(reset.value.project.tasks[0].checked, false);
  assert.equal(reset.value.project.tasks[0].manual, false);
});

test('stale source writes and concurrent updates fail instead of replacing changes', async t => {
  const { request, create } = setup(t);
  const { token } = await create();
  const calls = await Promise.all([
    request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token: ADMIN, data: { checked: true, baseRevision: 1 } }),
    request('/api/projects/project-one/sync', { method: 'PUT', token, data: { name: 'Source edit', sourceId: SOURCE, markdown: MARKDOWN + '\nSource edit', baseRevision: 1 } })
  ]);
  assert.deepEqual(calls.map(call => call.status).sort(), [200, 409]);
  const stale = await request('/api/projects/project-one/sync', { method: 'PUT', token, data: { name: 'Stale edit', sourceId: SOURCE, markdown: MARKDOWN, baseRevision: 1 } });
  assert.equal(stale.status, 409);
  const current = await request('/api/projects/project-one', { token });
  assert.equal(current.value.project.revision, 2);
});

test('project credentials cannot read another project, list projects, or make manual edits', async t => {
  const { request, create } = setup(t);
  const { token } = await create('project-one');
  await create('project-two');
  assert.equal((await request('/api/projects/project-one', { token })).status, 200);
  assert.equal((await request('/api/projects/project-two', { token })).status, 403);
  assert.equal((await request('/api/projects', { token })).status, 403);
  assert.equal((await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token, data: { checked: true, baseRevision: 1 } })).status, 403);
  assert.equal((await request('/api/projects/project-one/document', { method: 'PUT', token, data: { markdown: MARKDOWN, baseRevision: 1 } })).status, 403);
  assert.equal((await request('/api/projects/project-one/sync', { method: 'PUT', token, data: { name: 'Wrong source', sourceId: 'another-source', markdown: MARKDOWN, baseRevision: 1 } })).status, 403);
});

test('session credentials are hashed, expire, and logout revokes access', async t => {
  const { request, DB } = setup(t);
  const login = await request('/api/session', { method: 'POST', origin: ORIGIN, data: { key: ADMIN } });
  const cookieHeader = login.response.headers.get('Set-Cookie');
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.match(cookieHeader, /Secure/);
  const cookie = cookieHeader.split(';')[0];
  const saved = DB.db.prepare('SELECT * FROM sessions').get();
  assert.notEqual(saved.token_hash, cookie.split('=')[1]);
  assert.ok(saved.expires_at > Date.now() / 1000 + 29 * 86400);
  assert.equal((await request('/api/projects', { cookie })).status, 200);
  assert.equal((await request('/api/session', { method: 'DELETE', cookie, origin: ORIGIN })).status, 200);
  assert.equal((await request('/api/projects', { cookie })).status, 401);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('expired sessions cannot authenticate', async t => {
  const { request, login, DB } = setup(t);
  const cookie = await login();
  DB.db.exec('UPDATE sessions SET expires_at = 1');
  assert.equal((await request('/api/projects', { cookie })).status, 401);
});

test('browser writes require exact Origin and forged origins fail with bearer credentials too', async t => {
  const { request, create, login } = setup(t);
  await create(); const cookie = await login();
  const patch = { method: 'PATCH', cookie, data: { checked: true, baseRevision: 1 } };
  assert.equal((await request(`/api/projects/project-one/tasks/${TASK}`, patch)).status, 403);
  assert.equal((await request(`/api/projects/project-one/tasks/${TASK}`, { ...patch, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(`/api/projects/project-one/tasks/${TASK}`, { ...patch, token: ADMIN, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/session', { method: 'POST', origin: 'https://evil.example', data: { key: ADMIN } })).status, 403);
  assert.equal((await request('/api/session', { method: 'POST', data: { key: ADMIN } })).status, 403);
  assert.equal((await request(`/api/projects/project-one/tasks/${TASK}`, { ...patch, origin: ORIGIN })).status, 200);
});

test('document editor adds IDs, retains existing overrides, and drops deleted overrides', async t => {
  const { request, create } = setup(t);
  await create();
  await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token: ADMIN, data: { checked: true, baseRevision: 1 } });
  const edited = await request('/api/projects/project-one/document', { method: 'PUT', token: ADMIN, data: { markdown: MARKDOWN + '- [ ] Added in browser\n', baseRevision: 2 } });
  assert.equal(edited.status, 200);
  assert.equal(edited.value.project.tasks[0].manual, true);
  assert.ok(edited.value.project.tasks[1].id);
  assert.equal(edited.value.project.total, 2);
  const deleted = await request('/api/projects/project-one/document', { method: 'PUT', token: ADMIN, data: { markdown: '# Empty now', baseRevision: 3 } });
  assert.equal(deleted.status, 200);
  const restored = await request('/api/projects/project-one/document', { method: 'PUT', token: ADMIN, data: { markdown: MARKDOWN, baseRevision: 4 } });
  assert.equal(restored.value.project.tasks[0].manual, false);
  assert.equal(restored.value.project.tasks[0].checked, false);
});

test('invalid input, unknown tasks, duplicate projects, and oversized bodies fail visibly', async t => {
  const { request, create } = setup(t);
  await create();
  assert.equal((await request('/api/projects', { method: 'POST', token: ADMIN, data: { id: 'project-one', name: 'Duplicate', sourceId: SOURCE, markdown: MARKDOWN } })).status, 409);
  assert.equal((await request('/api/projects', { method: 'POST', token: ADMIN, data: { id: '../bad', name: 'Invalid', sourceId: SOURCE, markdown: MARKDOWN } })).status, 400);
  assert.equal((await request('/api/projects', { method: 'POST', token: ADMIN, data: { id: 'invalid-markdown', name: 'Invalid', sourceId: SOURCE, markdown: MARKDOWN + MARKDOWN } })).status, 400);
  assert.equal((await request('/api/projects/project-one/document', { method: 'PUT', token: ADMIN, raw: '{invalid' })).status, 400);
  assert.equal((await request('/api/projects/project-one/document', { method: 'PUT', token: ADMIN, data: { markdown: 'a'.repeat(256 * 1024), baseRevision: 1 } })).status, 413);
  assert.equal((await request('/api/projects/project-one/tasks/unknown_task_123', { method: 'PATCH', token: ADMIN, data: { checked: true, baseRevision: 1 } })).status, 404);
  assert.equal((await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token: ADMIN, data: { checked: 'true', baseRevision: 1 } })).status, 400);
  assert.equal((await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token: ADMIN, data: { checked: true, baseRevision: 0 } })).status, 400);
});

test('the 100-project cap is enforced by the same statement as insertion', async t => {
  const { request, DB } = setup(t);
  const insert = DB.db.prepare('INSERT INTO projects (id, name, markdown, source_id, token_hash, created_at, updated_at, project_key, project_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 100; i++) insert.run(`fixture-${i}`, 'Fixture', '', SOURCE, `hash-${i}`, 'now', 'now', `fixture-${i}`, 'Fixture');
  const result = await request('/api/projects', { method: 'POST', token: ADMIN, data: { id: 'one-too-many', name: 'Over limit', sourceId: SOURCE, markdown: '' } });
  assert.equal(result.status, 409);
  assert.match(result.value.error, /100 projects/);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM projects').get().count, 100);
});

test('valid task IDs that match JavaScript property names retain manual choices', async t => {
  const { request, create } = setup(t);
  const markdown = '- [ ] Special ID <!-- checklist:__proto__ -->';
  const { token } = await create('project-one', markdown);
  const changed = await request('/api/projects/project-one/tasks/__proto__', { method: 'PATCH', token: ADMIN, data: { checked: true, baseRevision: 1 } });
  assert.equal(changed.status, 200);
  assert.equal(changed.value.project.tasks[0].checked, true);
  const synced = await request('/api/projects/project-one/sync', { method: 'PUT', token, data: { markdown, name: 'Updated', sourceId: SOURCE, baseRevision: 2 } });
  assert.equal(synced.value.project.tasks[0].checked, true);
  assert.equal(synced.value.project.tasks[0].manual, true);
});

test('admin connection recovery replaces the scoped credential without changing tasks or source', async t => {
  const { request, create, DB } = setup(t);
  const { token: oldToken } = await create();
  const changed = await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token: ADMIN, data: { checked: true, baseRevision: 1 } });
  const before = changed.value.project;
  const recovered = await request('/api/projects/project-one/token', { method: 'PUT', token: ADMIN, data: { sourceId: SOURCE, baseRevision: 2 } });
  assert.equal(recovered.status, 200);
  assert.notEqual(recovered.value.token, oldToken);
  assert.equal(recovered.value.project.revision, 3);
  assert.equal(recovered.value.project.markdown, before.markdown);
  assert.equal(recovered.value.project.name, before.name);
  assert.equal(recovered.value.project.sourceId, before.sourceId);
  assert.deepEqual(recovered.value.project.tasks, before.tasks);
  assert.equal(recovered.value.project.done, before.done);
  assert.equal(recovered.value.project.total, before.total);
  assert.notEqual(DB.db.prepare('SELECT token_hash FROM projects WHERE id = ?').get('project-one').token_hash, recovered.value.token);
  assert.equal((await request('/api/projects/project-one', { token: oldToken })).status, 403);
  assert.equal((await request('/api/projects/project-one', { token: recovered.value.token })).status, 200);
});

test('connection recovery requires admin authority, matching source, exact browser Origin, and a current revision', async t => {
  const { request, create, login } = setup(t);
  const { token } = await create(); const cookie = await login();
  const path = '/api/projects/project-one/token';
  const options = { method: 'PUT', data: { sourceId: SOURCE, baseRevision: 1 } };
  assert.equal((await request(path, options)).status, 401);
  assert.equal((await request(path, { ...options, token })).status, 403);
  assert.equal((await request(path, { ...options, token: ADMIN, data: { sourceId: 'wrong-source', baseRevision: 1 } })).status, 403);
  assert.equal((await request(path, { ...options, cookie })).status, 403);
  assert.equal((await request(path, { ...options, cookie, origin: 'https://evil.example' })).status, 403);
  const recovered = await request(path, { ...options, cookie, origin: ORIGIN });
  assert.equal(recovered.status, 200);
  assert.equal((await request(path, { ...options, token: ADMIN })).status, 409);
  assert.equal((await request('/api/projects/project-one', { token: recovered.value.token })).status, 200);
});

test('concurrent recovery requests cannot both rotate the same project revision', async t => {
  const { request, create } = setup(t);
  await create();
  const options = { method: 'PUT', token: ADMIN, data: { sourceId: SOURCE, baseRevision: 1 } };
  const results = await Promise.all([request('/api/projects/project-one/token', options), request('/api/projects/project-one/token', options)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const success = results.find(result => result.status === 200);
  assert.equal((await request('/api/projects/project-one', { token: success.value.token })).status, 200);
});

test('document text edits preserve manual status and explicit checkedChanges persist through future sync', async t => {
  const { request, create } = setup(t);
  const { token } = await create();
  await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token: ADMIN, data: { checked: true, baseRevision: 1 } });
  const effective = MARKDOWN.replace('- [ ]', '- [x]');
  const textEdit = await request('/api/projects/project-one/document', { method: 'PUT', token: ADMIN, data: { markdown: effective.replace('original', 'edited'), checkedChanges: {}, baseRevision: 2 } });
  assert.equal(textEdit.status, 200);
  assert.equal(textEdit.value.project.tasks[0].manual, true);
  assert.equal(textEdit.value.project.tasks[0].checked, true);
  const explicitUncheck = await request('/api/projects/project-one/document', { method: 'PUT', token: ADMIN, data: { markdown: MARKDOWN, checkedChanges: { [TASK]: false }, baseRevision: 3 } });
  assert.equal(explicitUncheck.status, 200);
  assert.equal(explicitUncheck.value.project.tasks[0].manual, true);
  assert.equal(explicitUncheck.value.project.tasks[0].checked, false);
  const synced = await request('/api/projects/project-one/sync', { method: 'PUT', token, data: { name: 'Source update', sourceId: SOURCE, markdown: effective, baseRevision: 4 } });
  assert.equal(synced.status, 200);
  assert.equal(synced.value.project.tasks[0].sourceChecked, true);
  assert.equal(synced.value.project.tasks[0].checked, false);
  assert.equal(synced.value.project.tasks[0].manual, true);
});

test('document checkedChanges reject unknown IDs and non-boolean values without writing', async t => {
  const { request, create } = setup(t);
  await create();
  for (const checkedChanges of [null, [], { unknown_task_123: true }, { [TASK]: 'true' }, { [TASK]: null }]) {
    const result = await request('/api/projects/project-one/document', { method: 'PUT', token: ADMIN, data: { markdown: MARKDOWN, checkedChanges, baseRevision: 1 } });
    assert.equal(result.status, 400);
  }
  const current = await request('/api/projects/project-one', { token: ADMIN });
  assert.equal(current.value.project.revision, 1);
  assert.equal(current.value.project.tasks[0].manual, false);
});

test('hierarchy migration preserves legacy rows, manual decisions, credentials and separate same-name projects', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const insert = db.prepare('INSERT INTO projects (id, name, markdown, source_id, token_hash, overrides_json, revision, done, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const id of ['legacy-a', 'legacy-b']) insert.run(id, 'Same display name', MARKDOWN, SOURCE, `original-${id}`, JSON.stringify({ [TASK]: true }), 7, 1, 1, 'created', 'updated');
  db.exec(readFileSync(new URL('../migrations/0002_hierarchy_archive.sql', import.meta.url), 'utf8'));
  const rows = db.prepare('SELECT * FROM projects ORDER BY id').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.scope, 'project');
    assert.equal(row.project_key, row.id);
    assert.equal(row.project_name, 'Same display name');
    assert.equal(row.chat_id, null);
    assert.equal(row.chat_title, null);
    assert.equal(row.archived_at, null);
    assert.equal(row.markdown, MARKDOWN);
    assert.equal(row.token_hash, `original-${row.id}`);
    assert.equal(row.overrides_json, JSON.stringify({ [TASK]: true }));
    assert.equal(row.revision, 7);
    assert.equal(row.updated_at, 'updated');
  }
});

test('legacy Worker inserts during rollout receive distinct identities without altering explicit metadata', t => {
  const { DB } = setup(t);
  const legacyInsert = DB.db.prepare('INSERT INTO projects (id, name, markdown, source_id, token_hash, overrides_json, revision, done, total, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM projects) < 100');
  for (const id of ['rollout-one', 'rollout-two']) legacyInsert.run(id, 'Shared display name', MARKDOWN, SOURCE, `token-${id}`, '{}', 0, 1, 'created', 'updated');
  const rows = DB.db.prepare('SELECT * FROM projects ORDER BY id').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.project_key, row.id);
    assert.equal(row.project_name, 'Shared display name');
    assert.equal(row.scope, 'project');
    assert.equal(row.revision, 1);
    assert.equal(row.markdown, MARKDOWN);
    assert.equal(row.updated_at, 'updated');
  }
  DB.db.prepare('INSERT INTO projects (id, name, markdown, source_id, token_hash, created_at, updated_at, project_key, project_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('explicit-identity', 'Document name', MARKDOWN, SOURCE, 'explicit-token', 'created', 'updated', 'chosen-group', 'Chosen project name');
  const explicit = DB.db.prepare('SELECT project_key, project_name FROM projects WHERE id = ?').get('explicit-identity');
  assert.deepEqual({ ...explicit }, { project_key: 'chosen-group', project_name: 'Chosen project name' });
});

test('project and chat checklists share a stable project group while active identities stay unique', async t => {
  const { request, create } = setup(t);
  const parent = await create('project-main', MARKDOWN, { projectKey: 'group-123', projectName: 'Shared project' });
  assert.equal(parent.project.scope, 'project');
  assert.equal(parent.project.chatId, null);
  const chatMetadata = { scope: 'chat', projectKey: 'group-123', projectName: 'Shared project', chatId: 'chat-123', chatTitle: 'Original chat title' };
  const chat = await create('checklist-chat', MARKDOWN, chatMetadata);
  assert.equal(chat.project.chatId, 'chat-123');
  assert.equal(chat.project.chatTitle, 'Original chat title');
  await create('other-chat', MARKDOWN, { ...chatMetadata, chatId: 'chat-456', chatTitle: 'Second chat' });
  await create('different-project-chat', MARKDOWN, { ...chatMetadata, projectKey: 'another-group' });
  const duplicateProject = await request('/api/projects', { method: 'POST', token: ADMIN, data: { id: 'duplicate-project', name: 'Different name', markdown: MARKDOWN, sourceId: SOURCE, projectKey: 'group-123' } });
  assert.equal(duplicateProject.status, 409);
  const duplicateChat = await request('/api/projects', { method: 'POST', token: ADMIN, data: { id: 'duplicate-chat', name: 'Different name', markdown: MARKDOWN, sourceId: SOURCE, ...chatMetadata, chatTitle: 'Renamed chat' } });
  assert.equal(duplicateChat.status, 409);
  const list = await request('/api/projects', { token: ADMIN });
  assert.equal(list.value.projects.length, 4);
  const summary = list.value.projects.find(project => project.id === 'checklist-chat');
  assert.deepEqual({ scope: summary.scope, projectKey: summary.projectKey, projectName: summary.projectName, chatId: summary.chatId, chatTitle: summary.chatTitle, archivedAt: summary.archivedAt }, { ...chatMetadata, archivedAt: null });
  assert.equal(summary.markdown, undefined);
});

test('invalid hierarchy metadata is rejected before creating or classifying a checklist', async t => {
  const { request, create } = setup(t);
  const invalid = [
    { scope: 'invalid' },
    { scope: 'chat' },
    { scope: 'chat', chatId: 'chat-123' },
    { scope: 'chat', chatId: '', chatTitle: 'Title' },
    { scope: 'project', chatId: 'chat-123', chatTitle: 'Title' },
    { projectKey: '   ' },
    { projectName: 'bad\nname' }
  ];
  for (const metadata of invalid) {
    const result = await request('/api/projects', { method: 'POST', token: ADMIN, data: { id: 'invalid-metadata', name: 'Name', markdown: MARKDOWN, sourceId: SOURCE, ...metadata } });
    assert.equal(result.status, 400);
  }
  await create();
  const missingIdentity = await request('/api/projects/project-one/identity', { method: 'PUT', token: ADMIN, data: { baseRevision: 1, scope: 'project' } });
  assert.equal(missingIdentity.status, 400);
  const current = await request('/api/projects/project-one', { token: ADMIN });
  assert.equal(current.value.project.revision, 1);
  assert.equal(current.value.project.projectKey, 'project-one');
});

const ORIGIN_CHAT_A = '867523d0-69d3-4e99-8198-7bbb32063e1f';
const ORIGIN_CHAT_B = '6b0236bc-558b-48a9-814a-fb97a18a6722';

test('origin migration links only existing chat checklists and preserves their source and manual decisions', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  for (const file of ['0001_initial.sql', '0002_hierarchy_archive.sql']) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const insert = db.prepare('INSERT INTO projects (id, name, markdown, source_id, token_hash, overrides_json, revision, done, total, created_at, updated_at, scope, project_key, project_name, chat_id, chat_title, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, scope, archivedAt] of [['project-origin', 'project', null], ['chat-origin', 'chat', null], ['archived-origin', 'chat', 'archived']]) insert.run(id, id, MARKDOWN, SOURCE, `original-token-${id}`, JSON.stringify({ [TASK]: true }), 7, 1, 1, 'created', 'updated', scope, id, id, ORIGIN_CHAT_A, scope === 'chat' ? 'Chat title' : null, archivedAt);
  const prior = db.prepare('SELECT * FROM projects ORDER BY id').all();
  db.exec(readFileSync(new URL('../migrations/0003_origin_chat.sql', import.meta.url), 'utf8'));
  const after = db.prepare('SELECT * FROM projects ORDER BY id').all();
  for (let i = 0; i < after.length; i++) {
    const { origin_chat_id, ...originalFields } = after[i];
    assert.deepEqual(originalFields, { ...prior[i] });
    assert.equal(origin_chat_id, after[i].scope === 'chat' ? ORIGIN_CHAT_A : null);
  }
});

test('a project origin is normalized and preserved through sync and identity changes that omit it', async t => {
  const { request, create, DB } = setup(t);
  const { project, token } = await create('project-one', MARKDOWN, { originChatId: ORIGIN_CHAT_A.toUpperCase() });
  assert.equal(project.originChatId, ORIGIN_CHAT_A);
  assert.equal(project.scope, 'project');
  assert.equal(project.chatId, null);
  const manuallyChecked = await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token: ADMIN, data: { baseRevision: 1, checked: true } });
  assert.equal(manuallyChecked.status, 200);
  const synced = await request('/api/projects/project-one/sync', { method: 'PUT', token, data: { baseRevision: 2, markdown: MARKDOWN, name: 'New name', sourceId: SOURCE, originChatId: ORIGIN_CHAT_B } });
  assert.equal(synced.status, 200);
  assert.equal(synced.value.project.originChatId, ORIGIN_CHAT_A);
  const updated = await request('/api/projects/project-one/identity', { method: 'PUT', token: ADMIN, data: { baseRevision: 3, scope: 'project', projectKey: 'new-group', projectName: 'New project name' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.value.project.originChatId, ORIGIN_CHAT_A);
  assert.equal(updated.value.project.markdown, MARKDOWN);
  assert.equal(updated.value.project.tasks[0].checked, true);
  assert.equal(updated.value.project.tasks[0].id, TASK);
  assert.equal(DB.db.prepare('SELECT origin_chat_id FROM projects').get().origin_chat_id, ORIGIN_CHAT_A);
  const list = await request('/api/projects', { token: ADMIN });
  assert.equal(list.value.projects[0].originChatId, ORIGIN_CHAT_A);
});

test('origin changes accept only UUIDs or null and require admin access and the current active revision', async t => {
  const { request, create } = setup(t);
  const invalid = ['', 'chat-123', ` ${ORIGIN_CHAT_A}`, `${ORIGIN_CHAT_A}\n`, 123, false, {}, []];
  for (const value of invalid) assert.equal((await request('/api/projects', { method: 'POST', token: ADMIN, data: { id: 'invalid-origin', name: 'Name', sourceId: SOURCE, markdown: MARKDOWN, originChatId: value } })).status, 400);
  const { token } = await create();
  assert.equal((await request('/api/projects/project-one', { token: ADMIN })).value.project.originChatId, null);
  const metadata = { baseRevision: 1, scope: 'project', projectKey: 'project-one', projectName: 'Project', originChatId: ORIGIN_CHAT_A.toUpperCase() };
  const write = (data, credential = ADMIN) => request('/api/projects/project-one/identity', { method: 'PUT', token: credential, data });
  assert.equal((await write(metadata, token)).status, 403);
  for (const value of invalid) assert.equal((await write({ ...metadata, originChatId: value })).status, 400);
  const assigned = await write(metadata);
  assert.equal(assigned.status, 200);
  assert.equal(assigned.value.project.originChatId, ORIGIN_CHAT_A);
  assert.equal((await write(metadata)).status, 409);
  const cleared = await write({ ...metadata, baseRevision: 2, originChatId: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.value.project.originChatId, null);
  const archived = await request('/api/projects/project-one/archive', { method: 'POST', token: ADMIN, data: { baseRevision: 3 } });
  assert.equal(archived.status, 200);
  assert.equal((await write({ ...metadata, baseRevision: 4 })).status, 410);
  assert.equal((await request('/api/projects/project-one', { token: ADMIN })).value.project.originChatId, null);
});

test('chat checklists route to their own chat even when their separate origin is missing or stale', async t => {
  const { request, create, DB } = setup(t);
  const metadata = { scope: 'chat', projectKey: 'chat-group', projectName: 'Project', chatId: ORIGIN_CHAT_A, chatTitle: 'Original chat' };
  const created = await create('chat-origin', MARKDOWN, metadata);
  assert.equal(created.project.originChatId, ORIGIN_CHAT_A);
  for (const storedOrigin of [null, ORIGIN_CHAT_B]) {
    DB.db.prepare('UPDATE projects SET origin_chat_id = ? WHERE id = ?').run(storedOrigin, 'chat-origin');
    assert.equal((await request('/api/projects/chat-origin', { token: ADMIN })).value.project.originChatId, ORIGIN_CHAT_A);
    assert.equal((await request('/api/projects', { token: ADMIN })).value.projects[0].originChatId, ORIGIN_CHAT_A);
  }
  const classified = await request('/api/projects/chat-origin/identity', { method: 'PUT', token: ADMIN, data: { baseRevision: 1, ...metadata, originChatId: ORIGIN_CHAT_B } });
  assert.equal(classified.status, 200);
  assert.equal(classified.value.project.chatId, ORIGIN_CHAT_A);
  assert.equal(classified.value.project.originChatId, ORIGIN_CHAT_A);
});

test('identity edits require admin access, preserve content, and reject stale or conflicting identities', async t => {
  const { request, create, login, DB } = setup(t);
  const { token } = await create(); const cookie = await login();
  const changed = await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token: ADMIN, data: { checked: true, baseRevision: 1 } });
  const prior = changed.value.project;
  const originalHash = DB.db.prepare('SELECT token_hash FROM projects WHERE id = ?').get('project-one').token_hash;
  const metadata = { scope: 'chat', projectKey: 'group-one', projectName: 'A project', chatId: 'chat-one', chatTitle: 'A chat' };
  const options = { method: 'PUT', data: { baseRevision: 2, ...metadata } };
  assert.equal((await request('/api/projects/project-one/identity', { ...options, token })).status, 403);
  assert.equal((await request('/api/projects/project-one/identity', { ...options, cookie })).status, 403);
  const classified = await request('/api/projects/project-one/identity', { ...options, cookie, origin: ORIGIN });
  assert.equal(classified.status, 200);
  assert.equal(classified.value.project.revision, 3);
  assert.equal(classified.value.project.markdown, prior.markdown);
  assert.deepEqual(classified.value.project.tasks, prior.tasks);
  assert.equal(classified.value.project.sourceId, prior.sourceId);
  assert.equal(classified.value.project.name, prior.name);
  assert.equal(DB.db.prepare('SELECT token_hash FROM projects WHERE id = ?').get('project-one').token_hash, originalHash);
  assert.equal((await request('/api/projects/project-one', { token })).status, 200);
  assert.equal((await request('/api/projects/project-one/identity', { ...options, token: ADMIN })).status, 409);
  await create('another-checklist');
  const collision = await request('/api/projects/another-checklist/identity', { method: 'PUT', token: ADMIN, data: { baseRevision: 1, ...metadata } });
  assert.equal(collision.status, 409);
  const unchanged = await request('/api/projects/another-checklist', { token: ADMIN });
  assert.equal(unchanged.value.project.revision, 1);
  assert.equal(unchanged.value.project.scope, 'project');
});

test('archiving keeps content and hierarchy readable to admins, separates lists, and revokes project access', async t => {
  const { request, create, login, DB } = setup(t);
  const metadata = { scope: 'chat', projectKey: 'group-one', projectName: 'A project', chatId: 'chat-one', chatTitle: 'A chat' };
  const { token } = await create('project-one', MARKDOWN, metadata); const cookie = await login();
  await create('still-active');
  const checked = await request(`/api/projects/project-one/tasks/${TASK}`, { method: 'PATCH', token: ADMIN, data: { checked: true, baseRevision: 1 } });
  const oldHash = DB.db.prepare('SELECT token_hash FROM projects WHERE id = ?').get('project-one').token_hash;
  const archived = await request('/api/projects/project-one/archive', { method: 'POST', cookie, origin: ORIGIN, data: { baseRevision: 2 } });
  assert.equal(archived.status, 200);
  assert.equal(archived.value.project.revision, 3);
  assert.ok(archived.value.project.archivedAt);
  assert.equal(archived.value.project.updatedAt, archived.value.project.archivedAt);
  assert.equal(archived.value.project.markdown, checked.value.project.markdown);
  assert.deepEqual(archived.value.project.tasks, checked.value.project.tasks);
  for (const [key, value] of Object.entries(metadata)) assert.equal(archived.value.project[key], value);
  const stored = DB.db.prepare('SELECT * FROM projects WHERE id = ?').get('project-one');
  assert.notEqual(stored.token_hash, oldHash);
  assert.equal(stored.overrides_json, JSON.stringify({ [TASK]: true }));
  assert.equal((await request('/api/projects/project-one', { token })).status, 403);
  assert.equal((await request('/api/projects/project-one')).status, 401);
  assert.equal((await request('/api/projects/project-one', { cookie })).status, 200);
  const activeList = await request('/api/projects', { token: ADMIN });
  assert.deepEqual(activeList.value.projects.map(project => project.id), ['still-active']);
  const archivedList = await request('/api/projects?archived=true', { cookie });
  assert.deepEqual(archivedList.value.projects.map(project => project.id), ['project-one']);
  assert.equal(archivedList.value.projects[0].markdown, undefined);
  assert.equal(archivedList.value.projects[0].archivedAt, archived.value.project.archivedAt);
  assert.equal((await request('/api/projects?archived=true', { token })).status, 403);
});

test('archive requires current revision, admin authority and browser Origin; all later writes fail with 410', async t => {
  const { request, create, login, DB } = setup(t);
  const { token } = await create(); const cookie = await login();
  const archive = { method: 'POST', data: { baseRevision: 1 } };
  assert.equal((await request('/api/projects/project-one/archive', { ...archive, token })).status, 403);
  assert.equal((await request('/api/projects/project-one/archive', { ...archive, cookie })).status, 403);
  assert.equal((await request('/api/projects/project-one/archive', { ...archive, cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/projects/project-one/archive', { ...archive, token: ADMIN, data: { baseRevision: 2 } })).status, 409);
  assert.equal((await request('/api/projects/project-one', { token })).status, 200);
  assert.equal((await request('/api/projects/project-one/archive', { ...archive, token: ADMIN })).status, 200);
  const before = DB.db.prepare('SELECT * FROM projects WHERE id = ?').get('project-one');
  const writes = [
    ['/sync', 'PUT', { baseRevision: 2, sourceId: SOURCE, name: 'Changed', markdown: '# Changed' }],
    ['/document', 'PUT', { baseRevision: 2, markdown: '# Changed' }],
    [`/tasks/${TASK}`, 'PATCH', { baseRevision: 2, checked: true }],
    ['/token', 'PUT', { baseRevision: 2, sourceId: SOURCE }],
    ['/identity', 'PUT', { baseRevision: 2, scope: 'project', projectKey: 'changed-group', projectName: 'Changed' }],
    ['/archive', 'POST', { baseRevision: 2 }]
  ];
  for (const [suffix, method, data] of writes) {
    const result = await request('/api/projects/project-one' + suffix, { method, token: ADMIN, data });
    assert.equal(result.status, 410, suffix);
    assert.match(result.value.error, /archived/);
  }
  assert.deepEqual(DB.db.prepare('SELECT * FROM projects WHERE id = ?').get('project-one'), before);
  assert.equal((await request('/api/projects/project-one/sync', { method: 'PUT', token, data: writes[0][2] })).status, 403);
});

test('archiving one checklist leaves its project and sibling chat checklists active', async t => {
  const { request, create } = setup(t);
  await create('project-main', MARKDOWN, { projectKey: 'shared-group', projectName: 'Shared project' });
  const common = { scope: 'chat', projectKey: 'shared-group', projectName: 'Shared project' };
  await create('chat-one', MARKDOWN, { ...common, chatId: 'thread-one', chatTitle: 'First chat' });
  const sibling = await create('chat-two', MARKDOWN, { ...common, chatId: 'thread-two', chatTitle: 'Second chat' });
  assert.equal((await request('/api/projects/chat-one/archive', { method: 'POST', token: ADMIN, data: { baseRevision: 1 } })).status, 200);
  const list = await request('/api/projects', { token: ADMIN });
  assert.deepEqual(list.value.projects.map(project => project.id).sort(), ['chat-two', 'project-main']);
  assert.equal((await request('/api/projects/chat-two', { token: sibling.token })).status, 200);
  // A separate explicit enrollment may reuse a group identity, but never restores the archived record.
  await create('replacement-chat', MARKDOWN, { ...common, chatId: 'thread-one', chatTitle: 'A new checklist' });
  const original = await request('/api/projects/chat-one', { token: ADMIN });
  assert.ok(original.value.project.archivedAt);
});

test('concurrent hierarchy claims are atomically unique', async t => {
  const { request, create } = setup(t);
  await create('first'); await create('second');
  const data = { baseRevision: 1, scope: 'chat', projectKey: 'contended-group', projectName: 'A project', chatId: 'same-chat', chatTitle: 'A chat' };
  const results = await Promise.all(['first', 'second'].map(id => request(`/api/projects/${id}/identity`, { method: 'PUT', token: ADMIN, data })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const current = await request('/api/projects', { token: ADMIN });
  assert.equal(current.value.projects.filter(project => project.scope === 'chat').length, 1);
});

test('in-flight writes cannot alter a checklist after archive commits', async t => {
  for (const operation of ['sync', 'document', 'task', 'token', 'identity']) {
    await t.test(operation, async t => {
      const { request, create, DB } = setup(t);
      const { token } = await create();
      const originalPrepare = DB.prepare.bind(DB);
      let intercepted = false;
      DB.prepare = sql => {
        const prepared = originalPrepare(sql);
        if (!intercepted && sql.startsWith('UPDATE projects SET') && !sql.startsWith('UPDATE projects SET archived_at')) {
          intercepted = true;
          return { ...prepared, bind: (...args) => {
            const bound = prepared.bind(...args);
            return { ...bound, run: async () => {
              const archived = await request('/api/projects/project-one/archive', { method: 'POST', token: ADMIN, data: { baseRevision: 1 } });
              assert.equal(archived.status, 200);
              return bound.run();
            } };
          } };
        }
        return prepared;
      };
      const writes = {
        sync: ['/sync', 'PUT', { baseRevision: 1, sourceId: SOURCE, name: 'Changed', markdown: '# Changed' }],
        document: ['/document', 'PUT', { baseRevision: 1, markdown: '# Changed' }],
        task: [`/tasks/${TASK}`, 'PATCH', { baseRevision: 1, checked: true }],
        token: ['/token', 'PUT', { baseRevision: 1, sourceId: SOURCE }],
        identity: ['/identity', 'PUT', { baseRevision: 1, scope: 'project', projectKey: 'changed-group', projectName: 'Changed' }]
      };
      const [suffix, method, data] = writes[operation];
      const response = await request('/api/projects/project-one' + suffix, { method, token: operation === 'sync' ? token : ADMIN, data });
      assert.equal(response.status, 410);
      const row = DB.db.prepare('SELECT * FROM projects WHERE id = ?').get('project-one');
      assert.equal(row.revision, 2);
      assert.equal(row.markdown, MARKDOWN);
      assert.equal(row.name, 'project-one');
      assert.equal(row.project_key, 'project-one');
      assert.equal(row.overrides_json, '{}');
      assert.ok(row.archived_at);
      assert.equal((await request('/api/projects/project-one', { token })).status, 403);
    });
  }
});

const PASSWORD = 'A long local test passphrase!';
const NEXT_PASSWORD = 'A different local test passphrase!';
const cookieFrom = result => result.response.headers.get('Set-Cookie')?.split(';')[0];

test('password setup stores only a salted peppered verifier and signs the current browser back in', async t => {
  const { request, login, DB } = setup(t);
  const oldCookie = await login();
  assert.deepEqual((await request('/api/password', { cookie: oldCookie })).value, { passwordSet: false });
  const set = await request('/api/password', { method: 'PUT', cookie: oldCookie, origin: ORIGIN, data: { password: PASSWORD } });
  assert.equal(set.status, 200, JSON.stringify(set.value));
  assert.deepEqual(set.value, { ok: true, passwordSet: true });
  const cookie = cookieFrom(set);
  assert.ok(cookie && cookie !== oldCookie);
  assert.equal((await request('/api/projects', { cookie: oldCookie })).status, 401);
  assert.equal((await request('/api/projects', { cookie })).status, 200);
  assert.equal((await request('/api/diagrams', { cookie })).status, 200);
  assert.deepEqual((await request('/api/password', { cookie })).value, { passwordSet: true });
  const row = DB.db.prepare('SELECT * FROM workspace_password').get();
  assert.match(row.salt, /^[a-f0-9]{64}$/);
  assert.match(row.verifier, /^[a-f0-9]{64}$/);
  assert.match(row.version, /^[a-f0-9]{64}$/);
  assert.equal(row.iterations, 100000);
  assert.ok(row.updated_at);
  assert.ok(!JSON.stringify(row).includes(PASSWORD));
  assert.notEqual(row.verifier, createHash('sha256').update(PASSWORD).digest('hex'));
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
});

test('chosen password signs into both modes while the owner key remains a separate recovery credential', async t => {
  const { request, DB } = setup(t);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: ADMIN } })).status, 200);
  assert.equal((await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } })).status, 200);
  const before = { ...DB.db.prepare('SELECT * FROM workspace_password').get() };
  for (const password of ['wrong passphrase text', ADMIN, '', null]) {
    const denied = await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password } });
    assert.equal(denied.status, 401);
    assert.equal(denied.response.headers.get('Set-Cookie'), null);
    assert.equal(denied.value.error, 'The password or access key is incorrect.');
  }
  const login = await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: PASSWORD } });
  assert.equal(login.status, 200);
  for (const path of ['/api/projects', '/api/diagrams']) assert.equal((await request(path, { cookie: cookieFrom(login) })).status, 200);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { key: ADMIN } })).status, 200);
  assert.deepEqual({ ...DB.db.prepare('SELECT * FROM workspace_password').get() }, before);
});

test('password settings reject public and project-scoped access and require exact browser Origin', async t => {
  const { request, create, login, DB, env } = setup(t);
  const { token } = await create(); const cookie = await login();
  for (const method of ['GET', 'PUT']) {
    const data = method === 'PUT' ? { password: PASSWORD } : undefined;
    assert.equal((await request('/api/password', { method, data })).status, 401);
    assert.equal((await request('/api/password', { method, token, data })).status, 403);
  }
  for (const origin of [undefined, 'https://evil.example']) {
    assert.equal((await request('/api/password', { method: 'PUT', cookie, origin, data: { password: PASSWORD } })).status, 403);
  }
  assert.equal((await request('/api/password', { method: 'PUT', token: ADMIN, origin: 'https://evil.example', data: { password: PASSWORD } })).status, 403);
  const missingOrigin = await worker.fetch(new Request(ORIGIN + '/api/password', { method: 'PUT', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) }), env);
  assert.equal(missingOrigin.status, 403);
  assert.equal(DB.db.prepare('SELECT verifier FROM workspace_password').get().verifier, null);
});

test('password validation counts Unicode characters and preserves spaces without trimming', async t => {
  const { request } = setup(t);
  for (const password of ['a'.repeat(14), 'a'.repeat(129), '😀'.repeat(129), 'a'.repeat(14) + '\n', 'a'.repeat(14) + '\u0000', 'a'.repeat(14) + '\ud800', 123, null]) {
    const result = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password } });
    assert.equal(result.status, 400, String(password));
  }
  const password = ' ' + '😀'.repeat(126) + ' ';
  assert.equal((await request('/api/password', { method: 'PUT', token: ADMIN, data: { password } })).status, 200);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password } })).status, 200);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: password.trim() } })).status, 401);
});

test('password change needs the current password for cookie users and invalidates every earlier browser session', async t => {
  const { request, DB } = setup(t);
  const set = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } });
  const cookie = cookieFrom(set);
  const second = await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: PASSWORD } });
  const prior = { ...DB.db.prepare('SELECT * FROM workspace_password').get() };
  for (const currentPassword of [undefined, 'a different wrong password']) {
    const denied = await request('/api/password', { method: 'PUT', cookie, origin: ORIGIN, data: { password: NEXT_PASSWORD, currentPassword } });
    assert.equal(denied.status, 400);
    assert.match(denied.value.error, /current password/);
    assert.deepEqual({ ...DB.db.prepare('SELECT * FROM workspace_password').get() }, prior);
    assert.equal((await request('/api/projects', { cookie })).status, 200);
  }
  const changed = await request('/api/password', { method: 'PUT', cookie, origin: ORIGIN, data: { password: NEXT_PASSWORD, currentPassword: PASSWORD } });
  assert.equal(changed.status, 200);
  const replacement = cookieFrom(changed);
  for (const stale of [cookie, cookieFrom(second)]) assert.equal((await request('/api/projects', { cookie: stale })).status, 401);
  assert.equal((await request('/api/projects', { cookie: replacement })).status, 200);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: PASSWORD } })).status, 401);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: NEXT_PASSWORD } })).status, 200);
  const after = DB.db.prepare('SELECT * FROM workspace_password').get();
  assert.notEqual(after.version, prior.version);
  assert.notEqual(after.salt, prior.salt);
  assert.notEqual(after.verifier, prior.verifier);
});

test('the owner bearer can reset a forgotten password without changing project credentials or documents', async t => {
  const { request, create, DB } = setup(t);
  const { token } = await create();
  const before = { ...DB.db.prepare('SELECT * FROM projects').get() };
  await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } });
  const reset = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: NEXT_PASSWORD } });
  assert.equal(reset.status, 200);
  assert.deepEqual({ ...DB.db.prepare('SELECT * FROM projects').get() }, before);
  assert.equal((await request('/api/projects/project-one', { token })).status, 200);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: NEXT_PASSWORD } })).status, 200);
});

test('password setup and sign-in fail safely without the dedicated pepper while owner recovery still works', async t => {
  const { request, env, DB } = setup(t);
  const pepper = env.PASSWORD_PEPPER;
  delete env.PASSWORD_PEPPER;
  assert.equal((await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } })).status, 503);
  assert.equal(DB.db.prepare('SELECT verifier FROM workspace_password').get().verifier, null);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { key: ADMIN } })).status, 200);
  env.PASSWORD_PEPPER = pepper;
  await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } });
  delete env.PASSWORD_PEPPER;
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: PASSWORD } })).status, 503);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { key: ADMIN } })).status, 200);
  assert.equal((await request('/api/projects', { token: ADMIN })).status, 200);
});

test('owner key rotation invalidates browser sessions but keeps the chosen password usable with its independent pepper', async t => {
  const { request, env } = setup(t);
  const set = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } });
  const cookie = cookieFrom(set);
  env.ADMIN_KEY = 'a new local administrator key' + 'b'.repeat(48);
  assert.equal((await request('/api/projects', { cookie })).status, 401);
  const login = await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal((await request('/api/projects', { cookie: cookieFrom(login) })).status, 200);
});

test('old SHA-only cookies survive rollout before password setup and cannot return after setup', async t => {
  const { request, DB } = setup(t);
  const token = 'c'.repeat(64); const digest = createHash('sha256').update(token).digest('hex');
  const cookie = `checklist_session=${token}`;
  const insert = () => DB.db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(digest, Math.floor(Date.now() / 1000) + 3600);
  insert();
  assert.equal((await request('/api/projects', { cookie })).status, 200);
  await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } });
  assert.equal((await request('/api/projects', { cookie })).status, 401);
  insert();
  assert.equal((await request('/api/projects', { cookie })).status, 401);
});

test('sign-in attempts use a durable hashed edge-IP bucket with bounded cleanup and no forwarded-header bypass', async t => {
  const { request, DB } = setup(t);
  const attempt = headers => request('/api/session', { method: 'POST', origin: ORIGIN, headers, data: { password: 'incorrect password text' } });
  for (let index = 0; index < 10; index++) assert.equal((await attempt({ 'CF-Connecting-IP': 'fixture-address-5', 'X-Forwarded-For': `spoofed-forwarded-${index}` })).status, 401);
  const blocked = await attempt({ 'CF-Connecting-IP': 'fixture-address-5', 'X-Forwarded-For': 'spoofed-alternate-5' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.response.headers.get('Retry-After')) > 0);
  assert.equal((await attempt({ 'CF-Connecting-IP': 'fixture-address-6' })).status, 401);
  const rows = DB.db.prepare('SELECT * FROM password_attempts').all();
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row.bucket, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(rows).includes('fixture-address-'));
  assert.equal((await request('/api/projects', { token: ADMIN })).status, 200);
  DB.db.exec('UPDATE password_attempts SET expires_at = 1');
  assert.equal((await attempt({ 'CF-Connecting-IP': 'fixture-address-5' })).status, 401);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM password_attempts').get().count, 1);
});

test('repeated incorrect current passwords are limited without signing out the legitimate browser', async t => {
  const { request } = setup(t);
  const set = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } });
  const cookie = cookieFrom(set);
  const change = () => request('/api/password', { method: 'PUT', cookie, origin: ORIGIN, data: { password: NEXT_PASSWORD, currentPassword: 'incorrect current password' } });
  for (let index = 0; index < 10; index++) assert.equal((await change()).status, 400);
  assert.equal((await change()).status, 429);
  assert.equal((await request('/api/projects', { cookie })).status, 200);
});

test('expired attempt buckets reset even when bounded cleanup cannot reach the requested bucket', async t => {
  const { request, DB } = setup(t);
  const attempt = () => request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: 'incorrect password text' } });
  assert.equal((await attempt()).status, 401);
  DB.db.exec('UPDATE password_attempts SET attempts = 11, expires_at = 2');
  const insert = DB.db.prepare('INSERT INTO password_attempts (bucket, attempts, expires_at) VALUES (?, 11, 1)');
  for (let index = 0; index < 129; index++) insert.run(`synthetic-expired-${index}`);
  assert.equal((await attempt()).status, 401);
  const rows = DB.db.prepare('SELECT * FROM password_attempts').all();
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(row => row.expires_at > 2).length, 1);
  assert.equal(rows.find(row => row.expires_at > 2).attempts, 1);
});

test('attempt bucket storage stays bounded while existing users and owner API access keep working', async t => {
  const { request, DB } = setup(t);
  const attempt = address => request('/api/session', { method: 'POST', origin: ORIGIN, headers: { 'CF-Connecting-IP': address }, data: { password: 'incorrect password text' } });
  assert.equal((await attempt('fixture-address-7')).status, 401);
  const insert = DB.db.prepare('INSERT INTO password_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?)');
  const expires = Math.floor(Date.now() / 1000) + 900;
  for (let index = 1; index < 4096; index++) insert.run(`synthetic-active-${index}`, expires);
  assert.equal((await attempt('fixture-address-8')).status, 429);
  assert.equal((await attempt('fixture-address-7')).status, 401);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM password_attempts').get().count, 4096);
  assert.equal((await request('/api/projects', { token: ADMIN })).status, 200);
});

test('a password reset that races an old-password sign-in prevents that sign-in from minting a usable cookie', async t => {
  const { request, DB } = setup(t);
  await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } });
  const originalPrepare = DB.prepare.bind(DB); let intercepted = false;
  DB.prepare = sql => {
    const prepared = originalPrepare(sql);
    if (!intercepted && sql.startsWith('INSERT INTO sessions (token_hash, expires_at) SELECT')) {
      return { ...prepared, bind: (...args) => {
        const bound = prepared.bind(...args);
        return { ...bound, run: async () => {
          intercepted = true;
          const reset = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: NEXT_PASSWORD } });
          assert.equal(reset.status, 200);
          return bound.run();
        } };
      } };
    }
    return prepared;
  };
  const staleLogin = await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: PASSWORD } });
  assert.equal(staleLogin.status, 409);
  assert.equal(staleLogin.response.headers.get('Set-Cookie'), null);
  const currentLogin = await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: NEXT_PASSWORD } });
  assert.equal(currentLogin.status, 200);
});

test('concurrent password resets do not delete the winning session or overwrite its verifier', async t => {
  const { request, DB } = setup(t);
  await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } });
  const originalBatch = DB.batch.bind(DB); let winningCookie; let intercepted = false;
  DB.batch = async statements => {
    if (!intercepted) {
      intercepted = true;
      const winner = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: NEXT_PASSWORD } });
      assert.equal(winner.status, 200);
      winningCookie = cookieFrom(winner);
    }
    return originalBatch(statements);
  };
  const loser = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: 'This stale change must never win' } });
  assert.equal(loser.status, 409);
  assert.equal(loser.response.headers.get('Set-Cookie'), null);
  assert.equal((await request('/api/projects', { cookie: winningCookie })).status, 200);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  assert.equal((await request('/api/session', { method: 'POST', origin: ORIGIN, data: { password: NEXT_PASSWORD } })).status, 200);
});

test('an interrupted password-change transaction rolls back its verifier and session revocation together', async t => {
  const { request, DB } = setup(t);
  const initial = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: PASSWORD } });
  const cookie = cookieFrom(initial);
  const before = { ...DB.db.prepare('SELECT * FROM workspace_password').get() };
  const originalBatch = DB.batch.bind(DB);
  DB.batch = statements => originalBatch([statements[0], { _run: () => { throw new Error('Synthetic transaction failure'); } }, statements[2]]);
  const failed = await request('/api/password', { method: 'PUT', token: ADMIN, data: { password: NEXT_PASSWORD } });
  assert.equal(failed.status, 500);
  assert.deepEqual({ ...DB.db.prepare('SELECT * FROM workspace_password').get() }, before);
  assert.equal((await request('/api/projects', { cookie })).status, 200);
});

const EDIT_UUID = '6002712b-2a48-463e-84a5-1889a35df1b0';
const EDIT_CHAT = '8625b5c9-c5b7-42ce-8c14-bd8db7f52979';
const EDIT_NEXT_CHAT = '1d6a1ae4-fc67-4e99-8974-5ccadb5595b8';
const EDIT_ANNOTATION = { id: 'pin-one', kind: 'point', x: 0.25, y: 0.75, width: 0, height: 0, view: 'diagram', nodeId: 'A', nodeLabel: 'First', comment: '  Put this node before the second step.\nKeep its current label.  ' };
const EDIT_HASH = createHash('sha256').update(diagramSvg).digest('hex');
const EDIT_INPUT = { id: EDIT_UUID, baseRevision: 1, baseHash: EDIT_HASH, originChatId: EDIT_CHAT, annotations: [EDIT_ANNOTATION] };
async function createEditableDiagram(request, id = 'edit-flow') {
  const created = await request('/api/diagrams/' + id, { method: 'PUT', token: ADMIN, data: diagramInput });
  assert.equal(created.status, 201);
  return created.value.diagram;
}

test('Mermaid edit origins and saved requests require owner authorization and same-origin browser writes', async t => {
  const { request, create, login } = setup(t);
  await createEditableDiagram(request);
  const { token } = await create();
  const cookie = await login();
  for (const path of ['/api/diagrams/edit-flow/origin', '/api/diagrams/edit-flow/requests', '/api/diagram-edit-requests/' + EDIT_UUID]) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, { token })).status, 403);
  }
  for (const [path, method, data] of [['/api/diagrams/edit-flow/origin', 'PUT', { originChatId: EDIT_CHAT }], ['/api/diagrams/edit-flow/requests', 'POST', EDIT_INPUT]]) {
    assert.equal((await request(path, { method, data, cookie })).status, 403);
    assert.equal((await request(path, { method, data, cookie, origin: 'https://unrelated.example' })).status, 403);
    assert.equal((await request(path, { method, data, token })).status, 403);
    assert.equal((await request(path, { method, data, token: ADMIN, origin: 'https://unrelated.example' })).status, 403);
    assert.ok([200, 201].includes((await request(path, { method, data, cookie, origin: ORIGIN })).status));
  }
  assert.equal((await request('/api/diagram-edit-requests/' + EDIT_UUID, { method: 'PATCH', cookie, data: { status: 'applied' } })).status, 403);
  const privateResponse = await request('/api/diagrams/edit-flow/requests', { cookie });
  assert.equal(privateResponse.response.headers.get('Cache-Control'), 'no-store');
  assert.equal(privateResponse.response.headers.get('Access-Control-Allow-Origin'), null);
});

test('Mermaid origin metadata is separate and stores only validated chat UUIDs', async t => {
  const { request } = setup(t);
  const diagram = await createEditableDiagram(request);
  const originPath = '/api/diagrams/edit-flow/origin';
  assert.deepEqual((await request(originPath, { token: ADMIN })).value, { originChatId: null, diagramHash: EDIT_HASH });
  assert.equal((await request('/api/diagrams/missing-flow/origin', { method: 'PUT', token: ADMIN, data: { originChatId: EDIT_CHAT } })).status, 404);
  for (const value of ['', 'codex://threads/' + EDIT_CHAT, {}, 5, 'not-a-chat']) assert.equal((await request(originPath, { method: 'PUT', token: ADMIN, data: { originChatId: value } })).status, 400);
  assert.equal((await request(originPath, { method: 'PUT', token: ADMIN, data: {} })).status, 400);
  assert.deepEqual((await request(originPath, { method: 'PUT', token: ADMIN, data: { originChatId: EDIT_CHAT.toUpperCase() } })).value, { originChatId: EDIT_CHAT, diagramHash: EDIT_HASH });
  assert.deepEqual((await request('/api/diagrams/edit-flow', { token: ADMIN })).value.diagram, diagram);
  assert.deepEqual((await request(originPath, { method: 'PUT', token: ADMIN, data: { originChatId: null } })).value, { originChatId: null, diagramHash: EDIT_HASH });
});

test('Mermaid saves exact immutable comments without modifying diagram, checklist or password data', async t => {
  const { request, DB, create } = setup(t);
  const diagram = await createEditableDiagram(request);
  const { project } = await create();
  const passwordBefore = { ...DB.db.prepare('SELECT * FROM workspace_password').get() };
  const result = await request('/api/diagrams/edit-flow/requests', { method: 'POST', token: ADMIN, data: EDIT_INPUT });
  assert.equal(result.status, 201, JSON.stringify(result.value));
  const saved = result.value.request;
  assert.deepEqual(saved.annotations, EDIT_INPUT.annotations);
  assert.equal(saved.diagramId, diagram.id);
  assert.equal(saved.diagramRevision, diagram.revision);
  assert.equal(saved.diagramHash, EDIT_HASH);
  assert.equal(saved.diagramTitle, diagram.title);
  assert.equal(saved.originChatId, EDIT_CHAT);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.appliedRevision, null);
  assert.ok(Number.isFinite(Date.parse(saved.createdAt)));
  assert.equal(Object.hasOwn(saved, 'payloadHash'), false);
  assert.deepEqual((await request('/api/diagram-edit-requests/' + EDIT_UUID, { token: ADMIN })).value.request, saved);
  assert.deepEqual((await request('/api/diagrams/edit-flow/requests', { token: ADMIN })).value.requests, [saved]);
  assert.deepEqual((await request('/api/diagrams/edit-flow', { token: ADMIN })).value.diagram, diagram);
  assert.deepEqual((await request('/api/projects/' + project.id, { token: ADMIN })).value.project, project);
  assert.deepEqual({ ...DB.db.prepare('SELECT * FROM workspace_password').get() }, passwordBefore);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM diagram_edit_requests').get().count, 1);
});

test('Mermaid request retries reuse the saved result and reject changed content or diagram identity', async t => {
  const { request, DB } = setup(t);
  await createEditableDiagram(request);
  await createEditableDiagram(request, 'other-flow');
  const path = '/api/diagrams/edit-flow/requests';
  const first = await request(path, { method: 'POST', token: ADMIN, data: EDIT_INPUT });
  assert.equal(first.status, 201);
  await request('/api/diagrams/edit-flow', { method: 'PUT', token: ADMIN, data: { ...diagramInput, baseRevision: 1 } });
  const retry = await request(path, { method: 'POST', token: ADMIN, data: EDIT_INPUT });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.value, first.value);
  assert.equal((await request(path, { method: 'POST', token: ADMIN, data: { ...EDIT_INPUT, annotations: [{ ...EDIT_ANNOTATION, comment: 'A different instruction.' }] } })).status, 409);
  assert.equal((await request('/api/diagrams/other-flow/requests', { method: 'POST', token: ADMIN, data: EDIT_INPUT })).status, 409);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM diagram_edit_requests').get().count, 1);
});

test('implicit request destinations remain stable when the diagram chat link later changes', async t => {
  const { request } = setup(t);
  await createEditableDiagram(request);
  const origin = '/api/diagrams/edit-flow/origin';
  const path = '/api/diagrams/edit-flow/requests';
  await request(origin, { method: 'PUT', token: ADMIN, data: { originChatId: EDIT_CHAT } });
  const input = { id: EDIT_UUID, baseRevision: 1, baseHash: EDIT_HASH, annotations: [EDIT_ANNOTATION] };
  const saved = await request(path, { method: 'POST', token: ADMIN, data: input });
  assert.equal(saved.value.request.originChatId, EDIT_CHAT);
  await request(origin, { method: 'PUT', token: ADMIN, data: { originChatId: EDIT_NEXT_CHAT } });
  const retry = await request(path, { method: 'POST', token: ADMIN, data: input });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.value, saved.value);
});

test('Mermaid request validation bounds geometry, comments, request bodies and diagram revisions', async t => {
  const { request, DB } = setup(t);
  await createEditableDiagram(request);
  const post = data => request('/api/diagrams/edit-flow/requests', { method: 'POST', token: ADMIN, data });
  const invalid = [
    { ...EDIT_INPUT, id: 'not-a-uuid' }, { ...EDIT_INPUT, baseRevision: 0 }, { ...EDIT_INPUT, baseRevision: 1.5 }, { ...EDIT_INPUT, originChatId: 'wrong' }, { ...EDIT_INPUT, baseHash: 'bad' }, { ...EDIT_INPUT, baseHash: undefined },
    { ...EDIT_INPUT, annotations: null }, { ...EDIT_INPUT, annotations: [] }, { ...EDIT_INPUT, annotations: [null] },
    ...[{ comment: '' }, { comment: 'x'.repeat(4001) }, { comment: 'invisible\u0000data' }, { id: '../bad' }, { kind: 'script' }, { x: null }, { x: -0.1 }, { x: 1.1 }, { y: '0.1' }, { width: 2 }, { kind: 'region', width: 0, height: 0.2 }, { kind: 'region', x: 0.8, width: 0.3, height: 0.2 }, { kind: 'diagram', width: 0.1 }, { view: '' }, { nodeId: 'x'.repeat(81) }, { nodeLabel: 'x'.repeat(241) }].map(change => ({ ...EDIT_INPUT, annotations: [{ ...EDIT_ANNOTATION, ...change }] })),
    { ...EDIT_INPUT, annotations: [EDIT_ANNOTATION, EDIT_ANNOTATION] },
    { ...EDIT_INPUT, annotations: Array.from({ length: 21 }, (_, i) => ({ ...EDIT_ANNOTATION, id: 'pin-' + i })) },
  ];
  for (const input of invalid) assert.equal((await post(input)).status, 400, JSON.stringify(input).slice(0, 150));
  assert.equal((await post({ ...EDIT_INPUT, annotations: Array.from({ length: 20 }, (_, i) => ({ ...EDIT_ANNOTATION, id: 'pin-' + i, comment: 'x'.repeat(4000) })) })).status, 413);
  assert.equal((await request('/api/diagrams/missing-flow/requests', { method: 'POST', token: ADMIN, data: EDIT_INPUT })).status, 404);
  assert.equal((await post({ ...EDIT_INPUT, baseRevision: 2 })).status, 409);
  assert.equal((await post({ ...EDIT_INPUT, baseHash: '0'.repeat(64) })).status, 409);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM diagram_edit_requests').get().count, 0);
  const valid = await post({ ...EDIT_INPUT, annotations: [{ id: 'whole-diagram', kind: 'diagram', comment: 'Simplify the diagram.' }, { ...EDIT_ANNOTATION, id: 'region', kind: 'region', width: 0.25, height: 0.1 }] });
  assert.equal(valid.status, 201);
  assert.deepEqual(valid.value.request.annotations[0], { id: 'whole-diagram', kind: 'diagram', x: 0, y: 0, width: 1, height: 1, view: 'diagram', nodeId: null, nodeLabel: null, comment: 'Simplify the diagram.' });
});

test('Mermaid request INSERT rechecks the diagram revision after a competing update', async t => {
  const { request, DB } = setup(t);
  await createEditableDiagram(request);
  const prepare = DB.prepare.bind(DB);
  let changed = false;
  DB.prepare = sql => {
    if (!changed && sql.startsWith('INSERT INTO diagram_edit_requests')) {
      changed = true;
      DB.db.prepare('UPDATE mermaid_diagrams SET revision = revision + 1 WHERE id = ?').run('edit-flow');
    }
    return prepare(sql);
  };
  const result = await request('/api/diagrams/edit-flow/requests', { method: 'POST', token: ADMIN, data: EDIT_INPUT });
  assert.equal(result.status, 409);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM diagram_edit_requests').get().count, 0);
});

test('Mermaid baseline hashes detect changed previews even if their revision number is unchanged', async t => {
  const { request, DB } = setup(t);
  await createEditableDiagram(request);
  const path = '/api/diagrams/edit-flow/requests';
  const prepare = DB.prepare.bind(DB);
  let changed = false;
  DB.prepare = sql => {
    if (!changed && sql.startsWith('INSERT INTO diagram_edit_requests')) {
      changed = true;
      DB.db.prepare('UPDATE mermaid_diagrams SET svg = ? WHERE id = ?').run(diagramSvg.replace('<rect ', '<rect fill="blue" '), 'edit-flow');
    }
    return prepare(sql);
  };
  assert.equal((await request(path, { method: 'POST', token: ADMIN, data: EDIT_INPUT })).status, 409);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM diagram_edit_requests').get().count, 0);
  const latest = (await request('/api/diagrams/edit-flow/origin', { token: ADMIN })).value;
  assert.notEqual(latest.diagramHash, EDIT_HASH);
  const saved = await request(path, { method: 'POST', token: ADMIN, data: { ...EDIT_INPUT, baseHash: latest.diagramHash } });
  assert.equal(saved.status, 201);
  assert.equal(saved.value.request.diagramRevision, 1);
  DB.db.prepare('UPDATE mermaid_diagrams SET svg = ? WHERE id = ?').run(diagramSvg, 'edit-flow');
  const retry = await request(path, { method: 'POST', token: ADMIN, data: { ...EDIT_INPUT, baseHash: latest.diagramHash } });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.value, saved.value);
});

test('Mermaid saved edit requests retain their comments when marked applied or dismissed', async t => {
  const { request } = setup(t);
  await createEditableDiagram(request);
  const saved = (await request('/api/diagrams/edit-flow/requests', { method: 'POST', token: ADMIN, data: EDIT_INPUT })).value.request;
  const path = '/api/diagram-edit-requests/' + EDIT_UUID;
  for (const data of [{ status: 'pending' }, { status: 'erase' }, { status: 'applied', appliedRevision: 0 }]) assert.equal((await request(path, { method: 'PATCH', token: ADMIN, data })).status, 400);
  const applied = (await request(path, { method: 'PATCH', token: ADMIN, data: { status: 'applied', appliedRevision: 2, annotations: [] } })).value.request;
  assert.deepEqual(applied, { ...saved, status: 'applied', appliedRevision: 2 });
  const dismissed = (await request(path, { method: 'PATCH', token: ADMIN, data: { status: 'dismissed' } })).value.request;
  assert.deepEqual(dismissed, { ...saved, status: 'dismissed', appliedRevision: null });
  assert.equal((await request(path, { method: 'DELETE', token: ADMIN })).status, 404);
  assert.equal((await request('/api/diagram-edit-requests/29433aa1-4964-4364-8f0e-04186fd3f15c', { token: ADMIN })).status, 404);
});

test('Mermaid request capacity blocks new rows while keeping idempotent retries available', async t => {
  const { request, DB } = setup(t);
  await createEditableDiagram(request);
  const path = '/api/diagrams/edit-flow/requests';
  const first = await request(path, { method: 'POST', token: ADMIN, data: EDIT_INPUT });
  const seed = DB.db.prepare('SELECT * FROM diagram_edit_requests WHERE id = ?').get(EDIT_UUID);
  const insert = DB.db.prepare('INSERT INTO diagram_edit_requests (id, diagram_id, diagram_revision, diagram_hash, diagram_title, annotations_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 999; i++) insert.run('capacity-' + i, 'edit-flow', 1, seed.diagram_hash, seed.diagram_title, seed.annotations_json, seed.payload_hash, seed.created_at);
  const blocked = await request(path, { method: 'POST', token: ADMIN, data: { ...EDIT_INPUT, id: '150120d2-2eb0-44df-8b2d-cdc3d3ed3c9d' } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.value.error, /1000/);
  assert.deepEqual((await request(path, { method: 'POST', token: ADMIN, data: EDIT_INPUT })).value, first.value);
  assert.equal((await request(path, { token: ADMIN })).value.requests.length, 100);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS count FROM diagram_edit_requests').get().count, 1000);
});

test('the built-in interactive Mermaid map accepts requests and separate origin metadata', async t => {
  const { request } = setup(t);
  if (!interactiveDiagram) return;
  const path = '/api/diagrams/interactive-example';
  assert.equal((await request(path + '/origin', { method: 'PUT', token: ADMIN, data: { originChatId: EDIT_CHAT } })).status, 200);
  const result = await request(path + '/requests', { method: 'POST', token: ADMIN, data: { ...EDIT_INPUT, baseHash: interactiveDiagram.sha256 } });
  assert.equal(result.status, 201);
  assert.equal(result.value.request.diagramId, 'interactive-example');
  assert.equal(result.value.request.diagramTitle, 'Interactive example');
  assert.equal((await request(path + '/requests', { token: ADMIN })).value.requests.length, 1);
});

test('diagram preview checksum preconditions bind the rendered SVG and HTML to their requested baseline', async t => {
  const { request } = setup(t);
  await createEditableDiagram(request);
  const fixtures = [{ path: '/diagram/edit-flow', checksum: EDIT_HASH, expected: diagramSvg }];
  if (interactiveDiagram) fixtures.push({ path: '/diagram/interactive-example', checksum: interactiveDiagram.sha256 });
  for (const { path, checksum, expected } of fixtures) {
    const bare = await request(path, { token: ADMIN });
    assert.equal(bare.status, 200);
    if (expected) assert.equal(bare.value, expected);
    for (const method of ['GET', 'HEAD']) {
      const matching = await request(path + '?checksum=' + checksum, { method, token: ADMIN });
      assert.equal(matching.status, 200);
      assert.equal(matching.value, method === 'HEAD' ? '' : bare.value);
      assert.equal(matching.response.headers.get('Content-Type'), bare.response.headers.get('Content-Type'));
      assert.equal(matching.response.headers.get('Cache-Control'), 'no-store');
      assert.equal((await request(path + '?checksum=' + '0'.repeat(64), { method, token: ADMIN })).status, 409);
      for (const suffix of ['?checksum=', '?checksum=wrong', '?checksum=' + checksum + '&checksum=' + checksum]) {
        assert.equal((await request(path + suffix, { method, token: ADMIN })).status, 400);
        assert.equal((await request(path + suffix, { method })).status, 401);
      }
    }
  }
});
