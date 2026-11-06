import test from 'node:test';
import assert from 'node:assert/strict';
import { groupChecklists, chatIdFromLink } from '../public/hierarchy.mjs';
test('chat checklists group by project identity, including a project without its own checklist', () => {
  const items = [{id:'p', projectKey:'one', projectName:'Same name'}, {id:'c',scope:'chat',projectKey:'one',projectName:'Same name',chatTitle:'First'}, {id:'other',scope:'chat',projectKey:'two',projectName:'Same name',chatTitle:'Second'}];
  const groups = groupChecklists(items);
  assert.equal(groups.length,2);
  assert.equal(groups[0].project.id,'p');
  assert.equal(groups[0].chats[0].id,'c');
  assert.equal(groups[1].project,null);
  assert.equal(groups[1].chats[0].id,'other');
});
test('search by chat keeps its project context and search by project includes all children', () => {
  const items = [{id:'a',scope:'chat',projectKey:'p',projectName:'Store',chatTitle:'Research'}, {id:'b',scope:'chat',projectKey:'p',projectName:'Store',chatTitle:'Design'}];
  assert.deepEqual(groupChecklists(items,'research')[0].chats.map(x=>x.id),['a']);
  assert.equal(groupChecklists(items,'store')[0].chats.length,2);
  assert.equal(groupChecklists(items,'missing').length,0);
});
test('legacy rows remain independent project checklists without guessing from titles', () => {
  assert.equal(groupChecklists([{id:'a',name:'Same'},{id:'b',name:'Same'}]).length,2);
});
test('archive grouping preserves multiple historic project checklists for the same project', () => {
  const group=groupChecklists([{id:'old',projectKey:'same',projectName:'Store',archivedAt:'2026-10-17'}, {id:'new',projectKey:'same',projectName:'Store',archivedAt:'2026-10-18'}])[0];
  assert.equal(group.project.id,'old');
  assert.equal(group.otherProjects[0].id,'new');
});
test('chat identity accepts full Codex links and IDs but rejects arbitrary URLs and titles', () => {
  const id='867523d0-69d3-4e99-8198-7bbb32063e1f';
  assert.equal(chatIdFromLink(`codex://threads/${id}`),id);
  assert.equal(chatIdFromLink(id),id);
  assert.throws(()=>chatIdFromLink('https://example.com/'+id));
  assert.throws(()=>chatIdFromLink('Research chat'));
});
