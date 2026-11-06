import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, parseArguments, sourceDigest } from '../scripts/checklist.mjs';
import { parseTasks, tasksWithOverrides, survivingOverrides } from '../src/tasks.mjs';

const testParent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'cli-tests');

async function fixture(t, { protectedHomes = [], env = {} } = {}) {
  await fs.mkdir(testParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(testParent, 'case-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.ok(resolved.toLowerCase().startsWith((testParent + path.sep).toLowerCase()));
    await fs.rm(resolved, { recursive: true });
  });
  const projectPath = path.join(root, 'project');
  const serviceRoot = path.join(root, 'service');
  await fs.mkdir(projectPath);
  await fs.mkdir(serviceRoot);
  const file = path.join(projectPath, 'CHECKLIST.md');
  const original = '# Launch\r\n\r\n- [ ] Ship preview\r\n- [x] Write brief\r\n';
  await fs.writeFile(file, original);
  const calls = [];
  const api = { project: null, overrides: {}, race: false, unavailable: false, loseCreateResponse: false, token: 'test-project-scoped-token', tokenRotations: 0 };
  const render = () => {
    const tasks = tasksWithOverrides(api.project.markdown, api.overrides);
    return { ...api.project, originChatId: api.project.scope === 'chat' ? api.project.chatId : api.project.originChatId ?? null, tasks, done: tasks.filter(task => task.checked).length, total: tasks.length };
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (api.unavailable) throw new Error('provider failure with private detail');
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === 'POST') {
      assert.equal(init.headers.authorization, 'Bearer test-admin-only');
      if (api.project) return Response.json({ error: 'exists' }, { status: 409 });
      api.project = { ...body, revision: 1, updatedAt: '2026-10-17T12:00:00Z' };
      if (api.loseCreateResponse) throw new Error('Lost create response.');
      return Response.json({ project: render(), token: api.token }, { status: 201 });
    }
    if (url.endsWith('/token')) {
      assert.equal(init.headers.authorization, 'Bearer test-admin-only');
      if (api.race || body.baseRevision !== api.project.revision || body.sourceId !== api.project.sourceId) return Response.json({ error: 'stale' }, { status: 409 });
      api.token = `test-project-scoped-token-recovered-${++api.tokenRotations}`;
      api.project.revision++;
      return Response.json({ project: render(), token: api.token });
    }
    if (!["Bearer test-admin-only", `Bearer ${api.token}`].includes(init.headers.authorization)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (!api.project) return Response.json({ error: 'missing' }, { status: 404 });
    if (init.method === 'GET') return Response.json({ project: render() });
    if (api.race || body.baseRevision !== api.project.revision) return Response.json({ error: 'stale' }, { status: 409 });
    api.project = { ...api.project, ...body, revision: api.project.revision + 1 };
    api.overrides = survivingOverrides(body.markdown, api.overrides);
    return Response.json({ project: render() });
  };
  const clientEnv = { CHECKLIST_URL: 'https://checklist.example', CHECKLIST_ADMIN_KEY: 'test-admin-only', ...env };
  const client = createClient({ serviceRoot, fetchImpl, protectedHomes, env: clientEnv });
  return { root, projectPath, serviceRoot, file, original, calls, api, client, env: clientEnv, options: { project: projectPath, name: 'Launch' } };
}

async function savedState(f) {
  const directory = path.join(f.serviceRoot, '.private', 'connections');
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  const file = path.join(directory, files[0]);
  return { file, state: JSON.parse(await fs.readFile(file, 'utf8')) };
}

const CHAT_A = '867523d0-69d3-4e99-8198-7bbb32063e1f';
const CHAT_B = '6b0236bc-558b-48a9-814a-fb97a18a6722';

