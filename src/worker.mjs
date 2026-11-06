import { assets, interactiveDiagram } from './assets.mjs';
import { ensureTaskIds, survivingOverrides, tasksWithOverrides, TASK_ID } from './tasks.mjs';

const MAX_BODY = 256 * 1024;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_COOKIE = 'checklist_session';
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const CHAT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 100000; // Cloudflare Web Crypto's supported PBKDF2 limit.
const PASSWORD_ATTEMPT_SECONDS = 15 * 60;
const PASSWORD_ATTEMPT_LIMIT = 10;

class ApiError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}
function fail(status, message, headers) { throw new ApiError(status, message, headers); }
function json(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } }); }
async function hash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), b => b.toString(16).padStart(2, '0')).join(''); }
function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
async function equalSecret(left, right) {
  const a = await hash(left); const b = await hash(right);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function adminConfigured(env) { return typeof env.ADMIN_KEY === 'string' && env.ADMIN_KEY.length >= 32; }
function passwordPepper(env) {
  if (typeof env.PASSWORD_PEPPER !== 'string' || env.PASSWORD_PEPPER.length < 32) fail(503, 'Password sign-in is not configured.');
  return env.PASSWORD_PEPPER;
}
function passwordText(value) {
  if (typeof value !== 'string' || value.length > 256) fail(400, 'Use a password with 15 to 128 characters.');
  const length = Array.from(value).length;
  if (length < 15 || length > 128 || /[\u0000-\u001f\u007f]|\p{Cs}/u.test(value)) fail(400, 'Use a password with 15 to 128 characters, without control characters.');
  return value;
}
function hex(bytes) { return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, encoder.encode(value));
}
async function passwordVerifier(env, password, salt) {
  const material = await hmac(passwordPepper(env), `checklist-password-v1:${password}`);
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  const saltBytes = Uint8Array.from(salt.match(/../g), pair => parseInt(pair, 16));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PASSWORD_ITERATIONS }, key, 256));
}
async function passwordState(env) {
  const row = await first(env.DB, 'SELECT version, salt, verifier FROM workspace_password WHERE id = 1');
  if (!row) fail(503, 'Password settings are not configured.');
  return row;
}
async function browserSessionHash(env, token, version) {
  return hex(await hmac(env.ADMIN_KEY, `checklist-browser-session-v1:${version}:${token}`));
}
async function consumePasswordAttempt(request, env, purpose) {
  const now = Math.floor(Date.now() / 1000);
  // Cloudflare sets this header at its edge. Missing addresses share one conservative bucket.
  // No client-supplied X-Forwarded-For value or raw IP address is persisted.
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = hex(await hmac(env.ADMIN_KEY, `checklist-password-attempt-v1:${purpose}:${address}`));
  await env.DB.prepare('DELETE FROM password_attempts WHERE bucket IN (SELECT bucket FROM password_attempts WHERE expires_at <= ? LIMIT 128)').bind(now).run();
  const row = await first(env.DB, `INSERT INTO password_attempts (bucket, attempts, expires_at)
    SELECT ?, 1, ? WHERE (SELECT COUNT(*) FROM password_attempts) < 4096 OR EXISTS (SELECT 1 FROM password_attempts WHERE bucket = ?)
    ON CONFLICT(bucket) DO UPDATE SET
      attempts = CASE WHEN password_attempts.expires_at <= ? THEN 1 ELSE MIN(password_attempts.attempts + 1, ?) END,
      expires_at = CASE WHEN password_attempts.expires_at <= ? THEN excluded.expires_at ELSE password_attempts.expires_at END
    RETURNING attempts, expires_at`, bucket, now + PASSWORD_ATTEMPT_SECONDS, bucket, now, PASSWORD_ATTEMPT_LIMIT + 1, now);
  if (!row || row.attempts > PASSWORD_ATTEMPT_LIMIT) {
    fail(429, 'Too many sign-in attempts. Try again in 15 minutes.', { 'Retry-After': String(Math.max(1, (row?.expires_at || now + PASSWORD_ATTEMPT_SECONDS) - now)) });
  }
}
async function startBrowserSession(request, env, state) {
  const token = randomToken(); const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  const result = await env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM workspace_password WHERE id = 1 AND version = ?)')
    .bind(await browserSessionHash(env, token, state.version), now + SESSION_SECONDS, state.version).run();
  if (result.meta?.changes !== 1) fail(409, 'Password settings changed. Sign in again.');
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, token) });
}
function sessionToken(request) { return (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) || null; }
function sessionCookie(request, token, maxAge = SESSION_SECONDS) { return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
function verifyOrigin(request, required) {
  const origin = request.headers.get('Origin');
  if ((required && !origin) || (origin && origin !== new URL(request.url).origin)) fail(403, 'This request must come from this checklist website.');
}
async function body(request, maximum = MAX_BODY) {
  const advertised = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(advertised) && advertised > maximum) fail(413, 'Request is too large.');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(400, 'Send JSON with Content-Type application/json.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Request body is required.');
  const parts = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); fail(413, 'Request is too large.'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(400, 'Request body is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Request body must be an object.');
  return value;
}
function textField(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(400, `${name} must contain 1 to ${maximum} printable characters.`);
  return value.trim();
}
function projectId(value) { if (typeof value !== 'string' || !PROJECT_ID.test(value)) fail(400, 'Invalid project ID.'); return value; }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail(400, 'baseRevision must be a positive integer.'); return value; }
function originChatId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length !== 36 || !CHAT_UUID.test(value)) fail(400, 'originChatId must be a Codex chat UUID or null.');
  return value.toLowerCase();
}
function identity(input, defaults = null) {
  const scope = input.scope ?? defaults?.scope;
  if (!['project', 'chat'].includes(scope)) fail(400, 'scope must be project or chat.');
  const projectKey = textField(input.projectKey ?? defaults?.projectKey, 'projectKey', 160);
  const projectName = textField(input.projectName ?? defaults?.projectName, 'projectName', 160);
  const origin = Object.hasOwn(input, 'originChatId') ? originChatId(input.originChatId) : defaults?.originChatId ?? null;
  if (scope === 'project') {
    if (input.chatId != null || input.chatTitle != null) fail(400, 'Project checklists cannot have chatId or chatTitle.');
    return { scope, projectKey, projectName, chatId: null, chatTitle: null, originChatId: origin };
  }
  return { scope, projectKey, projectName, chatId: textField(input.chatId, 'chatId', 160), chatTitle: textField(input.chatTitle, 'chatTitle', 160), originChatId: origin };
}
function document(value) {
  if (typeof value !== 'string') fail(400, 'Markdown must be text.');
  if (encoder.encode(value).byteLength > MAX_BODY) fail(413, 'Markdown is too large.');
  try {
    const normalized = ensureTaskIds(value);
    if (encoder.encode(normalized).byteLength > MAX_BODY) fail(413, 'Markdown is too large after adding task IDs.');
    return normalized;
  } catch (error) { if (error instanceof ApiError) throw error; fail(400, error.message); }
}
async function first(db, sql, ...values) { const result = await db.prepare(sql).bind(...values).all(); return result.results?.[0] || null; }
async function getProject(db, id) { const row = await first(db, 'SELECT * FROM projects WHERE id = ?', id); if (!row) fail(404, 'Project was not found.'); return row; }
function requireActive(row) { if (row.archived_at != null) fail(410, 'This checklist is archived and cannot be changed or reconnected.'); }
async function writeConflict(db, id) { requireActive(await getProject(db, id)); fail(409, 'This checklist changed. Refresh it before saving again.'); }
function uniquenessConflict(error) {
  if (/UNIQUE|PRIMARY KEY|constraint failed/i.test(String(error))) fail(409, 'A checklist with that ID or an active checklist with that project/chat identity already exists.');
  throw error;
}
function publicProject(row, full = true) {
  const value = { id: row.id, name: row.name, sourceId: row.source_id, revision: row.revision, updatedAt: row.updated_at, done: row.done, total: row.total, scope: row.scope, projectKey: row.project_key, projectName: row.project_name, chatId: row.chat_id, chatTitle: row.chat_title, originChatId: row.scope === 'chat' ? row.chat_id : row.origin_chat_id ?? null, archivedAt: row.archived_at };
  if (full) { value.markdown = row.markdown; value.tasks = tasksWithOverrides(row.markdown, JSON.parse(row.overrides_json)); }
  return value;
}
async function authenticate(request, env, id, adminOnly = false) {
  if (!adminConfigured(env)) fail(503, 'Administrator key is not configured.');
  const auth = request.headers.get('Authorization');
  const bearer = auth?.match(/^Bearer ([A-Za-z0-9_\-.~+/=]+)$/i)?.[1];
  if (auth && (!bearer || bearer.length > 4096)) fail(401, 'A valid Bearer credential is required.');
  if (bearer) {
    verifyOrigin(request, false);
    if (await equalSecret(bearer, env.ADMIN_KEY)) return { admin: true, kind: 'bearer' };
    if (id && !adminOnly) {
      const row = await first(env.DB, 'SELECT id FROM projects WHERE id = ? AND token_hash = ? AND archived_at IS NULL', id, await hash(bearer));
      if (row) return { admin: false, kind: 'bearer' };
    }
    fail(403, 'This credential cannot access this project or operation.');
  }
  const token = sessionToken(request);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const state = await passwordState(env);
    const legacyHash = state.verifier === null && state.version === 'none' ? await hash(token) : '';
    const row = await first(env.DB, 'SELECT sessions.token_hash FROM sessions JOIN workspace_password ON workspace_password.id = 1 WHERE workspace_password.version = ? AND sessions.token_hash IN (?, ?) AND sessions.expires_at > ?', state.version, await browserSessionHash(env, token, state.version), legacyHash, Math.floor(Date.now() / 1000));
    if (row) {
      if (!['GET', 'HEAD'].includes(request.method)) verifyOrigin(request, true);
      return { admin: true, kind: 'session', passwordVersion: state.version };
    }
  }
  fail(401, 'Sign in to open the checklist.');
}
async function updateProject(db, row, values, baseRevision) {
  const tasks = tasksWithOverrides(values.markdown, values.overrides);
  const updatedAt = new Date().toISOString();
  const result = await db.prepare('UPDATE projects SET name = ?, markdown = ?, overrides_json = ?, revision = revision + 1, done = ?, total = ?, updated_at = ? WHERE id = ? AND revision = ? AND archived_at IS NULL')
    .bind(values.name, values.markdown, JSON.stringify(values.overrides), tasks.filter(task => task.checked).length, tasks.length, updatedAt, row.id, baseRevision).run();
  if (result.meta?.changes !== 1) await writeConflict(db, row.id);
  return publicProject(await getProject(db, row.id));
}

