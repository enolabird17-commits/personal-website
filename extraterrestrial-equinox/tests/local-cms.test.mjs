import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCmsMiddleware } from '../scripts/local-cms.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC7sAAAAASUVORK5CYII=', 'base64');

test('local CMS saves, uploads, and rejects unsafe or conflicting writes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portfolio-cms-test-'));
  await mkdir(path.join(root, 'public'), { recursive: true });
  await mkdir(path.join(root, 'src/data'), { recursive: true });
  await writeFile(path.join(root, 'public/test.png'), png);
  const gallery = path.join(root, 'src/data/artworks.json');
  await writeFile(gallery, JSON.stringify({ artworks: [{ title: 'Original', image: '/test.png' }] }));
  let middleware = createCmsMiddleware(root);
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const get = () => fetch(`${origin}/__portfolio-cms/gallery`, { headers: { Cookie: cookie } }).then((response) => response.json());
  const authStatus = () => fetch(`${origin}/__portfolio-cms/session`, { headers: { Cookie: cookie } }).then((response) => response.json());
  let session = await authStatus();
  const post = (route, body, headers = {}) => fetch(`${origin}/__portfolio-cms/${route}`, {
    method: 'POST', body,
    headers: { Origin: origin, Cookie: cookie, 'X-CMS-Token': session.token, 'Content-Type': 'application/json', ...headers },
  });
  const credentials = { username: 'fixture-editor', password: 'fixture-password-12345' };
  const login = async () => {
    session = await authStatus();
    const response = await post('login', JSON.stringify(credentials));
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    session = await get();
  };

  await t.test('the gallery, saves, and uploads require login before setup', async () => {
    assert.equal(session.needsSetup, true);
    assert.equal(session.authenticated, false);
    assert.equal((await fetch(`${origin}/__portfolio-cms/gallery`)).status, 401);
    assert.equal((await post('gallery', JSON.stringify({ artworks: [] }))).status, 401);
    assert.equal((await post('upload', png)).status, 401);
    assert.equal((await post('setup', JSON.stringify(credentials), { Origin: 'https://example.com' })).status, 403);
  });

  await t.test('one-time setup stores a private hash and creates an HttpOnly session', async () => {
    assert.equal((await post('setup', JSON.stringify({ ...credentials, password: 'short' }))).status, 400);
    const response = await post('setup', JSON.stringify(credentials));
    assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie');
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Max-Age=28800/);
    cookie = header.split(';')[0];
    const stored = await readFile(path.join(root, '.cms-auth/account.json'), 'utf8');
    assert(!stored.includes(credentials.password));
    const account = JSON.parse(stored);
    assert.equal(account.username, credentials.username);
    assert.equal(account.hash.length, 128);
    assert.equal((await stat(path.join(root, '.cms-auth/account.json'))).mode & 0o777, 0o600);
    assert.equal((await authStatus()).authenticated, true);
    session = await get();
    assert.equal((await post('setup', JSON.stringify(credentials))).status, 409);
  });

  await t.test('private credentials cannot be fetched directly or through Vite paths', async () => {
    for (const route of ['/.cms-auth/account.json', `/@fs/${root}/.cms-auth/account.json?raw`, '/.CMS-AUTH/account.json']) {
      assert.equal((await fetch(`${origin}${route}`)).status, 403);
    }
  });

  await t.test('save writes the JSON file and survives a fresh read', async () => {
    const response = await post('gallery', JSON.stringify({ revision: session.revision, artworks: [{ title: 'Edited', image: '/test.png' }] }));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(await readFile(gallery, 'utf8')), { artworks: [{ title: 'Edited', image: '/test.png' }] });
    assert.equal((await get()).artworks[0].title, 'Edited');
  });

  await t.test('a stale tab cannot overwrite a newer save', async () => {
    const response = await post('gallery', JSON.stringify({ revision: session.revision, artworks: [] }));
    assert.equal(response.status, 409);
    assert.equal((await get()).artworks[0].title, 'Edited');
    session = await get();
  });

  await t.test('foreign origins and missing tokens cannot write', async () => {
    const body = JSON.stringify({ revision: session.revision, artworks: [] });
    assert.equal((await post('gallery', body, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post('gallery', body, { 'X-CMS-Token': '' })).status, 403);
    const forgedHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(`${origin}/__portfolio-cms/gallery`, { headers: { Host: 'example.com' } }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('error', reject); req.end();
    });
    assert.equal(forgedHostStatus, 403);
    assert.equal((await get()).artworks[0].title, 'Edited');
  });

  await t.test('invalid entries and paths outside public cannot be saved', async () => {
    for (const art of [
      { title: '', image: '/test.png' },
      { title: 'Escape', image: '/../test.png' },
      { title: 'External', image: 'https://example.com/test.png' },
      { title: 'Missing', image: '/missing.png' },
    ]) {
      const response = await post('gallery', JSON.stringify({ revision: session.revision, artworks: [art] }));
      assert.equal(response.status, 400);
    }
  });

  await t.test('image upload writes a unique raster file that can be added to the gallery', async () => {
    const response = await post('upload', png, { 'Content-Type': 'image/png' });
    assert.equal(response.status, 201);
    const { image } = await response.json();
    assert.match(image, /^\/artwork\/[a-f0-9-]+\.png$/);
    assert.deepEqual(await readFile(path.join(root, 'public', image.slice(1))), png);
    assert.equal((await post('gallery', JSON.stringify({ revision: session.revision, artworks: [{ title: 'Uploaded', image }] }))).status, 200);
    session = await get();
  });

  await t.test('non-images and oversized uploads are rejected', async () => {
    assert.equal((await post('upload', '<svg onload="alert(1)"></svg>', { 'Content-Type': 'image/svg+xml' })).status, 400);
    assert.equal((await post('upload', Buffer.alloc(10 * 1024 * 1024 + 1), { 'Content-Type': 'image/png' })).status, 413);
  });

  await t.test('an empty gallery can be saved intentionally', async () => {
    assert.equal((await post('gallery', JSON.stringify({ revision: session.revision, artworks: [] }))).status, 200);
    assert.deepEqual((await get()).artworks, []);
  });

  await t.test('the admin shortcut points to the static page', async () => {
    const response = await fetch(`${origin}/admin/`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin/index.html');
  });

  await t.test('logout invalidates the session and blocks reads, saves, and uploads', async () => {
    session = await get();
    const oldCookie = cookie;
    const response = await post('logout', '');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await fetch(`${origin}/__portfolio-cms/gallery`, { headers: { Cookie: oldCookie } })).status, 401);
    assert.equal((await post('gallery', JSON.stringify({ artworks: [] }))).status, 401);
    assert.equal((await post('upload', png)).status, 401);
    cookie = '';
    session = await authStatus();
    assert.equal(session.needsSetup, false);
    assert.equal((await post('setup', JSON.stringify(credentials))).status, 409);
  });

  await t.test('incorrect passwords fail and the correct password restores access', async () => {
    assert.equal((await post('login', JSON.stringify({ ...credentials, password: 'wrong-password' }))).status, 401);
    assert.equal((await post('login', JSON.stringify({ ...credentials, username: 'unknown' }))).status, 401);
    await login();
    assert(Array.isArray(session.artworks));
    const oldCookie = cookie;
    await login();
    assert.notEqual(cookie, oldCookie);
    assert.equal((await fetch(`${origin}/__portfolio-cms/gallery`, { headers: { Cookie: oldCookie } })).status, 401);
  });

  await t.test('sessions expire after eight hours', async () => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 9 * 60 * 60 * 1000 });
    try {
      assert.equal((await fetch(`${origin}/__portfolio-cms/gallery`, { headers: { Cookie: cookie } })).status, 401);
    } finally { t.mock.timers.reset(); }
    cookie = '';
    await login();
  });

  await t.test('credentials survive a server restart, but old sessions do not', async () => {
    middleware = createCmsMiddleware(root);
    assert.equal((await fetch(`${origin}/__portfolio-cms/gallery`, { headers: { Cookie: cookie } })).status, 401);
    cookie = '';
    assert.equal((await authStatus()).needsSetup, false);
    await login();
    assert(Array.isArray(session.artworks));
  });

  await t.test('repeated incorrect logins are rate limited', async () => {
    await post('logout', '');
    cookie = '';
    session = await authStatus();
    for (let attempt = 0; attempt < 8; attempt++) {
      assert.equal((await post('login', JSON.stringify({ ...credentials, password: 'wrong' }))).status, 401);
    }
    assert.equal((await post('login', JSON.stringify(credentials))).status, 429);
  });
});
