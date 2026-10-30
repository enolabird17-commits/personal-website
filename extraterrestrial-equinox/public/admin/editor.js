const cards = document.querySelector('#artworks');
const template = document.querySelector('#artwork-template');
const saveButton = document.querySelector('#save');
const addButton = document.querySelector('#add');
const status = document.querySelector('#status');
const errorBox = document.querySelector('#error');
const authView = document.querySelector('#auth-view');
const editorView = document.querySelector('#editor-view');
const authForm = document.querySelector('#auth-form');
const loginButton = document.querySelector('#login');
const logoutButton = document.querySelector('#logout');
const usernameInput = document.querySelector('#username');
const passwordInput = document.querySelector('#password');
const confirmInput = document.querySelector('#confirm-password');
const setupKeyInput = document.querySelector('#setup-key');
const passwordForm = document.querySelector('#password-form');
let mode = 'local';
let maxUpload = 10 * 1024 * 1024;
let needsSetup = false;
let authenticated = false;
let artworks = [];
let revision;
let token;
let dirty = false;
let busy = false;

function showError(message = '') {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function updateControls() {
  saveButton.disabled = !authenticated || busy || !dirty;
  addButton.disabled = !authenticated || busy;
  logoutButton.disabled = busy;
  passwordForm.querySelectorAll('input, button').forEach((control) => { control.disabled = busy; });
  cards.querySelectorAll('input, button').forEach((control) => { control.disabled = busy; });
  cards.querySelectorAll('article').forEach((card, index) => {
    card.querySelector('.up').disabled = busy || index === 0;
    card.querySelector('.down').disabled = busy || index === artworks.length - 1;
  });
}

function changed() {
  dirty = true;
  status.textContent = 'You have unsaved changes.';
  showError();
  updateControls();
}

async function request(route, options = {}) {
  const response = await fetch(`/__portfolio-cms/${route}`, {
    ...options,
    headers: { 'X-CMS-Token': token ?? '', ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !['login', 'setup'].includes(route)) await refreshAuth();
    throw new Error(data.error || 'The editor could not connect. Check that the latest Netlify deploy has finished, then reload. For local editing, start npm run dev.');
  }
  return data;
}

function showAuth(data) {
  passwordForm.reset();
  document.querySelector('#password-status').textContent = '';
  mode = data.mode ?? 'local';
  maxUpload = data.maxUpload ?? 10 * 1024 * 1024;
  authenticated = false;
  token = data.token;
  needsSetup = data.needsSetup;
  editorView.hidden = true;
  logoutButton.hidden = true;
  authView.hidden = false;
  document.querySelector('#auth-heading').textContent = needsSetup ? 'Create your login' : 'Welcome back';
  document.querySelector('#auth-description').textContent = needsSetup
    ? 'Choose a username and password for your portfolio editor.' : 'Log in to edit your gallery.';
  document.querySelector('#confirm-label').hidden = !needsSetup;
  document.querySelector('#setup-key-label').hidden = !data.setupKeyRequired;
  setupKeyInput.required = Boolean(data.setupKeyRequired);
  setupKeyInput.value = '';
  document.querySelector('#password-hint').hidden = !needsSetup;
  confirmInput.required = needsSetup;
  passwordInput.minLength = needsSetup ? 12 : 1;
  passwordInput.autocomplete = needsSetup ? 'new-password' : 'current-password';
  loginButton.textContent = needsSetup ? 'Create login' : 'Log in';
  passwordInput.value = '';
  confirmInput.value = '';
  status.textContent = needsSetup ? 'Set up your editor login to get started.' : 'Login required to access the editor.';
  if (data.setupKeyRequired) {
    document.querySelector('#auth-description').textContent = data.setupConfigured
      ? 'Enter your private Netlify setup key, then choose your editor username and password.'
      : 'Add PORTFOLIO_SETUP_KEY in your Netlify environment variables with a private value of at least 24 characters, then redeploy. Use that key here to create your login.';
  }
  updateControls();
}

async function openEditor(data) {
  mode = data.mode ?? 'local';
  maxUpload = data.maxUpload ?? 10 * 1024 * 1024;
  token = data.token;
  authenticated = true;
  // Preserve unsaved edits after a session expires; the revision check still applies.
  if (!dirty) {
    const gallery = await request('gallery');
    artworks = gallery.artworks;
    revision = gallery.revision;
  }
  authView.hidden = true;
  editorView.hidden = false;
  logoutButton.hidden = false;
  render();
  document.querySelector('#editor-mode').textContent = `Portfolio editor · ${mode === 'online' ? 'Live website' : 'Local'}`;
  document.querySelector('#upload-hint').textContent = `JPEG, PNG, GIF, or WebP · Up to ${maxUpload / 1024 / 1024} MB per image`;
  document.querySelector('#password-settings').hidden = mode !== 'online';
  status.textContent = dirty ? 'Logged in. Your unsaved changes are ready to save.'
    : `Logged in as ${data.username}. ${mode === 'online' ? 'Save changes to publish them to your website.' : 'Changes stay on this computer.'}`;
}

async function refreshAuth() {
  const data = await request('session');
  if (data.authenticated) await openEditor(data);
  else showAuth(data);
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError();
  if (needsSetup && passwordInput.value !== confirmInput.value) {
    showError('The passwords do not match.'); confirmInput.focus(); return;
  }
  loginButton.disabled = true;
  const creating = needsSetup;
  try {
    const data = await request(creating ? 'setup' : 'login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameInput.value.trim(), password: passwordInput.value, ...(creating ? { setupKey: setupKeyInput.value } : {}) }),
    });
    passwordInput.value = '';
    confirmInput.value = '';
    setupKeyInput.value = '';
    await openEditor(data);
  } catch (error) { showError(error.message); }
  finally { loginButton.disabled = false; }
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const passwordStatus = document.querySelector('#password-status');
  const password = document.querySelector('#new-password').value;
  if (password !== document.querySelector('#new-password-confirm').value) {
    passwordStatus.textContent = 'The new passwords do not match.';
    return;
  }
  busy = true;
  updateControls();
  passwordStatus.textContent = 'Updating password…';
  try {
    const data = await request('password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: document.querySelector('#current-password').value, password }) });
    token = data.token;
    passwordForm.reset();
    passwordStatus.textContent = 'Password updated. Your other sessions are now logged out.';
  } catch (error) { passwordStatus.textContent = error.message; }
  finally { busy = false; updateControls(); }
});

logoutButton.addEventListener('click', async () => {
  if (dirty && !window.confirm('Log out and discard your unsaved gallery changes?')) return;
  busy = true;
  updateControls();
  try {
    await request('logout', { method: 'POST' });
    dirty = false;
    artworks = [];
    cards.replaceChildren();
    showError();
    await refreshAuth();
    status.textContent = 'You are logged out.';
    usernameInput.focus();
  } catch (error) { showError(error.message); }
  finally { busy = false; updateControls(); }
});

function render() {
  cards.replaceChildren();
  artworks.forEach((art, index) => {
    const card = template.content.firstElementChild.cloneNode(true);
    const title = card.querySelector('.title');
    title.value = art.title;
    title.setAttribute('aria-label', `Artwork ${index + 1} title`);
    title.addEventListener('input', () => { art.title = title.value; changed(); });
    const image = card.querySelector('img');
    if (art.image) {
      image.src = art.image;
      image.alt = art.title;
      image.hidden = false;
      card.querySelector('.placeholder').hidden = true;
    }
    const upload = card.querySelector('.upload');
    upload.setAttribute('aria-label', `Artwork ${index + 1} image`);
    upload.addEventListener('change', async () => {
      const file = upload.files[0];
      if (!file) return;
      if (file.size > maxUpload) { showError(`Choose an image under ${maxUpload / 1024 / 1024} MB.`); upload.value = ''; return; }
      busy = true;
      updateControls();
      showError();
      status.textContent = 'Uploading image…';
      try {
        const result = await request('upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        art.image = result.image;
        changed();
        render();
      } catch (error) { showError(error.message); status.textContent = 'Image upload failed. Your gallery changes are still here.'; }
      finally { busy = false; updateControls(); }
    });
    const move = (offset) => {
      [artworks[index], artworks[index + offset]] = [artworks[index + offset], artworks[index]];
      changed(); render();
      cards.children[index + offset].querySelector('.title').focus();
    };
    card.querySelector('.up').addEventListener('click', () => move(-1));
    card.querySelector('.down').addEventListener('click', () => move(1));
    card.querySelector('.remove').addEventListener('click', () => {
      artworks.splice(index, 1); changed(); render(); addButton.focus();
    });
    cards.append(card);
  });
  if (!artworks.length) {
    const empty = document.createElement('p');
    empty.textContent = 'Your gallery is empty. Add an artwork to get started.';
    cards.append(empty);
  }
  updateControls();
}

addButton.addEventListener('click', () => {
  artworks.push({ title: '', image: '' }); changed(); render();
  cards.lastElementChild.querySelector('.title').focus();
});

saveButton.addEventListener('click', async () => {
  const incomplete = artworks.findIndex((art) => !art.title.trim() || !art.image);
  if (incomplete >= 0) {
    showError(`Artwork ${incomplete + 1} needs a title and an image before saving.`);
    cards.children[incomplete].querySelector(!artworks[incomplete].title.trim() ? '.title' : '.upload').focus();
    return;
  }
  busy = true;
  updateControls();
  showError();
  status.textContent = 'Saving…';
  try {
    const result = await request('gallery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artworks, revision }),
    });
    artworks = result.artworks;
    revision = result.revision;
    dirty = false;
    status.textContent = mode === 'online' ? 'Published. Your public portfolio is up to date.' : 'Saved to your project. Your portfolio is up to date.';
    render();
  } catch (error) { showError(error.message); status.textContent = 'Changes could not be saved. Your edits are still here.'; }
  finally { busy = false; updateControls(); }
});

window.addEventListener('beforeunload', (event) => {
  if (dirty || busy) { event.preventDefault(); event.returnValue = ''; }
});

try {
  await refreshAuth();
} catch (error) {
  status.textContent = 'The portfolio editor is not connected.';
  showError(error.message);
}
