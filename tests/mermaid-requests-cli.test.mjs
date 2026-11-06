import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Mermaid edit-request CLI reads, resolves and links through its existing owner boundary', async t => {
  const id = '425c8d35-d816-4203-8c7b-a36987a9428a';
  const chat = '7ca90c2c-f6b4-4056-8566-b6a58893733b';
  const key = 'synthetic-mermaid-cli-owner-credential';
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const result = req.url.endsWith('/origin') ? { originChatId: req.method === 'PUT' ? chat : null, diagramHash: 'a'.repeat(64) } : req.url.endsWith('/requests') ? { requests: [{ id, status: 'pending' }] } : { request: { id, status: req.method === 'PATCH' ? 'applied' : 'pending' } };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://localhost:${server.address().port}`;
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/mermaid.mjs', import.meta.url)), ...args], { env: { ...process.env, MERMAID_TEST_ORIGIN: origin, MERMAID_TEST_KEY: key }, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned CLI fixture timed out')); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  for (const args of [['requests', 'list', '--diagram', 'demo'], ['requests', 'show', '--id', id], ['requests', 'resolve', '--id', id, '--status', 'applied', '--revision', '3'], ['link', '--id', 'demo'], ['link', '--id', 'demo', '--chat', chat]]) {
    const result = await run(args); assert.equal(result.code, 0, result.stderr); assert.ok(JSON.parse(result.stdout));
  }
  assert.deepEqual(calls.map(call => [call.method, call.path]), [['GET', '/api/diagrams/demo/requests'], ['GET', `/api/diagram-edit-requests/${id}`], ['PATCH', `/api/diagram-edit-requests/${id}`], ['GET', '/api/diagrams/demo/origin'], ['PUT', '/api/diagrams/demo/origin']]);
  assert.ok(calls.every(call => call.authorization === `Bearer ${key}`));
  assert.deepEqual(calls[2].body, { status: 'applied', appliedRevision: 3 });
  assert.deepEqual(calls[4].body, { originChatId: chat });
  const count = calls.length;
  for (const args of [['requests', 'show', '--id', '../secret'], ['requests', 'resolve', '--id', id, '--status', 'delete'], ['link', '--id', 'demo', '--chat', 'guessed-title']]) assert.notEqual((await run(args)).code, 0);
  assert.equal(calls.length, count, 'invalid identifiers never reach the service');
});
