import { AvoidLib } from 'libavoid-js';

let library;
class RoutingClearanceError extends Error {}

/** Route a validated Mermaid SVG offline. No routing code is shipped to the viewer. */
export async function routeSvg(svgText, { page, spacing = 18 } = {}) {
  if (!page) throw new Error('A local rendering page is required for diagram routing.');
  if (!Number.isFinite(spacing) || spacing < 8 || spacing > 40) throw new Error('Diagram lane spacing must be between 8 and 40.');
  const geometry = await page.evaluate(extractGeometry, svgText);
  if (!geometry || !geometry.edges.length) return svgText;
  let routes;
  for (const shapeBuffer of [spacing, spacing / 2]) {
    try {
      routes = await routeOrthogonalEdges(geometry, spacing, shapeBuffer);
      break;
    } catch (error) {
      if (!(error instanceof RoutingClearanceError) || shapeBuffer === spacing / 2) throw error;
    }
  }
  return page.evaluate(applyRoutes, { svgText, routes, spacing, nodes: geometry.nodes });
}

export async function routeOrthogonalEdges({ nodes, edges }, spacing = 18, shapeBuffer = spacing / 2) {
  library ??= AvoidLib.load().then(() => AvoidLib.getInstance());
  const avoid = await library;
  const router = new avoid.Router(avoid.OrthogonalRouting);
  const shapes = new Map();
  const owned = [];
  const connectors = [];
  const pins = new Map();
  const remember = value => { owned.push(value); return value; };
  try {
    router.setRoutingParameter(avoid.segmentPenalty, 40);
    router.setRoutingParameter(avoid.crossingPenalty, 80);
    router.setRoutingParameter(avoid.fixedSharedPathPenalty, 10000);
    router.setRoutingParameter(avoid.shapeBufferDistance, shapeBuffer);
    router.setRoutingParameter(avoid.idealNudgingDistance, spacing);
    router.setRoutingOption(avoid.nudgeOrthogonalSegmentsConnectedToShapes, true);
    router.setRoutingOption(avoid.penaliseOrthogonalSharedPathsAtConnEnds, true);
    router.setRoutingOption(avoid.nudgeOrthogonalTouchingColinearSegments, true);
    router.setRoutingOption(avoid.performUnifyingNudgingPreprocessingStep, true);
    router.setRoutingOption(avoid.nudgeSharedPathsWithCommonEndPoint, true);

    for (const [index, node] of nodes.entries()) {
      if (node.terminal) continue;
      const polygon = remember(new avoid.Polygon(node.polygon.length));
      node.polygon.forEach(([x, y], point) => polygon.set_ps(point, remember(new avoid.Point(x, y))));
      shapes.set(node.id, new avoid.ShapeRef(router, polygon, index + 1));
    }

    const groups = new Map();
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const edge of edges) {
      for (const end of ['source', 'target']) {
        const endpoint = { ...edge[end], side: end === 'source' ? 'bottom' : 'top' };
        const group = `${endpoint.node}:${endpoint.side}`;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ edge: edge.id, end, endpoint: { ...endpoint }, other: edge[end === 'source' ? 'target' : 'source'].point });
      }
    }
    let pinId = 1;
    for (const group of groups.values()) {
      if (!group.length) continue;
      const { node: nodeId, side } = group[0].endpoint;
      const node = byId.get(nodeId);
      const horizontal = side === 'top' || side === 'bottom';
      const { left, right, top, bottom } = node.bounds;
      const low = horizontal ? left : top;
      const high = horizontal ? right : bottom;
      const center = (low + high) / 2;
      const available = high - low - Math.min(20, (high - low) / 2);
      const portSpacing = group.length < 2 ? spacing : Math.min(spacing, available / (group.length - 1));
      if (portSpacing < 4) throw new Error(`Diagram node ${nodeId} needs more width for its ${side} connectors.`);
      group.sort((a, b) => a.other[0] - b.other[0] || a.endpoint.point[0] - b.endpoint.point[0] || a.edge.localeCompare(b.edge));
      group.forEach((item, rank) => {
        const coordinate = center + (rank - (group.length - 1) / 2) * portSpacing;
        const boundary = boundaryPoint(node.polygon, side, coordinate);
        const xOffset = (boundary[0] - left) / (right - left);
        const yOffset = (boundary[1] - top) / (bottom - top);
        const directions = { top: avoid.ConnDirUp, bottom: avoid.ConnDirDown, left: avoid.ConnDirLeft, right: avoid.ConnDirRight };
        const id = pinId++;
        if (node.terminal) {
          pins.set(`${item.edge}:${item.end}`, { point: boundary, direction: directions[side] });
        } else {
          const pin = new avoid.ShapeConnectionPin(shapes.get(nodeId), id, xOffset, yOffset, true, 0, directions[side]);
          pin.setExclusive(true);
          pins.set(`${item.edge}:${item.end}`, { shape: shapes.get(nodeId), id });
        }
      });
    }

    for (const [index, edge] of edges.entries()) {
      const source = pins.get(`${edge.id}:source`);
      const target = pins.get(`${edge.id}:target`);
      const makeEnd = pin => remember(pin.point ? new avoid.ConnEnd(remember(new avoid.Point(...pin.point)), pin.direction) : new avoid.ConnEnd(pin.shape, pin.id));
      const start = makeEnd(source);
      const end = makeEnd(target);
      const connector = new avoid.ConnRef(router, start, end, nodes.length + index + 1);
      connector.setRoutingType(avoid.ConnType_Orthogonal);
      connectors.push({ edge, connector });
    }
    router.processTransaction();
    return connectors.map(({ edge, connector }) => {
      const path = connector.displayRoute();
      let points = Array.from({ length: path.size() }, (_, index) => {
        const point = path.get_ps(index);
        return [round(point.x), round(point.y)];
      });
      if (points.length < 2) throw new RoutingClearanceError(`No route for diagram connector ${edge.id}.`);
      for (const end of ['source', 'target']) {
        const index = end === 'source' ? 0 : points.length - 1;
        const adjacent = points[end === 'source' ? 1 : points.length - 2];
        const point = points[index];
        const node = byId.get(edge[end].node);
        const side = end === 'source' ? 'bottom' : 'top';
        points[index] = boundaryPoint(node.polygon, side, point[0]).map(round);
        const outward = end === 'source' ? adjacent[1] - points[index][1] : points[index][1] - adjacent[1];
        if (point[0] !== adjacent[0] || outward <= 0) throw new RoutingClearanceError(`Connector ${edge.id} cannot use its required ${side} port.`);
      }
      for (let i = 1; i < points.length; i++) {
        if (points[i][0] !== points[i - 1][0] && points[i][1] !== points[i - 1][1]) {
          throw new RoutingClearanceError(`The routing clearance closes a corridor for ${edge.id}.`);
        }
      }
      points = simplifyRoute(points);
      return { id: edge.id, points };
    });
  } finally {
    avoid.destroy(router);
    for (const object of owned.reverse()) avoid.destroy(object);
  }
}

