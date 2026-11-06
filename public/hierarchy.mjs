export function checklistTitle(item) {
  return item.scope === 'chat' ? item.chatTitle || item.name : item.projectName || item.name;
}

export function groupChecklists(items, query = '') {
  const groups = new Map();
  for (const item of items) {
    const key = item.projectKey || item.id;
    if (!groups.has(key)) groups.set(key, { key, name: item.projectName || item.name, project: null, otherProjects: [], chats: [] });
    const group = groups.get(key);
    if (item.scope === 'chat') group.chats.push(item);
    else if (!group.project) group.project = item;
    else group.otherProjects.push(item);
  }
  const needle = query.trim().toLowerCase();
  return [...groups.values()].map(group => {
    if (group.project) group.name = group.project.projectName || group.project.name;
    const parentMatches = group.name.toLowerCase().includes(needle);
    return { ...group, chats: group.chats.filter(item => parentMatches || checklistTitle(item).toLowerCase().includes(needle) || (item.chatId || '').toLowerCase().includes(needle)).sort((a, b) => checklistTitle(a).localeCompare(checklistTitle(b))), visible: parentMatches };
  }).filter(group => group.visible || group.chats.length).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export function chatIdFromLink(value) {
  const text = value.trim();
  const match = text.match(/^(?:codex:\/\/threads\/)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\?.*)?$/i);
  if (!match) throw new Error('Enter the Codex chat link or its full chat ID.');
  return match[1].toLowerCase();
}
