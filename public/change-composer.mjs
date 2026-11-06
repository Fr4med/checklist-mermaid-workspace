import { buildChangeRequest, originThreadLink } from './change-request.mjs';
import { chatIdFromLink } from './hierarchy.mjs';

export function createChangeComposer({ getCurrent, saveOrigin, onClose = () => {} }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'change-composer';
  dialog.setAttribute('aria-labelledby', 'change-title');
  dialog.innerHTML = `<form>
    <div class="dialog-heading"><h2 id="change-title">Add to chat</h2><button type="button" class="icon-button change-close" aria-label="Close change request" title="Close"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
    <p class="change-context muted"></p>
    <blockquote class="change-quote" aria-label="Selected checklist text"></blockquote>
    <label for="change-instruction">What should change?</label>
    <textarea id="change-instruction" rows="3" maxlength="4000" placeholder="Describe the change to this passage…" required></textarea>
    <label for="change-chat">Original Codex chat</label>
    <input id="change-chat" placeholder="Paste its codex://threads/… link" autocomplete="off" spellcheck="false">
    <p class="change-destination-help muted"></p>
    <details class="change-preview"><summary>Request preview</summary><label class="sr-only" for="change-output">Prepared change request</label><textarea id="change-output" rows="8" readonly></textarea></details>
    <p class="change-feedback" role="status"></p>
    <p class="change-explanation muted">Paste and send in Codex. The checklist updates here when Codex syncs the changes.</p>
    <div class="dialog-footer"><button type="button" class="soft-button change-copy">Copy request</button><a class="soft-button change-open" hidden>Open original chat</a><button class="primary change-submit" type="submit">Copy &amp; open chat</button></div>
  </form>`;
  document.body.append(dialog);
  const find = selector => dialog.querySelector(selector);
  const instruction = find('#change-instruction'), destination = find('#change-chat'), output = find('#change-output');
  const feedback = find('.change-feedback'), openLink = find('.change-open');
  let snapshot = null, saving = false, epoch = 0, openedOrigin = null;

  function setSaving(value) {
    saving = value;
    instruction.readOnly = value;
    destination.readOnly = value || snapshot?.scope === 'chat';
    find('.change-close').disabled = value;
    find('.change-copy').disabled = value || !output.value;
    find('.change-submit').disabled = value || !output.value || !openLink.hasAttribute('href');
    openLink.setAttribute('aria-disabled', String(value));
  }
  function activeProject(runEpoch, expectedOrigin) {
    const current = getCurrent();
    if (epoch !== runEpoch || !snapshot || !current || current.id !== snapshot.projectId || current.archivedAt) throw new Error('This checklist is no longer active. Close this request and refresh.');
    const origin = current.scope === 'chat' ? current.chatId : current.originChatId;
    if (current.scope !== snapshot.scope || origin !== expectedOrigin) throw new Error('The linked chat changed. Close this request and select the passage again.');
    return current;
  }

  function setFeedback(message, error = false) { feedback.textContent = message; feedback.classList.toggle('error', error); }
  function preview() {
    setFeedback('');
    try { output.value = buildChangeRequest(snapshot, instruction.value); }
    catch { output.value = ''; }
    let link = null;
    try { link = originThreadLink(chatIdFromLink(destination.value)); } catch {}
    openLink.hidden = !link;
    if (link) openLink.href = link; else openLink.removeAttribute('href');
    find('.change-copy').disabled = !output.value || saving;
    find('.change-submit').disabled = !output.value || !link || saving;
  }
  async function copyRequest(text = buildChangeRequest(snapshot, instruction.value)) {
    const copyEpoch = epoch;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable.');
      await navigator.clipboard.writeText(text);
    } catch {
      if (copyEpoch !== epoch || !snapshot || !dialog.open) throw new Error('This change request was closed.');
      find('details').open = true; output.value = text; output.focus(); output.select();
      throw new Error('Copy the selected request with Ctrl+C or your device’s Copy command, then open the original chat.');
    }
  }
  find('form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving || !snapshot) return;
    const runEpoch = epoch;
    try {
      const current = activeProject(runEpoch, openedOrigin);
      const text = buildChangeRequest(snapshot, instruction.value);
      const originChatId = chatIdFromLink(destination.value);
      const link = originThreadLink(originChatId);
      if (!link) throw new Error('Paste the original Codex chat link.');
      const expected = current.scope === 'chat' ? current.chatId : current.originChatId;
      if (current.scope === 'chat' && originChatId !== expected) throw new Error('This checklist belongs to its linked chat.');
      setSaving(true); setFeedback('Preparing request…');
      if (current.scope !== 'chat' && originChatId !== expected) await saveOrigin(current, originChatId);
      activeProject(runEpoch, originChatId);
      openedOrigin = originChatId;
      await copyRequest(text);
      activeProject(runEpoch, originChatId);
      openLink.href = link; openLink.hidden = false;
      setFeedback('Request copied. Paste and send it in the original chat. If Codex did not open, use Open original chat.');
      setSaving(false);
      openLink.click();
    } catch (error) { if (epoch === runEpoch) setFeedback(error.message, true); }
    finally { if (epoch === runEpoch) setSaving(false); }
  });
  find('.change-copy').addEventListener('click', async () => {
    if (saving || !snapshot) return;
    const runEpoch = epoch;
    setSaving(true);
    try { await copyRequest(); if (epoch === runEpoch) setFeedback('Request copied. Paste and send it in the original Codex chat.'); }
    catch (error) { if (epoch === runEpoch) setFeedback(error.message, true); }
    finally { if (epoch === runEpoch) setSaving(false); }
  });
  instruction.addEventListener('input', preview); destination.addEventListener('input', preview);
  openLink.addEventListener('click', event => { if (saving) { event.preventDefault(); return; } try { activeProject(epoch, openedOrigin); } catch (error) { event.preventDefault(); setFeedback(error.message, true); } });
  find('.change-close').addEventListener('click', () => { if (!saving) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { epoch++; snapshot = null; saving = false; instruction.value = ''; output.value = ''; find('.change-quote').textContent = ''; onClose(); });
  return {
    open(value) {
      if (saving) return;
      epoch++; snapshot = value; instruction.value = ''; find('details').open = false;
      find('.change-context').textContent = value.checklistName && value.checklistName !== value.projectName ? `${value.projectName} · ${value.checklistName}` : value.projectName;
      find('.change-quote').textContent = value.quote;
      const origin = value.scope === 'chat' ? value.chatId : value.originChatId;
      openedOrigin = origin ?? null;
      destination.value = originThreadLink(origin) || '';
      destination.readOnly = value.scope === 'chat';
      find('.change-destination-help').textContent = origin ? 'This request returns to the linked chat.' : 'Link the original chat once. This checklist will remember it.';
      preview(); setSaving(false); dialog.showModal(); instruction.focus();
    },
    isOpen: () => dialog.open,
    close: () => { epoch++; dialog.close(); }
  };
}
