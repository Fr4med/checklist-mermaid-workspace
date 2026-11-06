import { createPasswordSettings } from './password-settings.mjs';
import { attachSvgEditSurface, createDiagramEdits } from './diagram-edits.mjs';
import { normalizeDiagramTarget } from './diagram-edit-request.mjs';
import { attachSidebarResize } from './sidebar-resize.mjs';

const icons = {
  diagram: 'M9 3h6v6H9zM3 16h6v5H3zM15 16h6v5h-6zM12 9v4M6 16v-3h12v3',
  checklist: 'm3 6 1.5 1.5L7 5m-4 7 1.5 1.5L7 11m-4 7 1.5 1.5L7 17M11 6h10m-10 6h10m-10 6h10',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-3l2 3M19 17a8 8 0 0 1-13 3l-2-3',
  logout: 'M9 4H4v16h5M10 12h11m-4-4 4 4-4 4',
  source: 'm8 6-6 6 6 6m8-12 6 6-6 6m-2-15-4 18',
  close: 'm6 6 12 12M6 18 18 6',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  fit: 'M9 4H4v5m11-5h5v5m0 6v5h-5m-6 0H4v-5',
  key: 'M15 8a5 5 0 1 1-3 9L4 21H2v-4l8-8a5 5 0 0 1 5-1M16 7h.01',
  folder: 'M3 7h7l2-3h9v16H3z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  chevron: 'm9 5 7 7-7 7',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name]}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });

const $ = id => document.getElementById(id);
const workspaceReturnKey = 'checklist:workspace-return';
const diagramId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const stage = $('diagram-visual');
const sourceDialog = $('source-dialog');
let diagrams = [];
let selected = null;
let libraryRequest = null;
let libraryRefreshPromise = null;
let selectionRequest = null;
let svgControls = null;
let organizeTarget = null;
let deleteTarget = null;
let libraryBusy = false;
let lastDeleted = null;
const collapsedProjects = new Set();
attachSidebarResize({ workspace: $('mermaid-workspace'), handle: $('mermaid-library-resize') });
const diagramEdits = createDiagramEdits({
  button: $('request-diagram-edits'), host: stage.parentElement, api: request,
  onUnauthorized: () => showAuth('Sign in again to save your diagram request.'),
});

function checklistLocation() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(workspaceReturnKey) || 'null');
    const params = new URLSearchParams();
    if (typeof saved?.project === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(saved.project)) params.set('project', saved.project);
    if (saved?.archived === true) params.set('archived', '1');
    return params.size ? '/#' + params : '/';
  } catch { return '/'; }
}

function clearChecklistReturn() {
  try { sessionStorage.removeItem(workspaceReturnKey); } catch {}
  updateChecklistLinks();
}

function updateChecklistLinks() {
  const destination = checklistLocation();
  $('open-checklist').href = destination;
  $('auth-checklist').href = destination;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const details = method === 'HEAD' ? null : await response.json().catch(() => null);
    const error = new Error(details?.error || 'Mermaid could not load this request.');
    error.status = response.status;
    throw error;
  }
  return method === 'HEAD' ? null : response.json();
}

function message(text = '', retry = false) {
  $('diagram-message-text').textContent = text;
  $('diagram-message').hidden = !text;
  $('retry-diagram').hidden = !retry;
}

function notice(text = '', action = null) {
  if (!text && lastDeleted) {
    text = `Deleted “${lastDeleted.title}”.`;
    action = { label: 'Undo', run: restoreLastDiagram };
  }
  $('mermaid-notice').replaceChildren(document.createTextNode(text));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'notice-action';
    button.textContent = action.label;
    button.addEventListener('click', () => { void action.run(); });
    $('mermaid-notice').append(button);
  }
  $('mermaid-notice').hidden = !text;
}

function clearPreview() {
  diagramEdits.reset();
  selectionRequest?.abort();
  selectionRequest = null;
  svgControls = null;
  stage.replaceChildren();
  $('diagram-zoom').hidden = true;
  $('diagram-source').hidden = true;
  if (sourceDialog.open) sourceDialog.close();
  $('source-text').value = '';
}