async function api(request, env, path) {
  const method = request.method;
  if (path === '/api/health' && method === 'GET') return json({ ok: true });
  if (!env.DB) fail(503, 'Checklist database is not configured.');
  if (path === '/api/diagrams' || path.startsWith('/api/diagrams/')) return diagramApi(request, env, path);
  if (path.startsWith('/api/diagram-edit-requests/')) return diagramEditRequestApi(request, env, path);
  if (path === '/api/session' && method === 'POST') {
    verifyOrigin(request, true);
    if (!adminConfigured(env)) fail(503, 'Administrator key is not configured.');
    const input = await body(request, 8192);
    await consumePasswordAttempt(request, env, 'login');
    const state = await passwordState(env);
    let valid = false;
    if (Object.hasOwn(input, 'key') && !Object.hasOwn(input, 'password')) {
      valid = typeof input.key === 'string' && input.key.length <= 4096 && await equalSecret(input.key, env.ADMIN_KEY);
    } else if (Object.hasOwn(input, 'password') && !Object.hasOwn(input, 'key')) {
      if (state.verifier !== null) {
        passwordPepper(env);
        let password;
        try { password = passwordText(input.password); } catch (error) { if (!(error instanceof ApiError)) throw error; }
        if (password !== undefined) valid = await equalSecret(await passwordVerifier(env, password, state.salt), state.verifier);
      } else {
        valid = typeof input.password === 'string' && input.password.length <= 4096 && await equalSecret(input.password, env.ADMIN_KEY);
        // Keep a normal failed password attempt on the same slow path before first setup.
        // The dummy verifier is discarded and never creates a password or account.
        if (!valid && typeof env.PASSWORD_PEPPER === 'string' && env.PASSWORD_PEPPER.length >= 32) {
          let candidate;
          try { candidate = passwordText(input.password); } catch (error) { if (!(error instanceof ApiError)) throw error; }
          if (candidate !== undefined) await passwordVerifier(env, candidate, '0'.repeat(64));
        }
      }
    }
    if (!valid) fail(401, 'The password or access key is incorrect.');
    return startBrowserSession(request, env, state);
  }
  if (path === '/api/session' && method === 'DELETE') {
    const auth = await authenticate(request, env, null, true);
    const token = sessionToken(request);
    if (token) {
      const state = await passwordState(env);
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash IN (?, ?)').bind(await browserSessionHash(env, token, auth.passwordVersion || state.version), await hash(token)).run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }
  if (path === '/api/password' && ['GET', 'PUT'].includes(method)) {
    const auth = await authenticate(request, env, null, true);
    const state = await passwordState(env);
    if (method === 'GET') return json({ passwordSet: state.verifier !== null });
    verifyOrigin(request, true);
    if (auth.kind === 'session' && auth.passwordVersion !== state.version) fail(409, 'Password settings changed. Sign in again.');
    const input = await body(request, 8192);
    const password = passwordText(input.password);
    passwordPepper(env);
    if (auth.kind === 'session' && state.verifier !== null) {
      await consumePasswordAttempt(request, env, 'change');
      let currentPassword;
      try { currentPassword = passwordText(input.currentPassword); } catch (error) { if (!(error instanceof ApiError)) throw error; }
      if (currentPassword === undefined || !(await equalSecret(await passwordVerifier(env, currentPassword, state.salt), state.verifier))) fail(400, 'The current password is incorrect.');
    }
    const salt = randomToken(); const version = randomToken(); const token = randomToken();
    const verifier = await passwordVerifier(env, password, salt);
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const results = await env.DB.batch([
      env.DB.prepare('UPDATE workspace_password SET version = ?, salt = ?, verifier = ?, updated_at = ? WHERE id = 1 AND version = ?')
        .bind(version, salt, verifier, new Date().toISOString(), state.version),
      env.DB.prepare('DELETE FROM sessions WHERE EXISTS (SELECT 1 FROM workspace_password WHERE id = 1 AND version = ?)').bind(version),
      env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM workspace_password WHERE id = 1 AND version = ?)')
        .bind(await browserSessionHash(env, token, version), expiresAt, version)
    ]);
    if (results[0].meta?.changes !== 1 || results[2].meta?.changes !== 1) fail(409, 'Password settings changed. Refresh and try again.');
    return json({ ok: true, passwordSet: true }, 200, { 'Set-Cookie': sessionCookie(request, token) });
  }
  if (path === '/api/projects' && method === 'GET') {
    await authenticate(request, env, null, true);
    const archived = new URL(request.url).searchParams.get('archived') === 'true';
    const result = await env.DB.prepare(`SELECT id, name, source_id, revision, updated_at, done, total, scope, project_key, project_name, chat_id, chat_title, origin_chat_id, archived_at FROM projects WHERE archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY updated_at DESC, id ASC`).all();
    return json({ projects: result.results.map(row => publicProject(row, false)) });
  }
  if (path === '/api/projects' && method === 'POST') {
    await authenticate(request, env, null, true);
    const input = await body(request);
    const id = projectId(input.id); const name = textField(input.name, 'Name', 160); const sourceId = textField(input.sourceId, 'sourceId', 160); const markdown = document(input.markdown);
    const metadata = identity(input, { scope: 'project', projectKey: id, projectName: name });
    const token = randomToken(); const now = new Date().toISOString(); const tasks = tasksWithOverrides(markdown);
    let result;
    try {
      result = await env.DB.prepare('INSERT INTO projects (id, name, markdown, source_id, token_hash, overrides_json, revision, done, total, created_at, updated_at, scope, project_key, project_name, chat_id, chat_title, origin_chat_id) SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM projects) < 100')
        .bind(id, name, markdown, sourceId, await hash(token), '{}', tasks.filter(task => task.checked).length, tasks.length, now, now, metadata.scope, metadata.projectKey, metadata.projectName, metadata.chatId, metadata.chatTitle, metadata.originChatId).run();
    } catch (error) {
      uniquenessConflict(error);
    }
    if (result.meta?.changes !== 1) fail(409, 'This checklist has reached its limit of 100 projects.');
    return json({ project: publicProject(await getProject(env.DB, id)), token }, 201);
  }
  const match = path.match(/^\/api\/projects\/([^/]+)(?:\/(sync|document|token|identity|archive)|\/tasks\/([^/]+))?$/);
  if (match) {
    let id; let taskId;
    try { id = decodeURIComponent(match[1]); taskId = match[3] ? decodeURIComponent(match[3]) : null; } catch { fail(400, 'Invalid encoded identifier.'); }
    projectId(id);
    const operation = match[2] || (taskId ? 'task' : 'read');
    if (taskId && !TASK_ID.test(taskId)) fail(400, 'Invalid task ID.');
    if (!((operation === 'read' && method === 'GET') || (['sync', 'document', 'token', 'identity'].includes(operation) && method === 'PUT') || (operation === 'task' && method === 'PATCH') || (operation === 'archive' && method === 'POST'))) fail(404, 'API route was not found.');
    const auth = await authenticate(request, env, id, ['task', 'document', 'token', 'identity', 'archive'].includes(operation));
    const row = await getProject(env.DB, id);
    if (operation === 'read') {
      if (row.archived_at != null && !auth.admin) fail(403, 'This credential cannot access an archived checklist.');
      return json({ project: publicProject(row) });
    }
    requireActive(row);
    const input = await body(request); const baseRevision = revision(input.baseRevision);
    if (baseRevision !== row.revision) fail(409, 'This checklist changed. Refresh it before saving again.');
    if (operation === 'archive') {
      const now = new Date().toISOString();
      const result = await env.DB.prepare('UPDATE projects SET archived_at = ?, token_hash = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND archived_at IS NULL')
        .bind(now, await hash(randomToken()), now, id, baseRevision).run();
      if (result.meta?.changes !== 1) await writeConflict(env.DB, id);
      return json({ project: publicProject(await getProject(env.DB, id)) });
    }
    if (operation === 'identity') {
      const metadata = identity(input, { originChatId: row.origin_chat_id });
      let result;
      try {
        result = await env.DB.prepare('UPDATE projects SET scope = ?, project_key = ?, project_name = ?, chat_id = ?, chat_title = ?, origin_chat_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND archived_at IS NULL')
          .bind(metadata.scope, metadata.projectKey, metadata.projectName, metadata.chatId, metadata.chatTitle, metadata.originChatId, new Date().toISOString(), id, baseRevision).run();
      } catch (error) { uniquenessConflict(error); }
      if (result.meta?.changes !== 1) await writeConflict(env.DB, id);
      return json({ project: publicProject(await getProject(env.DB, id)) });
    }
    if (operation === 'token') {
      if (input.sourceId !== row.source_id) fail(403, 'The source does not match this connected project.');
      const token = randomToken();
      const result = await env.DB.prepare('UPDATE projects SET token_hash = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND source_id = ? AND revision = ? AND archived_at IS NULL')
        .bind(await hash(token), new Date().toISOString(), id, input.sourceId, baseRevision).run();
      if (result.meta?.changes !== 1) await writeConflict(env.DB, id);
      return json({ project: publicProject(await getProject(env.DB, id)), token });
    }
    let markdown = row.markdown; let name = row.name; let overrides = Object.assign(Object.create(null), JSON.parse(row.overrides_json));
    if (operation === 'sync') {
      if (input.sourceId !== row.source_id) fail(403, 'The source does not match this connected project.');
      name = textField(input.name, 'Name', 160);
      markdown = document(input.markdown);
      overrides = survivingOverrides(markdown, overrides);
    } else if (operation === 'document') {
      markdown = document(input.markdown);
      overrides = survivingOverrides(markdown, overrides);
      if (Object.hasOwn(input, 'checkedChanges')) {
        if (!input.checkedChanges || typeof input.checkedChanges !== 'object' || Array.isArray(input.checkedChanges)) fail(400, 'checkedChanges must be an object of task IDs and boolean values.');
        const ids = new Set(tasksWithOverrides(markdown).map(task => task.id));
        for (const [changedId, checked] of Object.entries(input.checkedChanges)) {
          if (!TASK_ID.test(changedId) || !ids.has(changedId)) fail(400, 'checkedChanges contains an unknown task ID.');
          if (typeof checked !== 'boolean') fail(400, 'checkedChanges values must be true or false.');
          overrides[changedId] = checked;
        }
      }
    } else {
      if (input.checked !== null && typeof input.checked !== 'boolean') fail(400, 'checked must be true, false, or null.');
      if (!tasksWithOverrides(markdown).some(task => task.id === taskId)) fail(404, 'Task was not found.');
      if (input.checked === null) delete overrides[taskId]; else overrides[taskId] = input.checked;
    }
    return json({ project: await updateProject(env.DB, row, { name, markdown, overrides }, baseRevision) });
  }
  fail(404, 'API route was not found.');
}

const BUILT_IN_DIAGRAM = {
  id: 'interactive-example', title: 'Interactive example', revision: 1, updatedAt: null, kind: 'interactive',
};
const DIAGRAM_FIELDS = 'id, title, source, revision, updated_at';
const DIAGRAM_LIMIT = 100;
const DIAGRAM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DIAGRAM_REQUEST = 1536 * 1024;
const HTML_DIAGRAM_PATH = `/diagram/${BUILT_IN_DIAGRAM.id}`;
const SVG_DIAGRAM_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

function diagramId(value) {
  if (value.length > 64 || !DIAGRAM_ID.test(value)) fail(400, 'Invalid diagram ID.');
  return value;
}

function diagramText(value, label, limitKiB) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) fail(400, `${label} must be nonempty text.`);
  if (encoder.encode(value).byteLength > limitKiB * 1024) fail(413, `${label} exceeds ${limitKiB} KiB.`);
  return value;
}

