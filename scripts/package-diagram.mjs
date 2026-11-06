import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { installInteractiveEditsBridge } from './interactive-edits-bridge.mjs';
import { polishInteractiveDiagram } from './interactive-diagram-ui.mjs';

export async function packageDiagram(file) {
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('The reviewed diagram package must be 1 byte to 4 MiB.');
  const html = polishInteractiveDiagram(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (!/^<!doctype html>/i.test(html) || scripts.length !== 1 || scripts[0][1].trim()) throw new Error('Expected a self-contained diagram document with one inline script.');
  const bridge = `\n;(${installInteractiveEditsBridge.toString()})();\n`;
  const script = (scripts[0][2] + bridge).replace(/\r\n?/g, '\n');
  const packagedHtml = html.replace(scripts[0][0], () => `<script>${script}</script>`);
  const packagedBytes = Buffer.from(packagedHtml, 'utf8');
  return {
    kind: 'private-diagram', contentType: 'text/html; charset=utf-8',
    sha256: createHash('sha256').update(packagedBytes).digest('hex'),
    scriptHash: createHash('sha256').update(script).digest('base64'),
    gzip: gzipSync(packagedBytes, { level: 9 }).toString('base64'),
  };
}