function round(value) { return Math.round(value * 1000) / 1000; }

function simplifyRoute(points) {
  const result = [];
  for (const point of points) {
    if (result.length && point[0] === result.at(-1)[0] && point[1] === result.at(-1)[1]) continue;
    while (result.length > 1) {
      const a = result.at(-2), b = result.at(-1);
      const sameAxis = a[0] === b[0] && b[0] === point[0] || a[1] === b[1] && b[1] === point[1];
      const forward = (b[0] - a[0]) * (point[0] - b[0]) + (b[1] - a[1]) * (point[1] - b[1]) >= 0;
      if (!sameAxis || !forward) break;
      result.pop();
    }
    result.push(point);
  }
  return result;
}

function boundaryPoint(polygon, side, coordinate) {
  const vertical = side === 'top' || side === 'bottom';
  const axis = vertical ? 0 : 1;
  const hits = [];
  for (let i = 0; i < polygon.length; i++) {
    const from = polygon[i], to = polygon[(i + 1) % polygon.length];
    if (coordinate < Math.min(from[axis], to[axis]) - .001 || coordinate > Math.max(from[axis], to[axis]) + .001) continue;
    if (Math.abs(to[axis] - from[axis]) < .001) {
      hits.push(from[1 - axis], to[1 - axis]);
    } else {
      const ratio = (coordinate - from[axis]) / (to[axis] - from[axis]);
      hits.push(from[1 - axis] + ratio * (to[1 - axis] - from[1 - axis]));
    }
  }
  if (!hits.length) throw new Error('A connector port could not reach its node boundary.');
  const across = side === 'top' || side === 'left' ? Math.min(...hits) : Math.max(...hits);
  return vertical ? [coordinate, across] : [across, coordinate];
}