function storedDiagram(row, full = false) {
  const result = { id: row.id, title: row.title, revision: row.revision, updatedAt: row.updated_at, kind: 'svg', ...diagramLibraryMetadata(row.library, row.id) };
  if (full) result.source = row.source;
  return result;
}

const LIBRARY_FIELDS = 'diagram_id, project_key, project_name, is_test, deleted_at, revision, updated_at';
function diagramLibraryMetadata(row, id) {
  const builtIn = id === BUILT_IN_DIAGRAM.id;
  return {
    projectKey: row ? row.project_key : builtIn ? BUILT_IN_DIAGRAM.id : null,
    projectName: row ? row.project_name : builtIn ? BUILT_IN_DIAGRAM.title : null,
    isTest: Boolean(row?.is_test), libraryRevision: row?.revision ?? 0, deletedAt: row?.deleted_at ?? null,
  };
}
async function diagramLibraryRow(db, id) {
  return first(db, `SELECT ${LIBRARY_FIELDS} FROM diagram_library WHERE diagram_id = ?`, id);
}
async function requireVisibleDiagram(db, id) {
  const metadata = await diagramLibraryRow(db, id);
  if (metadata?.deleted_at) fail(404, 'Diagram was not found.');
  return metadata;
}
function libraryRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail(400, 'baseLibraryRevision must be a nonnegative integer.');
  return value;
}
function libraryValues(input, previous) {
  const value = { ...previous };
  for (const [field, label] of [['projectKey', 'Project key'], ['projectName', 'Project name']]) {
    if (Object.hasOwn(input, field)) value[field] = input[field] === null ? null : textField(input[field], label, 160);
  }
  if ((value.projectKey === null) !== (value.projectName === null)) fail(400, 'Set both projectKey and projectName, or clear both with null.');
  if (Object.hasOwn(input, 'isTest')) {
    if (typeof input.isTest !== 'boolean') fail(400, 'isTest must be true or false.');
    value.isTest = input.isTest;
  }
  return value;
}
async function diagramLibraryAction(request, env, id, action) {
  const db = env.DB;
  const stored = id === BUILT_IN_DIAGRAM.id && interactiveDiagram
    ? { ...BUILT_IN_DIAGRAM }
    : await first(db, `SELECT ${DIAGRAM_FIELDS} FROM mermaid_diagrams WHERE id = ?`, id);
  if (!stored) fail(404, 'Diagram was not found.');
  const row = await diagramLibraryRow(db, id);
  const previous = diagramLibraryMetadata(row, id);
  if (action === 'metadata' && request.method === 'GET') {
    const diagram = id === BUILT_IN_DIAGRAM.id ? { ...BUILT_IN_DIAGRAM, ...previous } : storedDiagram({ ...stored, library: row });
    return json({ diagram });
  }
  const input = await body(request, 4096);
  const base = libraryRevision(input.baseLibraryRevision);
  if (previous.libraryRevision !== base) fail(409, 'This diagram library entry changed. Refresh it before saving again.');
  if (action === 'restore' ? !previous.deletedAt : previous.deletedAt) fail(409, action === 'restore' ? 'This diagram is not deleted.' : 'This diagram is deleted. Restore it before changing it.');
  if (action === 'delete' && revision(input.baseRevision) !== stored.revision) fail(409, 'This diagram changed. Refresh it before deleting it.');
  if (action === 'metadata' && !['projectKey', 'projectName', 'isTest'].some(field => Object.hasOwn(input, field))) fail(400, 'Choose a project or test status to update.');
  const values = action === 'metadata' ? libraryValues(input, previous) : previous;
  const now = new Date().toISOString();
  const deletedAt = action === 'delete' ? now : null;
  const sourceCondition = id === BUILT_IN_DIAGRAM.id
    ? '1 = ?'
    : 'EXISTS (SELECT 1 FROM mermaid_diagrams WHERE id = ? AND revision = ?)';
  const sourceValues = id === BUILT_IN_DIAGRAM.id ? [stored.revision] : [id, stored.revision];
  const saved = await first(db, `INSERT INTO diagram_library (${LIBRARY_FIELDS})
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT revision FROM diagram_library WHERE diagram_id = ?), 0) = ? AND ${sourceCondition}
    ON CONFLICT(diagram_id) DO UPDATE SET project_key = excluded.project_key, project_name = excluded.project_name,
      is_test = excluded.is_test, deleted_at = excluded.deleted_at, revision = excluded.revision, updated_at = excluded.updated_at
      WHERE diagram_library.revision = ? RETURNING ${LIBRARY_FIELDS}`,
  id, values.projectKey, values.projectName, Number(values.isTest), deletedAt, base + 1, now, id, base, ...sourceValues, base);
  if (!saved) fail(409, 'This diagram or library entry changed. Refresh it before saving again.');
  const diagram = id === BUILT_IN_DIAGRAM.id ? { ...BUILT_IN_DIAGRAM, ...diagramLibraryMetadata(saved, id) } : storedDiagram({ ...stored, library: saved });
  return json({ diagram });
}

