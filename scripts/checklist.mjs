#!/usr/bin/env node
import { promises as fs, watch as watchFile } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureTaskIds, parseTasks, effectiveMarkdown } from '../src/tasks.mjs';
import { ENTRY_POLICY } from '../src/entry-policy.mjs';

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = '.checklist.json';
const INSTRUCTIONS_MARKER = '<!-- checklist:connected -->';
const CHAT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root, value) => key(value) === key(root) || key(value).startsWith(key(root + path.sep));
const fail = (message, status) => { const error = new Error(message); if (status) error.status = status; throw error; };

export const help = `Checklist connects one project's Markdown to the shared website.

  node scripts/checklist.mjs connect --project <absolute-path> --name <name> [--file CHECKLIST.md] [--instructions] [--origin-chat <UUID>]
  node scripts/checklist.mjs recover --project <absolute-path> [--reviewed-revision <number>]
  node scripts/checklist.mjs sync    --project <absolute-path> [--reviewed-revision <number>]
  node scripts/checklist.mjs status  --project <absolute-path>
  node scripts/checklist.mjs show    --project <absolute-path>
  node scripts/checklist.mjs pull    --project <absolute-path>
  node scripts/checklist.mjs watch   --project <absolute-path>
  node scripts/checklist.mjs index   --project <absolute-path> [--name <project-name>] [--origin-chat <UUID>]
  node scripts/checklist.mjs archive --project <absolute-path>

Add --chat <actual-Codex-chat-UUID> to select one chat's checklist for any command.
Chat connect also takes --chat-name <title>; --name remains the project name.
New connections retain their original chat from --chat, --origin-chat, or a valid
CODEX_THREAD_ID. Ordinary sync never changes that chat. For an existing project,
index --origin-chat <UUID> assigns its verified original chat without regrouping.
Project scope keeps .checklist.json. Chat metadata and default Markdown live in
.checklist/chats/<chat-UUID>.json and .md, without changing the project checklist.

connect creates the checklist only if missing. Existing Markdown is backed up
before adding stable task IDs. --instructions adds a managed AGENTS.md block.
recover resumes an interrupted connect after checking its existing remote ID.
Changed local work is preserved. Recovery stops for review when sources differ.
sync publishes local changes, preserving manual checks. It stops on conflicts.
After reviewing and merging website changes, --reviewed-revision acknowledges
that exact live revision. It refuses if the website has changed again.
pull downloads the document and manual checks only with no unpushed local edits.
show prints the remote document, task states, and revision without changing it.
watch syncs this one file while the foreground process runs. Ctrl+C stops it.
index explicitly updates grouping metadata for the selected existing checklist.
archive disconnects only the selected checklist and preserves local files.
Archived checklists cannot sync, recover, or recreate. Codex chats are unaffected.

Service settings: .private/service.json with {"url":"https://...","adminKey":"..."},
or CHECKLIST_URL / CHECKLIST_ADMIN_KEY. Tokens are never printed. Project tokens
stay in this service's .private/connections directory, outside project metadata.
No background scheduler, model calls, or unrelated project scanning is started.
`;

export function parseArguments(argv) {
  const [command = 'help', ...args] = argv;
  const options = {};
  const allowed = new Set(['project', 'name', 'file', 'instructions', 'reviewed-revision', 'chat', 'chat-name', 'origin-chat']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(name) || name in options) fail(`Unknown or repeated option: ${args[i]}`);
    if (name === 'instructions') options[name] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail(`Missing value for --${name}.`);
      options[name] = value;
    }
  }
  return { command: command === '--help' || command === '-h' ? 'help' : command, options };
}

export function sourceDigest(markdown) {
  // A manual completion toggle does not conflict with a new source task.
  // Keep all other bytes, including task IDs, significant.
  const unchecked = Object.fromEntries(parseTasks(markdown).map(task => [task.id, false]));
  // The null key also normalizes tasks that do not have IDs yet. The shared
  // renderer knows every supported task prefix, including quotes and nesting.
  return digest(effectiveMarkdown(markdown, unchecked));
}

function withoutTaskIds(markdown) {
  const parts = markdown.split(/(\r?\n)/);
  for (const task of parseTasks(markdown)) parts[task.line * 2] = parts[task.line * 2].replace(/ ?<!--\s*checklist:[^]*?-->/g, '');
  return parts.join('');
}

