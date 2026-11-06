import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { applyRoutes, routeOrthogonalEdges } from '../scripts/diagram-routing.mjs';

const SPACING = 18;
const EPSILON = .001;

function rectangle(id, left, top, width, height) {
  const right = left + width;
  const bottom = top + height;
  return {
    id,
    polygon: [[left, top], [right, top], [right, bottom], [left, bottom]],
    bounds: { left, right, top, bottom },
  };
}

function segments(routes) {
  return routes.flatMap(route => route.points.slice(1).map((point, index) => {
    const previous = route.points[index];
    const vertical = Math.abs(point[0] - previous[0]) < EPSILON;
    const horizontal = Math.abs(point[1] - previous[1]) < EPSILON;
    assert(vertical !== horizontal, `Connector ${route.id} must contain nonzero right-angle segments.`);
    const axis = vertical ? 1 : 0;
    return {
      edge: route.id,
      axis,
      lane: point[1 - axis],
      start: Math.min(previous[axis], point[axis]),
      end: Math.max(previous[axis], point[axis]),
    };
  }));
}

test('repeated connections use separate, evenly spaced lanes around an obstacle', async () => {
  const nodes = [
    rectangle('start', 0, 170, 120, 140),
    rectangle('obstacle', 270, 90, 120, 300),
    rectangle('finish', 600, 170, 120, 140),
  ];
  // All four connections begin with the same requested ports. The router must
  // separate their ports and bends instead of drawing over an earlier path.
  const edges = ['north', 'east', 'west', 'south'].map(id => ({
    id,
    source: { node: 'start', side: 'right', point: [120, 240] },
    target: { node: 'finish', side: 'left', point: [600, 240] },
  }));
  const routes = await routeOrthogonalEdges({ nodes, edges }, SPACING);
  assert.deepEqual(routes.map(route => route.id), edges.map(edge => edge.id));
  for (const route of routes) {
    assert.equal(route.points[0][1], 310, 'Every output leaves the bottom face.');
    assert.equal(route.points.at(-1)[1], 170, 'Every input enters the top face.');
    assertVerticalPorts(route);
  }
  for (const end of [0, -1]) {
    const ports = routes.map(route => route.points.at(end)[0]).sort((a, b) => a - b);
    ports.slice(1).forEach((coordinate, index) => assert.equal(coordinate - ports[index], SPACING));
  }

  const lines = segments(routes);
  let closestParallelLane = Infinity;
  for (const [index, line] of lines.entries()) {
    for (const { bounds } of nodes) {
      const low = line.axis === 0 ? bounds.left : bounds.top;
      const high = line.axis === 0 ? bounds.right : bounds.bottom;
      const near = line.axis === 0 ? bounds.top : bounds.left;
      const far = line.axis === 0 ? bounds.bottom : bounds.right;
      const crossesInterior = line.lane > near + EPSILON && line.lane < far - EPSILON &&
        line.start < high - EPSILON && line.end > low + EPSILON;
      assert(!crossesInterior, `Connector ${line.edge} crosses a node interior.`);
    }
    for (const other of lines.slice(index + 1)) {
      if (line.edge === other.edge || line.axis !== other.axis) continue;
      const overlap = Math.min(line.end, other.end) - Math.max(line.start, other.start);
      if (overlap <= EPSILON) continue;
      const distance = Math.abs(line.lane - other.lane);
      assert(distance >= SPACING - EPSILON, `Connectors ${line.edge} and ${other.edge} share a lane.`);
      closestParallelLane = Math.min(closestParallelLane, distance);
    }
  }
  assert.equal(closestParallelLane, SPACING);
});