const DIAGRAM_EDIT_LIMIT = 1000;
const DIAGRAM_EDIT_FIELDS = 'id, diagram_id, diagram_revision, diagram_hash, diagram_title, origin_chat_id, annotations_json, payload_hash, created_at, status, applied_revision';
function editRequestId(value) {
  if (typeof value !== 'string' || !CHAT_UUID.test(value)) fail(400, 'The request ID must be a UUID.');
  return value.toLowerCase();
}
function editText(value, label, maximum, { optional = false, singleLine = false } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || (singleLine ? /[\u0000-\u001f\u007f]/ : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/).test(value)) fail(400, `${label} must contain 1 to ${maximum} characters.`);
  return value;
}
function editAnnotations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) fail(400, 'Include 1 to 20 diagram comments.');
  const ids = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(400, 'Each diagram comment must be an object.');
    const id = editText(item.id, 'Comment ID', 80, { singleLine: true });
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id) || ids.has(id)) fail(400, 'Comment IDs must be unique identifiers.');
    ids.add(id);
    if (!['point', 'region', 'diagram'].includes(item.kind)) fail(400, 'Choose a point, region or whole-diagram comment.');
    const defaults = item.kind === 'diagram' ? { x: 0, y: 0, width: 1, height: 1 } : { width: 0, height: 0 };
    const bounds = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      const number = Object.hasOwn(item, key) ? item[key] : defaults[key];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) fail(400, 'Comment coordinates must be numbers between 0 and 1.');
      bounds[key] = number;
    }
    if (bounds.x + bounds.width > 1 + 1e-9 || bounds.y + bounds.height > 1 + 1e-9 || (item.kind === 'region' && (!bounds.width || !bounds.height))) fail(400, 'The selected region must fit inside the diagram.');
    if (item.kind === 'point' && (bounds.width !== 0 || bounds.height !== 0)) fail(400, 'Point comments must have zero width and height.');
    if (item.kind === 'diagram' && (bounds.x !== 0 || bounds.y !== 0 || bounds.width !== 1 || bounds.height !== 1)) fail(400, 'Whole-diagram comments must select the whole canvas.');
    return { id, kind: item.kind, ...bounds, view: editText(item.view ?? 'diagram', 'Diagram view', 80, { singleLine: true }), nodeId: editText(item.nodeId, 'Node ID', 80, { optional: true, singleLine: true }), nodeLabel: editText(item.nodeLabel, 'Node label', 240, { optional: true }), comment: editText(item.comment, 'Comment', 4000) };
  });
}
function storedEditRequest(row) {
  return { id: row.id, diagramId: row.diagram_id, diagramRevision: row.diagram_revision, diagramHash: row.diagram_hash, diagramTitle: row.diagram_title, originChatId: row.origin_chat_id, annotations: JSON.parse(row.annotations_json), createdAt: row.created_at, status: row.status, appliedRevision: row.applied_revision };
}
async function editDiagram(db, id) {
  await requireVisibleDiagram(db, id);
  if (id === BUILT_IN_DIAGRAM.id && interactiveDiagram) return { ...BUILT_IN_DIAGRAM, diagramHash: interactiveDiagram.sha256 };
  const row = await first(db, 'SELECT id, title, revision, svg FROM mermaid_diagrams WHERE id = ?', id);
  if (!row) fail(404, 'Diagram was not found.');
  return { ...row, diagramHash: await hash(row.svg) };
}
async function diagramEditAction(request, env, id, action) {
  const method = request.method;
  const db = env.DB;
  await requireVisibleDiagram(db, id);
  if (action === 'origin' && ['GET', 'PUT'].includes(method)) {
    const diagram = await editDiagram(db, id);
    if (method === 'GET') {
      const row = await first(db, 'SELECT origin_chat_id FROM diagram_origins WHERE diagram_id = ?', id);
      return json({ originChatId: row?.origin_chat_id ?? null, diagramHash: diagram.diagramHash });
    }
    const input = await body(request, 2048);
    const origin = originChatId(input.originChatId);
    await db.prepare('INSERT INTO diagram_origins (diagram_id, origin_chat_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(diagram_id) DO UPDATE SET origin_chat_id = excluded.origin_chat_id, updated_at = excluded.updated_at')
      .bind(id, origin, new Date().toISOString()).run();
    return json({ originChatId: origin, diagramHash: diagram.diagramHash });
  }
  if (action === 'requests' && ['GET', 'POST'].includes(method)) {
    if (method === 'GET') {
      await editDiagram(db, id);
      const result = await db.prepare(`SELECT ${DIAGRAM_EDIT_FIELDS} FROM diagram_edit_requests WHERE diagram_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`).bind(id).all();
      return json({ requests: result.results.map(storedEditRequest) });
    }
    const input = await body(request, 64 * 1024);
    const requestId = editRequestId(input.id);
    const base = revision(input.baseRevision);
    if (typeof input.baseHash !== 'string' || !/^[a-f0-9]{64}$/i.test(input.baseHash)) fail(400, 'baseHash must be the diagram preview SHA-256.');
    const baseHash = input.baseHash.toLowerCase();
    const annotations = editAnnotations(input.annotations);
    const explicitOrigin = Object.hasOwn(input, 'originChatId');
    const origin = explicitOrigin ? originChatId(input.originChatId) : (await first(db, 'SELECT origin_chat_id FROM diagram_origins WHERE diagram_id = ?', id))?.origin_chat_id ?? null;
    // An identical retry with an implicit destination retains its original saved destination.
    const payloadHash = await hash(JSON.stringify({ diagramId: id, baseRevision: base, baseHash, originChatId: explicitOrigin ? origin : null, useSavedOrigin: !explicitOrigin, annotations }));
    const existing = await first(db, `SELECT ${DIAGRAM_EDIT_FIELDS} FROM diagram_edit_requests WHERE id = ?`, requestId);
    if (existing) {
      if (existing.payload_hash !== payloadHash) fail(409, 'That request ID already belongs to different comments.');
      return json({ request: storedEditRequest(existing) });
    }
    const diagram = await editDiagram(db, id);
    if (diagram.revision !== base || diagram.diagramHash !== baseHash) fail(409, 'This diagram changed. Refresh it before requesting edits.');
    const now = new Date().toISOString();
    // Revision and library capacity are tested by the same INSERT that saves the request.
    const current = id === BUILT_IN_DIAGRAM.id ? '1 = ?' : 'EXISTS (SELECT 1 FROM mermaid_diagrams WHERE id = ? AND revision = ? AND svg = ?)';
    const values = [requestId, id, base, baseHash, diagram.title, origin, JSON.stringify(annotations), payloadHash, now, DIAGRAM_EDIT_LIMIT, ...(id === BUILT_IN_DIAGRAM.id ? [base] : [id, base, diagram.svg]), id];
    const saved = await first(db, `INSERT INTO diagram_edit_requests (id, diagram_id, diagram_revision, diagram_hash, diagram_title, origin_chat_id, annotations_json, payload_hash, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM diagram_edit_requests) < ? AND ${current}
      AND NOT EXISTS (SELECT 1 FROM diagram_library WHERE diagram_id = ? AND deleted_at IS NOT NULL)
      ON CONFLICT(id) DO NOTHING RETURNING ${DIAGRAM_EDIT_FIELDS}`, ...values);
    if (saved) return json({ request: storedEditRequest(saved) }, 201);
    const raced = await first(db, `SELECT ${DIAGRAM_EDIT_FIELDS} FROM diagram_edit_requests WHERE id = ?`, requestId);
    if (raced) {
      if (raced.payload_hash !== payloadHash) fail(409, 'That request ID already belongs to different comments.');
      return json({ request: storedEditRequest(raced) });
    }
    const latest = await editDiagram(db, id);
    if (latest.revision !== base || latest.diagramHash !== baseHash) fail(409, 'This diagram changed. Refresh it before requesting edits.');
    fail(409, `The edit-request library has reached its limit of ${DIAGRAM_EDIT_LIMIT} requests.`);
  }
  fail(404, 'Diagram action was not found.');
}
async function diagramEditRequestApi(request, env, path) {
  await authenticate(request, env, null, true);
  const id = editRequestId(path.slice('/api/diagram-edit-requests/'.length));
  if (!['GET', 'PATCH'].includes(request.method)) fail(404, 'Edit-request operation was not found.');
  let row = await first(env.DB, `SELECT ${DIAGRAM_EDIT_FIELDS} FROM diagram_edit_requests WHERE id = ?`, id);
  if (!row) fail(404, 'Edit request was not found.');
  if (request.method === 'PATCH') {
    const input = await body(request, 2048);
    if (!['applied', 'dismissed'].includes(input.status)) fail(400, 'Choose applied or dismissed for the request status.');
    const applied = input.appliedRevision == null ? null : revision(input.appliedRevision);
    row = await first(env.DB, `UPDATE diagram_edit_requests SET status = ?, applied_revision = ? WHERE id = ? RETURNING ${DIAGRAM_EDIT_FIELDS}`, input.status, input.status === 'applied' ? applied : null, id);
  }
  return json({ request: storedEditRequest(row) });
}

