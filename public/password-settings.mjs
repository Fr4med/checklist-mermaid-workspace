// Passwords stay in these inputs and same-origin requests only.
export function createPasswordSettings({ api, onSaved, onUnauthorized, canOpen = () => true }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'password-dialog';
  dialog.className = 'password-settings';
  dialog.setAttribute('aria-labelledby', 'password-title');
  dialog.innerHTML = `<form id="password-form">
    <div class="dialog-heading"><h2 id="password-title">Password settings</h2><button id="password-close" class="icon-button" type="button" title="Close" aria-label="Close"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
    <p id="password-loading" class="password-description" role="status">Loading password settings…</p>
    <div id="password-fields" hidden>
      <p id="password-description" class="password-description">Use the same password for Checklist and Mermaid.</p>
      <div id="current-password-field" hidden><label for="current-password">Current password</label><input id="current-password" name="current-password" type="password" autocomplete="current-password" aria-describedby="password-error"></div>
      <label for="new-password">New password</label><input id="new-password" name="new-password" type="password" autocomplete="new-password" aria-describedby="password-help password-error" required>
      <p id="password-help" class="password-help">At least 15 characters. A short sentence works well.</p>
      <label for="confirm-password">Confirm password</label><input id="confirm-password" name="confirm-password" type="password" autocomplete="new-password" aria-describedby="password-error" required>
      <p class="password-help">Saving signs out other browsers.</p>
    </div>
    <p id="password-error" class="error" role="alert"></p>
    <div class="dialog-footer"><button id="password-cancel" class="soft-button" type="button">Cancel</button><button id="password-save" class="primary" type="submit" disabled>Save password</button></div>
  </form>`;
  document.body.append(dialog);
  const get = id => dialog.querySelector('#' + id);
  const form = get('password-form');
  const fields = [get('current-password'), get('new-password'), get('confirm-password')];
  let passwordSet = false;
  let loading = false;
  let saving = false;
  let sequence = 0;
  const clear = () => { for (const field of fields) { field.value = ''; field.removeAttribute('aria-invalid'); } };
  const setSaving = value => {
    saving = value;
    for (const control of form.elements) control.disabled = value;
    get('password-save').disabled = value || loading;
    get('password-save').textContent = value ? 'Saving…' : 'Save password';
    form.setAttribute('aria-busy', String(value));
  };
  function close(force = false) {
    if (saving && !force) return;
    sequence++;
    clear();
    if (dialog.open) dialog.close();
  }
  dialog.addEventListener('close', () => { sequence++; clear(); });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  get('password-close').addEventListener('click', () => close());
  get('password-cancel').addEventListener('click', () => close());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (loading || saving) return;
    get('password-error').textContent = '';
    for (const field of fields) field.removeAttribute('aria-invalid');
    const length = [...get('new-password').value].length;
    if (length < 15 || length > 128) {
      get('password-error').textContent = 'Use between 15 and 128 characters for your new password.';
      get('new-password').setAttribute('aria-invalid', 'true');
      get('new-password').focus();
      return;
    }
    if (get('new-password').value !== get('confirm-password').value) {
      get('password-error').textContent = 'The new passwords do not match. Enter them again.';
      get('confirm-password').setAttribute('aria-invalid', 'true');
      get('confirm-password').focus();
      return;
    }
    const submission = ++sequence;
    setSaving(true);
    try {
      await api('/api/password', { method: 'PUT', body: { password: get('new-password').value, ...(passwordSet ? { currentPassword: get('current-password').value } : {}) } });
      if (submission !== sequence) return;
      close(true);
      onSaved?.('Password saved. Other browsers have been signed out.');
    } catch (error) {
      if (submission !== sequence) return;
      if (error.status === 401) { close(true); onUnauthorized?.(); }
      else get('password-error').textContent = error.message || 'Password could not be saved. Try again.';
    } finally {
      clear();
      setSaving(false);
      if (dialog.open) fields[passwordSet ? 0 : 1].focus();
    }
  });
  return {
    close: () => close(true),
    async open() {
      if (dialog.open || !canOpen()) return;
      const opening = ++sequence;
      clear();
      passwordSet = false;
      loading = true;
      setSaving(false);
      get('password-error').textContent = '';
      get('password-fields').hidden = true;
      get('password-loading').hidden = false;
      get('password-loading').textContent = 'Loading password settings…';
      dialog.showModal();
      get('password-cancel').focus();
      try {
        const status = await api('/api/password');
        if (opening !== sequence || !dialog.open) return;
        passwordSet = status.passwordSet === true;
        get('current-password-field').hidden = !passwordSet;
        get('current-password').required = passwordSet;
        get('password-title').textContent = passwordSet ? 'Change password' : 'Set a password';
        get('password-loading').hidden = true;
        get('password-fields').hidden = false;
        loading = false;
        get('password-save').disabled = false;
        fields[passwordSet ? 0 : 1].focus();
      } catch (error) {
        if (opening !== sequence || !dialog.open) return;
        get('password-loading').hidden = true;
        if (error.status === 401) { close(true); onUnauthorized?.(); }
        else get('password-error').textContent = error.message || 'Password settings could not load. Close this window and try again.';
      }
    },
  };
}