test('crowded nodes keep distinct, evenly spaced ports on the bottom and top faces', async () => {
  const nodes = [rectangle('start', 0, 0, 80, 56), rectangle('finish', 400, 0, 80, 56)];
  const edges = Array.from({ length: 7 }, (_, i) => ({
    id: `branch-${i}`,
    source: { node: 'start', side: 'right', point: [80, 28] },
    target: { node: 'finish', side: 'left', point: [400, 28] },
  }));
  const routes = await routeOrthogonalEdges({ nodes, edges }, SPACING);
  assert.deepEqual(routes.map(route => route.id), edges.map(edge => edge.id));
  for (const end of [0, -1]) {
    const ports = routes.map(route => route.points.at(end));
    assert.equal(new Set(ports.map(point => point.join(','))).size, edges.length, 'Every incident connector needs a distinct port.');
    const { left, right, top, bottom } = nodes[end === 0 ? 0 : 1].bounds;
    for (const [x, y] of ports) {
      assert(x > left && x < right, 'Crowded ports do not move to side faces.');
      assert.equal(y, end === 0 ? bottom : top);
    }
    const xs = ports.map(point => point[0]).sort((a,b) => a-b);
    const gap = xs[1] - xs[0];
    assert(gap >= 4 && gap < SPACING, 'A narrow face uses a bounded smaller gap.');
    xs.slice(1).forEach((x,index) => assert(Math.abs(x-xs[index]-gap)<EPSILON, 'Crowded face ports remain evenly spaced.'));
  }
  segments(routes);
  for (const { points } of routes) {
    assertVerticalPorts({ points });
    for (let i = 2; i < points.length; i++) {
      const [a, b, c] = points.slice(i - 2, i + 1);
      assert(!(a[0] === b[0] && b[0] === c[0]) && !(a[1] === b[1] && b[1] === c[1]), 'Route points describe actual bends.');
    }
  }
});

function assertVerticalPorts({ points }) {
  assert.equal(points[0][0], points[1][0], 'A source port starts vertically.');
  assert(points[1][1] > points[0][1], 'The first segment leaves downward.');
  assert.equal(points.at(-1)[0], points.at(-2)[0], 'A target port ends vertically.');
  assert(points.at(-1)[1] > points.at(-2)[1], 'The last segment enters the top downward.');
}

test('branches, returning edges and self loops retain bottom outputs and top inputs', async () => {
  const nodes = [rectangle('first', 100, 0, 120, 60), rectangle('second', 0, 180, 120, 60), rectangle('third', 250, 180, 120, 60)];
  const makeEdge = (id, source, target) => ({ id, source: { node: source, side: 'left', point: [0, 0] }, target: { node: target, side: 'right', point: [0, 0] } });
  const edges = [makeEdge('branch-left', 'first', 'second'), makeEdge('branch-right', 'first', 'third'), makeEdge('return', 'second', 'first'), makeEdge('self-loop', 'third', 'third')];
  const routes = await routeOrthogonalEdges({ nodes, edges }, SPACING);
  assert.equal(routes.length, edges.length);
  for (const route of routes) {
    assertVerticalPorts(route);
    const edge = edges.find(edge => edge.id === route.id);
    assert.equal(route.points[0][1], nodes.find(node => node.id === edge.source.node).bounds.bottom);
    assert.equal(route.points.at(-1)[1], nodes.find(node => node.id === edge.target.node).bounds.top);
  }
  for (const line of segments(routes)) for (const { bounds } of nodes) {
    const low = line.axis === 0 ? bounds.left : bounds.top, high = line.axis === 0 ? bounds.right : bounds.bottom;
    const near = line.axis === 0 ? bounds.top : bounds.left, far = line.axis === 0 ? bounds.bottom : bounds.right;
    assert(!(line.lane > near + EPSILON && line.lane < far - EPSILON && line.start < high - EPSILON && line.end > low + EPSILON), `Connector ${line.edge} must route around every node.`);
  }
});

test('opposing long connections use separate straight crossing lanes without central switchbacks', async () => {
  const nodes = [rectangle('left-source', 100, 0, 150, 80), rectangle('right-source', 1600, 0, 150, 80), rectangle('left-target', 100, 240, 150, 80), rectangle('right-target', 1600, 240, 150, 80)];
  const edges = [
    { id: 'east', source: { node: 'left-source', side: 'right', point: [250,40] }, target: { node: 'right-target', side: 'left', point: [1600,280] } },
    { id: 'west', source: { node: 'right-source', side: 'left', point: [1600,40] }, target: { node: 'left-target', side: 'right', point: [250,280] } },
  ];
  const routes = await routeOrthogonalEdges({ nodes, edges }, SPACING);
  for (const route of routes) {
    assertVerticalPorts(route);
    assert.equal(route.points.length, 4, 'Each crossing uses one straight horizontal run between its endpoint legs.');
  }
  assert(Math.abs(routes[0].points[1][1] - routes[1].points[1][1]) >= SPACING);
});