async function scopeFixture(t) {
  const f = await fixture(t);
  const entries = new Map();
  const calls = [];
  const controls = { archiveBeforeSync: false };
  const render = entry => {
    const tasks = tasksWithOverrides(entry.project.markdown, entry.overrides);
    return { ...entry.project, originChatId: entry.project.scope === 'chat' ? entry.project.chatId : entry.project.originChatId ?? null, tasks, total: tasks.length, done: tasks.filter(task => task.checked).length };
  };
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    const admin = init.headers.authorization === 'Bearer test-admin-only';
    const route = new URL(url).pathname;
    if (route === '/api/projects' && init.method === 'POST') {
      assert.ok(admin);
      if (entries.has(body.id)) return Response.json({}, { status: 409 });
      const entry = { project: { ...body, archivedAt: null, revision: 1 }, token: `test-scoped-${body.id}`, overrides: {} };
      entries.set(body.id, entry);
      return Response.json({ project: render(entry), token: entry.token }, { status: 201 });
    }
    const id = route.split('/')[3];
    const entry = entries.get(id);
    if (!entry) return Response.json({}, { status: 404 });
    if (route.endsWith('/sync') && controls.archiveBeforeSync) { entry.project.archivedAt = '2026-10-18T10:00:00Z'; entry.project.revision++; entry.token = null; }
    if (!admin && (!entry.token || init.headers.authorization !== `Bearer ${entry.token}`)) return Response.json({}, { status: 403 });
    if (init.method === 'GET') return Response.json({ project: render(entry) });
    if (entry.project.archivedAt || body.baseRevision !== entry.project.revision) return Response.json({}, { status: 409 });
    if (route.endsWith('/archive')) {
      assert.ok(admin);
      entry.project.archivedAt = '2026-10-18T10:00:00Z';
      entry.token = null;
    } else if (route.endsWith('/identity')) {
      assert.ok(admin);
      const { baseRevision, ...metadata } = body;
      Object.assign(entry.project, metadata);
    } else if (route.endsWith('/sync')) {
      entry.project.markdown = body.markdown;
      entry.project.name = body.name;
    } else throw new Error(`Unexpected route ${route}`);
    entry.project.revision++;
    return Response.json({ project: render(entry) });
  };
  const client = createClient({ serviceRoot: f.serviceRoot, fetchImpl, protectedHomes: [], env: f.env });
  return { ...f, client, entries, calls, controls };
}

async function addChat(f, chat, title) {
  const folder = path.join(f.projectPath, '.checklist', 'chats');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `${chat}.md`);
  await fs.writeFile(file, `# ${title}\n\n- [ ] Task for ${title}\n`);
  const options = { ...f.options, chat, 'chat-name': title, instructions: true };
  const result = await f.client.connect(options);
  return { file, options, result, configPath: path.join(folder, `${chat}.json`) };
}

