import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getStore, setEnvironmentContext } from '@netlify/blobs';
import { BlobsServer } from '@netlify/blobs/server';
import { createOnlineCms } from '../scripts/online-cms.mjs';
import netlifyHandler, { config } from '../netlify/functions/portfolio-cms.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC7sAAAAASUVORK5CYII=', 'base64');
const origin = 'https://portfolio.example';
const setupKey = 'fixture-only-private-setup-key-123456';
const credentials = { username: 'artist', password: 'fixture-password-12345' };
const initialGallery = { artworks: [{ title: 'Original', image: '/original.png' }] };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'online-portfolio-'));
  const server = new BlobsServer({ directory, token: 'fixture' });
  const address = await server.start();
  const apiURL = address.address;
  // The local emulator omits ETags on GET. Reattach its actual last-write ETag
  // to exercise the hosted API's documented conditional-write contract.
  const etags = new Map();
  const emulatorFetch = async (url, options = {}) => {
    const response = await fetch(url, options);
    const key = new URL(url).pathname;
    if (options.method === 'put' && response.ok && response.headers.has('etag')) etags.set(key, response.headers.get('etag'));
    if (options.method === 'get' && response.ok && !response.headers.has('etag') && etags.has(key)) {
      const headers = new Headers(response.headers);
      headers.set('etag', etags.get(key));
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  };
  const storageOptions = { siteID: 'test-site', token: 'fixture', apiURL, consistency: 'strong', fetch: emulatorFetch };
  const store = (name) => getStore({ name, ...storageOptions });
  const stores = { privateStore: store('test-private'), galleryStore: store('test-gallery'), mediaStore: store('test-media') };
  let time = Date.now();
  const makeHandler = () => createOnlineCms({ ...stores, initialGallery, setupKey, now: () => time, ...options });
  t.after(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });
  return { ...stores, store, storageOptions, makeHandler, advance: (milliseconds) => { time += milliseconds; } };
}