function showAuth(text = '') {
  passwordSettings.close();
  $('organize-diagram-dialog').close();
  $('delete-diagram-dialog').close();
  organizeTarget = null;
  deleteTarget = null;
  lastDeleted = null;
  libraryRequest?.abort();
  clearPreview();
  selected = null;
  diagrams = [];
  renderLibrary();
  document.title = 'Mermaid';
  $('mermaid-workspace').hidden = true;
  $('mermaid-auth').hidden = false;
  $('mermaid-auth-error').textContent = text;
}

function renderLibrary() {
  const list = $('diagram-list');
  const picker = $('diagram-picker');
  list.replaceChildren();
  picker.replaceChildren();
  const groups = new Map();
  for (const diagram of diagrams) {
    const key = diagram.projectKey || '';
    if (!groups.has(key)) groups.set(key, { key, name: diagram.projectName || 'Ungrouped', diagrams: [] });
    groups.get(key).diagrams.push(diagram);
  }
  const ordered = [...groups.values()].sort((a, b) => !a.key ? 1 : !b.key ? -1 : a.name.localeCompare(b.name));
  const options = $('diagram-project-options');
  options.replaceChildren();
  for (const group of ordered) {
    const section = document.createElement('details');
    section.className = 'diagram-project-group';
    section.dataset.project = group.key;
    section.open = !collapsedProjects.has(group.key);
    section.addEventListener('toggle', () => {
      if (section.open) collapsedProjects.delete(group.key); else collapsedProjects.add(group.key);
    });
    const summary = document.createElement('summary');
    summary.innerHTML = icon('chevron') + icon('folder');
    summary.firstElementChild.classList.add('project-chevron');
    const label = document.createElement('span');
    label.className = 'diagram-project-name';
    label.textContent = group.name;
    label.title = group.name;
    const count = document.createElement('span');
    count.className = 'diagram-project-count';
    count.textContent = group.diagrams.length;
    summary.append(label, count);
    section.append(summary);
    const items = document.createElement('div');
    items.className = 'diagram-project-items';
    const optionGroup = document.createElement('optgroup');
    optionGroup.label = group.name;
    if (group.key) options.append(new Option(group.name, group.name));
    for (const diagram of group.diagrams) {
    const row = document.createElement('div');
    row.className = 'diagram-row' + (diagram.isTest ? ' is-test' : '');
    row.dataset.diagramId = diagram.id;
    row.dataset.selected = String(diagram.id === selected?.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diagram-open';
    button.title = diagram.title;
    button.setAttribute('aria-label', diagram.title + (diagram.isTest ? ', test diagram' : ''));
    button.setAttribute('aria-current', String(diagram.id === selected?.id));
    button.innerHTML = icon('diagram');
    const title = document.createElement('span');
    title.className = 'diagram-row-title';
    title.textContent = diagram.title;
    button.append(title);
    button.addEventListener('click', () => { void openDiagram(diagram.id, { focusRow: true }); });
    const actions = document.createElement('div');
    actions.className = 'diagram-row-actions';
    for (const [name, symbol, run] of [['Organize', 'folder', openOrganization], ['Delete', 'trash', openDeletion]]) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'icon-button' + (symbol === 'trash' ? ' diagram-delete' : '');
      action.title = `${name} diagram`;
      action.setAttribute('aria-label', `${name} ${diagram.title}`);
      action.dataset.action = name.toLowerCase();
      action.innerHTML = icon(symbol);
      action.disabled = libraryBusy;
      action.addEventListener('click', () => run(diagram));
      actions.append(action);
    }
    row.append(button, actions);
    items.append(row);
    optionGroup.append(new Option(diagram.title + (diagram.isTest ? ' · Test' : ''), diagram.id));
    }
    section.append(items);
    list.append(section);
    picker.append(optionGroup);
  }
  if (selected) picker.value = selected.id;
  $('diagram-mobile-library').classList.toggle('is-test', Boolean(diagrams.find(d => d.id === selected?.id)?.isTest));
  $('mobile-organize-diagram').disabled = libraryBusy || !selected;
  $('mobile-delete-diagram').disabled = libraryBusy || !selected;
  $('diagram-mobile-library').hidden = diagrams.length === 0;
  $('diagram-count').textContent = diagrams.length || '';
}