test('connect preserves original bytes in backup, stores token outside the project and adds instructions', async t => {
  const f = await fixture(t);
  const instructions = '# Existing rules\n\nKeep these.\n';
  await fs.writeFile(path.join(f.projectPath, 'AGENTS.md'), instructions);
  const result = await f.client.connect({ ...f.options, instructions: true });
  const config = JSON.parse(await fs.readFile(path.join(f.projectPath, '.checklist.json')));
  assert.equal(result.projectId, config.id);
  assert.equal(result.url, `https://checklist.example/#project=${config.id}`);
  assert.equal(config.token, undefined);
  assert.equal(JSON.stringify(result).includes('test-project-scoped-token'), false);
  const state = JSON.parse(await fs.readFile(path.join(f.serviceRoot, '.private', 'connections', `${config.id}.json`)));
  assert.equal(state.token, 'test-project-scoped-token');
  const source = await fs.readFile(f.file, 'utf8');
  assert.equal(parseTasks(source).length, 2);
  assert.ok(parseTasks(source).every(task => task.id));
  assert.ok(source.includes('\r\n'));
  const files = await fs.readdir(f.projectPath);
  const backup = files.find(name => name.startsWith('CHECKLIST.md.checklist-backup-'));
  assert.equal(await fs.readFile(path.join(f.projectPath, backup), 'utf8'), f.original);
  const updatedInstructions = await fs.readFile(path.join(f.projectPath, 'AGENTS.md'), 'utf8');
  assert.ok(updatedInstructions.startsWith(instructions));
  await f.client.addInstructions(f.projectPath, 'CHECKLIST.md');
  assert.equal(await fs.readFile(path.join(f.projectPath, 'AGENTS.md'), 'utf8'), updatedInstructions);
  await assert.rejects(f.client.connect(f.options), /already has/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('a new project remembers its original environment chat and later sync or index never reroutes it', async t => {
  const f = await fixture(t, { env: { CODEX_THREAD_ID: CHAT_A.toUpperCase() } });
  const created = await f.client.connect(f.options);
  assert.equal(created.scope, 'project');
  assert.equal(created.chatId, null);
  assert.equal(created.originChatId, CHAT_A);
  assert.equal(f.calls[0].body.originChatId, CHAT_A);
  assert.equal((await savedState(f)).state.originChatId, CHAT_A);
  const config = JSON.parse(await fs.readFile(path.join(f.projectPath, '.checklist.json')));
  assert.equal(config.originChatId, CHAT_A);
  f.env.CODEX_THREAD_ID = CHAT_B;
  await fs.appendFile(f.file, '\n- [ ] Later task from another chat\n');
  await f.client.sync(f.options);
  const sync = f.calls.findLast(call => call.url.endsWith('/sync'));
  assert.equal(Object.hasOwn(sync.body, 'originChatId'), false);
  assert.equal((await f.client.status(f.options)).originChatId, CHAT_A);
  assert.equal((await savedState(f)).state.originChatId, CHAT_A);
});

test('an explicit original chat overrides the environment while a chat checklist always uses its selected chat', async t => {
  const project = await fixture(t, { env: { CODEX_THREAD_ID: CHAT_B } });
  const created = await project.client.connect({ ...project.options, 'origin-chat': CHAT_A.toUpperCase() });
  assert.equal(created.originChatId, CHAT_A);
  const chat = await fixture(t, { env: { CODEX_THREAD_ID: CHAT_B } });
  const chatCreated = await chat.client.connect({ ...chat.options, chat: CHAT_A, 'chat-name': 'Selected chat', 'origin-chat': CHAT_B });
  assert.equal(chatCreated.originChatId, CHAT_A);
  assert.equal(chatCreated.scope, 'chat');
  assert.equal((await chat.client.status({ project: chat.projectPath, chat: CHAT_A })).originChatId, CHAT_A);
});

test('origin options reject malformed UUIDs and an unverified environment value creates no chat link', async t => {
  const f = await fixture(t, { env: { CODEX_THREAD_ID: 'not-a-chat-UUID' } });
  for (const value of ['', 'chat-name', ` ${CHAT_A}`, `${CHAT_A}\n`]) await assert.rejects(f.client.connect({ ...f.options, 'origin-chat': value }), /verified original Codex chat UUID/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.client.connect(f.options)).originChatId, null);
  assert.equal((await f.client.status(f.options)).originChatId, null);
  assert.deepEqual(parseArguments(['index', '--project', '/example/project', '--origin-chat', CHAT_A]), { command: 'index', options: { project: '/example/project', 'origin-chat': CHAT_A } });
});

test('index can assign a project origin without resetting its website grouping or checklist content', async t => {
  const f = await scopeFixture(t);
  const created = await f.client.connect(f.options);
  const remote = f.entries.get(created.projectId).project;
  Object.assign(remote, { projectKey: 'website-project-group', projectName: 'Website project name' });
  remote.revision++;
  const beforeSource = await fs.readFile(f.file, 'utf8');
  const beforeMarkdown = remote.markdown;
  const indexed = await f.client.index({ project: f.projectPath, 'origin-chat': CHAT_A.toUpperCase() });
  assert.equal(indexed.originChatId, CHAT_A);
  assert.equal(indexed.scope, 'project');
  assert.equal(remote.projectKey, 'website-project-group');
  assert.equal(remote.projectName, 'Website project name');
  assert.equal(remote.chatId, null);
  assert.equal(remote.markdown, beforeMarkdown);
  assert.equal(await fs.readFile(f.file, 'utf8'), beforeSource);
  assert.equal((await f.client.status(f.options)).originChatId, CHAT_A);
  f.env.CODEX_THREAD_ID = CHAT_B;
  const ordinaryIndex = await f.client.index({ project: f.projectPath, name: 'Explicitly renamed project' });
  assert.equal(ordinaryIndex.originChatId, CHAT_A);
  const ordinaryWrite = f.calls.findLast(call => call.url.endsWith('/identity'));
  assert.equal(Object.hasOwn(ordinaryWrite.body, 'originChatId'), false);
  assert.equal(remote.originChatId, CHAT_A);
  const before = f.calls.length;
  await assert.rejects(f.client.index({ project: f.projectPath, 'origin-chat': '../invalid' }), /verified original Codex chat UUID/);
  assert.ok(f.calls.slice(before).every(call => call.method === 'GET'));
});

test('assigning an origin to a root connection classified as a chat preserves its grouping and local selector', async t => {
  const f = await scopeFixture(t);
  const created = await f.client.connect(f.options);
  const remote = f.entries.get(created.projectId).project;
  Object.assign(remote, { scope: 'chat', projectKey: 'verified-project-group', projectName: 'Actual project', chatId: CHAT_A, chatTitle: 'Original chat' });
  remote.revision++;
  const indexed = await f.client.index({ project: f.projectPath, 'origin-chat': CHAT_B });
  assert.equal(indexed.scope, 'chat');
  assert.equal(indexed.originChatId, CHAT_A);
  assert.equal(remote.chatId, CHAT_A);
  assert.equal(remote.projectKey, 'verified-project-group');
  assert.equal(remote.chatTitle, 'Original chat');
  const config = JSON.parse(await fs.readFile(path.join(f.projectPath, '.checklist.json')));
  assert.equal(config.scope, 'project');
  assert.equal(config.chatId, null);
  assert.equal((await f.client.status({ project: f.projectPath })).chatId, CHAT_A);
  await fs.appendFile(f.file, '\n- [ ] Preserve root source selector\n');
  await f.client.sync({ project: f.projectPath });
  assert.equal(remote.chatId, CHAT_A);
  assert.equal((await f.client.status({ project: f.projectPath })).originChatId, CHAT_A);
});

test('sync adds new tasks and preserves manual checks after another revision', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  const firstId = parseTasks(f.api.project.markdown)[0].id;
  f.api.overrides[firstId] = true;
  f.api.project.revision++;
  await fs.appendFile(f.file, '- [ ] New task\r\n');
  await f.client.sync(f.options);
  assert.equal(parseTasks(f.api.project.markdown).length, 3);
  assert.equal(f.api.overrides[firstId], true);
  const status = await f.client.status(f.options);
  assert.equal(status.localChanges, false);
  assert.equal(status.done, 2);
});

test('show reads remote content without exposing credentials and unchanged sync avoids a PUT', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  const before = await fs.readFile(f.file, 'utf8');
  const shown = await f.client.show(f.options);
  assert.equal(shown.project.markdown, f.api.project.markdown);
  assert.equal(shown.project.revision, 1);
  assert.equal(JSON.stringify(shown).includes('test-project-scoped-token'), false);
  await f.client.sync(f.options);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('remote Markdown edits cause a conflict without a PUT or local data loss', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  const local = await fs.readFile(f.file, 'utf8');
  f.api.project.markdown += '\nA note from the website.\n';
  f.api.project.revision++;
  await assert.rejects(f.client.sync(f.options), /website document changed/);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(await fs.readFile(f.file, 'utf8'), local);
  assert.equal((await f.client.status(f.options)).remoteDocumentChanges, true);
});

test('a reviewed revision permits a merged document, while a stale review is rejected', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  f.api.project.markdown += '\nWebsite note.\n';
  f.api.project.revision++;
  await fs.appendFile(f.file, '\nWebsite note.\nLocal note.\n');
  await assert.rejects(f.client.sync({ ...f.options, 'reviewed-revision': '1' }), /reviewed revision/);
  await f.client.sync({ ...f.options, 'reviewed-revision': '2' });
  assert.ok(f.api.project.markdown.includes('Website note.\nLocal note.'));
});