export function createClient({ serviceRoot = SERVICE_ROOT, fetchImpl = globalThis.fetch, env = process.env, protectedHomes = [os.homedir()] } = {}) {
  const privateRoot = path.join(serviceRoot, '.private');

  function protect(candidate) {
    for (const home of protectedHomes) if (path.isAbsolute(home) && inside(path.resolve(home), path.resolve(candidate))) fail('Refusing to write or enroll a path inside the protected home directory. Choose a project directory outside your protected home folder.');
  }

  async function checkedPath(candidate, { missing = false } = {}) {
    const absolute = path.resolve(candidate);
    protect(absolute);
    const parsed = path.parse(absolute);
    let current = parsed.root;
    const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) { if (error.code === 'ENOENT' && missing) return absolute; throw error; }
      if (stat.isSymbolicLink()) fail(`Refusing a symbolic link or junction: ${current}`);
      if (i < segments.length - 1 && !stat.isDirectory()) fail(`Not a directory: ${current}`);
      const real = await fs.realpath(current);
      protect(real);
      if (key(real) !== key(current)) fail(`Path resolves elsewhere: ${current}`);
    }
    return absolute;
  }

  async function projectRoot(input) {
    if (!input || !path.isAbsolute(input)) fail('--project must be an absolute project path.');
    const root = await checkedPath(input);
    if (!(await fs.stat(root)).isDirectory()) fail('Project path is not a directory.');
    return root;
  }

  async function projectFile(root, relative, { missing = false } = {}) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) fail('Checklist file must be a path relative to this project.');
    const target = path.resolve(root, relative);
    if (!inside(root, target) || key(target) === key(root)) fail('Checklist file must stay inside this project.');
    return checkedPath(target, { missing });
  }

  async function readJson(file) {
    await checkedPath(file);
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) fail(`Invalid JSON in ${path.basename(file)}.`); throw error; }
  }

  async function ensureDir(directory) {
    await checkedPath(directory, { missing: true });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await checkedPath(directory);
  }

  async function atomicJson(file, value, { exclusive = false } = {}) {
    await checkedPath(file, { missing: true });
    await ensureDir(path.dirname(file));
    const content = JSON.stringify(value, null, 2) + '\n';
    if (exclusive) return fs.writeFile(file, content, { flag: 'wx', mode: 0o600 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await checkedPath(file, { missing: true });
    await fs.rename(temporary, file);
  }

  async function writeDocument(file, content) {
    await checkedPath(file, { missing: true });
    let original;
    try { original = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original === content) return null;
    if (original === undefined) {
      await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 });
      return null;
    }
    const backup = `${file}.checklist-backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await fs.copyFile(file, backup, 1);
    // Check again after making the backup. Never overwrite a concurrent edit.
    await checkedPath(file);
    if (await fs.readFile(file, 'utf8') !== original) fail('The local file changed while saving. The original backup was kept. Run the command again after editing stops.');
    const temporary = `${file}.checklist-${randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    return backup;
  }

  function serviceUrl(value) {
    let url;
    try { url = new URL(value); } catch { fail('Configure a valid CHECKLIST_URL or .private/service.json url.'); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('Service URL must be an origin without credentials, query, or a path.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) fail('Use HTTPS for the checklist service. HTTP is only allowed for localhost tests.');
    return url.origin;
  }

  async function settings() {
    let saved = {};
    try { saved = await readJson(path.join(privateRoot, 'service.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const url = serviceUrl(env.CHECKLIST_URL || saved.url);
    const adminKey = env.CHECKLIST_ADMIN_KEY || saved.adminKey;
    if (typeof adminKey !== 'string' || !adminKey) fail('Configure CHECKLIST_ADMIN_KEY or the private service settings before connecting a project.');
    return { url, adminKey };
  }

  async function request(url, route, token, method = 'GET', body, { allowNotFound = false } = {}) {
    let response;
    try {
      response = await fetchImpl(url + route, {
        method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(15000),
      });
    } catch { fail('Checklist service could not be reached. No automatic retry was sent. If connect was interrupted, run recover to reconcile its existing remote ID.'); }
    if (response.status === 404 && allowNotFound) return null;
    if (response.status === 409) fail('Conflict: the checklist changed. Run status, then pull if there are no unpushed edits. Reconcile both versions before syncing; no retry was sent.');
    if (response.status === 401 || response.status === 403) fail('Checklist credential was rejected. Check the intended service and project connection.', response.status);
    if (!response.ok) fail(`Checklist service returned HTTP ${response.status}. No automatic retry was sent.`, response.status);
    let result;
    try { result = await response.json(); } catch { fail('Checklist service returned an invalid response.'); }
    return result;
  }

  const connectionFile = id => path.join(privateRoot, 'connections', `${id}.json`);
  const projectId = root => `project-${digest(key(root)).slice(0, 20)}`;

  function selection(root, options = {}) {
    const chatId = options.chat?.toLowerCase() || null;
    if (chatId && (chatId.length !== 36 || !CHAT_UUID.test(chatId))) fail('--chat must be the actual Codex chat UUID. Do not invent one.');
    if (!chatId && options['chat-name']) fail('--chat-name requires --chat.');
    return { chatId, scope: chatId ? 'chat' : 'project', projectKey: projectId(root), id: chatId ? `chat-${digest(`${key(root)}\n${chatId}`).slice(0, 24)}` : projectId(root), configFile: chatId ? `.checklist/chats/${chatId}.json` : CONFIG, defaultFile: chatId ? `.checklist/chats/${chatId}.md` : 'CHECKLIST.md' };
  }

  function explicitOrigin(options) {
    const value = options['origin-chat'];
    if (typeof value !== 'string' || value.length !== 36 || !CHAT_UUID.test(value)) fail('--origin-chat must be the verified original Codex chat UUID.');
    return value.toLowerCase();
  }

  function identity(root, selected, options = {}, saved = {}) {
    const projectName = options.name || saved.projectName || (selected.chatId ? path.basename(root) : saved.name) || path.basename(root);
    const chatTitle = selected.chatId ? options['chat-name'] || saved.chatTitle : null;
    for (const value of [projectName, ...(selected.chatId ? [chatTitle] : [])]) if (typeof value !== 'string' || !value.trim() || value.length > 120) fail('Project and chat names must be 1–120 characters. Supply --chat-name for a new chat checklist.');
    return { scope: selected.scope, projectKey: selected.projectKey, projectName, chatId: selected.chatId, chatTitle };
  }

  const archivedMessage = 'This checklist is archived and disconnected. Local files were preserved. It cannot sync, recover, or be recreated.';
  function isDisconnected(context) { return Boolean(context.config?.archivedAt || context.config?.disconnectedAt || context.state?.archivedAt || context.state?.status === 'archived'); }

  async function markDisconnected(context, project) {
    const disconnectedAt = new Date().toISOString();
    const archivedAt = project.archivedAt || context.state.archivedAt;
    const state = { ...context.state, token: null, status: 'archived', archivedAt, disconnectedAt, revision: project.revision ?? context.state.revision };
    const config = { ...context.config, status: 'archived', archivedAt, disconnectedAt };
    await atomicJson(context.statePath, state);
    await atomicJson(context.configPath, config);
    context.state = state;
    context.config = config;
    await addInstructions(context.root, config.file, { chat: context.selected.chatId, 'chat-name': config.chatTitle, archived: true, onlyIfPresent: true });
  }

  async function adminFor(context) {
    const configured = await settings();
    if (configured.url !== context.config.url) fail('Configured administrator service differs from this selected checklist. No administrator request was sent.');
    return configured.adminKey;
  }

  async function scopedRequest(context, route, method = 'GET', body) {
    if (isDisconnected(context)) fail(archivedMessage, 'ARCHIVED');
    try { return await request(context.config.url, route, context.state.token, method, body); }
    catch (error) {
      if (error.status !== 401 && error.status !== 403) throw error;
      let remote;
      try {
        const adminKey = await adminFor(context);
        remote = validateRemote((await request(context.config.url, `/api/projects/${encodeURIComponent(context.config.id)}`, adminKey)).project, context.config);
      } catch { throw error; }
      if (remote.archivedAt) { await markDisconnected(context, remote); fail(archivedMessage, 'ARCHIVED'); }
      throw error;
    }
  }

  async function load(options) {
    const root = await projectRoot(options.project);
    const selected = selection(root, options);
    const configPath = await projectFile(root, selected.configFile, { missing: true });
    let config;
    try { config = await readJson(configPath); }
    catch (error) { if (error.code === 'ENOENT') fail('Project is not connected. Run connect first.'); throw error; }
    if (config.version !== 1 || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(config.id || '') || !config.sourceId) fail('Unrecognized project checklist metadata. It has not been changed.');
    if (typeof config.file !== 'string' || !/\.md$/i.test(config.file)) fail('Project metadata must reference its enrolled Markdown file.');
    const file = await projectFile(root, config.file, { missing: true });
    config.url = serviceUrl(config.url);
    const statePath = connectionFile(config.id);
    let state;
    try { state = await readJson(statePath); }
    catch (error) { if (error.code === 'ENOENT') fail('This machine has no project credential. The project metadata contains no token.'); throw error; }
    if (key(state.projectPath || '') !== key(root) || state.url !== config.url || state.sourceId !== config.sourceId || (!state.token && !state.archivedAt)) fail('Project credential does not match this project and service.');
    if ((config.chatId || null) !== selected.chatId || (state.chatId || null) !== selected.chatId) fail('Selected chat does not match the enrolled checklist.');
    if (state.file !== config.file) fail('Project metadata does not match its enrolled source file. Run recover to reconcile the connection without publishing another file.');
    return { root, config, configPath, selected, file, state, statePath };
  }

  function validateRemote(project, config) {
    if (!project || project.id !== config.id || typeof project.markdown !== 'string' || !Number.isSafeInteger(project.revision)) fail('Checklist service returned an invalid project.');
    if (project.sourceId !== config.sourceId) fail('This remote checklist belongs to a different source. No changes were sent.');
    return project;
  }

  async function getRemote(context) {
    const { config } = context;
    const result = await scopedRequest(context, `/api/projects/${encodeURIComponent(config.id)}`);
    const project = validateRemote(result.project, config);
    if (project.archivedAt) { await markDisconnected(context, project); fail(archivedMessage, 'ARCHIVED'); }
    return project;
  }

  async function addInstructions(root, relative, options = {}) {
    const selected = selection(root, options);
    const marker = selected.chatId ? `<!-- checklist:connected:${selected.chatId} -->` : INSTRUCTIONS_MARKER;
    const endMarker = selected.chatId ? `<!-- /checklist:connected:${selected.chatId} -->` : '<!-- /checklist:connected -->';
    const file = await projectFile(root, 'AGENTS.md', { missing: true });
    let original = '';
    try { original = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (options.onlyIfPresent && !original.includes(marker)) return;
    const title = selected.chatId ? `Shared checklist for chat ${selected.chatId}` : 'Shared project checklist';
    const selector = selected.chatId ? ` --chat "${selected.chatId}"` : '';
    const scope = selected.chatId ? `This block applies only to Codex chat ${selected.chatId}. Other chats must not update its checklist.` : 'This block applies to the project-wide checklist. Chat-specific checklists use their own metadata and --chat selector.';
    const instructions = options.archived
      ? `${scope} This checklist is archived and disconnected. Keep ${JSON.stringify(relative)} as local reference. Do not sync, watch, recover, reconnect, or recreate this archived link. This does not archive the actual Codex chat.`
      : `${scope} Its connection metadata is ${selected.configFile}. Use the checklist skill for ongoing updates. Keep ${JSON.stringify(relative)} current as tasks in this scope are created, completed, reopened, or changed. Run status and pull with the same selector before editing when there are no unpushed changes. After changes, run node ${JSON.stringify(path.join(serviceRoot, 'scripts', 'checklist.mjs').replaceAll('\\', '/'))} sync --project ${JSON.stringify(root.replaceAll('\\', '/'))}${selector}. Preserve task ID comments and manual checks. Stop when the connection reports archived or disconnected; do not recover or recreate it. On a conflict, preserve both versions and reconcile before retrying. Publish only this checklist, without secrets or unrelated project data.`;
    const block = `${marker}\n## ${title}\n\n${instructions}\n\n${ENTRY_POLICY}\n${endMarker}`;
    const start = original.indexOf(marker);
    if (start >= 0) {
      const end = original.indexOf(endMarker, start);
      if (end < 0 || original.indexOf(marker, start + marker.length) >= 0) fail('Managed checklist instructions are incomplete or duplicated. Existing instructions were preserved.');
      await writeDocument(file, original.slice(0, start) + block + original.slice(end + endMarker.length));
    } else await writeDocument(file, original + (original && !original.endsWith('\n') ? '\n' : '') + (original ? '\n' : '') + block + '\n');
  }

  async function requireSeparateSource(root, target, selectedConfig) {
    const candidates = [CONFIG];
    const folder = await projectFile(root, '.checklist/chats', { missing: true });
    try {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of entries) if (/^[a-f0-9-]{36}\.json$/i.test(entry.name)) candidates.push(`.checklist/chats/${entry.name}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const candidate of candidates) {
      if (candidate === selectedConfig) continue;
      let metadata;
      try { metadata = await readJson(await projectFile(root, candidate, { missing: true })); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (typeof metadata.file === 'string' && key(path.resolve(root, metadata.file)) === key(target)) fail('This Markdown file already belongs to another checklist in this project. Choose a separate source file; existing data was preserved.');
    }
  }

  async function connect(options) {
    const root = await projectRoot(options.project);
    const selected = selection(root, options);
    const metadata = identity(root, selected, options);
    const suppliedOrigin = Object.hasOwn(options, 'origin-chat') ? explicitOrigin(options) : null;
    metadata.originChatId = selected.chatId || suppliedOrigin || (typeof env.CODEX_THREAD_ID === 'string' && env.CODEX_THREAD_ID.length === 36 && CHAT_UUID.test(env.CODEX_THREAD_ID) ? env.CODEX_THREAD_ID.toLowerCase() : null);
    const name = metadata.chatTitle || metadata.projectName;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) fail('Project name must be 1–120 characters.');
    const relative = options.file || selected.defaultFile;
    if (!/\.md$/i.test(relative)) fail('Checklist source must be a .md file.');
    const file = await projectFile(root, relative, { missing: true });
    if (selected.chatId && !options.file) await ensureDir(path.dirname(file));
    await checkedPath(path.dirname(file));
    if (options.instructions) await projectFile(root, 'AGENTS.md', { missing: true });
    const configPath = await projectFile(root, selected.configFile, { missing: true });
    try { await fs.lstat(configPath); fail(`This scope already has ${selected.configFile}. Use status or sync; existing metadata was preserved.`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await requireSeparateSource(root, file, selected.configFile);
    const { url, adminKey } = await settings();
    if (selected.chatId) {
      const rootConfigPath = await projectFile(root, CONFIG, { missing: true });
      let rootExists = false;
      try { await fs.lstat(rootConfigPath); rootExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (rootExists) {
        const rootContext = await load({ project: root });
        const rootAdminKey = await adminFor(rootContext);
        const existingRoot = validateRemote((await request(rootContext.config.url, `/api/projects/${encodeURIComponent(rootContext.config.id)}`, rootAdminKey)).project, rootContext.config);
        if (existingRoot.scope === 'chat' && existingRoot.chatId === selected.chatId) fail(existingRoot.archivedAt ? archivedMessage : 'This chat already uses the root .checklist.json connection. Reuse status, sync, pull, watch, and archive with --project only, without --chat. No new connection was created.');
      }
    }
    const id = selected.id;
    const statePath = connectionFile(id);
    try { await fs.lstat(statePath); fail('A connection record already exists for this path. Run recover to reconcile the existing remote project before reconnecting.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let original, originalExisted = true;
    try { original = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; originalExisted = false; original = `# ${name}\n\n`; }
    const markdown = ensureTaskIds(original);
    const sourceId = randomUUID();
    const config = { version: 1, url, id, name, file: relative, sourceId, ...metadata };
    // Record intent before the request. A lost response must not cause a duplicate create.
    const pending = { version: 1, projectPath: root, url, id, sourceId, name, file: relative, ...metadata, instructions: Boolean(options.instructions), status: 'connecting', initialDigest: digest(markdown), initialMarkdown: markdown, initialInputDigest: digest(original), initialFileExisted: originalExisted };
    await atomicJson(statePath, pending, { exclusive: true });
    const result = await request(url, '/api/projects', adminKey, 'POST', { id, name, markdown, sourceId, ...metadata });
    const project = validateRemote(result.project, config);
    if (typeof result.token !== 'string' || !result.token) fail('Connect returned no project credential. The pending connection record was preserved.');
    const state = { ...pending, token: result.token, status: 'connecting-local', revision: project.revision, localDigest: digest(markdown), remoteSourceDigest: sourceDigest(project.markdown), syncedAt: new Date().toISOString() };
    await atomicJson(statePath, state);
    // Preserve changes made during the network round trip.
    let current;
    try { current = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== undefined && current !== original) fail('Remote checklist was created, but the local document changed during connect. The scoped credential was preserved. Reconcile before finishing enrollment.');
    await writeDocument(file, markdown);
    await atomicJson(configPath, config, { exclusive: true });
    if (options.instructions) await addInstructions(root, relative, options);
    await atomicJson(statePath, { ...state, status: 'connected', enrolledAt: new Date().toISOString() });
    return { message: `Connected ${name}. ${parseTasks(markdown).length} tasks.`, url: `${url}/#project=${encodeURIComponent(id)}`, projectId: id, ...metadata };
  }

  async function recover(options) {
    const root = await projectRoot(options.project);
    const selected = selection(root, options);
    const id = selected.id;
    const statePath = connectionFile(id);
    let state;
    try { state = await readJson(statePath); }
    catch (error) { if (error.code === 'ENOENT') fail('No interrupted connection record exists for this project. Use connect.'); throw error; }
    if (state.version !== 1 || state.id !== id || key(state.projectPath || '') !== key(root) || typeof state.sourceId !== 'string' || !state.sourceId) fail('Connection record does not match this project. Nothing was changed.');
    if (state.archivedAt || state.status === 'archived' || state.disconnectedAt) fail(archivedMessage, 'ARCHIVED');
    if ((state.chatId || null) !== selected.chatId) fail('Selected chat does not match this connection record.');
    const { url, adminKey } = await settings();
    if (serviceUrl(state.url) !== url) fail('Configured service differs from the interrupted connection. Restore the intended service settings before recovery.');
    const configPath = await projectFile(root, selected.configFile, { missing: true });
    let existing;
    try { existing = await readJson(configPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing?.archivedAt || existing?.disconnectedAt) fail(archivedMessage, 'ARCHIVED');
    if (existing && (existing.version !== 1 || existing.id !== id || existing.url !== url || existing.sourceId !== state.sourceId)) fail('Existing project metadata belongs to another connection. It was preserved.');
    const relative = state.file || existing?.file || selected.defaultFile;
    if (typeof relative !== 'string' || !/\.md$/i.test(relative)) fail('Recovery source must be the enrolled Markdown file.');
    if (existing && existing.file !== relative) fail('Project metadata and connection record name different files. Reconcile them before recovery.');
    const file = await projectFile(root, relative, { missing: true });
    await checkedPath(path.dirname(file));
    if (state.instructions) await projectFile(root, 'AGENTS.md', { missing: true });
    let local;
    try { local = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const localIdentity = identity(root, selected, {}, { ...existing, ...state });
    if (Object.hasOwn(state, 'originChatId') || Object.hasOwn(existing || {}, 'originChatId')) localIdentity.originChatId = state.originChatId ?? existing?.originChatId ?? null;
    const config = { version: 1, url, id, name: state.name || existing?.name || path.basename(root), file: relative, sourceId: state.sourceId, ...localIdentity };
    const remoteResult = await request(url, `/api/projects/${encodeURIComponent(id)}`, adminKey, 'GET', undefined, { allowNotFound: true });
    let remote = remoteResult && validateRemote(remoteResult.project, config);
    if (remote?.archivedAt) { await markDisconnected({ root, selected, config: existing || config, configPath, state, statePath }, remote); fail(archivedMessage, 'ARCHIVED'); }
    let token = state.token;
    const initialIsValid = typeof state.initialMarkdown === 'string' && digest(state.initialMarkdown) === state.initialDigest;
    const originalUnchanged = local === undefined
      ? state.initialFileExisted === false
      : digest(local) === state.initialInputDigest || (initialIsValid && local === state.initialMarkdown);
    const unfinishedEnrollment = !existing && !state.enrolledAt && ['connecting', 'connecting-local', 'recovering-create', 'recovering'].includes(state.status);
    const baselineUnchanged = local !== undefined && typeof state.localDigest === 'string' && digest(local) === state.localDigest;
    const reviewed = options['reviewed-revision'];

    async function reviewRequired(project) {
      const snapshot = path.join(privateRoot, 'recovery', `${id}-r${project.revision}.json`);
      const safeProject = { id: project.id, name: project.name, sourceId: project.sourceId, revision: project.revision, markdown: project.markdown, tasks: project.tasks || [] };
      try { await atomicJson(snapshot, { project: safeProject }, { exclusive: true }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      fail(`Local checklist differs from the saved source. It was preserved. Review ${snapshot}, merge task IDs and edits, then run recover with --reviewed-revision ${project.revision}. No credential or project document was changed.`);
    }

    let preserveLocalEdits = false;
    if (!remote) {
      if (!unfinishedEnrollment) fail('This established project is absent remotely. Recovery will not recreate its old enrollment snapshot. Preserve local work and reconcile the missing remote project.');
      if (!initialIsValid || typeof state.name !== 'string' || !state.name) fail('Remote project is absent and this older connection record has no verified initial Markdown or name. Recreation stopped. Manually reconcile the original request before connecting again.');
      if (!originalUnchanged) fail('Remote project is absent, but local source changed since the interrupted connection. It was preserved. Restore or reconcile the saved initial source before recovery; no create was sent.');
      if (reviewed !== undefined) fail('There is no remote revision to review. Remove --reviewed-revision after reconciling the original source.');
      // The confirmed 404 permits one exact replay in this explicit command.
      // No retry occurs if this request or its response is interrupted again.
      await atomicJson(statePath, { ...state, status: 'recovering-create', recoveryAttemptAt: new Date().toISOString() });
      const savedIdentity = state.scope ? { scope: state.scope, projectKey: state.projectKey, projectName: state.projectName, chatId: state.chatId, chatTitle: state.chatTitle, ...(Object.hasOwn(state, 'originChatId') ? { originChatId: state.originChatId } : {}) } : {};
      const created = await request(url, '/api/projects', adminKey, 'POST', { id, name: state.name || config.name, markdown: state.initialMarkdown, sourceId: state.sourceId, ...savedIdentity });
      remote = validateRemote(created.project, config);
      token = created.token;
    } else {
      const rawMatches = local !== undefined && (local === remote.markdown || local === effectiveMarkdown(remote.markdown, Object.fromEntries((remote.tasks || []).map(task => [task.id, task.checked]))));
      // Older pending records can still finish when the only local difference
      // is the stable ID comments added by the original enrollment.
      const idsOnly = local !== undefined && withoutTaskIds(local) === withoutTaskIds(remote.markdown) && parseTasks(local).every(task => !task.id || parseTasks(remote.markdown).some(remoteTask => remoteTask.line === task.line && remoteTask.id === task.id));
      const safeLocal = (unfinishedEnrollment && originalUnchanged) || baselineUnchanged || rawMatches || idsOnly;
      if (reviewed !== undefined && (!/^\d+$/.test(String(reviewed)) || !Number.isSafeInteger(Number(reviewed)) || Number(reviewed) !== remote.revision)) fail('The reviewed revision must equal the current remote revision. Read the latest recovery snapshot before finishing enrollment.');
      if (!safeLocal && reviewed === undefined) await reviewRequired(remote);
      preserveLocalEdits = !safeLocal;
      if (preserveLocalEdits && local === undefined) fail('The local checklist is missing. Restore the reviewed document before recovery.');

      if (token) {
        try {
          const scoped = validateRemote((await request(url, `/api/projects/${encodeURIComponent(id)}`, token)).project, config);
          if (scoped.revision !== remote.revision) fail('Remote project changed while checking the saved credential. No replacement credential was issued. Run recover again to read the latest revision.');
        } catch (error) {
          if (error.status !== 401 && error.status !== 403) throw error;
          const latest = validateRemote((await request(url, `/api/projects/${encodeURIComponent(id)}`, adminKey)).project, config);
          if (latest.archivedAt) { await markDisconnected({ root, selected, config: existing || config, configPath, state, statePath }, latest); fail(archivedMessage, 'ARCHIVED'); }
          if (latest.revision !== remote.revision) fail('Remote project changed while checking the saved credential. Run recover again to review the current revision.');
          token = null;
        }
      }
      if (!token) {
        const rotated = await request(url, `/api/projects/${encodeURIComponent(id)}/token`, adminKey, 'PUT', { sourceId: state.sourceId, baseRevision: remote.revision });
        const latest = validateRemote(rotated.project, config);
        if (latest.markdown !== remote.markdown) fail('Remote document changed during credential recovery. Local work was preserved; inspect the current revision before continuing.');
        remote = latest;
        token = rotated.token;
      }
    }

    if (typeof token !== 'string' || !token) fail('Recovery returned no scoped credential. The connection record was preserved; no local document was replaced.');
    const remoteMarkdown = effectiveMarkdown(remote.markdown, Object.fromEntries((remote.tasks || []).map(task => [task.id, task.checked])));
    const recovered = { ...state, ...localIdentity, name: remote.name, file: relative, token, status: 'recovering', revision: remote.revision, localDigest: digest(remoteMarkdown), remoteSourceDigest: sourceDigest(remote.markdown), recoveredAt: new Date().toISOString() };
    // Keep the received token before touching project files, so another local
    // interruption can resume with it instead of rotating again.
    await atomicJson(statePath, recovered);
    let current;
    try { current = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== local) fail('Local checklist changed during recovery. Its edits and the scoped credential were preserved. Run recover again to reconcile them.');
    const target = preserveLocalEdits ? ensureTaskIds(local) : remoteMarkdown;
    await writeDocument(file, target);
    if (!existing) await atomicJson(configPath, { ...config, name: remote.name }, { exclusive: true });
    if (state.instructions) await addInstructions(root, relative, { chat: selected.chatId, 'chat-name': localIdentity.chatTitle });
    await atomicJson(statePath, { ...recovered, status: 'connected', enrolledAt: state.enrolledAt || new Date().toISOString() });
    return { message: `Recovered ${remote.name}.${preserveLocalEdits ? ' Reviewed local edits remain unpushed; run sync when ready.' : ''}`, projectId: id, url: `${url}/#project=${encodeURIComponent(id)}`, revision: remote.revision, localChanges: digest(target) !== recovered.localDigest };
  }

  async function sync(options) {
    const context = await load(options);
    const { file, config, state, statePath } = context;
    const original = await fs.readFile(file, 'utf8');
    const markdown = ensureTaskIds(original);
    const remote = await getRemote(context);
    const reviewed = options['reviewed-revision'];
    if (reviewed !== undefined && (!/^\d+$/.test(String(reviewed)) || !Number.isSafeInteger(Number(reviewed)) || Number(reviewed) !== remote.revision)) fail('The reviewed revision must equal the current website revision. Review the latest document before sending a merged version.');
    if (reviewed === undefined && sourceDigest(remote.markdown) !== state.remoteSourceDigest && sourceDigest(remote.markdown) !== sourceDigest(markdown)) fail('Conflict: the website document changed since the last sync. Local edits were kept. Pull if unchanged locally, or reconcile both documents and sync with --reviewed-revision after reviewing that exact revision.');
    if (await fs.readFile(file, 'utf8') !== original) fail('Local checklist changed during sync. No changes were sent.');
    if (digest(markdown) === state.localDigest && sourceDigest(remote.markdown) === state.remoteSourceDigest) return { message: `${remote.name} is current.`, revision: remote.revision };
    // IDs must be saved before dispatch, so an interrupted upload cannot create duplicates.
    await writeDocument(file, markdown);
    const result = await scopedRequest(context, `/api/projects/${encodeURIComponent(config.id)}/sync`, 'PUT', { name: remote.name, markdown, baseRevision: remote.revision, sourceId: config.sourceId });
    const project = validateRemote(result.project, config);
    await atomicJson(statePath, { ...state, revision: project.revision, localDigest: digest(markdown), remoteSourceDigest: sourceDigest(project.markdown), syncedAt: new Date().toISOString() });
    return { message: `Synced ${remote.name}. ${project.done ?? 0}/${project.total ?? parseTasks(markdown).length} complete.`, revision: project.revision };
  }

  async function status(options) {
    const context = await load(options);
    if (isDisconnected(context)) return { status: 'archived', connected: false, projectId: context.config.id, archivedAt: context.state.archivedAt, file: context.config.file, message: archivedMessage };
    let remote;
    try { remote = await getRemote(context); }
    catch (error) { if (error.status === 'ARCHIVED') return { status: 'archived', connected: false, projectId: context.config.id, archivedAt: context.state.archivedAt, file: context.config.file, message: archivedMessage }; throw error; }
    const local = await fs.readFile(context.file, 'utf8');
    return { name: remote.name, projectId: remote.id, scope: remote.scope || 'project', projectKey: remote.projectKey, projectName: remote.projectName, chatId: remote.chatId || null, chatTitle: remote.chatTitle || null, originChatId: remote.scope === 'chat' ? remote.chatId || null : remote.originChatId || null, connected: true, file: context.config.file, url: `${context.config.url}/#project=${encodeURIComponent(remote.id)}`, done: remote.done, total: remote.total, revision: remote.revision, localChanges: digest(local) !== context.state.localDigest, remoteDocumentChanges: sourceDigest(remote.markdown) !== context.state.remoteSourceDigest, updatedAt: remote.updatedAt };
  }

  async function show(options) { return { project: await getRemote(await load(options)) }; }

  async function index(options) {
    const context = await load(options);
    if (isDisconnected(context)) fail(archivedMessage, 'ARCHIVED');
    const adminKey = await adminFor(context);
    const route = `/api/projects/${encodeURIComponent(context.config.id)}`;
    const remote = validateRemote((await request(context.config.url, route, adminKey)).project, context.config);
    if (remote.archivedAt) { await markDisconnected(context, remote); fail(archivedMessage, 'ARCHIVED'); }
    const originOnly = Object.hasOwn(options, 'origin-chat') && !Object.hasOwn(options, 'name') && !Object.hasOwn(options, 'chat-name');
    const metadata = originOnly
      ? { scope: remote.scope, projectKey: remote.projectKey, projectName: remote.projectName, chatId: remote.chatId ?? null, chatTitle: remote.chatTitle ?? null }
      : identity(context.root, context.selected, options, { ...context.config, ...context.state });
    if (Object.hasOwn(options, 'origin-chat')) metadata.originChatId = explicitOrigin(options);
    let project = remote;
    if (Object.entries(metadata).some(([name, value]) => (remote[name] ?? null) !== value)) {
      project = validateRemote((await request(context.config.url, `${route}/identity`, adminKey, 'PUT', { baseRevision: remote.revision, ...metadata })).project, context.config);
    }
    // Local scope still selects its original metadata file, even when the website
    // groups a legacy root connection as a chat.
    const localMetadata = originOnly ? { originChatId: project.originChatId ?? metadata.originChatId } : { ...metadata, originChatId: project.originChatId ?? context.state.originChatId ?? context.config.originChatId ?? null };
    await atomicJson(context.statePath, { ...context.state, ...localMetadata, revision: project.revision });
    await atomicJson(context.configPath, { ...context.config, ...localMetadata });
    await addInstructions(context.root, context.config.file, { ...options, onlyIfPresent: !context.state.instructions });
    return { message: `Indexed ${metadata.chatTitle || metadata.projectName}.`, projectId: project.id, revision: project.revision, ...metadata, originChatId: project.scope === 'chat' ? project.chatId : project.originChatId ?? localMetadata.originChatId ?? null };
  }

  async function archive(options) {
    const context = await load(options);
    if (isDisconnected(context)) return { status: 'archived', connected: false, projectId: context.config.id, archivedAt: context.state.archivedAt, message: archivedMessage };
    const adminKey = await adminFor(context);
    const route = `/api/projects/${encodeURIComponent(context.config.id)}`;
    let project = validateRemote((await request(context.config.url, route, adminKey)).project, context.config);
    if (!project.archivedAt) project = validateRemote((await request(context.config.url, `${route}/archive`, adminKey, 'POST', { baseRevision: project.revision })).project, context.config);
    if (!project.archivedAt) fail('Service did not confirm archive. Local connection was preserved.');
    await markDisconnected(context, project);
    return { status: 'archived', connected: false, projectId: project.id, archivedAt: project.archivedAt, message: 'Checklist archived and disconnected. Local files were preserved; the Codex chat was not changed.' };
  }

  async function pull(options) {
    const context = await load(options);
    const { file, state, statePath } = context;
    const original = await fs.readFile(file, 'utf8');
    if (digest(original) !== state.localDigest) fail('Local checklist has unpushed changes. Pull stopped without changing it. Sync or reconcile those changes first.');
    const remote = await getRemote(context);
    const overrides = Object.fromEntries((remote.tasks || []).map(task => [task.id, task.checked]));
    const markdown = effectiveMarkdown(remote.markdown, overrides);
    if (await fs.readFile(file, 'utf8') !== original) fail('Local checklist changed during pull. It was preserved.');
    const backup = await writeDocument(file, markdown);
    await atomicJson(statePath, { ...state, revision: remote.revision, localDigest: digest(markdown), remoteSourceDigest: sourceDigest(remote.markdown), syncedAt: new Date().toISOString() });
    return { message: `Pulled ${remote.name}, including manual checks.`, revision: remote.revision, ...(backup ? { backup } : {}) };
  }

  async function watch(options, { onResult = result => process.stdout.write(JSON.stringify(result) + '\n'), onError = error => process.stderr.write(error.message + '\n') } = {}) {
    const context = await load(options);
    await sync(options);
    let timer, running = false, queued = false, stopped = false;
    const stop = () => { stopped = true; clearTimeout(timer); watcher.close(); };
    const run = async () => {
      if (stopped) return;
      if (running) { queued = true; return; }
      running = true;
      try { onResult(await sync(options)); }
      catch (error) { stop(); onError(error); }
      finally { running = false; if (queued && !stopped) { queued = false; timer = setTimeout(run, 400); } }
    };
    const watcher = watchFile(path.dirname(context.file), (_event, filename) => {
      if (filename && filename.toString() !== path.basename(context.file)) return;
      clearTimeout(timer);
      timer = setTimeout(run, 400);
    });
    watcher.on('error', error => { stop(); onError(new Error(`Watcher stopped: ${error.code || 'file watch failed'}.`)); });
    return { stop, file: context.file };
  }

  return { connect, recover, sync, status, show, pull, watch, index, archive, checkedPath, addInstructions };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === 'help') { process.stdout.write(help); return; }
  if (!['connect', 'recover', 'sync', 'status', 'show', 'pull', 'watch', 'index', 'archive'].includes(command)) fail('Unknown command. Run with --help.');
  const permitted = command === 'connect' ? ['project', 'name', 'file', 'instructions', 'chat', 'chat-name', 'origin-chat'] : command === 'index' ? ['project', 'name', 'chat', 'chat-name', 'origin-chat'] : ['sync', 'recover'].includes(command) ? ['project', 'chat', 'reviewed-revision'] : ['project', 'chat'];
  if (Object.keys(options).some(name => !permitted.includes(name))) fail(`An option is not supported by ${command}. Run with --help.`);
  const client = createClient();
  if (command === 'watch') {
    const watcher = await client.watch(options, { onError: error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; } });
    process.stdout.write(`Watching ${watcher.file}. Keep this process open; Ctrl+C stops it.\n`);
    process.once('SIGINT', watcher.stop);
    process.once('SIGTERM', watcher.stop);
  } else process.stdout.write(JSON.stringify(await client[command](options), null, 2) + '\n');
}

if (process.argv[1] && key(path.resolve(process.argv[1])) === key(fileURLToPath(import.meta.url))) {
  main().catch(error => { process.stderr.write((error.message || 'Checklist command failed.') + '\n'); process.exitCode = 1; });
}
