import { mkdir, readFile, realpath, writeFile, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { routeSvg } from './diagram-routing.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const MAX_SOURCE = 64 * 1024;
const MAX_SVG = 500 * 1024;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const require = createRequire(import.meta.url);
const usage = `Mermaid workspace
  preview --file <diagram.mmd> --output <new.svg>
  list
  show --id <diagram-id>
  publish --id <new-id> --title <title> --file <diagram.mmd>
  publish --id <id> --title <title> --file <diagram.mmd> --base-revision <revision>
    [--project-key <stable-key> --project-name <name>] [--test true|false]
  organize --id <diagram-id> --base-library-revision <revision>
    [--project-key <stable-key> --project-name <name> | --clear-project true] [--test true|false]
  delete --id <diagram-id> --base-revision <revision> --base-library-revision <revision>
  restore --id <diagram-id> --base-library-revision <deleted-library-revision>
  link --id <diagram-id> [--chat <actual-origin-chat-UUID>]
  requests list --diagram <diagram-id>
  requests show --id <request-UUID>
  requests resolve --id <request-UUID> --status applied|dismissed [--revision <published-revision>]

Preview renders locally. Publish creates or updates one diagram. Run show to check revisions before updating.
Project and test changes use a separate library revision. Delete retains source and saved review requests for restore.`;

function diagramId(value) {
  if (!value || value.length > 64 || !ID.test(value)) {
    throw new Error('Use a diagram ID of up to 64 lowercase letters, digits and single hyphens.');
  }
  return value;
}

async function diagramSource(file) {
  if (!file || path.extname(file).toLowerCase() !== '.mmd') {
    throw new Error('Specify a raw .mmd file with --file.');
  }
  const bytes = await readFile(file);
  if (bytes.length > MAX_SOURCE) throw new Error('The Mermaid source must be 64 KiB or smaller.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const content = source.trim();
  if (!content || /^```/.test(content)) throw new Error('Use raw Mermaid syntax without a Markdown code fence.');
  if (/^---(?:\r?\n|$)/.test(content) || /%%\s*\{/.test(content)) {
    throw new Error('Remove Mermaid front matter and directives. The workspace sets renderer options.');
  }
  return source;
}

async function outsideHome(directory) {
  const resolved = await realpath(directory);
  for (const home of new Set([homedir()])) {
    const physicalHome = await realpath(home).catch(error => {
      if (error.code === 'ENOENT') return path.resolve(home);
      throw error;
    });
    const relative = path.relative(physicalHome, resolved);
    if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new Error('Choose an output directory outside the protected home folder.');
    }
  }
  return resolved;
}

async function renderSvg(source) {
  const playwright = process.env.MERMAID_PLAYWRIGHT_MODULE ||
    'playwright';
  const chrome = process.env.MERMAID_CHROME_PATH;
  const { chromium } = require(playwright);
  const dist = path.dirname(fileURLToPath(import.meta.resolve('mermaid')));
  await outsideHome(ROOT);
  const privatePath = path.join(ROOT, '.private');
  try { if ((await lstat(privatePath)).isSymbolicLink()) throw new Error('The local rendering directory must not be a link.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(privatePath, { recursive: true, mode: 0o700 });
  const privateRoot = await outsideHome(privatePath);
  const temp = path.join(privateRoot, 'mermaid-render');
  await mkdir(temp, { recursive: true });
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = await outsideHome(temp);

  // The browser receives installed Mermaid files from Playwright, with no network server.
  const origin = 'http://mermaid.local';
  const browser = await chromium.launch({
    ...(chrome ? { executablePath: chrome } : {}),
    headless: true,
    timeout: 20000,
    args: ['--disable-background-networking', '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server'],
  });
  let deadline;
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || url.search || request.method() !== 'GET') return route.abort();
      if (url.pathname === '/') {
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          headers: { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'" },
          body: '<!doctype html><meta charset="utf-8"><title>Mermaid local renderer</title>',
        });
      }
      if (!/^\/(?:chunks\/mermaid\.esm\.min\/)?[-\w.]+\.mjs$/.test(url.pathname)) return route.abort();
      await route.fulfill({ path: path.join(dist, url.pathname.slice(1)), contentType: 'text/javascript; charset=utf-8' });
    });
    const page = await context.newPage();
    await page.goto(origin, { timeout: 10000 });
    const rendered = await Promise.race([
      page.evaluate(async text => {
        const { default: mermaid } = await import('/mermaid.esm.min.mjs');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          layout: 'dagre',
          theme: 'base',
          look: 'classic',
          htmlLabels: false,
          deterministicIds: true,
          deterministicIDSeed: 'workspace',
          maxTextSize: 65536,
          maxEdges: 500,
          flowchart: { curve: 'stepAfter', useMaxWidth: false },
          themeVariables: {
            darkMode: true, background: '#181818', primaryColor: '#3f4141',
            primaryTextColor: '#eeeeee', primaryBorderColor: '#637173', lineColor: '#929292',
            secondaryColor: '#43413c', tertiaryColor: '#252525', edgeLabelBackground: '#222222',
          },
        });
        const { svg } = await mermaid.render('mermaid-workspace-diagram', text);
        const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const root = parsed.documentElement;
        if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || parsed.querySelector('parsererror')) {
          throw new Error('Mermaid did not return a valid SVG.');
        }
        const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
        if (viewBox?.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) {
          throw new Error('The SVG has no usable drawing area. Add at least one visible element.');
        }
        root.setAttribute('width', String(viewBox[2]));
        root.setAttribute('height', String(viewBox[3]));
        root.style.removeProperty('max-width');
        for (const link of root.querySelectorAll('a')) link.replaceWith(...link.childNodes);
        const assertLocalCss = css => {
          const withoutLocalUrls = css.replace(/url\(\s*(['"]?)#[\w.:-]+\1\s*\)/gi, '');
          if (/@import\b|url\s*\(|\\/i.test(withoutLocalUrls)) {
            throw new Error('Diagram styles may only reference elements inside the SVG.');
          }
        };
        for (const element of [root, ...root.querySelectorAll('*')]) {
          if (/^(?:script|foreignObject|iframe|object|embed|image|set|animate.*)$/i.test(element.localName)) {
            throw new Error('Use plain labels and SVG shapes without embedded images, HTML or animation.');
          }
          if (element.localName === 'style') assertLocalCss(element.textContent);
          for (const attribute of element.attributes) {
            if (/^on/i.test(attribute.localName) || (attribute.localName === 'href' && !/^#[\w.:-]+$/.test(attribute.value))) {
              throw new Error('Diagram elements may only reference elements inside the SVG.');
            }
            if (attribute.localName === 'style' || /url\s*\(/i.test(attribute.value)) assertLocalCss(attribute.value);
          }
        }
        return new XMLSerializer().serializeToString(root);
      }, source).then(svg => routeSvg(svg, { page, spacing: 18 })),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Mermaid rendering exceeded 20 seconds. Simplify the diagram and try again.')), 20000);
      }),
    ]);
    if (Buffer.byteLength(rendered) > MAX_SVG) throw new Error('The diagram exceeds 500 KiB. Split it into smaller diagrams.');
    return rendered;
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}

async function serviceSettings() {
  const testOrigin = process.env.MERMAID_TEST_ORIGIN;
  if (testOrigin) {
    const origin = new URL(testOrigin);
    if (origin.protocol !== 'http:' || origin.hostname !== 'localhost' || testOrigin !== origin.origin || !process.env.MERMAID_TEST_KEY) {
      throw new Error('A Mermaid test requires a loopback HTTP origin and its separate test key.');
    }
    return { origin: origin.origin, key: process.env.MERMAID_TEST_KEY };
  }
  let saved = {};
  try { saved = JSON.parse(await readFile(path.join(ROOT, '.private', 'service.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('The private service settings could not be read.'); }
  const address = process.env.CHECKLIST_URL || saved.url;
  const key = process.env.CHECKLIST_ADMIN_KEY || saved.adminKey;
  let origin;
  try { origin = new URL(address); } catch { throw new Error('Configure CHECKLIST_URL or .private/service.json for your own workspace.'); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !(origin.protocol === 'https:' || origin.protocol === 'http:' && origin.hostname === 'localhost') || typeof key !== 'string' || !key) throw new Error('Use your workspace HTTPS origin and its private owner credential.');
  return { origin: origin.origin, key };
}

async function request(route, data, method = data ? 'PUT' : 'GET') {
  const { origin, key } = await serviceSettings();
  let response;
  try {
    response = await fetch(origin + route, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(data && { 'content-type': 'application/json' }) },
      body: data ? JSON.stringify(data) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(data ? 'The workspace write result is unknown. Read the saved diagram or request before retrying.' : 'The Mermaid workspace could not be reached.');
  }
  if (response.status === 409) throw new Error('The diagram ID or revision conflicts with the workspace, or the library is full. Run show or list before retrying.');
  if (response.status === 401 || response.status === 403) throw new Error('The workspace rejected the owner credential.');
  if (response.status === 404) throw new Error('The diagram or Mermaid workspace was not found.');
  if (!response.ok) throw new Error(`The Mermaid workspace returned HTTP ${response.status}.`);
  try { return { result: await response.json(), origin }; }
  catch { throw new Error(data ? 'The publish response could not be read. Run show before retrying.' : 'The Mermaid workspace returned invalid JSON.'); }
}

const command = process.argv[2];
const options = {
  preview: ['file', 'output'],
  list: [],
  show: ['id'],
  publish: ['id', 'title', 'file', 'base-revision', 'project-key', 'project-name', 'test', 'clear-project'],
  organize: ['id', 'base-library-revision', 'project-key', 'project-name', 'test', 'clear-project'],
  delete: ['id', 'base-revision', 'base-library-revision'],
  restore: ['id', 'base-library-revision'],
  link: ['id', 'chat'],
};

function metadataOptions(values) {
  const result = {};
  const hasProject = values['project-key'] !== undefined || values['project-name'] !== undefined;
  if (values['clear-project'] !== undefined) {
    if (values['clear-project'] !== 'true' || hasProject) throw new Error('Use --clear-project true by itself to remove a project assignment.');
    result.projectKey = null; result.projectName = null;
  } else if (hasProject) {
    for (const [option, field] of [['project-key', 'projectKey'], ['project-name', 'projectName']]) {
      const text = values[option];
      if (typeof text !== 'string' || !text.trim() || text.length > 160 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('Use both --project-key and --project-name with 1 to 160 printable characters.');
      result[field] = text.trim();
    }
  }
  if (values.test !== undefined) {
    if (!['true', 'false'].includes(values.test)) throw new Error('Use --test true or --test false.');
    result.isTest = values.test === 'true';
  }
  return result;
}
function libraryBase(value) {
  const parsed = Number(value);
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(parsed) || parsed >= Number.MAX_SAFE_INTEGER) throw new Error('Use the exact nonnegative --base-library-revision from show or the delete result.');
  return parsed;
}

async function editRequests() {
  const action = process.argv[3];
  const fields = { list: ['diagram'], show: ['id'], resolve: ['id', 'status', 'revision'] };
  if (!Object.hasOwn(fields, action)) throw new Error(usage);
  const { values, tokens } = parseArgs({ args: process.argv.slice(4), tokens: true, options: Object.fromEntries(fields[action].map(name => [name, { type: 'string' }])) });
  if (tokens.length !== Object.keys(values).length) throw new Error('Supply each option at most once.');
  if (action === 'list') {
    const { result } = await request('/api/diagrams/' + diagramId(values.diagram) + '/requests');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!UUID.test(values.id || '')) throw new Error('Use the exact edit request UUID from the workspace.');
  const route = '/api/diagram-edit-requests/' + values.id.toLowerCase();
  if (action === 'show') {
    const { result } = await request(route);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!['applied', 'dismissed'].includes(values.status)) throw new Error('Use --status applied or dismissed after reviewing the request.');
  const revision = values.revision === undefined ? undefined : Number(values.revision);
  if (revision !== undefined && (!/^[1-9]\d*$/.test(values.revision) || !Number.isSafeInteger(revision))) throw new Error('Use a positive published revision.');
  const { result } = await request(route, { status: values.status, ...(revision !== undefined && { appliedRevision: revision }) }, 'PATCH');
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  if (!command || command === 'help' || command === '--help') return console.log(usage);
  if (command === 'requests') return editRequests();
  if (!Object.hasOwn(options, command)) throw new Error(usage);
  const { values, tokens } = parseArgs({
    args: process.argv.slice(3), tokens: true,
    options: Object.fromEntries(options[command].map(name => [name, { type: 'string' }])),
  });
  if (tokens.length !== Object.keys(values).length) throw new Error('Supply each option at most once.');

  if (command === 'preview') {
    if (!values.output || path.extname(values.output).toLowerCase() !== '.svg') {
      throw new Error('Specify a new .svg path with --output.');
    }
    const output = path.join(await outsideHome(path.dirname(values.output)), path.basename(values.output));
    const svg = await renderSvg(await diagramSource(values.file));
    try { await writeFile(output, svg, { flag: 'wx' }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('The preview path already exists. Choose a new output path.');
      throw error;
    }
    console.log(JSON.stringify({ output, bytes: Buffer.byteLength(svg) }, null, 2));
    return;
  }

  if (command === 'list') {
    const { result } = await request('/api/diagrams');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const id = diagramId(values.id);
  const route = '/api/diagrams/' + id;
  if (['organize', 'delete', 'restore'].includes(command)) {
    const baseLibraryRevision = libraryBase(values['base-library-revision']);
    let data = { baseLibraryRevision };
    if (command === 'organize') {
      const metadata = metadataOptions(values);
      if (!Object.keys(metadata).length) throw new Error('Choose a project or test status to organize.');
      data = { ...data, ...metadata };
    }
    if (command === 'delete') {
      const baseRevision = Number(values['base-revision']);
      if (!/^[1-9]\d*$/.test(values['base-revision'] || '') || !Number.isSafeInteger(baseRevision) || baseRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Use the current positive --base-revision from show before deleting.');
      data.baseRevision = baseRevision;
    }
    const { result } = await request(route + (command === 'organize' ? '/metadata' : command === 'restore' ? '/restore' : ''), data, command === 'organize' ? 'PATCH' : command === 'restore' ? 'POST' : 'DELETE');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'link') {
    if (values.chat !== undefined && !UUID.test(values.chat)) throw new Error('Use the actual originating Codex chat UUID.');
    const { result } = await request(route + '/origin', values.chat === undefined ? undefined : { originChatId: values.chat.toLowerCase() });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'show') {
    const { result } = await request(route);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (id === 'interactive-example') throw new Error('Interactive example is the built-in interactive diagram. Choose a new ID.');
  const title = values.title?.trim();
  if (!title || title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) {
    throw new Error('Use a diagram title of 1 to 120 printable characters.');
  }
  const revision = values['base-revision'];
  const baseRevision = revision === undefined ? 0 : Number(revision);
  if (revision !== undefined && (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(baseRevision) || baseRevision >= Number.MAX_SAFE_INTEGER)) {
    throw new Error('Use the current positive revision from show when updating a diagram.');
  }
  const metadata = metadataOptions(values);
  const source = await diagramSource(values.file);
  const { result, origin } = await request(route, { title, source, svg: await renderSvg(source), baseRevision });
  if (result?.diagram?.id !== id || result.diagram.revision !== baseRevision + 1 || result.diagram.title !== title || result.diagram.source !== source) {
    throw new Error('The publish response did not confirm the expected revision. Run show before retrying.');
  }
  const chat = process.env.CODEX_THREAD_ID;
  let originWarning;
  let libraryWarning;
  if (Object.keys(metadata).length) {
    try {
      const changed = await request(route + '/metadata', { ...metadata, baseLibraryRevision: result.diagram.libraryRevision }, 'PATCH');
      if (changed.result?.diagram?.id !== id || Object.entries(metadata).some(([key, value]) => changed.result.diagram[key] !== value)) throw new Error('Unconfirmed library metadata.');
      Object.assign(result.diagram, changed.result.diagram);
    } catch { libraryWarning = 'Diagram published. Project or test metadata was not confirmed; inspect show before retrying that library operation.'; }
  }
  if (UUID.test(chat || '')) {
    try {
      const metadata = await request(route + '/origin');
      if (!metadata.result.originChatId) await request(route + '/origin', { originChatId: chat.toLowerCase() });
    } catch { originWarning = 'Diagram published. The original chat could not be linked; inspect link before trying that operation again.'; }
  }
  console.log(JSON.stringify({ id, title: result.diagram.title, revision: result.diagram.revision, projectKey: result.diagram.projectKey, projectName: result.diagram.projectName, isTest: result.diagram.isTest, libraryRevision: result.diagram.libraryRevision, url: `${origin}/mermaid#diagram=${id}`, ...(originWarning && { warning: originWarning }), ...(libraryWarning && { libraryWarning }) }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