test('revision races cause one PUT and no automatic retry', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  f.api.race = true;
  await fs.appendFile(f.file, '\n- [ ] Concurrent task\n');
  await assert.rejects(f.client.sync(f.options), /Conflict:/);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  assert.ok((await fs.readFile(f.file, 'utf8')).includes('Concurrent task'));
});

test('pull retrieves manual completion with a backup and refuses unpushed edits', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  const firstId = parseTasks(f.api.project.markdown)[0].id;
  f.api.overrides[firstId] = true;
  f.api.project.revision++;
  const result = await f.client.pull(f.options);
  assert.ok(result.backup);
  assert.equal(parseTasks(await fs.readFile(f.file, 'utf8'))[0].sourceChecked, true);
  assert.equal((await f.client.status(f.options)).localChanges, false);
  await fs.appendFile(f.file, '\nLocal unsent note.\n');
  const before = await fs.readFile(f.file, 'utf8');
  await assert.rejects(f.client.pull(f.options), /unpushed changes/);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('protected homes, traversal, and symlinks are rejected before enrollment', async t => {
  const f = await fixture(t);
  const protectedClient = createClient({ serviceRoot: f.serviceRoot, protectedHomes: [f.root] });
  await assert.rejects(protectedClient.connect(f.options), /protected home/);
  await assert.rejects(f.client.connect({ ...f.options, file: '../outside.md' }), /inside this project/);
  const target = path.join(f.root, 'outside');
  await fs.mkdir(target);
  await fs.symlink(target, path.join(f.projectPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.client.connect({ ...f.options, file: 'linked/tasks.md' }), /symbolic link or junction/);
  assert.equal(f.calls.length, 0);
});

test('project metadata cannot redirect an enrolled credential to another Markdown file', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  const metadataPath = path.join(f.projectPath, '.checklist.json');
  const config = JSON.parse(await fs.readFile(metadataPath));
  await fs.writeFile(path.join(f.projectPath, 'PRIVATE.md'), 'Not the enrolled source.\n');
  await fs.writeFile(metadataPath, JSON.stringify({ ...config, file: 'PRIVATE.md' }));
  const callsBefore = f.calls.length;
  await assert.rejects(f.client.sync(f.options), /enrolled source file/);
  await assert.rejects(f.client.recover({ project: f.projectPath }), /different files/);
  assert.equal(f.calls.length, callsBefore);
});

test('uncertain connection is recorded and cannot silently send a duplicate create', async t => {
  const f = await fixture(t);
  f.api.unavailable = true;
  await assert.rejects(f.client.connect(f.options), /No automatic retry/);
  await assert.rejects(f.client.connect({ ...f.options, name: 'Renamed project' }), /connection record already exists/);
  assert.equal(f.calls.length, 1);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
});

test('recover confirms a missing remote before replaying the exact initial create once', async t => {
  const f = await fixture(t);
  f.api.unavailable = true;
  await assert.rejects(f.client.connect(f.options), /No automatic retry/);
  const initialRequest = f.calls[0].body;
  f.api.unavailable = false;
  const result = await f.client.recover({ project: f.projectPath });
  const creates = f.calls.filter(call => call.method === 'POST');
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[1].body, initialRequest);
  assert.equal(f.calls[1].method, 'GET');
  assert.equal(result.localChanges, false);
  assert.equal(f.api.tokenRotations, 0);
  assert.equal((await f.client.status(f.options)).localChanges, false);
  assert.equal(JSON.stringify(result).includes(f.api.token), false);
});

