import { annotationLabel, buildDiagramEditRequest, diagramChatLink, nativeDiagramAnnotationAvailable, normalizeDiagramTarget, parseDiagramChat, requestNativeDiagramAnnotation } from './diagram-edit-request.mjs';

const closeIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
const editIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg>';
const trashIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg>';

export function createDiagramEdits({ button, host, api, onUnauthorized, onModeChange = () => {} }) {
  const panel = document.createElement('section');
  panel.className = 'diagram-edits-panel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'diagram-edits-title');
  panel.innerHTML = `<div class="diagram-edits-heading"><h2 id="diagram-edits-title">Request edits</h2><button type="button" class="icon-button" data-edit-action="close" title="Leave edit mode" aria-label="Leave edit mode">${closeIcon}</button></div>
    <p class="diagram-edits-help">Click a part of the diagram or drag around an area, then describe the change.</p>
    <p class="diagram-edits-hint">Turn off Request edits to move the diagram. You can still zoom.</p>
    <p class="diagram-native-status" role="status"></p>
    <div class="diagram-edit-comments" aria-live="polite"></div>
    <form class="diagram-comment-form" hidden><label for="diagram-comment">Requested change</label><p class="diagram-comment-target"></p><textarea id="diagram-comment" rows="3" maxlength="4000" required placeholder="What should change here?"></textarea><div class="diagram-comment-actions"><button class="soft-button" type="button" data-edit-action="cancel-comment">Cancel</button><button class="primary" type="submit">Add comment</button></div></form>
    <p class="diagram-edits-error error" role="alert"></p>
    <div class="diagram-edits-footer"><button class="soft-button" type="button" data-edit-action="whole">Comment on whole diagram</button><button class="primary" type="button" data-edit-action="review" disabled>Review request</button></div>
    <details class="diagram-saved-requests"><summary>Recent saved requests</summary><p class="diagram-chat-help">Showing up to 20 recent requests.</p><div class="diagram-saved-request-list"></div></details>`;
  host.append(panel);
  const review = document.createElement('dialog');
  review.id = 'diagram-edit-review';
  review.className = 'diagram-edit-review';
  review.setAttribute('aria-labelledby', 'diagram-review-title');
  review.innerHTML = `<form class="diagram-review-form"><div class="dialog-heading"><h2 id="diagram-review-title">Review diagram edits</h2><button type="button" class="icon-button" data-review-action="close" title="Close" aria-label="Close review">${closeIcon}</button></div>
    <p class="diagram-review-context"></p><label for="diagram-edit-chat">Original Codex chat</label><input id="diagram-edit-chat" autocomplete="off" placeholder="codex://threads/… or chat ID"><p class="diagram-chat-help">Link it once to return to the right chat. This can be left empty when saving.</p>
    <label for="diagram-edit-output">Request preview</label><textarea id="diagram-edit-output" rows="10" readonly spellcheck="false"></textarea>
    <p class="diagram-review-status" role="status"></p><p class="diagram-review-error error" role="alert"></p>
    <p class="diagram-send-help">Copy the request, open the original chat, then paste and send it in Codex. Saving here keeps the request; it does not start an agent.</p>
    <button class="soft-button diagram-native-annotation" type="button" data-review-action="native" title="Open the native annotation editor in the current Codex chat, which may differ from the original chat" hidden>Annotate in this Codex chat</button>
    <div class="dialog-footer diagram-review-actions"><button class="soft-button" type="button" data-review-action="copy">Copy request</button><a class="soft-button diagram-open-chat" hidden>Open original chat</a><button class="soft-button" type="button" data-review-action="save">Save request</button><button class="primary" type="submit">Copy and open chat</button></div></form>`;
  document.body.append(review);
  const find = selector => panel.querySelector(selector);
  const inReview = selector => review.querySelector(selector);
  const commentForm = find('.diagram-comment-form');
  const comment = find('#diagram-comment');
  const list = find('.diagram-edit-comments');
  const output = inReview('#diagram-edit-output');
  const destination = inReview('#diagram-edit-chat');
  const openLink = inReview('.diagram-open-chat');
  let diagram = null, adapter = null, annotations = [], pending = null, editingId = null;
  let active = false, busy = false, epoch = 0, draftId = null, attempted = false, saved = null, reviewing = null, originChatId = null, diagramHash = null;

  function failure(message = '') { find('.diagram-edits-error').textContent = message; }
  function reviewFailure(message = '') { inReview('.diagram-review-error').textContent = message; }
  function status(message = '') { inReview('.diagram-review-status').textContent = message; }
  function paint() {
    button.disabled = busy || !diagram;
    button.setAttribute('aria-pressed', String(active));
    button.querySelector('.request-edit-count').textContent = annotations.length ? String(annotations.length) : '';
    panel.hidden = !active;
    find('[data-edit-action="review"]').disabled = !annotations.length || busy;
    adapter?.setAnnotations(annotations);
  }
  function setMode(enabled) {
    active = Boolean(enabled && diagram);
    adapter?.setMode(active);
    onModeChange(active);
    paint();
  }
  function setBusy(value) {
    busy = value;
    for (const control of [...panel.querySelectorAll('button,textarea'), ...review.querySelectorAll('button,input')]) control.disabled = value;
    button.disabled = value || !diagram;
    review.setAttribute('aria-busy', String(value));
    inReview('[type="submit"]').textContent = value ? 'Saving…' : 'Copy and open chat';
    paint();
    updatePreview();
  }
  function touchDraft() {
    if (attempted || saved) { draftId = crypto.randomUUID(); attempted = false; }
    saved = null;
    reviewing = null;
  }
  function cancelComment() {
    pending = null; editingId = null; comment.value = ''; commentForm.hidden = true;
  }
  function renderComments() {
    list.replaceChildren();
    if (!annotations.length) {
      const empty = document.createElement('p'); empty.className = 'diagram-comment-empty'; empty.textContent = 'Your comments will appear here.'; list.append(empty);
    }
    for (const [index, annotation] of annotations.entries()) {
      const item = document.createElement('article'); item.className = 'diagram-edit-comment';
      const heading = document.createElement('strong'); heading.textContent = annotationLabel(annotation, index);
      const text = document.createElement('p'); text.textContent = annotation.comment;
      const actions = document.createElement('div'); actions.className = 'diagram-comment-row-actions';
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button'; edit.title = `Edit comment ${index + 1}`; edit.setAttribute('aria-label', edit.title); edit.innerHTML = editIcon;
      edit.addEventListener('click', () => { if (busy) return; selectTarget(annotation, annotation.id); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.title = `Remove draft comment ${index + 1}`; remove.setAttribute('aria-label', remove.title); remove.innerHTML = trashIcon;
      remove.addEventListener('click', () => { if (busy) return; touchDraft(); annotations = annotations.filter(value => value.id !== annotation.id); if (editingId === annotation.id) cancelComment(); renderComments(); paint(); });
      actions.append(edit, remove); item.append(heading, text, actions); list.append(item);
    }
  }
  function selectTarget(value, editId = null) {
    if (!active || busy || !diagram) return;
    try {
      if (pending && comment.value.trim() && !window.confirm('Discard the comment you have not added yet?')) return;
      pending = normalizeDiagramTarget(value);
      editingId = editId;
      commentForm.hidden = false;
      find('.diagram-comment-target').textContent = annotationLabel(pending, editingId ? annotations.findIndex(value => value.id === editingId) : annotations.length);
      comment.value = editId ? annotations.find(value => value.id === editId)?.comment || '' : '';
      commentForm.querySelector('[type="submit"]').textContent = editId ? 'Save comment' : 'Add comment';
      failure(); comment.focus();
    } catch (error) { failure(error.message); }
  }
  commentForm.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !pending) return;
    if (!comment.value.trim() || comment.value.length > 4000) { failure('Describe the change in 1 to 4,000 characters.'); return; }
    if (!editingId && annotations.length >= 20) { failure('Use up to 20 comments in one request.'); return; }
    touchDraft();
    const annotation = { ...pending, id: editingId || crypto.randomUUID(), comment: comment.value };
    annotations = editingId ? annotations.map(value => value.id === editingId ? annotation : value) : [...annotations, annotation];
    cancelComment(); failure(); renderComments(); paint();
  });
  find('[data-edit-action="cancel-comment"]').addEventListener('click', cancelComment);
  find('[data-edit-action="whole"]').addEventListener('click', () => selectTarget({ kind: 'diagram', x: 0, y: 0, width: 1, height: 1, view: 'all' }));
  find('[data-edit-action="close"]').addEventListener('click', () => setMode(false));
  button.addEventListener('click', () => { if (busy) return; setMode(!active); if (active) { void loadSaved(); find('[data-edit-action="whole"]').focus(); } });

  function currentReview() {
    return reviewing ? { diagram: { id: reviewing.diagramId, title: reviewing.diagramTitle, revision: reviewing.diagramRevision }, annotations: reviewing.annotations, requestId: reviewing.id, diagramHash: reviewing.diagramHash } : { diagram, annotations, requestId: saved?.id || null, diagramHash };
  }
  function updatePreview() {
    if (!diagram || !review.open) return;
    try {
      const chat = parseDiagramChat(destination.value);
      const nextOutput = buildDiagramEditRequest({ ...currentReview(), originChatId: chat, origin: location.origin });
      if (output.value !== nextOutput) output.value = nextOutput;
      const link = diagramChatLink(chat);
      openLink.hidden = !link;
      if (link) openLink.href = link; else openLink.removeAttribute('href');
      inReview('[type="submit"]').disabled = busy || !link;
      inReview('[data-review-action="save"]').disabled = busy || Boolean(saved || reviewing);
      inReview('[data-review-action="copy"]').disabled = busy;
      const native = inReview('[data-review-action="native"]');
      native.hidden = !nativeDiagramAnnotationAvailable(document);
      native.disabled = busy || !Boolean(saved || reviewing);
    } catch (error) {
      output.value = '';
      openLink.hidden = true;
      inReview('[type="submit"]').disabled = true;
      inReview('[data-review-action="save"]').disabled = true;
      inReview('[data-review-action="copy"]').disabled = true;
      reviewFailure(error.message);
    }
  }
  function openReview(item = null) {
    if (busy || !diagram) return;
    if (!item && pending && comment.value.trim()) { failure('Add or cancel the current comment before reviewing.'); return; }
    reviewing = item;
    destination.value = (item?.originChatId || originChatId) ? `codex://threads/${item?.originChatId || originChatId}` : '';
    destination.readOnly = Boolean(item || saved);
    inReview('.diagram-review-context').textContent = `${diagram.title} · ${item ? `saved at revision ${item.diagramRevision}` : `revision ${diagram.revision}`} · ${(item?.annotations || annotations).length} comments`;
    status(item ? `Saved request ${item.id} · ${item.status}` : saved ? `Saved request ${saved.id}.` : 'Review the full request before saving or copying.');
    reviewFailure(); review.showModal(); updatePreview();
    destination.value ? inReview('[data-review-action="copy"]').focus() : destination.focus();
  }
  find('[data-edit-action="review"]').addEventListener('click', () => openReview());
  destination.addEventListener('input', () => { if (!destination.readOnly && attempted) touchDraft(); reviewFailure(); updatePreview(); });
  async function saveRequest() {
    if (reviewing) return reviewing;
    if (saved) return saved;
    if (!/^[a-f0-9]{64}$/.test(diagramHash || '')) throw new Error('The diagram checksum could not load. Your comments are kept. Copy the request before reloading.');
    const chat = parseDiagramChat(destination.value);
    const currentEpoch = epoch;
    if (chat !== originChatId) {
      const result = await api(`/api/diagrams/${encodeURIComponent(diagram.id)}/origin`, { method: 'PUT', body: { originChatId: chat } });
      if (epoch !== currentEpoch) throw new Error('The selected diagram changed.');
      originChatId = result.originChatId;
    }
    attempted = true;
    const payload = { id: draftId, baseRevision: diagram.revision, baseHash: diagramHash, originChatId: chat, annotations: annotations.map(value => ({ ...value })) };
    const result = await api(`/api/diagrams/${encodeURIComponent(diagram.id)}/requests`, { method: 'POST', body: payload });
    if (epoch !== currentEpoch) throw new Error('The selected diagram changed.');
    saved = result.request;
    destination.readOnly = true;
    status(`Request saved. ID: ${saved.id}. Copy it and send it in the original Codex chat.`);
    void loadSaved();
    return saved;
  }
  async function copyRequest() {
    if (!output.value) throw new Error('The request preview is unavailable.');
    try { await navigator.clipboard.writeText(output.value); }
    catch { output.focus(); output.select(); throw new Error('The request is selected below. Copy it manually, then open the original chat.'); }
  }
  async function perform(action) {
    if (busy || !diagram) return;
    const currentEpoch = epoch;
    setBusy(true); reviewFailure();
    try {
      if (action === 'save' || action === 'send') await saveRequest();
      if (epoch !== currentEpoch) return;
      updatePreview();
      if (action === 'copy' || action === 'send') {
        await copyRequest();
        if (epoch !== currentEpoch) return;
        status('Request copied. Paste and send it in the original Codex chat.');
      }
      if (action === 'send' && !openLink.hidden) { setBusy(false); openLink.click(); }
    } catch (error) {
      if (epoch !== currentEpoch) return;
      if (error.status === 401) { onUnauthorized?.(); return; }
      const hint = error.status === 409 ? ' Your comments are kept. Copy them before refreshing the changed diagram.' : '';
      reviewFailure(error.message + hint);
    } finally { if (epoch === currentEpoch) setBusy(false); }
  }
  inReview('.diagram-review-form').addEventListener('submit', event => { event.preventDefault(); void perform('send'); });
  inReview('[data-review-action="save"]').addEventListener('click', () => { void perform('save'); });
  inReview('[data-review-action="copy"]').addEventListener('click', () => { void perform('copy'); });
  inReview('[data-review-action="native"]').addEventListener('click', () => {
    if (busy || !(saved || reviewing)) return;
    try {
      // The host API must run directly from this click, without awaiting a network request.
      review.close();
      const result = requestNativeDiagramAnnotation(document, host.querySelector('#diagram-visual'), reviewing || saved);
      if (result.accepted) { failure(); find('.diagram-native-status').textContent = 'Codex accepted the annotation request in this chat. Review and send it in Codex.'; }
      else { review.showModal(); reviewFailure('Codex could not accept an annotation right now. Use Copy and open chat instead.'); }
    } catch { if (!review.open) review.showModal(); reviewFailure('Native annotations are unavailable here. Use Copy and open chat instead.'); }
  });
  inReview('[data-review-action="close"]').addEventListener('click', () => { if (!busy) review.close(); });
  review.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  openLink.addEventListener('click', event => { if (busy) event.preventDefault(); });
  async function loadSaved() {
    if (!diagram) return;
    const currentEpoch = epoch;
    const container = find('.diagram-saved-request-list');
    try {
      const result = await api(`/api/diagrams/${encodeURIComponent(diagram.id)}/requests`);
      if (currentEpoch !== epoch) return;
      container.replaceChildren();
      for (const item of result.requests.slice(0, 20)) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'diagram-saved-request';
        row.textContent = `${item.annotations.length} comments · revision ${item.diagramRevision} · ${item.status}`;
        row.title = `Review saved request ${item.id}`;
        row.addEventListener('click', () => openReview(item)); container.append(row);
      }
      if (!result.requests.length) container.textContent = 'No saved requests yet.';
    } catch (error) { if (epoch === currentEpoch) container.textContent = error.status === 401 ? 'Sign in again to see saved requests.' : 'Saved requests could not load. Your draft is kept.'; }
  }
  return {
    selectTarget,
    isActive: () => active,
    hasDraft: () => Boolean(annotations.length && !saved || pending && comment.value.trim()),
    canLeave() { return !busy && (!(annotations.length && !saved || pending && comment.value.trim()) || window.confirm('Leave this diagram and discard the unsaved edit comments?')); },
    attach(value, nextAdapter, metadata) {
      epoch++; diagram = { id: value.id, title: value.title, revision: value.revision }; adapter = nextAdapter;
      annotations = []; pending = null; editingId = null; saved = null; reviewing = null;
      originChatId = metadata?.originChatId ?? null; diagramHash = metadata?.diagramHash ?? null;
      draftId = crypto.randomUUID(); attempted = false; cancelComment(); renderComments(); setMode(false);
    },
    reset() {
      epoch++; adapter?.setMode(false); adapter?.setAnnotations([]); adapter = null; diagram = null;
      annotations = []; saved = null; reviewing = null; originChatId = null; diagramHash = null; pending = null; busy = false;
      cancelComment(); if (review.open) review.close(); setMode(false); renderComments();
      output.value = ''; destination.value = ''; status(); reviewFailure(); failure();
      find('.diagram-native-status').textContent = '';
    },
  };
}

