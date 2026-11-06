import test from 'node:test';
import assert from 'node:assert/strict';
import { polishInteractiveDiagram } from '../scripts/interactive-diagram-ui.mjs';

test('ordinary diagram documents keep their original script and markup', () => {
  const html = '<!doctype html><html><style>body{color:white}</style><script>const title="Example diagram";</script></html>';
  assert.equal(polishInteractiveDiagram(html), html);
});

test('an incompatible interactive controller fails packaging instead of receiving a partial patch', () => {
  const html = '<!doctype html><html><style></style><script>window.researchDiagram = {}; function setupInteractions() { let unfamiliarSelection; }</script></html>';
  assert.throws(() => polishInteractiveDiagram(html), /changed/);
});