function openOrganization(diagram) {
  if (libraryBusy) return;
  organizeTarget = { ...diagram };
  $('organize-diagram-name').textContent = diagram.title;
  $('diagram-project-name').value = diagram.projectName || '';
  $('diagram-is-test').checked = diagram.isTest === true;
  $('organize-diagram-error').textContent = '';
  $('organize-diagram-dialog').showModal();
  $('diagram-project-name').focus();
}

function openDeletion(diagram) {
  if (libraryBusy || (diagram.id === selected?.id && !diagramEdits.canLeave())) return;
  deleteTarget = { ...diagram };
  $('delete-diagram-name').textContent = diagram.title;
  $('delete-diagram-error').textContent = '';
  $('delete-diagram-dialog').showModal();
  $('delete-diagram-dialog').querySelector('[data-close-dialog]').focus();
}

function setLibraryBusy(busy) {
  libraryBusy = busy;
  for (const dialog of [$('organize-diagram-dialog'), $('delete-diagram-dialog')]) {
    for (const button of dialog.querySelectorAll('button')) button.disabled = busy;
  }
  renderLibrary();
}

function focusLibrary(id = selected?.id, action = null) {
  const row = id ? $('diagram-list').querySelector(`[data-diagram-id="${id}"]`) : null;
  const button = row?.querySelector(action ? `[data-action="${action}"]` : '.diagram-open');
  if (button?.getClientRects().length) button.focus();
  else if (diagrams.length) $(action ? `mobile-${action}-diagram` : 'diagram-picker').focus();
  else $('refresh-diagrams').focus();
}

async function projectIdentity(name, previous) {
  if (!name) return { projectKey: null, projectName: null };
  if (name === previous.projectName) return { projectKey: previous.projectKey, projectName: name };
  const known = diagrams.find(diagram => diagram.projectName === name && diagram.projectKey);
  if (known) return { projectKey: known.projectKey, projectName: name };
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)));
  return { projectKey: 'project-' + [...hash].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join(''), projectName: name };
}

async function reconcileLibrary(id, error) {
  if (error.status && error.status !== 409 && error.status < 500) return null;
  try { return (await request('/api/diagrams/' + id + '/metadata')).diagram; }
  catch { return null; }
}

async function restoreLastDiagram() {
  if (libraryBusy || !lastDeleted) return;
  const target = lastDeleted;
  setLibraryBusy(true);
  try {
    try {
      await request('/api/diagrams/' + target.id + '/restore', { method: 'POST', body: { baseLibraryRevision: target.libraryRevision } });
    } catch (error) {
      const actual = await reconcileLibrary(target.id, error);
      if (!actual || actual.deletedAt || actual.libraryRevision !== target.libraryRevision + 1) throw error;
    }
    lastDeleted = null;
    await refreshLibrary({ afterWrite: true });
    notice(`Restored “${target.title}”.`);
  } catch (error) {
    if (error.status === 401 || error.status === 403) showAuth('Sign in again to restore the diagram.');
    else notice(error.message, { label: 'Retry undo', run: restoreLastDiagram });
  } finally {
    setLibraryBusy(false);
    if (!lastDeleted) focusLibrary(target.id);
  }
}

function refreshLibrary({ afterWrite = false } = {}) {
  if (libraryRefreshPromise) {
    // A pre-write GET cannot confirm a mutation. Finish it, then read again.
    return afterWrite ? libraryRefreshPromise.then(() => refreshLibrary({ afterWrite: true })) : libraryRefreshPromise;
  }
  libraryRefreshPromise = loadLibrary().finally(() => { libraryRefreshPromise = null; });
  return libraryRefreshPromise;
}

