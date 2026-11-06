// Runs only inside the existing no-same-origin diagram sandbox.
// Keep this function self-contained: the packager serializes it into the signed script.
export function installInteractiveEditsBridge() {
  const canvas = document.getElementById('canvas');
  const world = document.getElementById('world');
  if (!canvas || !world || window.parent === window) return;
  const parentOrigin = new URL(location.href).origin;
  const namespace = 'http://www.w3.org/2000/svg';
  let nonce = null;
  let enabled = false;
  let annotations = [];
  let pointer = null;
  let frame = 0;
  let layer = null;
  let drag = null;
  const graph = () => world.querySelector('svg');
  const view = () => document.getElementById('view')?.value || 'all';
  const clamp = n => Math.max(0, Math.min(1, n));
  function position(event, clip = false) {
    const svg = graph();
    const vb = svg?.viewBox?.baseVal;
    if (!vb || vb.width <= 0 || vb.height <= 0) return null;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    try {
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const x = (p.x - vb.x) / vb.width;
      const y = (p.y - vb.y) / vb.height;
      if (!clip && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
      return { x: clamp(x), y: clamp(y) };
    } catch { return null; }
  }
  function shape(name, attributes, text) {
    const item = document.createElementNS(namespace, name);
    for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
    if (text !== undefined) item.textContent = String(text);
    return item;
  }
  function render() {
    frame = 0;
    layer?.remove();
    layer = null;
    const svg = graph();
    const vb = svg?.viewBox?.baseVal;
    if (!svg || !vb || !enabled) return;
    const matrix = svg.getScreenCTM();
    const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
    const unit = 1 / Math.max(scale, 0.0001);
    layer = shape('g', { 'data-edit-annotations': '', 'pointer-events': 'none', 'aria-hidden': 'true' });
    function mark(target, number) {
      const x = vb.x + target.x * vb.width;
      const y = vb.y + target.y * vb.height;
      if (target.kind === 'region') layer.append(shape('rect', { x, y, width: target.width * vb.width, height: target.height * vb.height, fill: '#d6ddd7', 'fill-opacity': '.08', stroke: '#d6ddd7', 'stroke-width': 1.5 * unit, 'stroke-dasharray': `${5 * unit} ${4 * unit}`, rx: 2 * unit }));
      if (number !== null) {
        layer.append(shape('circle', { cx: x, cy: y, r: 11 * unit, fill: '#e4e7e3', stroke: '#292c29', 'stroke-width': 1.5 * unit }));
        layer.append(shape('text', { x, y: y + 4 * unit, 'text-anchor': 'middle', fill: '#181a18', 'font-size': 11 * unit, 'font-family': 'system-ui, sans-serif', 'font-weight': 700 }, number));
      }
    }
    annotations.forEach((annotation, index) => { if (annotation.view === view() && annotation.kind !== 'diagram') mark(annotation, index + 1); });
    if (drag) mark(drag, null);
    svg.append(layer);
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  function stop(event) { event.preventDefault(); event.stopImmediatePropagation(); }
  canvas.addEventListener('pointerdown', event => {
    if (!enabled || event.button !== 0) return;
    if (!event.isPrimary) { stop(event); cancel(); return; }
    const start = position(event);
    if (!start) return;
    const node = event.target.closest?.('[data-node-id]');
    pointer = { id: event.pointerId, start, clientX: event.clientX, clientY: event.clientY, nodeId: node?.getAttribute('data-node-id') || null, nodeLabel: node?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 240) || null };
    stop(event);
    canvas.setPointerCapture(event.pointerId);
  }, true);
  canvas.addEventListener('pointermove', event => {
    if (!enabled) return;
    stop(event);
    if (!pointer || pointer.id !== event.pointerId) return;
    const end = position(event, true);
    if (!end) return;
    drag = { kind: 'region', x: Math.min(pointer.start.x, end.x), y: Math.min(pointer.start.y, end.y), width: Math.abs(end.x - pointer.start.x), height: Math.abs(end.y - pointer.start.y) };
    schedule();
  }, true);
  canvas.addEventListener('pointerup', event => {
    if (!enabled) return;
    stop(event);
    if (!pointer || pointer.id !== event.pointerId) return;
    const saved = pointer;
    const end = position(event, true) || saved.start;
    const region = Math.abs(event.clientX - saved.clientX) > 4 && Math.abs(event.clientY - saved.clientY) > 4 && Math.abs(end.x - saved.start.x) > 0 && Math.abs(end.y - saved.start.y) > 0;
    pointer = null; drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const target = { kind: region ? 'region' : 'point', x: region ? Math.min(saved.start.x, end.x) : end.x, y: region ? Math.min(saved.start.y, end.y) : end.y, width: region ? Math.abs(end.x - saved.start.x) : 0, height: region ? Math.abs(end.y - saved.start.y) : 0, view: view(), nodeId: region ? null : saved.nodeId, nodeLabel: region ? null : saved.nodeLabel };
    window.parent.postMessage({ type: 'mermaid-edit-selection', nonce, target }, parentOrigin);
    schedule();
  }, true);
  const cancel = () => {
    const captured = pointer?.id;
    pointer = null; drag = null;
    if (captured !== undefined && canvas.hasPointerCapture(captured)) canvas.releasePointerCapture(captured);
    schedule();
  };
  canvas.addEventListener('pointercancel', cancel, true);
  canvas.addEventListener('lostpointercapture', cancel, true);
  canvas.addEventListener('click', event => { if (enabled) stop(event); }, true);
  canvas.addEventListener('wheel', () => { if (enabled) schedule(); }, { passive: true });
  window.addEventListener('resize', schedule);
  document.getElementById('view')?.addEventListener('change', () => { cancel(); schedule(); });
  new MutationObserver(schedule).observe(world, { childList: true, attributes: true, attributeFilter: ['style'] });
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.nonce)) return;
    if (data.type === 'mermaid-edit-mode') {
      nonce = data.nonce;
      enabled = data.enabled === true;
      canvas.style.cursor = enabled ? 'crosshair' : '';
      if (!enabled) cancel();
      schedule();
    } else if (data.type === 'mermaid-edit-pins' && data.nonce === nonce && Array.isArray(data.annotations)) {
      annotations = data.annotations.slice(0, 20).filter(a => a && ['point', 'region', 'diagram'].includes(a.kind) && ['x', 'y', 'width', 'height'].every(key => typeof a[key] === 'number' && Number.isFinite(a[key]) && a[key] >= 0 && a[key] <= 1) && typeof a.view === 'string');
      schedule();
    }
  });
}