async function diagramApi(request, env, path) {
  await authenticate(request, env, null, true);
  const method = request.method;
  if (path === '/api/diagrams' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, title, revision, updated_at FROM mermaid_diagrams ORDER BY updated_at DESC, id ASC').all();
    const metadata = await env.DB.prepare(`SELECT ${LIBRARY_FIELDS} FROM diagram_library`).all();
    const byId = new Map(metadata.results.map(row => [row.diagram_id, row]));
    const diagrams = results.filter(row => !byId.get(row.id)?.deleted_at).map(row => storedDiagram({ ...row, library: byId.get(row.id) }));
    if (interactiveDiagram && !byId.get(BUILT_IN_DIAGRAM.id)?.deleted_at) diagrams.push({ ...BUILT_IN_DIAGRAM, ...diagramLibraryMetadata(byId.get(BUILT_IN_DIAGRAM.id), BUILT_IN_DIAGRAM.id) });
    return json({ diagrams });
  }
  const libraryAction = path.match(/^\/api\/diagrams\/([^/]+)\/(metadata|restore)$/);
  if (libraryAction && ((libraryAction[2] === 'metadata' && ['GET', 'PATCH'].includes(method)) || (libraryAction[2] === 'restore' && method === 'POST'))) return diagramLibraryAction(request, env, diagramId(libraryAction[1]), libraryAction[2]);
  const action = path.match(/^\/api\/diagrams\/([^/]+)\/(origin|requests)$/);
  if (action) return diagramEditAction(request, env, diagramId(action[1]), action[2]);
  if (!path.startsWith('/api/diagrams/') || !['GET', 'PUT', 'DELETE'].includes(method)) fail(404, 'Diagram API route was not found.');
  const id = diagramId(path.slice('/api/diagrams/'.length));
  const db = env.DB;
  if (method === 'DELETE') return diagramLibraryAction(request, env, id, 'delete');
  const library = await requireVisibleDiagram(db, id);
  if (method === 'GET') {
    if (id === BUILT_IN_DIAGRAM.id && interactiveDiagram) return json({ diagram: { ...BUILT_IN_DIAGRAM, ...diagramLibraryMetadata(library, id), source: null } });
    const row = await first(db, `SELECT ${DIAGRAM_FIELDS} FROM mermaid_diagrams WHERE id = ?`, id);
    if (!row) fail(404, 'Diagram was not found.');
    return json({ diagram: storedDiagram({ ...row, library }, true) });
  }
  if (id === BUILT_IN_DIAGRAM.id) fail(409, 'The built-in Interactive example diagram has a reserved ID.');

  const input = await body(request, MAX_DIAGRAM_REQUEST);
  const base = input.baseRevision;
  if (!Number.isSafeInteger(base) || base < 0 || base >= Number.MAX_SAFE_INTEGER) fail(400, 'baseRevision must be a nonnegative integer.');
  const title = textField(input.title, 'Title', 120);
  const source = diagramText(input.source, 'Mermaid source', 64);
  const svg = diagramText(input.svg, 'SVG preview', 500);
  if (!/^\s*<svg(?:\s|>)/.test(svg) || !/<\/svg>\s*$/.test(svg) || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(svg)) fail(400, 'Preview must be an SVG document without a document type.');
  const now = new Date().toISOString();
  // Return the row this statement wrote, even if another writer updates it immediately afterwards.
  const saved = base === 0
    ? await first(db, `INSERT INTO mermaid_diagrams (id, title, source, svg, revision, updated_at) SELECT ?, ?, ?, ?, 1, ? WHERE (SELECT COUNT(*) FROM mermaid_diagrams) < ? ON CONFLICT(id) DO NOTHING RETURNING ${DIAGRAM_FIELDS}`, id, title, source, svg, now, DIAGRAM_LIMIT)
    : await first(db, `UPDATE mermaid_diagrams SET title = ?, source = ?, svg = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM diagram_library WHERE diagram_id = ? AND deleted_at IS NOT NULL) RETURNING ${DIAGRAM_FIELDS}`, title, source, svg, now, id, base, id);
  if (saved) return json({ diagram: storedDiagram({ ...saved, library }, true) }, base === 0 ? 201 : 200);
  const existing = await first(db, 'SELECT id FROM mermaid_diagrams WHERE id = ?', id);
  if (existing) fail(409, 'This diagram changed. Refresh it before saving again.');
  if (base === 0) fail(409, `The library has reached its limit of ${DIAGRAM_LIMIT} uploaded diagrams.`);
  fail(404, 'Diagram was not found.');
}