async function loadLibrary() {
  if (libraryRequest) return;
  const controller = new AbortController();
  libraryRequest = controller;
  $('refresh-diagrams').disabled = true;
  try {
    const result = await request('/api/diagrams', { signal: controller.signal });
    if (controller.signal.aborted) return;
    diagrams = result.diagrams.filter(diagram => typeof diagram.id === 'string' && diagramId.test(diagram.id) && diagram.id.length <= 64);
    $('mermaid-auth').hidden = true;
    $('mermaid-workspace').hidden = false;
    notice();
    if (!diagrams.length) {
      clearPreview();
      selected = null;
      renderLibrary();
      $('diagram-title').textContent = 'Diagram library';
      $('diagram-project-label').textContent = 'Mermaid';
      document.title = 'Mermaid';
      message('Publish a Mermaid diagram from Codex with $mermaid.');
      return;
    }
    const requested = new URLSearchParams(location.hash.slice(1)).get('diagram');
    const target = diagrams.find(diagram => diagram.id === requested) ?? diagrams[0];
    if (requested && target.id !== requested) notice('That diagram is unavailable. Choose a diagram from the library.');
    if (selected?.id !== target.id || selected.revision !== target.revision || !stage.firstElementChild) {
      await openDiagram(target.id);
    } else {
      selected = { ...selected, ...target };
      $('diagram-project-label').textContent = target.projectName || 'Ungrouped';
      renderLibrary();
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error.status === 401 || error.status === 403) showAuth();
    else if (selected) notice('Could not refresh diagrams. Try again.');
    else showAuth('Could not reach Mermaid. Try again.');
  } finally {
    if (libraryRequest === controller) libraryRequest = null;
    $('refresh-diagrams').disabled = false;
  }
}

async function openDiagram(id, { focusRow = false } = {}) {
  const entry = diagrams.find(diagram => diagram.id === id);
  if (!entry) return;
  if (!diagramEdits.canLeave()) return;
  clearPreview();
  selected = entry;
  collapsedProjects.delete(entry.projectKey || '');
  history.replaceState(null, '', '/mermaid#diagram=' + encodeURIComponent(id));
  renderLibrary();
  if (focusRow) $('diagram-list').querySelector('[aria-current="true"]')?.focus();
  $('diagram-title').textContent = entry.title;
  $('diagram-project-label').textContent = entry.projectName || 'Ungrouped';
  document.title = entry.title + ' · Mermaid';
  message('Loading diagram…');

  const controller = new AbortController();
  selectionRequest = controller;
  const { signal } = controller;
  const path = '/diagram/' + encodeURIComponent(id);
  try {
    const [{ diagram }, metadata] = await Promise.all([
      request('/api/diagrams/' + encodeURIComponent(id), { signal }),
      request('/api/diagrams/' + encodeURIComponent(id) + '/origin', { signal }),
    ]);
    const previewPath = path + '?checksum=' + encodeURIComponent(metadata.diagramHash);
    await request(previewPath, { method: 'HEAD', signal });
    if (signal.aborted) return;
    selected = diagram;
    if (typeof diagram.source === 'string') {
      $('diagram-source').hidden = false;
      $('source-text').value = diagram.source;
    }
    if (diagram.kind === 'interactive') {
      const frame = document.createElement('iframe');
      const nonce = crypto.randomUUID();
      let annotationMode = false;
      let annotationPins = [];
      const send = (type, extra) => frame.contentWindow?.postMessage({ type, nonce, ...extra }, '*');
      const adapter = {
        setMode(enabled) { annotationMode = enabled; send('mermaid-edit-mode', { enabled }); },
        setAnnotations(annotations) { annotationPins = annotations; send('mermaid-edit-pins', { annotations }); },
      };
      frame.title = diagram.title + ' diagram';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      frame.addEventListener('load', () => {
        if (signal.aborted) return;
        send('mermaid-edit-mode', { enabled: annotationMode });
        send('mermaid-edit-pins', { annotations: annotationPins });
        message();
      }, { once: true, signal });
      window.addEventListener('message', event => {
        if (signal.aborted || !annotationMode || event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.type !== 'mermaid-edit-selection' || event.data.nonce !== nonce) return;
        try { diagramEdits.selectTarget(normalizeDiagramTarget(event.data.target)); } catch { /* Reject unrelated or malformed bridge messages. */ }
      }, { signal });
      frame.src = previewPath;
      stage.replaceChildren(frame);
      diagramEdits.attach(diagram, adapter, metadata);
    } else {
      mountImage(previewPath, diagram.title, signal, metadata);
    }
  } catch (error) {
    if (signal.aborted) return;
    if (error.status === 401 || error.status === 403) showAuth('Sign in again to view the diagram.');
    else message('This diagram could not load.', true);
  }
}

