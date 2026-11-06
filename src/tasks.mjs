import { Marked } from 'marked';

export const MAX_TASKS = 1000;
export const TASK_ID = /^[A-Za-z0-9_-]{8,80}$/;
const TASK_ROW = /^([ \t]*(?:(?:>[ \t]*)|(?:(?:[-+*]|\d+[.)])[ \t]+))*(?:[-+*]|\d+[.)])[ \t]+\[)([ xX])(\])(?:[ \t]+(.*)|[ \t]*)$/;
const markdownLexer = new Marked({ gfm: true });
let cachedMarkdown = null;
let cachedTasks = null;

/** Read Markdown task rows, preserving their zero-based source line numbers. */
export function parseTasks(markdown) {
  if (typeof markdown !== 'string') throw new Error('Markdown must be text.');
  if (markdown === cachedMarkdown) return cachedTasks.map(task => ({ ...task }));
  const tasks = [];
  const ids = new Set();
  const candidates = new Map();
  const marker = `checklist-source-position-${crypto.randomUUID()}`;
  const positionMarker = new RegExp(`<!-- ${marker}:(\\d+) -->`);
  // Give possible rows source positions before lexing. The Markdown lexer decides
  // which candidates are real GFM tasks, ignoring quoted code and indented code.
  const annotated = markdown.split(/\r?\n/).map((raw, line) => {
    const match = raw.match(TASK_ROW);
    if (!match || !match[4]?.trim()) return raw;
    candidates.set(line, match);
    const suffix = raw.match(/[ \t]*$/)[0];
    return raw.slice(0, raw.length - suffix.length) + ` <!-- ${marker}:${line} -->` + suffix;
  }).join('\n');
  const positions = new Set();
  markdownLexer.walkTokens(markdownLexer.lexer(annotated), token => {
    if (token.type !== 'list_item' || !token.task) return;
    const position = token.raw.split('\n')[0].match(positionMarker);
    if (position) positions.add(Number(position[1]));
  });
  for (const line of [...positions].sort((a, b) => a - b)) {
    const match = candidates.get(line);
    const content = match[4];
    const markers = [...content.matchAll(/<!--\s*checklist:([^]*?)-->/g)];
    const occurrences = [...content.matchAll(/<!--\s*checklist\b/g)];
    if (markers.length !== occurrences.length || markers.length > 1) throw new Error(`Invalid task ID on line ${line + 1}.`);
    let id = null;
    if (markers.length) {
      id = markers[0][1].trim();
      if (!TASK_ID.test(id)) throw new Error(`Invalid task ID on line ${line + 1}.`);
      if (ids.has(id)) throw new Error(`Duplicate task ID ${id}.`);
      ids.add(id);
    }
    tasks.push({ id, line, text: content.replace(/<!--\s*checklist:[^]*?-->/g, '').trim(), sourceChecked: match[2].toLowerCase() === 'x' });
    if (tasks.length > MAX_TASKS) throw new Error(`A project can contain at most ${MAX_TASKS} tasks.`);
  }
  // A write validates, merges overrides and serializes the same document. Keep
  // only that last bounded document, with copies so callers cannot alter it.
  if (markdown.length <= 256 * 1024) { cachedMarkdown = markdown; cachedTasks = tasks; }
  else { cachedMarkdown = null; cachedTasks = null; }
  return tasks.map(task => ({ ...task }));
}

/** Add IDs only to task rows without one. Existing identifiers remain unchanged. */
export function ensureTaskIds(markdown) {
  const tasks = parseTasks(markdown);
  const parts = markdown.split(/(\r?\n)/);
  for (const task of tasks) {
    if (!task.id) {
      const index = task.line * 2;
      const suffix = parts[index].match(/[ \t]*$/)[0];
      parts[index] = parts[index].slice(0, parts[index].length - suffix.length) + ` <!-- checklist:${crypto.randomUUID()} -->` + suffix;
    }
  }
  return parts.join('');
}

/** Apply saved manual decisions without changing source text or stable IDs. */
export function effectiveMarkdown(markdown, overrides = {}) {
  const parts = markdown.split(/(\r?\n)/);
  for (const task of parseTasks(markdown)) {
    if (typeof overrides[task.id] === 'boolean') {
      const index = task.line * 2;
      parts[index] = parts[index].replace(TASK_ROW, (raw, prefix, _checked, close, text) => prefix + (overrides[task.id] ? 'x' : ' ') + close + raw.slice(prefix.length + 2));
    }
  }
  return parts.join('');
}

export function survivingOverrides(markdown, overrides = {}) {
  const kept = Object.create(null);
  for (const { id } of parseTasks(markdown)) if (typeof overrides[id] === 'boolean') kept[id] = overrides[id];
  return kept;
}

export function tasksWithOverrides(markdown, overrides = {}) {
  return parseTasks(markdown).map(task => ({ ...task, checked: typeof overrides[task.id] === 'boolean' ? overrides[task.id] : task.sourceChecked, manual: typeof overrides[task.id] === 'boolean' }));
}