let compressedDiagram;
async function diagramResponse(request, env, path) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  if (!env.DB) fail(503, 'Checklist database is not configured.');
  await authenticate(request, env, null, true);
  const checksumValues = new URL(request.url).searchParams.getAll('checksum');
  if (checksumValues.length > 1 || (checksumValues.length === 1 && !/^[a-f0-9]{64}$/i.test(checksumValues[0]))) fail(400, 'The preview checksum must be a SHA-256 value.');
  const checksum = checksumValues[0]?.toLowerCase() ?? null;
  const id = diagramId(path.slice('/diagram/'.length));
  await requireVisibleDiagram(env.DB, id);
  if (id !== BUILT_IN_DIAGRAM.id) {
    const head = request.method === 'HEAD';
    const row = await first(env.DB, head && !checksum ? 'SELECT id FROM mermaid_diagrams WHERE id = ?' : 'SELECT svg FROM mermaid_diagrams WHERE id = ?', id);
    if (!row) fail(404, 'Diagram was not found.');
    if (checksum && checksum !== await hash(row.svg)) fail(409, 'This diagram preview changed. Refresh it before requesting edits.');
    return new Response(head ? null : row.svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } });
  }
  if (!interactiveDiagram) fail(404, 'The Interactive example diagram is not available.');
  if (checksum && checksum !== interactiveDiagram.sha256) fail(409, 'This diagram preview changed. Refresh it before requesting edits.');
  let body = null;
  if (request.method === 'GET') {
    if (!compressedDiagram) {
      const decoded = atob(interactiveDiagram.gzip);
      compressedDiagram = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) compressedDiagram[i] = decoded.charCodeAt(i);
    }
    body = new Blob([compressedDiagram]).stream().pipeThrough(new DecompressionStream('gzip'));
  }
  return new Response(body, { headers: { 'Content-Type': interactiveDiagram.contentType } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const apiPath = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const diagramPath = url.pathname.startsWith('/diagram/');
    let response;
    try {
      if (apiPath) response = await api(request, env, url.pathname);
      else if (diagramPath) response = await diagramResponse(request, env, url.pathname);
      else if (!['GET', 'HEAD'].includes(request.method)) response = new Response('Not found', { status: 404 });
      else {
        const asset = assets[url.pathname] || (url.pathname === '/' ? assets['/index.html'] : null);
        response = asset ? new Response(request.method === 'HEAD' ? null : asset.body, { headers: { 'Content-Type': asset.contentType, 'Cache-Control': 'no-cache' } }) : new Response('Not found', { status: 404 });
      }
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Checklist request failed:', error?.name || 'Error');
      response = json({ error: error instanceof ApiError ? error.message : 'The server could not complete this request.' }, error instanceof ApiError ? error.status : 500, error instanceof ApiError ? error.headers : {});
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    const diagramDocument = url.pathname === HTML_DIAGRAM_PATH && response.ok;
    headers.set('X-Frame-Options', diagramDocument ? 'SAMEORIGIN' : 'DENY');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Content-Security-Policy', diagramDocument
      ? `default-src 'none'; script-src 'sha256-${interactiveDiagram.scriptHash}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`
      : diagramPath && response.ok ? SVG_DIAGRAM_CSP
        : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (diagramPath) headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    if (apiPath || diagramPath) headers.set('Cache-Control', 'no-store');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  }
};