function mountImage(path, title, signal, metadata) {
  const viewport = document.createElement('div');
  viewport.className = 'diagram-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'group');
  viewport.setAttribute('aria-label', title + ' diagram canvas');
  const image = new Image();
  image.alt = title;
  image.draggable = false;
  viewport.append(image);
  stage.replaceChildren(viewport);
  image.addEventListener('load', () => {
    if (!image.naturalWidth || !image.naturalHeight) {
      message('This diagram has no visible canvas.', true);
      return;
    }
    svgControls = enablePanZoom(viewport, image, signal);
    const adapter = attachSvgEditSurface({ viewport, image, camera: svgControls, controller: diagramEdits, signal });
    diagramEdits.attach(selected, adapter, metadata);
    $('diagram-zoom').hidden = false;
    message();
  }, { once: true, signal });
  image.addEventListener('error', () => message('This diagram preview could not load.', true), { once: true, signal });
  image.src = path;
}

function enablePanZoom(viewport, image, signal) {
  let scale, minimumScale, x, y, drag, pinch, frame;
  const paintListeners = new Set();
  const pointers = new Map();
  const paint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      image.style.transform = `translate3d(${x}px,${y}px,0) scale(${scale})`;
      for (const listener of paintListeners) listener();
    });
  };
  function cancelGesture() {
    const captured = [...pointers.keys()];
    pointers.clear();
    drag = null;
    pinch = null;
    viewport.classList.remove('dragging');
    for (const id of captured) {
      if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    }
  }
  function fit() {
    cancelGesture();
    scale = Math.min(1, Math.max(1, viewport.clientWidth - 40) / image.naturalWidth, Math.max(1, viewport.clientHeight - 40) / image.naturalHeight);
    minimumScale = scale / 2;
    x = (viewport.clientWidth - image.naturalWidth * scale) / 2;
    y = (viewport.clientHeight - image.naturalHeight * scale) / 2;
    paint();
  }
  function zoom(factor, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
    const next = Math.min(5, Math.max(minimumScale, scale * factor));
    x = anchorX - (anchorX - x) * (next / scale);
    y = anchorY - (anchorY - y) * (next / scale);
    scale = next;
    paint();
  }
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    if (pointers.size) return;
    const bounds = viewport.getBoundingClientRect();
    const distance = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
    zoom(Math.exp(-distance * .0015), event.clientX - bounds.left, event.clientY - bounds.top);
  }, { passive: false, signal });
  function localPoint(event) {
    const bounds = viewport.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }
  function beginGesture() {
    const [first, second] = pointers.values();
    drag = null;
    pinch = null;
    viewport.classList.toggle('dragging', Boolean(first));
    if (second) {
      pinch = {
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        centerX: (first.x + second.x) / 2,
        centerY: (first.y + second.y) / 2,
        scale, x, y,
      };
    } else if (first) {
      drag = { dx: first.x - x, dy: first.y - y };
    }
  }
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.pointerType !== 'touch' && (!event.isPrimary || pointers.size))) return;
    pointers.set(event.pointerId, localPoint(event));
    viewport.setPointerCapture(event.pointerId);
    beginGesture();
  }, { signal });
  function move(event) {
    if (!pointers.has(event.pointerId)) return;
    if (event.type === 'pointermove' && event.pointerType === 'mouse' && !(event.buttons & 1)) {
      cancelGesture();
      return;
    }
    pointers.set(event.pointerId, localPoint(event));
    const [first, second] = pointers.values();
    if (pinch && second) {
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const next = Math.min(5, Math.max(minimumScale, pinch.scale * distance / pinch.distance));
      const ratio = next / pinch.scale;
      x = (first.x + second.x) / 2 - (pinch.centerX - pinch.x) * ratio;
      y = (first.y + second.y) / 2 - (pinch.centerY - pinch.y) * ratio;
      scale = next;
    } else if (drag) {
      x = first.x - drag.dx;
      y = first.y - drag.dy;
    }
    paint();
  }
  function stop(event) {
    if (!pointers.delete(event.pointerId)) return;
    beginGesture();
  }
  viewport.addEventListener('pointermove', move, { signal });
  viewport.addEventListener('pointerup', event => { move(event); stop(event); }, { signal });
  viewport.addEventListener('pointercancel', stop, { signal });
  viewport.addEventListener('lostpointercapture', stop, { signal });
  viewport.addEventListener('keydown', event => {
    const direction = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[event.key];
    if (direction) {
      x += direction[0];
      y += direction[1];
      paint();
    } else if (event.key === 'Home') fit();
    else if (event.key === '+' || event.key === '=') zoom(1.25);
    else if (event.key === '-') zoom(.8);
    else return;
    event.preventDefault();
  }, { signal });
  window.addEventListener('resize', fit, { signal });
  window.addEventListener('blur', cancelGesture, { signal });
  signal.addEventListener('abort', () => { cancelGesture(); cancelAnimationFrame(frame); }, { once: true });
  fit();
  return { fit, zoom, getTransform: () => ({ scale, x, y }), onPaint: listener => { paintListeners.add(listener); signal.addEventListener('abort', () => paintListeners.delete(listener), { once: true }); } };
}