test('recover finds an existing project after response loss and recovers its scoped token', async t => {
  const f = await fixture(t);
  f.api.loseCreateResponse = true;
  await assert.rejects(f.client.connect(f.options), /No automatic retry/);
  const initial = f.api.project.markdown;
  f.api.overrides[parseTasks(initial)[0].id] = true;
  f.api.loseCreateResponse = false;
  const result = await f.client.recover({ project: f.projectPath });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.api.tokenRotations, 1);
  assert.equal(f.api.project.markdown, initial);
  assert.equal(parseTasks(await fs.readFile(f.file, 'utf8'))[0].sourceChecked, true);
  assert.equal(result.localChanges, false);
  assert.equal((await savedState(f)).state.token, f.api.token);
});

test('recover reuses a valid saved credential when local metadata was interrupted', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  await fs.unlink(path.join(f.projectPath, '.checklist.json'));
  await f.client.recover({ project: f.projectPath });
  assert.equal(f.api.tokenRotations, 0);
  assert.equal((await f.client.status(f.options)).localChanges, false);
});

test('recover preserves an unsent revert to enrollment content after a later sync', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  await fs.appendFile(f.file, '\n- [ ] Added after enrollment\n');
  await f.client.sync(f.options);
  await fs.writeFile(f.file, f.original);
  await assert.rejects(f.client.recover({ project: f.projectPath }), /Local checklist differs/);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
  assert.equal(f.api.tokenRotations, 0);
  // Losing metadata must not make an established source revert look unchanged.
  await fs.unlink(path.join(f.projectPath, '.checklist.json'));
  await assert.rejects(f.client.recover({ project: f.projectPath }), /Local checklist differs/);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
});

test('recover upgrades a legacy filename record using verified metadata and the saved token', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  const saved = await savedState(f);
  for (const name of ['file', 'name', 'initialMarkdown', 'initialInputDigest', 'initialFileExisted', 'enrolledAt']) delete saved.state[name];
  await fs.writeFile(saved.file, JSON.stringify(saved.state));
  await assert.rejects(f.client.status(f.options), /enrolled source file/);
  // The local baseline has no unpushed edits, so a newer website document is safe.
  f.api.project.markdown += '\nNew note from the website.\n';
  f.api.project.revision++;
  const result = await f.client.recover({ project: f.projectPath });
  assert.equal(result.localChanges, false);
  assert.equal(f.api.tokenRotations, 0);
  assert.equal((await savedState(f)).state.file, 'CHECKLIST.md');
  assert.equal((await savedState(f)).state.token, saved.state.token);
  assert.ok((await fs.readFile(f.file, 'utf8')).includes('New note from the website.'));
  assert.equal((await f.client.status(f.options)).localChanges, false);
});

