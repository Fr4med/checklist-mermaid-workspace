import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--url') throw new Error('Run npm run setup -- --url <your-workspace-origin>.');
const url = new URL(args[1]);
if (url.username || url.password || url.hash || url.search || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === 'localhost')) throw new Error('Use your HTTPS workspace origin, or the localhost origin printed by your development server.');
const privateRoot = path.join(root, '.private');
try { if ((await lstat(privateRoot)).isSymbolicLink()) throw new Error('The private configuration directory must not be a link.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const secretsFile = path.join(privateRoot, 'deploy-secrets.json');
let secrets;
try { secrets = JSON.parse(await readFile(secretsFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets = { ADMIN_KEY: randomBytes(32).toString('base64url'), PASSWORD_PEPPER: randomBytes(32).toString('base64url') };
  await writeFile(secretsFile, JSON.stringify(secrets, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
if (typeof secrets.ADMIN_KEY !== 'string' || secrets.ADMIN_KEY.length < 32 || typeof secrets.PASSWORD_PEPPER !== 'string' || secrets.PASSWORD_PEPPER.length < 32) throw new Error('Existing local secrets are invalid. Preserve the files and resolve them before continuing.');
async function writeOwned(file, content) {
  try { await writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(file, 'utf8') !== content) throw new Error(`${path.basename(file)} already exists with different settings. Preserve it and update the intended workspace configuration manually.`);
  }
}
await writeOwned(path.join(root, '.dev.vars'), `ADMIN_KEY=${secrets.ADMIN_KEY}\nPASSWORD_PEPPER=${secrets.PASSWORD_PEPPER}\n`);
await writeOwned(path.join(privateRoot, 'service.json'), JSON.stringify({ url: url.origin, adminKey: secrets.ADMIN_KEY }, null, 2) + '\n');
const destination = `${url.origin}/#key=${encodeURIComponent(secrets.ADMIN_KEY)}`;
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
await writeOwned(path.join(privateRoot, 'open-workspace.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open private workspace</title><meta http-equiv="refresh" content="0;url=${escape(destination)}"><p>Private workspace sign-in. Keep this file private and open it directly in your browser.</p></html>\n`);
console.log('Created ignored local settings, deployment secrets and a private browser shortcut. No credentials were printed.');