// These browser functions are deliberately self-contained for Playwright serialization.
export function extractGeometry(svgText) {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (svg.localName !== 'svg' || !svg.classList.contains('flowchart')) return null;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none';
  const mounted = document.importNode(svg, true);
  host.append(mounted);
  document.body.append(host);
  try {
    const rootMatrix = mounted.getCTM().inverse();
    const transformPoint = (element, x, y) => {
      const value = new DOMPoint(x, y).matrixTransform(rootMatrix.multiply(element.getCTM()));
      return [value.x, value.y];
    };
    const boundsOf = polygon => ({ left: Math.min(...polygon.map(p => p[0])), right: Math.max(...polygon.map(p => p[0])), top: Math.min(...polygon.map(p => p[1])), bottom: Math.max(...polygon.map(p => p[1])) });
    const nodes = [...mounted.querySelectorAll('.nodes .node')].map((node, index) => {
      const shape = node.querySelector('.label-container') || node.querySelector('rect,polygon,circle,ellipse,path');
      if (!shape) throw new Error('A diagram node has no routing boundary.');
      let points;
      if (shape.localName === 'polygon') points = [...shape.points].map(point => [point.x, point.y]);
      else if (['circle', 'ellipse'].includes(shape.localName)) {
        const cx = +shape.getAttribute('cx'), cy = +shape.getAttribute('cy');
        const rx = +(shape.getAttribute('rx') || shape.getAttribute('r'));
        const ry = +(shape.getAttribute('ry') || shape.getAttribute('r'));
        points = Array.from({ length: 32 }, (_, i) => [cx + rx * Math.cos(i * Math.PI / 16), cy + ry * Math.sin(i * Math.PI / 16)]);
      } else {
        const box = shape.getBBox();
        points = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]];
      }
      const polygon = points.map(([x, y]) => transformPoint(shape, x, y));
      return { id: node.id || `node-${index}`, polygon, bounds: boundsOf(polygon) };
    });
    const distance = (point, polygon) => Math.min(...polygon.map((from, i) => {
      const to = polygon[(i + 1) % polygon.length];
      const dx = to[0] - from[0], dy = to[1] - from[1];
      const t = Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / (dx * dx + dy * dy || 1)));
      return (point[0] - from[0] - t * dx) ** 2 + (point[1] - from[1] - t * dy) ** 2;
    }));
    const terminals = [...mounted.querySelectorAll('.cluster')].map(cluster => {
      const shape = cluster.querySelector('rect');
      if (!shape) return null;
      const box = shape.getBBox();
      const polygon = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]].map(([x, y]) => transformPoint(shape, x, y));
      return { id: cluster.id, polygon, bounds: boundsOf(polygon), terminal: true };
    }).filter(Boolean);
    const usedTerminals = new Map();
    const edges = [...mounted.querySelectorAll('.edgePaths .flowchart-link')].map((edge, index) => {
      const length = edge.getTotalLength();
      const endpoint = end => {
        const at = edge.getPointAtLength(end ? length : 0);
        const near = edge.getPointAtLength(end ? Math.max(0, length - .5) : Math.min(.5, length));
        const point = transformPoint(edge, at.x, at.y);
        const next = transformPoint(edge, near.x, near.y);
        let node = nodes.toSorted((a, b) => distance(point, a.polygon) - distance(point, b.polygon))[0];
        if (!node || distance(point, node.polygon) > 400) {
          node = terminals.toSorted((a, b) => distance(point, a.polygon) - distance(point, b.polygon))[0];
          if (!node || distance(point, node.polygon) > 400) throw new Error('A connector endpoint is detached from its node.');
          usedTerminals.set(node.id, node);
        }
        const dx = next[0] - point[0], dy = next[1] - point[1];
        const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
        return { node: node.id, side, point };
      };
      return { id: edge.id || `edge-${index}`, source: endpoint(false), target: endpoint(true) };
    });
    return { nodes: [...nodes, ...usedTerminals.values()], edges };
  } finally { host.remove(); }
}

