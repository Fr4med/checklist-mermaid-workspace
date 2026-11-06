import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { effectiveMarkdown as applyChecks, parseTasks } from '../src/tasks.mjs';
import { groupChecklists, checklistTitle, chatIdFromLink } from './hierarchy.mjs';
import { createSelectionActions } from './selection.mjs';
import { createChangeComposer } from './change-composer.mjs';
import { createPasswordSettings } from './password-settings.mjs';

const paths={check:'m5 12 4 4L19 6',plus:'M12 5v14M5 12h14',search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',folder:'M3 7h7l2-3h9v16H3z',file:'M14 2H5v20h14V7zM14 2v5h5M8 12h8M8 16h8',edit:'m16 3 5 5-12 12H4v-5zM13 6l5 5',refresh:'M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-3l2 3M19 17a8 8 0 0 1-13 3l-2-3',download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',panel:'M3 3h18v18H3zM9 3v18',close:'m6 6 12 12M6 18 18 6',link:'m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',logout:'M9 4H4v16h5M10 12h11m-4-4 4 4-4 4'};
Object.assign(paths,{archive:'M3 3h18v5H3zM5 8v13h14V8M9 12h6',chat:'M4 4h16v13H9l-5 4z',organize:'M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7',chevron:'m9 5 7 7-7 7'});
Object.assign(paths,{diagram:'M9 3h6v6H9zM3 16h6v5H3zM15 16h6v5h-6zM12 9v4M6 16v-3h12v3',key:'M15 8a5 5 0 1 1-3 9L4 21H2v-4l8-8a5 5 0 0 1 5-1M16 7h.01'});
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
const $=id=>document.getElementById(id);
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const marked=new Marked({gfm:true,breaks:false,renderer:{html:({text})=>{const marker=text.match(/^<!--\s*checklist:([A-Za-z0-9_-]{8,80})\s*-->$/);if(marker)return `<span data-checklist-id="${marker[1]}" hidden></span>`;if(/^<!--\s*\/?checklist-research:[A-Za-z0-9_-]{8,80}\s*-->$/.test(text.trim()))return '';return escape(text);}}});
let projects=[],current=null,selectedId='',filter='all',editing=false,editRevision=0,editOriginal='',busy=false,authenticated=false,failures=0,refreshRunning=false,loadSequence=0;
let timer;
const workspaceReturnKey='checklist:workspace-return';
let switchingWorkspace=false;
let archiveView=false,viewSequence=0,archiveTarget=null,organizeTarget=null,identityLoading=false;
let pendingProject=null;
const collapsedGroups=new Set();
const notice=(message='')=>{$('notice').textContent=message;$('notice').hidden=!message;};
function connection(label,ok=true){$('connection-status').textContent=label;$('connection-dot').classList.toggle('offline',!ok);}
async function api(path,{method='GET',body}={}){
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const result=await response.json();
  if(!response.ok){const error=new Error(result.error||`Request failed (${response.status})`);error.status=response.status;throw error;}
  return result;
}
function rememberWorkspace(params,draft=false){
  try{sessionStorage.setItem(workspaceReturnKey,JSON.stringify({project:params.get('project'),archived:params.get('archived')==='1',draft}));}catch{}
}
function openMermaid(){
  if(!authenticated||busy)return;
  if(editing&&$('source-editor').value!==editOriginal&&!keepDraft()){
    notice('Copy your draft before switching workspaces. It could not be stored on this device.');
    return;
  }
  const params=new URLSearchParams(location.hash.slice(1));
  if(selectedId)params.set('project',selectedId);
  if(archiveView)params.set('archived','1');else params.delete('archived');
  rememberWorkspace(params,editing);
  switchingWorkspace=true;
  location.assign('/mermaid');
}
function restoreWorkspaceEdit(id){
  try{
    const saved=JSON.parse(sessionStorage.getItem(workspaceReturnKey)||'null');
    if(saved?.project!==id||saved.archived!==archiveView)return;
    sessionStorage.removeItem(workspaceReturnKey);
    if(saved.draft&&!current.archivedAt)beginEdit();
  }catch{}
}
function showAuth(){authenticated=false;passwordSettings.close();selectionActions.clear();changeComposer.close();$('auth').hidden=false;$('workspace').hidden=true;clearTimeout(timer);loadSequence++;}
function showWorkspace(){authenticated=true;$('auth').hidden=true;$('workspace').hidden=false;}
function closeSidebar(){$('workspace').classList.remove('sidebar-open');$('backdrop').hidden=true;}
function renderProjects(){
  const query=$('project-search').value.trim();
  const groups=groupChecklists(projects,query);
  $('project-count').textContent=groupChecklists(projects).length||'';
  $('list-label').textContent=archiveView?'Archived':'Projects';
  $('archive-view').setAttribute('aria-pressed',String(archiveView));
  $('archive-view-label').textContent=archiveView?'Back to projects':'Archived checklists';
  $('projects').replaceChildren();
  for(const group of groups){
    const section=document.createElement('section');section.className='project-group';section.setAttribute('aria-label',group.name);
    const row=group.project?sidebarRow(group.project,false,group.name):document.createElement('div');
    if(!group.project){row.className='project-row folder-only';const label=document.createElement('span');label.className='group-name';label.innerHTML=`${icon('folder')}<span class="name">${escape(group.name)}</span>`;row.append(label);}
    const children=[...(group.otherProjects||[]),...group.chats];
    if(children.length){const expanded=!!query||!collapsedGroups.has(group.key);const toggle=document.createElement('button');toggle.className='group-toggle';toggle.innerHTML=icon('chevron');toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-label',`${expanded?'Collapse':'Expand'} ${group.name}`);toggle.addEventListener('click',()=>{if(expanded)collapsedGroups.add(group.key);else collapsedGroups.delete(group.key);renderProjects();});row.prepend(toggle);section.append(row);if(expanded){const list=document.createElement('div');list.className='chat-list';for(const item of children)list.append(sidebarRow(item,true));section.append(list);}}
    else section.append(row);
    $('projects').append(section);
  }
  if(!groups.length){const p=document.createElement('p');p.className='sidebar-empty';p.textContent=query?'No matching checklists.':archiveView?'No archived checklists.':'Connected projects appear here.';$('projects').append(p);}
}
function sidebarRow(item,child=false,title=checklistTitle(item)){
  const row=document.createElement('div');row.className=`project-row${child?' chat-row':''}${item.id===selectedId?' selected':''}`;
  const button=document.createElement('button');button.className='checklist-select';button.setAttribute('aria-current',item.id===selectedId?'page':'false');button.title=title;button.innerHTML=`${icon(item.scope==='chat'?'chat':'folder')}<span class="name">${escape(title)}</span>`;button.addEventListener('click',()=>selectProject(item.id));row.append(button);
  const count=document.createElement('small');count.className='row-count';count.textContent=`${item.done??0}/${item.total??0}`;row.append(count);
  if(!item.archivedAt){const button=document.createElement('button');button.className='icon-button row-archive';button.title='Archive checklist';button.setAttribute('aria-label',`Archive ${title}`);button.innerHTML=icon('archive');button.disabled=busy;button.addEventListener('click',()=>openArchive(item));row.append(button);}
  return row;
}
function effectiveMarkdown(project){return applyChecks(project.markdown,Object.fromEntries(project.tasks.map(task=>[task.id,task.checked])));}
function updateSummary(project){const idx=projects.findIndex(p=>p.id===project.id);const {markdown,tasks,...summary}=project;if(Boolean(project.archivedAt)!==archiveView){if(idx>=0)projects.splice(idx,1);}else if(idx<0)projects.push(summary);else projects[idx]=summary;renderProjects();}
function renderDocument(){
  selectionActions.clear();
  document.querySelectorAll('.row-archive').forEach(button=>{button.disabled=busy;});
  if(!current)return;
  $('empty').hidden=true;$('project-view').hidden=editing;$('editor-view').hidden=!editing;
  const archived=!!current.archivedAt;
  $('document-hint').textContent=archived?'Markdown · archived and disconnected':'Markdown · click to check or uncheck';
  $('project-title').textContent=checklistTitle(current);$('project-subtitle').textContent=current.scope==='chat'?`${current.projectName} / Chat checklist`:'Project checklist';$('edit').disabled=archived||editing||busy;$('download').disabled=false;
  $('archive-current').hidden=archived;$('archive-current').disabled=busy||editing;$('organize').disabled=archived||busy||editing;$('add-task').hidden=archived;$('archive-banner').hidden=!archived;
  $('archive-date').textContent=archived?`Archived ${new Date(current.archivedAt).toLocaleDateString()}. Disconnected from its project and chat.`:'';
  $('progress-label').textContent=`${current.done} of ${current.total} completed`;$('progress-fill').style.width=`${current.total?current.done/current.total*100:0}%`;
  const html=marked.parse(current.markdown);
  $('markdown').innerHTML=DOMPurify.sanitize(html,{FORBID_TAGS:['img','style','iframe','form'],ADD_TAGS:['input'],ADD_ATTR:['checked','disabled','type']});
  const boxes=[...$('markdown').querySelectorAll('input[type=checkbox]')];
  let unsupported=false;
  for(const box of boxes){
    const row=box.closest('li');if(!row)continue;
    const markers=[...row.querySelectorAll('[data-checklist-id]')].filter(marker=>marker.closest('li')===row);
    const task=markers.length===1?current.tasks.find(t=>t.id===markers[0].dataset.checklistId):null;
    if(!task){box.disabled=true;unsupported=true;continue;}
    // Marked wraps loose-list content in a paragraph. Keep the checkbox a direct child.
    if(box.parentElement!==row){const wrapper=box.parentElement;while(wrapper.firstChild)row.insertBefore(wrapper.firstChild,wrapper);wrapper.remove();}
    row.classList.add('task-row');row.classList.toggle('done',task.checked);row.dataset.taskId=task.id;row.dataset.checked=String(task.checked);
    box.disabled=busy||archived;box.checked=task.checked;box.setAttribute('aria-label',task.text);box.addEventListener('change',()=>toggleTask(task.id,box.checked));
    const label=document.createElement('span');label.className='task-text';let next=box.nextSibling;
    while(next&&!(next.nodeType===1&&['UL','OL'].includes(next.tagName))){const after=next.nextSibling;label.append(next);next=after;}box.after(label);
    const title=document.createElement('span');title.className='task-title';while(label.firstChild&&!(label.firstChild.nodeType===1&&['P','DIV','BLOCKQUOTE','PRE'].includes(label.firstChild.tagName)))title.append(label.firstChild);label.prepend(title);
    if(task.manual&&!archived){const reset=document.createElement('button');reset.className='icon-button reset-task';reset.title='Restore source status';reset.setAttribute('aria-label',`Restore source status: ${task.text}`);reset.innerHTML=icon('refresh');reset.disabled=busy;reset.addEventListener('click',()=>toggleTask(task.id,null));row.append(reset);}
  }
  if(unsupported)notice('Some task rows have no matching saved ID. Edit and save the Markdown to normalize them.');
  $('cancel-edit').disabled=busy;$('source-editor').readOnly=busy;$('sign-out').disabled=busy;$('save-edit').disabled=busy||archived;
  $('markdown').querySelectorAll('a').forEach(a=>{a.target='_blank';a.rel='noopener noreferrer';});
  $('updated-at').textContent=`Updated ${new Date(current.updatedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`;
  applyFilters();
}
function applyFilters(){const query=$('task-search').value.toLowerCase().trim();let count=0;const rows=[...$('markdown').querySelectorAll('.task-row')];for(const row of rows.reverse()){const content=row.cloneNode(true);content.querySelectorAll('.task-row,.reset-task').forEach(child=>child.remove());const ownText=content.textContent.toLowerCase();const self=(filter==='all'||(filter==='done')===(row.dataset.checked==='true'))&&ownText.includes(query);const childVisible=[...row.querySelectorAll('.task-row')].some(r=>!r.hidden);row.hidden=!self&&!childVisible;if(self)count++;} $('no-matches').hidden=!!count||(!query&&filter==='all');}
async function selectProject(id){
  if(busy)return;
  selectionActions.clear();
  pendingProject=null;
  if(editing){notice('Save or cancel the Markdown edit before switching projects.');return;}
  selectedId=id;current=null;$('project-view').hidden=true;$('edit').disabled=true;$('download').disabled=true;$('archive-current').disabled=true;$('organize').disabled=true;const sequence=++loadSequence;renderProjects();closeSidebar();
  try{const result=await api(`/api/projects/${encodeURIComponent(id)}`);if(sequence!==loadSequence||!authenticated)return;current=result.project;history.replaceState(null,'',`${location.pathname}${location.search}#project=${encodeURIComponent(id)}${archiveView?'&archived=1':''}`);renderDocument();notice();connection('Up to date');restoreWorkspaceEdit(id);}
  catch(e){if(e.status===401)showAuth();else notice(e.message);}
}
async function refresh(){
  if(!authenticated||busy||refreshRunning)return;
  refreshRunning=true;
  const view=viewSequence;
  try{const result=await api(`/api/projects${archiveView?'?archived=true':''}`);if(!authenticated||view!==viewSequence)return;projects=result.projects.map(p=>{const known=projects.find(k=>k.id===p.id);return known&&known.revision>p.revision?known:p;});renderProjects();
    if(!selectedId&&projects.length){const wanted=new URLSearchParams(location.hash.slice(1)).get('project');await selectProject(projects.some(p=>p.id===wanted)?wanted:projects[0].id);}
    else if(selectedId){const summary=projects.find(p=>p.id===selectedId);if(current&&((summary&&summary.revision>current.revision)||(!summary&&!current.archivedAt))){const id=selectedId;const sequence=loadSequence;const r=await api(`/api/projects/${encodeURIComponent(id)}`);if(id===selectedId&&sequence===loadSequence&&!busy&&authenticated&&view===viewSequence&&r.project.revision>=current.revision){if(changeComposer.isOpen()||selectionActions.hasSelection()){pendingProject=r.project;notice(r.project.archivedAt?'This checklist was archived. The quote is preserved, but its connection is closed.':'This checklist changed elsewhere. Your selected passage is preserved. Close the request or clear the selection to load the update.');}else if(editing&&!r.project.archivedAt)notice('This checklist changed elsewhere. The current draft is preserved. Cancel to load the latest version.');else{current=r.project;pendingProject=null;renderDocument();if(editing&&current.archivedAt)notice('This checklist was archived. Your unsaved draft remains on this device and can be copied. Sync is disconnected.');}}}}
    failures=0;connection('Up to date');
  }catch(e){if(e.status===401)showAuth();else{failures++;connection('Reconnecting',false);notice('The connection is unavailable. Saved tasks remain stored; refresh will retry.');}}
  finally{refreshRunning=false;if(view!==viewSequence&&authenticated&&!busy)void refresh();else schedule();}
}
function schedule(){clearTimeout(timer);if(authenticated&&!document.hidden)timer=setTimeout(refresh,Math.min(120000,15000*2**failures));}
async function toggleTask(taskId,checked){
  if(!current||current.archivedAt||busy||editing)return;const id=current.id;busy=true;loadSequence++;renderDocument();
  try{const result=await api(`/api/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`,{method:'PATCH',body:{checked,baseRevision:current.revision}});if(selectedId===id){current=result.project;updateSummary(current);}notice();connection('Saved');}
  catch(e){if(e.status===409){notice('Another update arrived first. The latest checklist is loaded; click the checkbox again.');const result=await api(`/api/projects/${encodeURIComponent(id)}`);if(selectedId===id)current=result.project;}else if(e.status===401)showAuth();else notice(`Could not save this check. ${e.message}`);}
  finally{busy=false;renderDocument();schedule();}
}
function draftKey(){return `checklist:draft:${current.id}`;}
function beginEdit(){if(!current||current.archivedAt||busy)return;editing=true;editRevision=current.revision;editOriginal=effectiveMarkdown(current);let draft=null;try{draft=JSON.parse(localStorage.getItem(draftKey())||'null');}catch{}$('source-editor').value=draft?.markdown??editOriginal;if(draft){editRevision=draft.revision;editOriginal=draft.original;$('draft-status').textContent='Recovered unsaved draft';}else $('draft-status').textContent='';renderDocument();$('source-editor').focus();}
function keepDraft(){try{localStorage.setItem(draftKey(),JSON.stringify({markdown:$('source-editor').value,revision:editRevision,original:editOriginal}));$('draft-status').textContent='Draft saved on this device';return true;}catch{$('draft-status').textContent='Draft is unsaved on this device';return false;}}
async function cancelEdit(){if(busy)return;editing=false;notice();await selectProject(selectedId);}
async function saveEdit(){if(!editing||!current||current.archivedAt||busy)return;busy=true;loadSequence++;renderDocument();$('save-edit').disabled=true;try{const before=new Map(parseTasks(editOriginal).filter(t=>t.id).map(t=>[t.id,t.sourceChecked]));const checkedChanges=Object.fromEntries(parseTasks($('source-editor').value).filter(t=>t.id&&before.has(t.id)&&before.get(t.id)!==t.sourceChecked).map(t=>[t.id,t.sourceChecked]));const result=await api(`/api/projects/${current.id}/document`,{method:'PUT',body:{markdown:$('source-editor').value,baseRevision:editRevision,checkedChanges}});try{localStorage.removeItem(draftKey());}catch{}current=result.project;editing=false;updateSummary(current);notice();connection('Saved');}catch(e){if(e.status===409)notice('This checklist changed elsewhere. The draft is safe on this device. Copy needed changes, cancel, then edit the latest version.');else if(e.status===401)showAuth();else notice(e.message);}finally{busy=false;renderDocument();schedule();}}
let formGroups=[];
async function prepareIdentity(prefix,item=null){
  const sequence=loadSequence;const result=await api('/api/projects');if(sequence!==loadSequence||!authenticated)return false;formGroups=groupChecklists(result.projects);
  const select=$(prefix+'-parent');select.innerHTML='<option value="__new__">New project…</option>'+formGroups.map(g=>`<option value="${escape(g.key)}">${escape(g.name)}</option>`).join('');
  $(prefix+'-scope').value=item?.scope||'project';select.value=item?.projectKey||'__new__';if(!select.value)select.value='__new__';
  $(prefix+'-project-name').value=item?.projectName||'';$(prefix+'-name').value=item?.chatTitle||'';$(prefix+'-chat-link').value=item?.chatId?`codex://threads/${item.chatId}`:'';identityFields(prefix);return true;
}
function identityFields(prefix){
  const chat=$(prefix+'-scope').value==='chat',newParent=$(prefix+'-parent').value==='__new__';
  $(prefix+'-new-parent').hidden=!newParent;$(prefix+'-project-name').required=newParent;$(prefix+'-chat-fields').hidden=!chat;$(prefix+'-name').required=chat;$(prefix+'-chat-link').required=chat;
}
function readIdentity(prefix,id){
  const scope=$(prefix+'-scope').value,key=$(prefix+'-parent').value;
  const group=formGroups.find(g=>g.key===key);const projectName=group?.name||$(prefix+'-project-name').value.trim();
  if(!projectName)throw new Error('Enter a project name.');
  const chatTitle=scope==='chat'?$(prefix+'-name').value.trim():null;
  if(scope==='chat'&&!chatTitle)throw new Error('Enter a chat title.');
  return {scope,projectKey:group?.key||id,projectName,chatId:scope==='chat'?chatIdFromLink($(prefix+'-chat-link').value):null,chatTitle};
}
async function createDialog(){if(identityLoading)return;if(busy||editing){notice('Save or cancel your Markdown edit first.');return;}identityLoading=true;try{if(!await prepareIdentity('new'))return;$('create-error').textContent='';$('create-dialog').showModal();$('new-scope').focus();}catch(e){notice(e.message);}finally{identityLoading=false;}}
async function organizeDialog(){if(!current||current.archivedAt||busy||editing||identityLoading)return;identityLoading=true;const target={...current};try{if(!await prepareIdentity('organize',target)||current?.id!==target.id)return;organizeTarget=target;$('organize-error').textContent='';$('organize-dialog').showModal();}catch(e){notice(e.message);}finally{identityLoading=false;}}
function clearSelection(){selectionActions.clear();current=null;selectedId='';loadSequence++;$('project-view').hidden=true;$('editor-view').hidden=true;$('empty').hidden=false;$('project-title').textContent=archiveView?'Archived checklists':'Checklist';$('project-subtitle').textContent='Select a checklist';for(const id of ['edit','download','organize','archive-current'])$(id).disabled=true;$('archive-current').hidden=archiveView;}
async function switchArchiveView(){if(busy||editing){notice('Save or cancel your Markdown edit before switching views.');return;}archiveView=!archiveView;viewSequence++;projects=[];clearSelection();history.replaceState(null,'',`${location.pathname}${location.search}${archiveView?'#archived=1':''}`);renderProjects();await refresh();}
function openArchive(item){if(busy)return;if(editing){notice('Save or cancel your Markdown edit before archiving.');return;}archiveTarget=item;$('archive-name').textContent=checklistTitle(item);$('archive-error').textContent='';$('archive-dialog').showModal();}
async function archiveChecklist(){
  if(busy||!archiveTarget)return;busy=true;loadSequence++;viewSequence++;const item=archiveTarget;$('confirm-archive').disabled=true;renderProjects();
  try{const result=await api(`/api/projects/${encodeURIComponent(item.id)}/archive`,{method:'POST',body:{baseRevision:item.revision}});projects=projects.filter(p=>p.id!==item.id);if(current?.id===item.id){current=result.project;renderDocument();}renderProjects();$('archive-dialog').close();notice('Checklist archived. Its saved tasks are kept and syncing is disconnected.');connection('Archived');}
  catch(e){$('archive-error').textContent=e.status===409?'This checklist changed. Close this dialog, refresh, then archive the latest version.':e.message;}
  finally{busy=false;$('confirm-archive').disabled=false;renderProjects();if(current)renderDocument();void refresh();}
}
for(const prefix of ['new','organize']){for(const field of ['scope','parent'])$(prefix+'-'+field).addEventListener('change',()=>identityFields(prefix));}
$('archive-view').addEventListener('click',switchArchiveView);$('archive-current').addEventListener('click',()=>current&&openArchive(current));$('confirm-archive').addEventListener('click',archiveChecklist);$('organize').addEventListener('click',organizeDialog);
$('organize-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy||!organizeTarget||current?.id!==organizeTarget.id)return;const id=organizeTarget.id;busy=true;loadSequence++;viewSequence++;const button=e.currentTarget.querySelector('[type=submit]');button.disabled=true;
  try{const identity=readIdentity('organize',`project-${crypto.randomUUID()}`);const result=await api(`/api/projects/${encodeURIComponent(id)}/identity`,{method:'PUT',body:{...identity,baseRevision:organizeTarget.revision}});if(current?.id===id)current=result.project;updateSummary(result.project);$('organize-dialog').close();notice('Checklist organization saved.');}
  catch(e){$('organize-error').textContent=e.status===409?'This checklist changed or that project/chat already has a checklist. Refresh before trying again.':e.message;}
  finally{busy=false;button.disabled=false;renderDocument();void refresh();}
});
const passwordSettings=createPasswordSettings({api,onSaved:notice,onUnauthorized:showAuth,canOpen:()=>authenticated&&!busy});
$('password-settings').addEventListener('click',()=>void passwordSettings.open());
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('/api/session',{method:'POST',body:{password:$('access-key').value}});$('login-error').textContent='';showWorkspace();await refresh();}catch(e){$('login-error').textContent=e.message;}finally{$('access-key').value='';button.disabled=false;}});
$('sign-out').addEventListener('click',async()=>{if(busy)return;try{await api('/api/session',{method:'DELETE'});try{sessionStorage.removeItem(workspaceReturnKey);}catch{}current=null;selectedId='';projects=[];editing=false;showAuth();$('markdown').replaceChildren();$('projects').replaceChildren();$('source-editor').value='';}catch(e){notice(`Sign out failed. ${e.message}`);}});
$('project-search').addEventListener('input',renderProjects);$('task-search').addEventListener('input',applyFilters);
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));applyFilters();}));
$('refresh').addEventListener('click',refresh);$('edit').addEventListener('click',beginEdit);$('source-editor').addEventListener('input',keepDraft);$('cancel-edit').addEventListener('click',cancelEdit);$('save-edit').addEventListener('click',saveEdit);
$('source-editor').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveEdit();}});
$('new-project').addEventListener('click',createDialog);$('empty-create').addEventListener('click',createDialog);$('connect-help').addEventListener('click',()=>$('help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{if(!busy)$(b.dataset.close).close();}));
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('cancel',e=>{if(busy)e.preventDefault();}));
$('create-form').addEventListener('submit',async e=>{e.preventDefault();if(busy)return;busy=true;loadSequence++;viewSequence++;const button=e.currentTarget.querySelector('[type=submit]');button.disabled=true;const id=`project-${crypto.randomUUID()}`;try{const identity=readIdentity('new',id);const name=identity.chatTitle||identity.projectName;const result=await api('/api/projects',{method:'POST',body:{id,name,...identity,markdown:$('new-markdown').value||`# ${name}\n\n## Next steps\n`,sourceId:`web:${id}`}});$('create-dialog').close();$('create-form').reset();if(archiveView){archiveView=false;viewSequence++;projects=[];}updateSummary(result.project);busy=false;await selectProject(result.project.id);await refresh();}catch(e){$('create-error').textContent=e.message;}finally{busy=false;button.disabled=false;schedule();}});
$('add-task').addEventListener('submit',async e=>{e.preventDefault();if(!current||current.archivedAt||busy||editing)return;const text=$('task-text').value.trim();if(!text)return;busy=true;loadSequence++;renderDocument();const id=current.id;try{const result=await api(`/api/projects/${id}/document`,{method:'PUT',body:{markdown:`${current.markdown.trimEnd()}\n- [ ] ${text}\n`,baseRevision:current.revision}});if(selectedId===id){current=result.project;updateSummary(current);renderDocument();}if($('task-text').value.trim()===text)$('task-text').value='';notice();}catch(e){notice(e.status===409?'The checklist changed. Refresh and add this task again; the text is preserved.':e.message);}finally{busy=false;renderDocument();schedule();}});
$('download').addEventListener('click',()=>{if(!current)return;const url=URL.createObjectURL(new Blob([effectiveMarkdown(current)],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`${current.id}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);});
$('open-sidebar').addEventListener('click',()=>{$('workspace').classList.add('sidebar-open');$('backdrop').hidden=false;});$('close-sidebar').addEventListener('click',closeSidebar);$('backdrop').addEventListener('click',closeSidebar);
$('open-diagrams').addEventListener('click',openMermaid);
function refreshVisible(){if(authenticated&&!document.hidden)void refresh();}
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else refreshVisible();});window.addEventListener('online',refreshVisible);window.addEventListener('pageshow',e=>{switchingWorkspace=false;if(e.persisted)refreshVisible();});window.addEventListener('beforeunload',e=>{if(!switchingWorkspace&&editing&&$('source-editor').value!==editOriginal){e.preventDefault();e.returnValue='';}});
async function start(){const params=new URLSearchParams(location.hash.slice(1));const key=params.get('key');
  if(new URLSearchParams(location.search).get('mode')==='diagrams'){
    if(params.has('project')||params.has('archived'))rememberWorkspace(params);
    const next=new URLSearchParams();
    if(key)next.set('key',key);
    location.replace('/mermaid'+(next.size?'#'+next:''));
    return;
  }
  if(key){params.delete('key');history.replaceState(null,'',`${location.pathname}${location.search}${params.size?'#'+params:''}`);try{await api('/api/session',{method:'POST',body:{key}});}catch(e){$('login-error').textContent=e.message;}}
  archiveView=params.get('archived')==='1';
  try{const result=await api(`/api/projects${archiveView?'?archived=true':''}`);projects=result.projects;showWorkspace();renderProjects();await refresh();}catch(e){showAuth();if(e.status!==401)$('login-error').textContent='Cannot reach the checklist service. Try again shortly.';}}
const changeComposer=createChangeComposer({
  getCurrent:()=>authenticated?(pendingProject&&current&&pendingProject.id===current.id&&pendingProject.revision>=current.revision?pendingProject:current):null,
  saveOrigin:async(project,originChatId)=>{
    const result=await api(`/api/projects/${encodeURIComponent(project.id)}/identity`,{method:'PUT',body:{scope:project.scope,projectKey:project.projectKey,projectName:project.projectName,chatId:project.chatId,chatTitle:project.chatTitle,originChatId,baseRevision:project.revision}});
    if(current?.id===project.id){const known=pendingProject?.id===project.id&&pendingProject.revision>current.revision?pendingProject:current;current=known.revision>result.project.revision?known:result.project;pendingProject=null;updateSummary(current);}
  },
  onClose:()=>{selectionActions.clear();if(pendingProject&&current&&pendingProject.id===current.id&&pendingProject.revision>=current.revision)current=pendingProject;pendingProject=null;if(authenticated){if(current)renderDocument();void refresh();}}
});
const selectionActions=createSelectionActions({
  root:$('markdown'),
  getContext:()=>authenticated&&!busy&&!editing&&current&&!current.archivedAt?{...current,checklistName:checklistTitle(current)}:null,
  onAdd:snapshot=>{if(current?.id!==snapshot.projectId)return;const latest=pendingProject?.id===current.id?pendingProject:current;if(latest.archivedAt||latest.scope!==snapshot.scope||(latest.scope==='chat'?latest.chatId:latest.originChatId)!==(snapshot.scope==='chat'?snapshot.chatId:snapshot.originChatId)){notice('The checklist connection changed. Select the passage again after refreshing.');current=latest;pendingProject=null;renderDocument();return;}changeComposer.open(snapshot);}
});
start();