test('recover preserves diverged local edits until an exact reviewed snapshot is merged', async t => {
  const f = await fixture(t);
  f.api.loseCreateResponse = true;
  await assert.rejects(f.client.connect(f.options), /No automatic retry/);
  f.api.loseCreateResponse = false;
  await fs.appendFile(f.file, '\n- [ ] Local addition\n');
  const local = await fs.readFile(f.file, 'utf8');
  await assert.rejects(f.client.recover({ project: f.projectPath }), /Local checklist differs/);
  assert.equal(await fs.readFile(f.file, 'utf8'), local);
  assert.equal(f.api.tokenRotations, 0);
  await assert.rejects(fs.access(path.join(f.projectPath, '.checklist.json')), { code: 'ENOENT' });
  const reviewFiles = await fs.readdir(path.join(f.serviceRoot, '.private', 'recovery'));
  assert.equal(reviewFiles.length, 1);
  const review = JSON.parse(await fs.readFile(path.join(f.serviceRoot, '.private', 'recovery', reviewFiles[0])));
  const merged = review.project.markdown + '\n- [ ] Local addition\n';
  await fs.writeFile(f.file, merged);
  await assert.rejects(f.client.recover({ project: f.projectPath, 'reviewed-revision': '999' }), /reviewed revision/);
  const result = await f.client.recover({ project: f.projectPath, 'reviewed-revision': String(review.project.revision) });
  assert.equal(result.localChanges, true);
  assert.equal(parseTasks(await fs.readFile(f.file, 'utf8')).length, 3);
  assert.equal(parseTasks(f.api.project.markdown).length, 2);
  await f.client.sync(f.options);
  assert.equal(parseTasks(f.api.project.markdown).length, 3);
});