export function applyRoutes({ svgText, routes, spacing, nodes = [] }) {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = document.importNode(parsed.documentElement, true);
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;font:16px Arial';
  host.append(root);
  document.body.append(host);
  try {
    const rootMatrix = root.getCTM();
    const toRoot = element => rootMatrix.inverse().multiply(element.getCTM());
    const point = ([x, y], matrix) => {
      const value = new DOMPoint(x, y).matrixTransform(matrix);
      return [Math.round(value.x * 1000) / 1000, Math.round(value.y * 1000) / 1000];
    };
    const rectangle = element => {
      const box = element.getBBox();
      const matrix = toRoot(element);
      const corners = [[box.x, box.y], [box.x + box.width, box.y + box.height]].map(value => point(value, matrix));
      return { left: corners[0][0], top: corners[0][1], right: corners[1][0], bottom: corners[1][1] };
    };
    const paths = new Map([...root.querySelectorAll('.edgePaths .flowchart-link')].map(path => [path.id, path]));
    const routeByLabel = new Map();
    for (const { id, points } of routes) {
      const path = paths.get(id);
      if (!path) throw new Error('Routed diagram connector is missing.');
      const local = points.map(value => point(value, toRoot(path).inverse()));
      let d = `M${local[0].join(',')}`;
      for (let i = 1; i < local.length; i++) {
        const [x, y] = local[i], previous = local[i - 1];
        if (Math.abs(previous[0] - x) > .001 && Math.abs(previous[1] - y) > .001) throw new Error('A routed connector is diagonal.');
        d += previous[0] === x ? `V${y}` : `H${x}`;
      }
      path.setAttribute('d', d);
      routeByLabel.set(path.dataset.id || path.id, { id, points });
    }
    for (const marker of root.querySelectorAll('marker[id$="-arrow"]')) {
      if (marker.getAttribute('viewBox') === '0 0 8 8') marker.setAttribute('refX', '8');
    }

    const routeLength = points => points.slice(1).reduce((length, value, index) => length + Math.abs(value[0] - points[index][0]) + Math.abs(value[1] - points[index][1]), 0);
    const labels = [...root.querySelectorAll('.edge-label-text[data-id], .edgeLabel')].flatMap(element => {
      const key = element.dataset.id || element.querySelector('[data-id]')?.dataset.id;
      const route = routeByLabel.get(key);
      if (!route || !element.textContent.trim()) return [];
      // Mermaid can wrap a native text label in .edgeLabel. Move that label once.
      if (element.classList.contains('edgeLabel') && element.querySelector('.edge-label-text[data-id]')) return [];
      const bounds = rectangle(element);
      const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
      if (!width || !height) return [];
      return [{ element, ...route, bounds, width, height }];
    }).sort((a, b) => routeLength(a.points) - routeLength(b.points) || b.width * b.height - a.width * a.height);
    const occupied = nodes.filter(node => !node.terminal).map(node => node.bounds);
    const intersects = (a, b, margin = 6) => a.left < b.right + margin && a.right > b.left - margin && a.top < b.bottom + margin && a.bottom > b.top - margin;
    const lines = routes.flatMap(route => route.points.slice(1).map((to, index) => {
      const from = route.points[index];
      return { id: route.id, left: Math.min(from[0], to[0]), right: Math.max(from[0], to[0]), top: Math.min(from[1], to[1]), bottom: Math.max(from[1], to[1]) };
    }));
    const labelBoxes = [];
    for (const label of labels) {
      const { width, height, bounds, points } = label;
      const oldCenter = [(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2];
      let destination;
      const blockers = [
        ...occupied.map(box => ({ box, margin: 6 })),
        ...lines.filter(line => line.id !== label.id).map(box => ({ box, margin: 3 })),
      ];
      const consider = (center, offset) => {
        const box = { left: center[0] - width / 2 - 4, right: center[0] + width / 2 + 4, top: center[1] - height / 2 - 2, bottom: center[1] + height / 2 + 2 };
        // A background may cover its own connector, but no unrelated stroke.
        if (blockers.some(obstacle => intersects(box, obstacle.box, obstacle.margin))) return;
        const score = offset ** 2 * 4 + (center[0] - oldCenter[0]) ** 2 + (center[1] - oldCenter[1]) ** 2;
        if (!destination || score < destination.score) destination = { center, box, score };
      };
      const segments = [];
      for (let i = 1; i < points.length; i++) {
        const from = points[i - 1], to = points[i];
        const horizontal = from[1] === to[1];
        const axis = horizontal ? 0 : 1;
        const size = horizontal ? width : height;
        const low = Math.min(from[axis], to[axis]) + size / 2 + 6;
        const high = Math.max(from[axis], to[axis]) - size / 2 - 6;
        if (low > high) continue;
        const projected = Math.min(high, Math.max(low, oldCenter[axis]));
        const coordinates = [projected, (low + high) / 2, low, high];
        for (let coordinate = low + 8; coordinate < high; coordinate += 8) coordinates.push(coordinate);
        const clearance = (horizontal ? height : width) / 2 + 10;
        segments.push({ from, horizontal, axis, low, high, clearance });
        for (const coordinate of coordinates) {
          const maximumOffset = clearance + spacing * 2;
          const offsets = new Set([0, -clearance, clearance, -clearance - spacing, clearance + spacing, -maximumOffset, maximumOffset]);
          for (const offset of offsets) {
            const center = horizontal ? [coordinate, from[1] + offset] : [from[0] + offset, coordinate];
            consider(center, offset);
          }
        }
      }
      if (!destination) {
        // Dense junctions can fill the original offset rings or leave a gap
        // between samples. Search exact free intervals around the junction,
        // bounded by its node width and two lane spacings beyond segment ends.
        const endpointWidths = nodes.filter(node => !node.terminal && [points[0], points.at(-1)].some(([x, y]) =>
          node.polygon.some(([ax, ay], index) => {
            const [bx, by] = node.polygon[(index + 1) % node.polygon.length];
            const dx = bx - ax, dy = by - ay;
            const fraction = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
            return Math.hypot(x - ax - dx * fraction, y - ay - dy * fraction) < .01;
          })))
          .map(node => node.bounds.right - node.bounds.left);
        const nearbyWidth = Math.max(width, ...endpointWidths);
        for (const segment of segments) {
          const { from, horizontal, axis, clearance } = segment;
          const low = segment.low - spacing * 2, high = segment.high + spacing * 2;
          const normal = 1 - axis;
          const normalSize = (horizontal ? height / 2 + 2 : width / 2 + 4);
          const axisSize = horizontal ? width / 2 + 4 : height / 2 + 2;
          const minimum = axis === 0 ? 'left' : 'top', maximum = axis === 0 ? 'right' : 'bottom';
          const normalMinimum = normal === 0 ? 'left' : 'top', normalMaximum = normal === 0 ? 'right' : 'bottom';
          const maximumOffset = Math.max(clearance + spacing * 2, nearbyWidth * .75, spacing * 6);
          const offsets = new Set([0, -maximumOffset, maximumOffset,
            Math.max(-maximumOffset, Math.min(maximumOffset, (oldCenter[normal] - from[normal]) / 5))]);
          for (const { box, margin } of blockers) {
            if (box[maximum] + axisSize + margin < low || box[minimum] - axisSize - margin > high) continue;
            for (const coordinate of [box[normalMinimum] - normalSize - margin - .01, box[normalMaximum] + normalSize + margin + .01]) {
              const offset = coordinate - from[normal];
              if (Math.abs(offset) <= maximumOffset) offsets.add(offset);
            }
          }
          for (const offset of offsets) {
            const normalCoordinate = from[normal] + offset;
            const forbidden = blockers.flatMap(({ box, margin }) => {
              if (normalCoordinate + normalSize <= box[normalMinimum] - margin || normalCoordinate - normalSize >= box[normalMaximum] + margin) return [];
              return [[box[minimum] - axisSize - margin - .01, box[maximum] + axisSize + margin + .01]];
            }).filter(([start, end]) => end >= low && start <= high).sort((a, b) => a[0] - b[0]);
            let start = low;
            const considerInterval = end => {
              if (end < start) return;
              const coordinate = Math.max(start, Math.min(end, oldCenter[axis]));
              consider(horizontal ? [coordinate, normalCoordinate] : [normalCoordinate, coordinate], offset);
            };
            for (const [blockedStart, blockedEnd] of forbidden) {
              considerInterval(Math.min(high, blockedStart));
              start = Math.max(start, blockedEnd);
              if (start > high) break;
            }
            if (start <= high) considerInterval(high);
          }
        }
      }
      if (!destination) throw new Error(`Diagram label ${label.id} has no clear placement near its connector.`);
      const parentMatrix = toRoot(label.element.parentElement).inverse();
      const origin = point([0, 0], parentMatrix);
      const moved = point([destination.center[0] - oldCenter[0], destination.center[1] - oldCenter[1]], parentMatrix);
      const transform = label.element.getAttribute('transform') || '';
      label.element.setAttribute('transform', `translate(${moved[0] - origin[0]},${moved[1] - origin[1]}) ${transform}`.trim());
      occupied.push(destination.box);
      labelBoxes.push(destination.box);
    }
    const nativeLabels = labels.filter(label => label.element.classList.contains('edge-label-text'));
    if (nativeLabels.length) {
      root.querySelector('.edge-label-background')?.remove();
      const group = nativeLabels[0].element.parentElement;
      const matrix = toRoot(group).inverse();
      const background = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      background.setAttribute('class', 'edge-label-background');
      background.setAttribute('d', nativeLabels.map(({ element }) => {
        const box = rectangle(element);
        const [left, top] = point([box.left - 4, box.top - 2], matrix);
        const [right, bottom] = point([box.right + 4, box.bottom + 2], matrix);
        return `M${left},${top}H${right}V${bottom}H${left}Z`;
      }).join(''));
      group.prepend(background);
    }
    const view = root.getAttribute('viewBox').split(/[\s,]+/).map(Number);
    const xs = [...routes.flatMap(route => route.points.map(value => value[0])), ...labelBoxes.flatMap(box => [box.left, box.right])];
    const ys = [...routes.flatMap(route => route.points.map(value => value[1])), ...labelBoxes.flatMap(box => [box.top, box.bottom])];
    const left = Math.min(view[0], ...xs) - spacing;
    const top = Math.min(view[1], ...ys) - spacing;
    const right = Math.max(view[0] + view[2], ...xs) + spacing;
    const bottom = Math.max(view[1] + view[3], ...ys) + spacing;
    root.setAttribute('viewBox', [left, top, right - left, bottom - top].join(' '));
    if (root.hasAttribute('width') && !root.getAttribute('width').includes('%')) root.setAttribute('width', right - left);
    if (root.hasAttribute('height') && !root.getAttribute('height').includes('%')) root.setAttribute('height', bottom - top);
    root.setAttribute('data-route-spacing', spacing);
    return new XMLSerializer().serializeToString(root);
  } finally { host.remove(); }
}