export function attachSvgEditSurface({ viewport, image, camera, controller, signal }) {
  const layer = document.createElement('div'); layer.className = 'diagram-edit-pins'; viewport.append(layer);
  let enabled = false, annotations = [], gesture = null, selection = null;
  const clamp = value => Math.min(1, Math.max(0, value));
  function point(event) {
    const rect = viewport.getBoundingClientRect(); const transform = camera.getTransform();
    return { x: (event.clientX - rect.left - transform.x) / (image.naturalWidth * transform.scale), y: (event.clientY - rect.top - transform.y) / (image.naturalHeight * transform.scale) };
  }
  function box(target) {
    const transform = camera.getTransform();
    return { left: transform.x + target.x * image.naturalWidth * transform.scale, top: transform.y + target.y * image.naturalHeight * transform.scale, width: target.width * image.naturalWidth * transform.scale, height: target.height * image.naturalHeight * transform.scale };
  }
  function paint() {
    layer.replaceChildren();
    if (!enabled) return;
    for (const [index, annotation] of annotations.entries()) {
      const bounds = box(annotation);
      const marker = document.createElement('div'); marker.className = 'diagram-edit-pin'; marker.textContent = String(index + 1);
      marker.style.left = `${bounds.left}px`; marker.style.top = `${bounds.top}px`; layer.append(marker);
      if (annotation.kind === 'region') { const region = document.createElement('div'); region.className = 'diagram-edit-region'; Object.assign(region.style, { left: bounds.left + 'px', top: bounds.top + 'px', width: bounds.width + 'px', height: bounds.height + 'px' }); layer.append(region); }
    }
    if (selection) { const bounds = box(selection); const preview = document.createElement('div'); preview.className = 'diagram-edit-region preview'; Object.assign(preview.style, { left: bounds.left + 'px', top: bounds.top + 'px', width: bounds.width + 'px', height: bounds.height + 'px' }); layer.append(preview); }
  }
  const cancel = () => {
    const pointerId = gesture?.pointerId;
    gesture = null; selection = null;
    if (pointerId !== undefined && viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
    paint();
  };
  viewport.addEventListener('pointerdown', event => {
    if (!enabled || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.isPrimary) { cancel(); return; }
    const start = point(event);
    if (start.x < 0 || start.x > 1 || start.y < 0 || start.y > 1) return;
    gesture = { pointerId: event.pointerId, start, clientX: event.clientX, clientY: event.clientY };
    viewport.setPointerCapture(event.pointerId);
  }, { capture: true, signal });
  viewport.addEventListener('pointermove', event => {
    if (!enabled) return;
    if (!gesture || gesture.pointerId !== event.pointerId) { if (!event.isPrimary) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
    event.preventDefault(); event.stopImmediatePropagation();
    const raw = point(event); const end = { x: clamp(raw.x), y: clamp(raw.y) }; const start = gesture.start;
    selection = { kind: 'region', x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    paint();
  }, { capture: true, signal });
  viewport.addEventListener('pointerup', event => {
    if (!enabled) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const started = gesture;
    const moved = Math.hypot(event.clientX - started.clientX, event.clientY - started.clientY) >= 6;
    const target = moved ? selection?.width > 0 && selection.height > 0 ? { ...selection, view: 'all', nodeId: null, nodeLabel: null } : null : { kind: 'point', ...started.start, width: 0, height: 0, view: 'all', nodeId: null, nodeLabel: null };
    cancel(); if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (target) controller.selectTarget(target);
  }, { capture: true, signal });
  viewport.addEventListener('pointercancel', cancel, { capture: true, signal });
  viewport.addEventListener('lostpointercapture', cancel, { capture: true, signal });
  camera.onPaint(paint);
  signal.addEventListener('abort', () => { layer.remove(); }, { once: true });
  return { setMode(value) { enabled = value; viewport.classList.toggle('diagram-annotating', enabled); cancel(); }, setAnnotations(value) { annotations = value; paint(); } };
}