test('recover never recreates missing data from an older record without initial Markdown', async t => {
  const f = await fixture(t);
  f.api.unavailable = true;
  await assert.rejects(f.client.connect(f.options), /No automatic retry/);
  const saved = await savedState(f);
  delete saved.state.initialMarkdown;
  await fs.writeFile(saved.file, JSON.stringify(saved.state));
  f.api.unavailable = false;
  await assert.rejects(f.client.recover({ project: f.projectPath }), /older connection record/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('recover refuses source mismatch and token revision races without retrying', async t => {
  const f = await fixture(t);
  f.api.loseCreateResponse = true;
  await assert.rejects(f.client.connect(f.options), /No automatic retry/);
  f.api.loseCreateResponse = false;
  const expectedSource = f.api.project.sourceId;
  f.api.project.sourceId = 'another-source';
  await assert.rejects(f.client.recover({ project: f.projectPath }), /different source/);
  assert.equal(f.api.tokenRotations, 0);
  f.api.project.sourceId = expectedSource;
  f.api.race = true;
  await assert.rejects(f.client.recover({ project: f.projectPath }), /Conflict:/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/token')).length, 1);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
});

test('foreground watch publishes a new task and stops when the remote document conflicts', async t => {
  const f = await fixture(t);
  await f.client.connect(f.options);
  let synced, conflict;
  const didSync = new Promise(resolve => { synced = resolve; });
  const didStop = new Promise(resolve => { conflict = resolve; });
  const watcher = await f.client.watch(f.options, { onResult: synced, onError: conflict });
  t.after(watcher.stop);
  const within = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Watcher did not respond within 5 seconds.')), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  await fs.appendFile(f.file, '\n- [ ] From file watcher\n');
  await within(didSync);
  assert.equal(parseTasks(f.api.project.markdown).length, 3);
  f.api.project.markdown += '\nRemote text edit.\n';
  f.api.project.revision++;
  await fs.appendFile(f.file, '\nLocal text edit.\n');
  const error = await within(didStop);
  assert.match(error.message, /website document changed/);
  const sent = f.calls.filter(call => call.method === 'PUT').length;
  await fs.appendFile(f.file, '\n- [ ] After watcher stopped\n');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, sent);
});

test('project and two chat checklists have isolated documents, tokens, and instruction blocks', async t => {
  const f = await scopeFixture(t);
  const project = await f.client.connect({ ...f.options, instructions: true });
  const projectMetadata = await fs.readFile(path.join(f.projectPath, '.checklist.json'), 'utf8');
  const projectSource = await fs.readFile(f.file, 'utf8');
  const a = await addChat(f, CHAT_A, 'Chat A');
  const b = await addChat(f, CHAT_B, 'Chat B');
  assert.equal(await fs.readFile(path.join(f.projectPath, '.checklist.json'), 'utf8'), projectMetadata);
  assert.equal(await fs.readFile(f.file, 'utf8'), projectSource);
  assert.equal(a.result.projectKey, project.projectId);
  assert.equal(b.result.projectKey, project.projectId);
  assert.notEqual(a.result.projectId, b.result.projectId);
  assert.notEqual(f.entries.get(a.result.projectId).token, f.entries.get(b.result.projectId).token);
  await fs.appendFile(a.file, '\n- [ ] Only A gets this task\n');
  await f.client.sync(a.options);
  assert.equal((await f.client.status(a.options)).total, 2);
  assert.equal((await f.client.status(b.options)).total, 1);
  assert.equal((await f.client.status(f.options)).total, 2);
  const instructions = await fs.readFile(path.join(f.projectPath, 'AGENTS.md'), 'utf8');
  assert.equal(instructions.split(`<!-- checklist:connected:${CHAT_A} -->`).length, 2);
  assert.equal(instructions.split(`<!-- checklist:connected:${CHAT_B} -->`).length, 2);
  assert.ok(instructions.includes(`--chat "${CHAT_A}"`));
  await assert.rejects(f.client.connect({ ...f.options, chat: '../fake' }), /actual Codex chat UUID/);
  await assert.rejects(f.client.connect({ ...f.options, chat: '8fc0de98-d20e-40ca-8fb2-2d74c12d124a', 'chat-name': 'Same source attempt', file: 'CHECKLIST.md' }), /already belongs to another checklist/);
});

test('archive disconnects one chat while preserving its files and sibling connections', async t => {
  const f = await scopeFixture(t);
  await f.client.connect({ ...f.options, instructions: true });
  const a = await addChat(f, CHAT_A, 'Chat A');
  const b = await addChat(f, CHAT_B, 'Chat B');
  const aSource = await fs.readFile(a.file, 'utf8');
  const bMetadata = await fs.readFile(b.configPath, 'utf8');
  const result = await f.client.archive(a.options);
  assert.equal(result.connected, false);
  assert.equal(await fs.readFile(a.file, 'utf8'), aSource);
  assert.equal(await fs.readFile(b.configPath, 'utf8'), bMetadata);
  assert.equal(f.entries.get(a.result.projectId).token, null);
  const state = JSON.parse(await fs.readFile(path.join(f.serviceRoot, '.private', 'connections', `${a.result.projectId}.json`)));
  assert.equal(state.token, null);
  assert.equal(state.status, 'archived');
  const before = f.calls.length;
  assert.equal((await f.client.status(a.options)).status, 'archived');
  await assert.rejects(f.client.sync(a.options), /archived and disconnected/);
  await assert.rejects(f.client.recover(a.options), /archived and disconnected/);
  await assert.rejects(f.client.connect(a.options), /already has/);
  assert.equal(f.calls.length, before);
  assert.equal((await f.client.status(b.options)).connected, true);
  assert.equal((await f.client.status(f.options)).connected, true);
  const instructions = await fs.readFile(path.join(f.projectPath, 'AGENTS.md'), 'utf8');
  const aBlock = instructions.split(`<!-- checklist:connected:${CHAT_A} -->`)[1].split(`<!-- /checklist:connected:${CHAT_A} -->`)[0];
  const bBlock = instructions.split(`<!-- checklist:connected:${CHAT_B} -->`)[1].split(`<!-- /checklist:connected:${CHAT_B} -->`)[0];
  assert.ok(aBlock.includes('archived and disconnected'));
  assert.ok(bBlock.includes('After changes, run node'));
});

test('a website archive is confirmed by one administrator read and becomes terminal locally', async t => {
  const f = await scopeFixture(t);
  const created = await f.client.connect(f.options);
  const entry = f.entries.get(created.projectId);
  entry.project.archivedAt = '2026-10-18T10:00:00Z';
  entry.project.revision++;
  entry.token = null;
  const before = f.calls.length;
  const result = await f.client.status(f.options);
  assert.equal(result.status, 'archived');
  assert.equal(f.calls.length - before, 2);
  assert.ok(f.calls.slice(before).every(call => call.method === 'GET'));
  const after = f.calls.length;
  await assert.rejects(f.client.recover(f.options), /archived and disconnected/);
  assert.equal((await f.client.status(f.options)).connected, false);
  assert.equal(f.calls.length, after);
});

test('archive between read and sync stops the write without retrying or losing local edits', async t => {
  const f = await scopeFixture(t);
  await f.client.connect(f.options);
  await fs.appendFile(f.file, '\n- [ ] Preserve this unsent task\n');
  f.controls.archiveBeforeSync = true;
  await assert.rejects(f.client.sync(f.options), /archived and disconnected/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/sync')).length, 1);
  assert.ok((await fs.readFile(f.file, 'utf8')).includes('Preserve this unsent task'));
  assert.equal((await f.client.status(f.options)).status, 'archived');
});

test('index updates selected legacy grouping and sync preserves later website classification', async t => {
  const f = await scopeFixture(t);
  const created = await f.client.connect(f.options);
  const remote = f.entries.get(created.projectId).project;
  for (const field of ['scope', 'projectKey', 'projectName', 'chatId', 'chatTitle']) delete remote[field];
  const original = remote.markdown;
  const indexed = await f.client.index({ project: f.projectPath, name: 'Actual project' });
  assert.equal(indexed.scope, 'project');
  assert.equal(remote.projectName, 'Actual project');
  assert.equal(remote.markdown, original);
  assert.equal(f.calls.filter(call => call.url.endsWith('/identity')).length, 1);
  Object.assign(remote, { scope: 'chat', chatId: CHAT_A, chatTitle: 'Explicit website classification' });
  remote.revision++;
  await fs.appendFile(f.file, '\n- [ ] More work\n');
  await f.client.sync(f.options);
  assert.equal(remote.scope, 'chat');
  assert.equal(remote.chatTitle, 'Explicit website classification');
  const synced = f.calls.findLast(call => call.url.endsWith('/sync'));
  assert.equal('scope' in synced.body, false);
  assert.equal('projectKey' in synced.body, false);
});

test('a root connection reclassified as a chat keeps its original selector for status, sync, and archive', async t => {
  const f = await scopeFixture(t);
  const created = await f.client.connect(f.options);
  const rootMetadata = await fs.readFile(path.join(f.projectPath, '.checklist.json'), 'utf8');
  const remote = f.entries.get(created.projectId).project;
  Object.assign(remote, { scope: 'chat', chatId: CHAT_A, chatTitle: 'Product research' });
  remote.revision++;
  const reported = await f.client.status({ project: f.projectPath });
  assert.equal(reported.scope, 'chat');
  assert.equal(reported.chatId, CHAT_A);
  await fs.appendFile(f.file, '\n- [ ] Task from the original chat connection\n');
  await f.client.sync({ project: f.projectPath });
  assert.equal(remote.scope, 'chat');
  assert.equal(remote.chatId, CHAT_A);
  assert.ok(remote.markdown.includes('Task from the original chat connection'));
  assert.equal(await fs.readFile(path.join(f.projectPath, '.checklist.json'), 'utf8'), rootMetadata);
  await assert.rejects(f.client.connect({ ...f.options, chat: CHAT_A, 'chat-name': 'Product research' }), /already uses the root/);
  await assert.rejects(fs.access(path.join(f.projectPath, '.checklist', 'chats', `${CHAT_A}.json`)), { code: 'ENOENT' });
  assert.equal((await fs.readdir(path.join(f.serviceRoot, '.private', 'connections'))).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/api/projects') && call.method === 'POST').length, 1);
  const archived = await f.client.archive({ project: f.projectPath });
  assert.equal(archived.projectId, created.projectId);
  assert.equal(remote.archivedAt, archived.archivedAt);
  assert.equal((await f.client.status({ project: f.projectPath })).connected, false);
});

test('chat enrollment recovery restores only its selected chat metadata', async t => {
  const f = await fixture(t);
  const options = { ...f.options, chat: CHAT_A, 'chat-name': 'Interrupted chat' };
  f.api.loseCreateResponse = true;
  await assert.rejects(f.client.connect(options), /No automatic retry/);
  f.api.loseCreateResponse = false;
  await f.client.recover(options);
  assert.equal((await f.client.status(options)).chatId, CHAT_A);
  await assert.rejects(fs.access(path.join(f.projectPath, '.checklist.json')), { code: 'ENOENT' });
  const metadata = JSON.parse(await fs.readFile(path.join(f.projectPath, '.checklist', 'chats', `${CHAT_A}.json`)));
  assert.equal(metadata.chatTitle, 'Interrupted chat');
});

test('source comparison ignores real task toggles but keeps fenced examples significant', () => {
  assert.equal(sourceDigest('- [ ] A'), sourceDigest('- [x] A'));
  assert.equal(sourceDigest('  1.  [ ] A'), sourceDigest('  1.  [x] A'));
  assert.equal(sourceDigest('> - [ ] Quoted'), sourceDigest('> - [x] Quoted'));
  assert.equal(sourceDigest('- - [ ] Nested'), sourceDigest('- - [x] Nested'));
  assert.equal(sourceDigest('> - [ ] Quoted <!-- checklist:quoted-task-123 -->'), sourceDigest('> - [x] Quoted <!-- checklist:quoted-task-123 -->'));
  assert.notEqual(sourceDigest('> ```\n> - [ ] Example\n> ```'), sourceDigest('> ```\n> - [x] Example\n> ```'));
  assert.notEqual(sourceDigest('```\n- [ ] A\n```'), sourceDigest('```\n- [x] A\n```'));
  assert.notEqual(sourceDigest('- [ ] A'), sourceDigest('- [ ] B'));
  assert.deepEqual(parseArguments(['sync', '--project', '/example/project', '--reviewed-revision', '4']), { command: 'sync', options: { project: '/example/project', 'reviewed-revision': '4' } });
});