const passwordSettings = createPasswordSettings({api: request, onSaved: notice, onUnauthorized: () => showAuth(), canOpen: () => !$('mermaid-workspace').hidden});
$('mermaid-password-settings').addEventListener('click', () => { void passwordSettings.open(); });

document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => {
  if (!libraryBusy) $(button.dataset.closeDialog).close();
}));
for (const dialog of [$('organize-diagram-dialog'), $('delete-diagram-dialog')]) {
  dialog.addEventListener('cancel', event => { if (libraryBusy) event.preventDefault(); });
}
$('mobile-organize-diagram').addEventListener('click', () => {
  const diagram = diagrams.find(item => item.id === selected?.id);
  if (diagram) openOrganization(diagram);
});
$('mobile-delete-diagram').addEventListener('click', () => {
  const diagram = diagrams.find(item => item.id === selected?.id);
  if (diagram) openDeletion(diagram);
});
$('organize-diagram-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (libraryBusy || !organizeTarget) return;
  const target = organizeTarget;
  const name = $('diagram-project-name').value.trim();
  const isTest = $('diagram-is-test').checked;
  $('organize-diagram-error').textContent = '';
  setLibraryBusy(true);
  try {
    const project = await projectIdentity(name, target);
    try {
      await request('/api/diagrams/' + target.id + '/metadata', {
        method: 'PATCH', body: { baseLibraryRevision: target.libraryRevision || 0, ...project, isTest },
      });
    } catch (error) {
      const actual = await reconcileLibrary(target.id, error);
      if (!actual || actual.deletedAt || actual.libraryRevision !== (target.libraryRevision || 0) + 1
        || actual.projectKey !== project.projectKey || actual.projectName !== project.projectName || actual.isTest !== isTest) throw error;
    }
    collapsedProjects.delete(project.projectKey || '');
    $('organize-diagram-dialog').close();
    organizeTarget = null;
    await refreshLibrary({ afterWrite: true });
  } catch (error) {
    if (error.status === 401 || error.status === 403) showAuth('Sign in again to organize the diagram.');
    else $('organize-diagram-error').textContent = error.status === 409
      ? 'This diagram changed. Close this panel, refresh the library, and try again.' : error.message;
  } finally {
    setLibraryBusy(false);
    if (!$('organize-diagram-dialog').open) focusLibrary(target.id, 'organize');
  }
});
$('delete-diagram-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (libraryBusy || !deleteTarget) return;
  const target = deleteTarget;
  $('delete-diagram-error').textContent = '';
  setLibraryBusy(true);
  try {
    let diagram;
    try {
      ({ diagram } = await request('/api/diagrams/' + target.id, {
        method: 'DELETE', body: { baseRevision: target.revision, baseLibraryRevision: target.libraryRevision || 0 },
      }));
    } catch (error) {
      diagram = await reconcileLibrary(target.id, error);
      if (!diagram?.deletedAt || diagram.libraryRevision !== (target.libraryRevision || 0) + 1 || diagram.revision !== target.revision) throw error;
    }
    lastDeleted = { ...target, ...diagram };
    $('delete-diagram-dialog').close();
    deleteTarget = null;
    if (selected?.id === target.id) {
      clearPreview();
      selected = null;
      history.replaceState(null, '', '/mermaid');
    }
    await refreshLibrary({ afterWrite: true });
    notice();
  } catch (error) {
    if (error.status === 401 || error.status === 403) showAuth('Sign in again to delete the diagram.');
    else $('delete-diagram-error').textContent = error.status === 409
      ? 'This diagram changed. Close this panel, refresh the library, and try again.' : error.message;
  } finally {
    setLibraryBusy(false);
    if (!$('delete-diagram-dialog').open) $('mermaid-notice').querySelector('button')?.focus();
  }
});

