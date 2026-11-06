const QUOTE_LIMIT = 8000;

function contextSnapshot(context) {
  if (!context || context.archivedAt || context.archived || context.connected === false || context.disconnected === true) return null;
  if (typeof context.id !== 'string' || !context.id || !Number.isInteger(context.revision) || context.revision < 0) return null;
  return {
    projectId: context.id,
    revision: context.revision,
    projectName: String(context.projectName || context.name || ''),
    checklistName: String(context.checklistName || context.name || context.projectName || ''),
    scope: context.scope === 'chat' ? 'chat' : 'project',
    chatId: typeof context.chatId === 'string' ? context.chatId : null,
    chatTitle: typeof context.chatTitle === 'string' ? context.chatTitle : null,
    originChatId: typeof (context.scope === 'chat' ? context.chatId : context.originChatId) === 'string' ? (context.scope === 'chat' ? context.chatId : context.originChatId) : null,
  };
}

function sameContext(left, right) {
  return !!left && !!right && Object.keys(left).every(key => left[key] === right[key]);
}

function sameRange(left, right) {
  return !!left && !!right && left.startContainer === right.startContainer && left.startOffset === right.startOffset && left.endContainer === right.endContainer && left.endOffset === right.endOffset;
}

/** Capture a checklist passage without changing its text, checkboxes, or connection. */
export function createSelectionActions({ root, getContext, onAdd }) {
  if (!root?.ownerDocument || typeof getContext !== 'function' || typeof onAdd !== 'function') throw new TypeError('A checklist root, context reader, and add handler are required.');
  const document = root.ownerDocument;
  const window = document.defaultView;
  const toolbar = document.createElement('div');
  toolbar.className = 'selection-actions';
  toolbar.hidden = true;
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Selected checklist text');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'selection-add';
  button.textContent = 'Add to chat';
  button.title = 'Add selected text to chat';
  toolbar.append(button);
  document.body.append(toolbar);

  let snapshot = null;
  let capturedContext = null;
  let capturedRange = null;
  let dismissedRange = null;
  let frame = null;
  let destroyed = false;

  function liveSelection() {
    const context = contextSnapshot(getContext());
    const selection = document.getSelection();
    if (!context || !root.isConnected || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const quote = selection.toString();
    return quote.trim() ? { context, range, quote } : null;
  }

  function hide() {
    toolbar.hidden = true;
    snapshot = null;
    capturedContext = null;
    capturedRange = null;
  }

  function clear() {
    const selection = document.getSelection();
    dismissedRange = selection?.rangeCount === 1 ? selection.getRangeAt(0).cloneRange() : null;
    hide();
  }

  function focusedSnapshot() {
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) return false;
    return !!snapshot && toolbar.contains(document.activeElement) && sameContext(capturedContext, contextSnapshot(getContext())) && root.isConnected && root.contains(capturedRange?.startContainer) && root.contains(capturedRange?.endContainer);
  }

  function position(range) {
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0;
    const topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const rects = Array.from(range.getClientRects());
    const anchor = rects.find(rect => rect.width > 0 && rect.height > 0 && rect.bottom > topEdge && rect.top < topEdge + height && rect.right > leftEdge && rect.left < leftEdge + width);
    if (!anchor) {
      toolbar.hidden = true;
      return;
    }
    toolbar.hidden = false;
    const { width: toolbarWidth, height: toolbarHeight } = toolbar.getBoundingClientRect();
    const minimumLeft = leftEdge + 8;
    const maximumLeft = Math.max(minimumLeft, leftEdge + width - toolbarWidth - 8);
    const maximumTop = Math.max(topEdge + 8, topEdge + height - toolbarHeight - 8);
    let top = anchor.top - toolbarHeight - 7;
    if (top < topEdge + 8) top = anchor.bottom + 7;
    toolbar.style.left = `${Math.max(minimumLeft, Math.min(anchor.left, maximumLeft))}px`;
    toolbar.style.top = `${Math.max(topEdge + 8, Math.min(top, maximumTop))}px`;
  }

  function update() {
    frame = null;
    if (destroyed) return;
    const selected = liveSelection();
    if (!selected && focusedSnapshot()) {
      position(capturedRange);
      return;
    }
    if (!selected || sameRange(selected.range, dismissedRange)) {
      hide();
      return;
    }
    if (capturedContext && !sameContext(selected.context, capturedContext)) {
      clear();
      return;
    }
    if (!sameRange(selected.range, capturedRange) || !sameContext(selected.context, capturedContext) || snapshot?.quote !== selected.quote) {
      const taskIds = [];
      for (const row of root.querySelectorAll('.task-row[data-task-id]')) {
        if (!row.hidden && !row.closest?.('[hidden]') && selected.range.intersectsNode(row) && row.dataset.taskId && !taskIds.includes(row.dataset.taskId)) taskIds.push(row.dataset.taskId);
      }
      capturedContext = selected.context;
      capturedRange = selected.range.cloneRange();
      const tooLong = selected.quote.length > QUOTE_LIMIT;
      button.disabled = tooLong;
      button.textContent = tooLong ? 'Select less text' : 'Add to chat';
      button.title = tooLong ? 'Selection is longer than 8,000 characters. Select a shorter passage.' : 'Add selected text to chat';
      button.setAttribute('aria-label', button.title);
      snapshot = tooLong ? null : Object.freeze({ quote: selected.quote, taskIds: Object.freeze(taskIds), ...capturedContext });
    }
    position(capturedRange);
  }

  function schedule() {
    if (!destroyed && frame === null) frame = window.requestAnimationFrame(update);
  }

  function hasSelection() {
    if (destroyed) return false;
    const selected = liveSelection();
    if (!selected && focusedSnapshot()) return true;
    if (capturedContext && !sameContext(selected?.context, capturedContext)) {
      clear();
      return false;
    }
    return !!selected && !sameRange(selected.range, dismissedRange);
  }

  function add() {
    const selected = liveSelection();
    if (!selected && !focusedSnapshot()) {
      clear();
      return;
    }
    if (selected && (!sameRange(selected.range, capturedRange) || snapshot?.quote !== selected.quote)) update();
    if (!snapshot || button.disabled || !sameContext(capturedContext, contextSnapshot(getContext())) || !root.contains(capturedRange?.startContainer) || !root.contains(capturedRange?.endContainer)) {
      clear();
      return;
    }
    const result = snapshot;
    clear();
    onAdd(result);
  }

  function preserveSelection(event) {
    if (event.button === 0 && event.isPrimary !== false) event.preventDefault();
  }

  function keydown(event) {
    if (event.key === 'Escape' && !toolbar.hidden) {
      clear();
      event.preventDefault();
    } else if (event.key === 'Tab' && !event.shiftKey && !toolbar.hidden && !button.disabled && (document.activeElement === document.body || document.activeElement === document.documentElement || root.contains(document.activeElement))) {
      event.preventDefault();
      button.focus({ preventScroll: true });
    }
  }

  button.addEventListener('pointerdown', preserveSelection);
  button.addEventListener('click', add);
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('pointerup', schedule);
  document.addEventListener('keyup', schedule);
  document.addEventListener('keydown', keydown);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  const observer = new window.MutationObserver(() => {
    if (capturedRange && (!root.contains(capturedRange.startContainer) || !root.contains(capturedRange.endContainer))) clear();
  });
  observer.observe(root, { childList: true, subtree: true });

  return {
    clear,
    hasSelection,
    destroy() {
      if (destroyed) return;
      clear();
      destroyed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      button.removeEventListener('pointerdown', preserveSelection);
      button.removeEventListener('click', add);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerup', schedule);
      document.removeEventListener('keyup', schedule);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      observer.disconnect();
      toolbar.remove();
    },
  };
}