test('an impossibly crowded face fails clearly instead of using side ports or merging connections', async () => {
  const nodes = [rectangle('start', 0, 0, 30, 50), rectangle('finish', 300, 0, 30, 50)];
  const edges = Array.from({ length: 12 }, (_, i) => ({ id: `edge-${i}`, source: { node: 'start', side: 'right', point: [30,25] }, target: { node: 'finish', side: 'left', point: [300,25] } }));
  await assert.rejects(routeOrthogonalEdges({ nodes, edges }, SPACING), /needs more width for its bottom connectors/);
});

// Use the same optional local renderer as the Mermaid CLI. The core router tests
// above remain runnable when no compatible browser has been installed.

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)(process.env.MERMAID_PLAYWRIGHT_MODULE ||
    'playwright'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const chromePath = process.env.MERMAID_CHROME_PATH || chromium?.executablePath();

test('edge labels keep unrelated strokes visible, find nearby free space and reject blocked placements', {
  skip: !chromium || !existsSync(chromePath) ? 'The optional local Mermaid browser renderer is unavailable.' : false,
}, async () => {
  const temp = fileURLToPath(new URL('../.private/mermaid-render/', import.meta.url));
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = process.env.TMP = temp;
  let browser;
  try {
    await mkdir(temp, { recursive: true });
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const page = await browser.newPage();
    const routes = [
      { id: 'labelled', points: [[40, 100], [560, 100]] },
      { id: 'crossing', points: [[300, 20], [300, 180]] },
      { id: 'parallel', points: [[40, 104], [560, 104]] },
    ];
    const svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" width="600" height="200" class="flowchart">
      <g class="edgePaths">${routes.map(route => `<path class="flowchart-link" id="${route.id}" data-id="${route.id}" d="M0,0H1"/>`).join('')}</g>
      <g class="edgeLabels"><g class="edgeLabel"><text class="edge-label-text" data-id="labelled" x="300" y="105" text-anchor="middle">A readable label</text></g></g>
    </svg>`;
    const result = await page.evaluate(applyRoutes, { svgText, routes, spacing: SPACING });
    const measured = await page.evaluate(svg => {
      document.body.innerHTML = svg;
      const label = document.querySelector('.edge-label-text');
      const box = label.getBBox();
      const transform = label.getCTM();
      const a = new DOMPoint(box.x - 4, box.y - 2).matrixTransform(transform);
      const b = new DOMPoint(box.x + box.width + 4, box.y + box.height + 2).matrixTransform(transform);
      return {
        box: { left: a.x, right: b.x, top: a.y, bottom: b.y },
        wrapperTransform: label.parentElement.getAttribute('transform'),
        labelTransform: label.getAttribute('transform'),
        backgrounds: document.querySelector('.edge-label-background').getAttribute('d').match(/M/g).length,
        text: label.textContent,
        edges: document.querySelectorAll('.flowchart-link').length,
      };
    }, result);
    assert.equal(measured.edges, routes.length);
    assert.equal(measured.text, 'A readable label');
    assert.equal(measured.wrapperTransform, null);
    assert.match(measured.labelTransform, /^translate\(/);
    assert.equal(measured.backgrounds, 1);
    // Root transforms include the viewBox translation added by applyRoutes.
    const view = result.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    const crossingX = 300 - view[0], parallelY = 104 - view[1];
    assert(measured.box.right < crossingX || measured.box.left > crossingX, 'The label background must clear the crossing connector.');
    assert(measured.box.bottom < parallelY || measured.box.top > parallelY, 'The label background must clear the neighboring parallel connector.');

    // A 93px connector between stacked nodes has a readable gap below two
    // crossing lines. Sampling only its endpoints and 32px steps misses it.
    const narrowRoutes = [
      { id: 'short', points: [[200, 40], [200, 133]] },
      { id: 'upper-crossing', points: [[-500, 75.7], [800, 75.7]] },
      { id: 'lower-crossing', points: [[-500, 93.7], [800, 93.7]] },
    ];
    const narrowSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 250" width="600" height="250" class="flowchart">
      <g class="edgePaths">${narrowRoutes.map(route => `<path class="flowchart-link" id="${route.id}" data-id="${route.id}" d="M0,0H1"/>`).join('')}</g>
      <g class="edgeLabels"><text class="edge-label-text" data-id="short" x="200" y="91" text-anchor="middle">A readable label</text></g>
    </svg>`;
    const narrowResult = await page.evaluate(applyRoutes, {
      svgText: narrowSvg, routes: narrowRoutes, spacing: SPACING,
      nodes: [rectangle('above', -500, -52, 1300, 92), rectangle('below', -500, 133, 1300, 92)],
    });
    const narrowBox = await page.evaluate(svg => {
      document.body.innerHTML = svg;
      const root = document.querySelector('svg'), label = root.querySelector('.edge-label-text');
      const box = label.getBBox(), transform = root.getCTM().inverse().multiply(label.getCTM());
      const top = new DOMPoint(box.x - 4, box.y - 2).matrixTransform(transform);
      const bottom = new DOMPoint(box.x + box.width + 4, box.y + box.height + 2).matrixTransform(transform);
      return { top: top.y, bottom: bottom.y };
    }, narrowResult);
    assert(narrowBox.top > 93.7 + 3, 'The label must use the free part of its short connector.');
    assert(narrowBox.bottom <= 133 - 6, 'The label must leave the adjacent node clear.');

    // Every ordinary offset is blocked by a dense bundle of unrelated lines.
    // The label must move just outside the bundle instead of hiding a stroke.
    const bundledRoutes = [
      { id: 'bundle-label', points: [[40, 100], [560, 100]] },
      ...Array.from({ length: 17 }, (_, index) => ({ id: `bundle-${index}`, points: [[-500, 20 + index * 10], [1000, 20 + index * 10]] })),
    ];
    const bundledSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 250" width="600" height="250" class="flowchart">
      <g class="edgePaths">${bundledRoutes.map(route => `<path class="flowchart-link" id="${route.id}" data-id="${route.id}" d="M0,0H1"/>`).join('')}</g>
      <g class="edgeLabels"><text class="edge-label-text" data-id="bundle-label" x="300" y="105" text-anchor="middle">A readable label</text></g>
    </svg>`;
    const bundledResult = await page.evaluate(applyRoutes, { svgText: bundledSvg, routes: bundledRoutes, spacing: SPACING });
    const bundledBox = await page.evaluate(svg => {
      document.body.innerHTML = svg;
      const root = document.querySelector('svg'), label = root.querySelector('.edge-label-text');
      const box = label.getBBox(), transform = root.getCTM().inverse().multiply(label.getCTM());
      const top = new DOMPoint(box.x - 4, box.y - 2).matrixTransform(transform);
      const bottom = new DOMPoint(box.x + box.width + 4, box.y + box.height + 2).matrixTransform(transform);
      return { top: top.y, bottom: bottom.y, text: label.textContent };
    }, bundledResult);
    assert.equal(bundledBox.text, 'A readable label');
    assert(bundledBox.bottom <= 17 || bundledBox.top >= 183, 'The entire background must clear the dense line bundle.');
    assert(Math.abs((bundledBox.top + bundledBox.bottom) / 2 - 100) < 170, 'The fallback must remain near its own connector.');
    await assert.rejects(page.evaluate(applyRoutes, {
      svgText: bundledSvg, routes: bundledRoutes, spacing: SPACING,
      nodes: [rectangle('fully-blocked', -2000, -2000, 4000, 4000)],
    }), /bundle-label has no clear placement near its connector/);
  } finally {
    if (browser) await browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
