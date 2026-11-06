const DEFAULT_WIDTH = 232;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const MIN_CANVAS_WIDTH = 420;
const STORAGE_KEY = 'mermaid.sidebarWidth';
const MOBILE_QUERY = '(max-width: 700px), (max-width: 1000px) and (pointer: coarse)';

/** Resize the diagram library without changing diagram selection or canvas gestures. */
export function attachSidebarResize({ workspace, handle, storage, window: view } = {}) {
  if (!workspace || !handle) throw new TypeError('A workspace and resize handle are required.');
  const win = view || workspace.ownerDocument?.defaultView || globalThis.window;
  if (!win) throw new TypeError('A browser window is required.');
  if (storage === undefined) {
    try { storage = win.localStorage; } catch { storage = null; }
  }
  const mobile = win.matchMedia?.(MOBILE_QUERY);
  const listeners = [];
  let preferred = DEFAULT_WIDTH;
  let width = DEFAULT_WIDTH;
  let drag = null;
  let frame = null;
  let disposed = false;

  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (saved !== null && saved !== undefined && saved.trim() !== '') {
      const number = Number(saved);
      if (Number.isFinite(number) && number > 0) preferred = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, number));
    }
  } catch { /* Browser storage may be unavailable; resizing still works. */ }

  const isMobile = () => mobile?.matches ?? win.innerWidth <= 700;
  const maximum = () => {
    const available = workspace.getBoundingClientRect?.().width || win.innerWidth;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(available - MIN_CANVAS_WIDTH)));
  };
  const apply = value => {
    const max = maximum();
    width = Math.round(Math.min(max, Math.max(MIN_WIDTH, value)));
    workspace.style.setProperty('--mermaid-sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width} pixels`);
  };
  const persist = () => {
    preferred = width;
    try { storage?.setItem(STORAGE_KEY, String(preferred)); } catch { /* Session-only preference. */ }
  };
  const cancelFrame = () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
  };
  const paint = () => {
    frame = null;
    if (drag) apply(drag.pending);
  };
  const finish = commit => {
    if (!drag) return;
    cancelFrame();
    const active = drag;
    drag = null;
    if (commit) {
      apply(active.pending);
      persist();
    } else apply(preferred);
    workspace.removeAttribute('data-sidebar-resizing');
    try {
      if (!handle.hasPointerCapture || handle.hasPointerCapture(active.id)) handle.releasePointerCapture?.(active.id);
    } catch { /* Capture can already be gone after a pointer cancellation. */ }
  };
  const refresh = () => {
    finish(false);
    const hidden = isMobile();
    handle.hidden = hidden;
    handle.tabIndex = hidden ? -1 : 0;
    apply(preferred);
  };
  const reset = () => {
    if (disposed) return;
    finish(false);
    preferred = DEFAULT_WIDTH;
    apply(preferred);
    // Store the requested default, even while a narrow layout temporarily clamps it.
    try { storage?.setItem(STORAGE_KEY, String(preferred)); } catch { /* Session-only preference. */ }
  };
  const listen = (target, name, callback) => {
    target.addEventListener(name, callback);
    listeners.push(() => target.removeEventListener(name, callback));
  };

  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-controls', 'diagram-library');
  handle.setAttribute('aria-label', 'Resize diagram library');
  handle.setAttribute('title', 'Drag to resize. Arrow keys adjust width; double-click resets.');
  listen(handle, 'pointerdown', event => {
    if (isMobile() || drag || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    handle.focus?.({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width, pending: width };
    try { handle.setPointerCapture?.(event.pointerId); } catch { drag = null; return; }
    workspace.setAttribute('data-sidebar-resizing', 'true');
  });
  listen(handle, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.pending = drag.width + event.clientX - drag.x;
    if (frame === null) frame = win.requestAnimationFrame(paint);
  });
  listen(handle, 'pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.pending = drag.width + event.clientX - drag.x;
    finish(true);
  });
  listen(handle, 'pointercancel', event => { if (drag && event.pointerId === drag.id) finish(false); });
  listen(handle, 'lostpointercapture', event => { if (drag && event.pointerId === drag.id) finish(false); });
  listen(handle, 'keydown', event => {
    if (isMobile() || drag) return;
    const step = event.shiftKey ? 40 : 10;
    let next;
    if (event.key === 'ArrowLeft') next = width - step;
    else if (event.key === 'ArrowRight') next = width + step;
    else if (event.key === 'Home') next = MIN_WIDTH;
    else if (event.key === 'End') next = maximum();
    else if (event.key === 'Enter') next = DEFAULT_WIDTH;
    else return;
    event.preventDefault();
    apply(next);
    persist();
  });
  listen(handle, 'dblclick', event => {
    if (isMobile()) return;
    event.preventDefault();
    reset();
  });
  listen(win, 'resize', refresh);
  listen(win, 'blur', () => finish(false));
  if (mobile?.addEventListener) listen(mobile, 'change', refresh);
  else if (mobile?.addListener) {
    mobile.addListener(refresh);
    listeners.push(() => mobile.removeListener(refresh));
  }
  refresh();

  return {
    reset,
    cleanup() {
      if (disposed) return;
      finish(false);
      disposed = true;
      for (const unlisten of listeners) unlisten();
      cancelFrame();
    },
  };
}
