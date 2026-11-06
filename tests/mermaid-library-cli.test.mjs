import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Mermaid CLI manages project, test and deletion metadata through the owner boundary', async t => {
  const key = 'synthetic-mermaid-library-cli-key';
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ diagram: { id: 'demo', revision: 4, libraryRevision: (body?.baseLibraryRevision ?? 0) + 1 } }));
  });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://localhost:${server.address().port}`;
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/mermaid.mjs', import.meta.url)), ...args], { env: { ...process.env, MERMAID_TEST_ORIGIN: origin, MERMAID_TEST_KEY: key }, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned CLI fixture timed out')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const cases = [
    ['organize', '--id', 'demo', '--base-library-revision', '0', '--project-key', 'studio', '--project-name', 'Studio', '--test', 'true'],
    ['organize', '--id', 'demo', '--base-library-revision', '1', '--clear-project', 'true', '--test', 'false'],
    ['delete', '--id', 'demo', '--base-revision', '4', '--base-library-revision', '2'],
    ['restore', '--id', 'demo', '--base-library-revision', '3'],
  ];
  for (const args of cases) { const result = await run(args); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).diagram.id, 'demo'); }
  assert.deepEqual(calls.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'PATCH', path: '/api/diagrams/demo/metadata', body: { baseLibraryRevision: 0, projectKey: 'studio', projectName: 'Studio', isTest: true } },
    { method: 'PATCH', path: '/api/diagrams/demo/metadata', body: { baseLibraryRevision: 1, projectKey: null, projectName: null, isTest: false } },
    { method: 'DELETE', path: '/api/diagrams/demo', body: { baseLibraryRevision: 2, baseRevision: 4 } },
    { method: 'POST', path: '/api/diagrams/demo/restore', body: { baseLibraryRevision: 3 } },
  ]);
  assert.ok(calls.every(call => call.authorization === `Bearer ${key}`));
  const count = calls.length;
  for (const args of [
    ['organize', '--id', 'demo', '--base-library-revision', '0', '--project-name', 'Missing key'],
    ['organize', '--id', 'demo', '--base-library-revision', '0', '--test', 'maybe'],
    ['organize', '--id', 'demo', '--base-library-revision', '0', '--project-key', 'a', '--project-name', 'A', '--clear-project', 'true'],
    ['organize', '--id', 'demo', '--base-library-revision', '-1', '--test', 'true'],
    ['delete', '--id', 'demo', '--base-library-revision', '0'],
    ['restore', '--id', 'demo', '--base-library-revision', '3', '--base-library-revision', '4'],
    ['publish', '--id', 'demo', '--title', 'Demo', '--file', 'missing.mmd', '--test', 'maybe'],
  ]) assert.notEqual((await run(args)).code, 0, args.join(' '));
  assert.equal(calls.length, count, 'invalid input never reaches the workspace');
});