$('mermaid-login').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/session', { method: 'POST', body: { password: $('mermaid-key').value } });
    $('mermaid-auth-error').textContent = '';
    await refreshLibrary();
  } catch (error) { $('mermaid-auth-error').textContent = error.message; }
  finally { $('mermaid-key').value = ''; button.disabled = false; }
});

$('mermaid-sign-out').addEventListener('click', async event => {
  if (!diagramEdits.canLeave()) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await request('/api/session', { method: 'DELETE' });
    clearChecklistReturn();
    showAuth();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      clearChecklistReturn();
      showAuth();
    } else notice(error.message);
  } finally { button.disabled = false; }
});

$('refresh-diagrams').addEventListener('click', () => {
  if (!diagramEdits.canLeave()) return;
  clearPreview();
  selected = null;
  void refreshLibrary();
});
$('retry-diagram').addEventListener('click', () => { if (selected) void openDiagram(selected.id); });
$('diagram-picker').addEventListener('change', event => { void openDiagram(event.target.value); });
$('zoom-out').addEventListener('click', () => svgControls?.zoom(.8));
$('fit-diagram').addEventListener('click', () => svgControls?.fit());
$('zoom-in').addEventListener('click', () => svgControls?.zoom(1.25));
$('diagram-source').addEventListener('click', () => {
  $('copy-status').textContent = '';
  sourceDialog.showModal();
});
$('copy-source').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('source-text').value);
    $('copy-status').textContent = 'Copied.';
  } catch {
    $('source-text').focus();
    $('source-text').select();
    $('copy-status').textContent = 'Copy the selected source.';
  }
});
window.addEventListener('hashchange', () => { if (diagrams.length) void refreshLibrary(); });
$('open-checklist').addEventListener('click', event => { if (!diagramEdits.canLeave()) event.preventDefault(); else diagramEdits.reset(); });
window.addEventListener('beforeunload', event => { if (diagramEdits.hasDraft()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    updateChecklistLinks();
    void refreshLibrary();
  }
});

async function start() {
  updateChecklistLinks();
  const params = new URLSearchParams(location.hash.slice(1));
  const key = params.get('key');
  if (key) {
    params.delete('key');
    history.replaceState(null, '', '/mermaid' + (params.size ? '#' + params : ''));
    try { await request('/api/session', { method: 'POST', body: { key } }); }
    catch (error) { showAuth(error.message); return; }
  }
  await refreshLibrary();
}

void start();
