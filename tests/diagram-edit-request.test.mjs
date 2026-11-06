import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationLabel, buildDiagramEditRequest, diagramChatLink, nativeDiagramAnnotationAvailable, normalizeDiagramTarget, parseDiagramChat, requestNativeDiagramAnnotation } from '../public/diagram-edit-request.mjs';

const requestId = '30503941-f6b5-46a5-8c4f-7ebeeb230cb5';
const chatId = 'd372747f-c7f4-4f63-8742-46a4de59c550';
const diagramHash = 'a'.repeat(64);
const diagram = { id: 'example-flow', title: 'Example flow', revision: 4 };
const annotation = { id: 'comment-one', kind: 'region', x: .2, y: .3, width: .4, height: .2, view: 'overview', nodeId: 'NODE_A', nodeLabel: 'Review request', comment: 'Give this part more space.\nKeep the existing connection.' };

test('Mermaid chat destination accepts an exact Codex chat or UUID and rejects unrelated URLs', () => {
  assert.equal(parseDiagramChat(chatId), chatId);
  assert.equal(parseDiagramChat(' codex://threads/' + chatId.toUpperCase() + ' '), chatId);
  assert.equal(parseDiagramChat(''), null);
  assert.equal(diagramChatLink(chatId), 'codex://threads/' + chatId);
  for (const value of ['https://example.test/' + chatId, 'codex://threads/' + chatId + '?prompt=secret', 'javascript:alert(1)', 'not-a-chat']) assert.throws(() => parseDiagramChat(value));
});

test('diagram target normalization preserves scene bounds and strips unknown fields', () => {
  assert.deepEqual(normalizeDiagramTarget({ ...annotation, unexpected: '<script>' }), { kind: 'region', x: .2, y: .3, width: .4, height: .2, view: 'overview', nodeId: 'NODE_A', nodeLabel: 'Review request' });
  assert.deepEqual(normalizeDiagramTarget({ kind: 'diagram' }), { kind: 'diagram', x: 0, y: 0, width: 1, height: 1, view: 'all', nodeId: null, nodeLabel: null });
  for (const value of [{ ...annotation, x: NaN }, { ...annotation, width: Infinity }, { ...annotation, x: .9 }, { ...annotation, width: 0 }, { ...annotation, y: '0.2' }, { ...annotation, kind: 'code' }]) assert.throws(() => normalizeDiagramTarget(value));
});

test('request packet carries identity, immutable revision/hash, exact comments and actionable Mermaid retrieval', () => {
  const packet = buildDiagramEditRequest({ diagram, annotations: [annotation], requestId, diagramHash, originChatId: chatId, origin: 'https://workspace.example' });
  for (const expected of ['# Mermaid diagram edit request', 'Diagram ID: example-flow', 'Source revision: 4', `Diagram checksum: ${diagramHash}`, `Saved request ID: ${requestId}`, 'https://workspace.example/mermaid#diagram=example-flow', `codex://threads/${chatId}`, 'Node ID: NODE_A', 'x=0.200000', '> Give this part more space.\n> Keep the existing connection.', `requests show --id ${requestId}`, 'Keep Checklist entries and manual checks unchanged.']) assert.ok(packet.includes(expected), expected);
  assert.equal(annotationLabel(annotation, 0), '1. Review request');
});

test('draft packet never claims its request was saved or invents an original chat', () => {
  const packet = buildDiagramEditRequest({ diagram, annotations: [annotation], diagramHash, origin: 'https://workspace.example' });
  assert.ok(!packet.includes('Saved request ID:'));
  assert.ok(!packet.includes('Original Codex chat:'));
  assert.ok(!packet.includes('requests show --id'));
});

test('packet rejects malformed identity, empty/oversized comments, private URL credentials and invalid hashes', () => {
  const base = { diagram, annotations: [annotation], diagramHash, origin: 'https://workspace.example' };
  for (const overrides of [{ diagram: { ...diagram, id: '../other' } }, { diagram: { ...diagram, revision: 0 } }, { annotations: [] }, { annotations: new Array(21).fill(annotation) }, { annotations: [{ ...annotation, comment: ' ' }] }, { annotations: [{ ...annotation, comment: 'x'.repeat(4001) }] }, { origin: 'https://user:password@workspace.example' }, { origin: 'file:///workspace' }, { diagramHash: 'not-a-hash' }, { requestId: 'not-an-id' }]) assert.throws(() => buildDiagramEditRequest({ ...base, ...overrides }));
});

test('native annotation delegates directly to the supplied host with bounded flat metadata', () => {
  const calls = [];
  const documentRef = { oai: { annotation: { request: (target, options) => { calls.push({ target, options }); return { accepted: true }; } } } };
  const target = { id: 'visible-stage' };
  assert.equal(nativeDiagramAnnotationAvailable(documentRef), true);
  assert.deepEqual(requestNativeDiagramAnnotation(documentRef, target, { id: requestId, diagramId: diagram.id, diagramRevision: diagram.revision, diagramHash }), { accepted: true });
  assert.equal(calls[0].target, target);
  assert.ok(calls[0].options.initialComment.length <= 240);
  assert.deepEqual(calls[0].options.metadata, { diagramId: diagram.id, revision: diagram.revision, requestId, diagramHash });
  assert.throws(() => requestNativeDiagramAnnotation(documentRef, target, { id: 'unsaved' }));
});

test('missing and declined native annotation support remain explicit without inventing success', () => {
  assert.equal(nativeDiagramAnnotationAvailable({}), false);
  assert.deepEqual(requestNativeDiagramAnnotation({}, {}, {}), { accepted: false });
  const documentRef = { oai: { annotation: { request: () => ({ accepted: false }) } } };
  assert.deepEqual(requestNativeDiagramAnnotation(documentRef, {}, { id: requestId, diagramId: diagram.id, diagramRevision: 4, diagramHash }), { accepted: false });
});