function browser(handler, ip = '192.0.2.1') {
  const jar = new Map();
  let token;
  const client = {
    setHandler(value) { handler = value; },
    async request(route, body, extra = {}) {
      const headers = { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), 'X-CMS-Token': token ?? '',
        ...(body !== undefined ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...extra };
      const request = new Request(`${origin}${route.startsWith('/') ? route : `/__portfolio-cms/${route}`}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        ...(body !== undefined ? { body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}),
      });
      const response = await handler(request, { ip });
      for (const value of response.headers.getSetCookie()) {
        const [key, val] = value.split(';')[0].split('=');
        if (val) jar.set(key, val); else jar.delete(key);
      }
      return response;
    },
    async session() {
      const response = await client.request('session');
      assert.equal(response.status, 200);
      const data = await response.json(); token = data.token; return data;
    },
    async authenticate(route = 'login', input = credentials) {
      await client.session();
      const response = await client.request(route, input);
      assert.equal(response.status, 200, await response.clone().text());
      const data = await response.json(); token = data.token; return { response, data };
    },
    async gallery() { return (await client.request('gallery')).json(); },
  };
  return client;
}

test('hosted editor persists secure accounts, uploads and public gallery edits through real Blobs SDK', async (t) => {
  const storage = await fixture(t);
  const client = browser(storage.makeHandler());
  let uploaded;

  await t.test('public gallery is readable, while editor writes require login', async () => {
    const response = await client.request('/portfolio-data');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), initialGallery);
    assert.equal((await client.request('gallery')).status, 401);
    assert.equal((await client.request('upload', png)).status, 401);
    const session = await client.session();
    assert.equal(session.needsSetup, true);
    assert.equal(session.setupKeyRequired, true);
    assert(!JSON.stringify(session).includes(setupKey));
  });

  await t.test('setup requires the private key, same origin, CSRF token and a strong password', async () => {
    const body = { ...credentials, setupKey };
    assert.equal((await client.request('setup', body, { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await client.request('setup', body, { 'X-CMS-Token': '' })).status, 403);
    assert.equal((await client.request('setup', { ...credentials, setupKey: 'wrong' })).status, 403);
    assert.equal((await client.request('setup', { ...body, password: 'short' })).status, 400);
    const { response } = await client.authenticate('setup', body);
    assert.match(response.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict; Path=\//);
    const stored = await storage.privateStore.get('account', { type: 'json' });
    assert.equal(stored.username, credentials.username);
    assert.equal(stored.hash.length, 128);
    assert(!JSON.stringify(stored).includes(credentials.password));
    assert.equal((await client.request('setup', body)).status, 409);
  });

  await t.test('sessions survive cold starts and gallery saves become public immediately', async () => {
    client.setHandler(storage.makeHandler());
    assert.equal((await client.session()).authenticated, true);
    const gallery = await client.gallery();
    const save = await client.request('gallery', { revision: gallery.revision, artworks: [{ title: 'A new title', image: '/original.png' }] });
    assert.equal(save.status, 200, await save.clone().text());
    assert.equal((await (await client.request('/portfolio-data')).json()).artworks[0].title, 'A new title');
    assert.equal((await client.request('gallery', { revision: gallery.revision, artworks: [] })).status, 409);
    const current = await client.gallery();
    for (const image of ['https://evil.example/test.png', '/../private/account.png', '/portfolio-media/account', '/missing.png']) {
      assert.equal((await client.request('gallery', { revision: current.revision, artworks: [{ title: 'Invalid', image }] })).status, 400);
    }
  });

  await t.test('image replacements are persistent, public, typed, and limited to 4 MB raster uploads', async () => {
    assert.equal((await client.request('upload', '<svg onload="alert(1)"></svg>')).status, 400);
    assert.equal((await client.request('upload', png, { 'Content-Length': String(4 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await client.request('upload', Buffer.alloc(4 * 1024 * 1024 + 1))).status, 413);
    const response = await client.request('upload', png, { 'Content-Type': 'image/png' });
    assert.equal(response.status, 201, await response.clone().text());
    uploaded = (await response.json()).image;
    const image = await client.request(uploaded);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const current = await client.gallery();
    assert.equal((await client.request('gallery', { revision: current.revision, artworks: [{ title: '<script>literal title</script>', image: uploaded }] })).status, 200);
    const secondInstance = browser(storage.makeHandler());
    assert.deepEqual((await (await secondInstance.request('/portfolio-data')).json()).artworks,
      [{ title: '<script>literal title</script>', image: uploaded }]);
    assert.equal((await secondInstance.request('/portfolio-media/account')).status, 404);
    assert.equal((await secondInstance.request('/__portfolio-cms/account')).status, 401);
  });

  await t.test('password changes require the current password and revoke other sessions', async () => {
    const other = browser(storage.makeHandler(), '192.0.2.2');
    await other.authenticate();
    assert.equal((await client.request('password', { currentPassword: 'wrong', password: 'replacement-password-123' })).status, 401);
    const response = await client.request('password', { currentPassword: credentials.password, password: 'replacement-password-123' });
    assert.equal(response.status, 200);
    await client.session();
    assert.equal((await other.request('gallery')).status, 401);
    assert.equal((await client.request('gallery')).status, 200);
    await client.request('logout', '');
    await client.session();
    assert.equal((await client.request('login', credentials)).status, 401);
    await client.authenticate('login', { ...credentials, password: 'replacement-password-123' });
  });

  await t.test('empty galleries publish correctly and logout revokes a persisted session', async () => {
    const current = await client.gallery();
    assert.equal((await client.request('gallery', { revision: current.revision, artworks: [] })).status, 200);
    assert.deepEqual(await (await client.request('/portfolio-data')).json(), { artworks: [] });
    assert.equal((await client.request('logout', '')).status, 200);
    client.setHandler(storage.makeHandler());
    assert.equal((await client.request('gallery')).status, 401);
  });

  await t.test('login throttling survives cold starts and sessions expire', async () => {
    const limited = browser(storage.makeHandler(), '192.0.2.99');
    await limited.session();
    for (let index = 0; index < 8; index++) {
      limited.setHandler(storage.makeHandler());
      assert.equal((await limited.request('login', { ...credentials, password: 'wrong' })).status, 401);
    }
    assert.equal((await limited.request('login', { ...credentials, password: 'replacement-password-123' })).status, 429);
    storage.advance(16 * 60 * 1000);
    await limited.authenticate('login', { ...credentials, password: 'replacement-password-123' });
    storage.advance(9 * 60 * 60 * 1000);
    assert.equal((await limited.request('gallery')).status, 401);
    assert.equal((await limited.session()).needsSetup, false);
  });
});

test('public setup fails closed when the owner has not configured a private setup key', async (t) => {
  const storage = await fixture(t, { setupKey: undefined });
  const client = browser(storage.makeHandler());
  assert.equal((await client.session()).setupConfigured, false);
  assert.equal((await client.request('setup', { ...credentials, setupKey })).status, 503);
  assert.equal(await storage.privateStore.get('account', { type: 'json' }), null);
});

test('Netlify entrypoint shares production storage across deploys and isolates preview deploys', async (t) => {
  const storage = await fixture(t);
  setEnvironmentContext(storage.storageOptions);
  t.after(() => setEnvironmentContext({}));
  await storage.store('portfolio-production-gallery').setJSON('gallery', { artworks: [{ title: 'Live', image: '/live.png' }] });
  const request = () => new Request(`${origin}/portfolio-data`);
  for (const id of ['first-deploy', 'next-deploy']) {
    const response = await netlifyHandler(request(), { deploy: { context: 'production', id } });
    assert.equal((await response.json()).artworks[0].title, 'Live');
  }
  const preview = await netlifyHandler(request(), { deploy: { context: 'deploy-preview', id: 'preview-deploy' } });
  assert.notEqual((await preview.json()).artworks[0].title, 'Live');
  assert(config.path.includes('/portfolio-data'));
  assert(config.path.includes('/__portfolio-cms/*'));
});
