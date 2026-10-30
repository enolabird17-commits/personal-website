import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const lifetime = 8 * 60 * 60 * 1000;
const prefix = '/__portfolio-cms/';
const sessionCookie = '__Host-portfolio_session';
const csrfCookie = '__Host-portfolio_csrf';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const imageTypes = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}

function cookies(request) {
  return Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map((part) => part.trim().split('=')));
}

function cookie(name, value, seconds = lifetime / 1000) {
  return `${name}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}`;
}

async function bytes(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw fail(413, 'This file or request is too large.');
  const reader = request.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw fail(413, 'This file or request is too large.'); }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request, limit = 4096) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw fail(415, 'Expected JSON data.');
  const body = await bytes(request, limit);
  try {
    const data = JSON.parse(body.toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw fail(400, 'The submitted data could not be read.'); }
}

function extension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw fail(400, 'Choose a JPEG, PNG, GIF, or WebP image.');
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{1,80}$/.test(username.trim())) {
    throw fail(400, 'Choose a username using letters, numbers, dots, underscores, @, or hyphens.');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw fail(400, 'Choose a password between 12 and 128 characters.');
  }
}

async function passwordMatches(account, password) {
  const candidate = await derive(typeof password === 'string' && password.length <= 128 ? password : '', account.salt, 64);
  return timingSafeEqual(candidate, Buffer.from(account.hash, 'hex'));
}

async function newAccount(username, password) {
  validateCredentials(username, password);
  const salt = random();
  return { username: username.trim(), salt, hash: (await derive(password, salt, 64)).toString('hex'), version: random() };
}

// Stores are injected so the same handlers can be tested across independent function instances.
export function createOnlineCms({ privateStore, galleryStore, mediaStore, initialGallery, setupKey, now = Date.now }) {
  const initialImages = new Set(initialGallery.artworks.map((art) => art.image));
  const mediaPattern = /^\/portfolio-media\/([a-f0-9-]{36}\.(?:png|jpg|gif|webp))$/;
  const revision = (data) => hash(JSON.stringify(data));

  async function readGallery() {
    const stored = await galleryStore.getWithMetadata('gallery', { type: 'json' });
    return { data: stored?.data ?? initialGallery, etag: stored?.etag };
  }

  async function rateLimit(ip) {
    const key = `attempts/${hash(ip)}`;
    for (let retry = 0; retry < 6; retry++) {
      const previous = await privateStore.getWithMetadata(key, { type: 'json' });
      const window = previous?.data.until > now() ? previous.data : { count: 0, until: now() + 15 * 60 * 1000 };
      if (window.count >= 8) throw fail(429, 'Too many login attempts. Try again in 15 minutes.');
      const result = await privateStore.setJSON(key, { ...window, count: window.count + 1 },
        previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
      if (result.modified) return key;
    }
    throw fail(429, 'Too many simultaneous login attempts. Try again shortly.');
  }

  async function sessionFor(request, account) {
    const id = cookies(request)[sessionCookie];
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
    const key = `sessions/${hash(id)}`;
    const session = await privateStore.get(key, { type: 'json' });
    if (!session) return null;
    if (session.expires <= now() || session.accountVersion !== account?.version || session.origin !== new URL(request.url).origin) {
      await privateStore.delete(key);
      return null;
    }
    return { ...session, key };
  }

  async function start(request, account, oldSession, headers) {
    if (oldSession) await privateStore.delete(oldSession.key);
    const id = random();
    const session = { accountVersion: account.version, username: account.username, origin: new URL(request.url).origin,
      expires: now() + lifetime, token: random() };
    await privateStore.setJSON(`sessions/${hash(id)}`, session);
    headers.append('Set-Cookie', cookie(sessionCookie, id));
    return { authenticated: true, needsSetup: false, mode: 'online', username: account.username, token: session.token, maxUpload: 4 * 1024 * 1024 };
  }

  async function validateGallery(artworks) {
    if (!Array.isArray(artworks) || artworks.length > 500) throw fail(400, 'The gallery must contain at most 500 artworks.');
    return Promise.all(artworks.map(async (art) => {
      if (typeof art?.title !== 'string' || !art.title.trim() || art.title.length > 160) throw fail(400, 'Each artwork needs a title of 1–160 characters.');
      if (typeof art.image !== 'string') throw fail(400, 'Each artwork needs an uploaded image.');
      if (!initialImages.has(art.image)) {
        const match = mediaPattern.exec(art.image);
        if (!match || !(await mediaStore.getMetadata(match[1]))) throw fail(400, 'Choose an existing or uploaded image.');
      }
      return { title: art.title.trim(), image: art.image };
    }));
  }

  return async (request, context = {}) => {
    const url = new URL(request.url);
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Netlify-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const send = (status, data) => new Response(JSON.stringify(data), { status, headers });
    try {
      if (request.method === 'GET' && url.pathname === '/portfolio-data') {
        return send(200, (await readGallery()).data);
      }
      const media = mediaPattern.exec(url.pathname);
      if (request.method === 'GET' && media) {
        const stored = await mediaStore.getWithMetadata(media[1], { type: 'arrayBuffer' });
        if (!stored) throw fail(404, 'Image not found.');
        return new Response(stored.data, { headers: { 'Content-Type': imageTypes[media[1].split('.').pop()],
          'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (!url.pathname.startsWith(prefix)) throw fail(404, 'This action does not exist.');
      if (url.protocol !== 'https:') throw fail(400, 'Open the editor using HTTPS.');
      const route = url.pathname.slice(prefix.length);
      const accountRecord = await privateStore.getWithMetadata('account', { type: 'json' });
      const account = accountRecord?.data;
      const session = await sessionFor(request, account);
      if (request.method === 'GET' && route === 'session') {
        if (session) return send(200, { authenticated: true, needsSetup: false, mode: 'online', username: session.username, token: session.token, maxUpload: 4 * 1024 * 1024 });
        const csrf = /^[a-f0-9]{64}$/.test(cookies(request)[csrfCookie] ?? '') ? cookies(request)[csrfCookie] : random();
        headers.append('Set-Cookie', cookie(csrfCookie, csrf));
        return send(200, { authenticated: false, needsSetup: !account, setupKeyRequired: !account,
          setupConfigured: Boolean(setupKey && setupKey.length >= 24), mode: 'online', token: csrf, maxUpload: 4 * 1024 * 1024 });
      }
      const authRoute = ['setup', 'login'].includes(route);
      if (!session && !authRoute) throw fail(401, 'Log in to edit your portfolio.');
      if (request.method === 'GET' && route === 'gallery') {
        const gallery = await readGallery();
        return send(200, { ...gallery.data, revision: revision(gallery.data) });
      }
      if (request.method !== 'POST') throw fail(405, 'This action is not supported.');
      if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site'
        || !equal(request.headers.get('x-cms-token'), session?.token ?? cookies(request)[csrfCookie])) {
        throw fail(403, 'Reload the editor and try again.');
      }
      if (authRoute || route === 'password') {
        const attemptKey = await rateLimit(context.ip ?? 'unknown');
        const input = await jsonBody(request);
        if (route === 'setup') {
          if (account) throw fail(409, 'A login already exists. Log in with your username and password.');
          if (!setupKey || setupKey.length < 24) throw fail(503, 'Set PORTFOLIO_SETUP_KEY in Netlify to a private value of at least 24 characters, then redeploy.');
          if (!equal(input.setupKey, setupKey)) throw fail(403, 'The setup key is incorrect.');
          const created = await newAccount(input.username, input.password);
          const result = await privateStore.setJSON('account', created, { onlyIfNew: true });
          if (!result.modified) throw fail(409, 'A login already exists. Reload and log in.');
          await privateStore.delete(attemptKey);
          return send(200, await start(request, created, session, headers));
        }
        if (!account) throw fail(409, 'Create your editor login first.');
        if (route === 'password') {
          if (!(await passwordMatches(account, input.currentPassword))) throw fail(401, 'The current password is incorrect.');
          const replacement = await newAccount(account.username, input.password);
          const result = await privateStore.setJSON('account', replacement, { onlyIfMatch: accountRecord.etag });
          if (!result.modified) throw fail(409, 'Your login changed in another session. Log in again.');
          await privateStore.delete(attemptKey);
          return send(200, await start(request, replacement, session, headers));
        }
        const matches = await passwordMatches(account, input.password);
        if (!matches || typeof input.username !== 'string' || input.username.trim() !== account.username) throw fail(401, 'Username or password is incorrect.');
        await privateStore.delete(attemptKey);
        return send(200, await start(request, account, session, headers));
      }
      if (route === 'logout') {
        await privateStore.delete(session.key);
        headers.append('Set-Cookie', cookie(sessionCookie, '', 0));
        return send(200, { authenticated: false });
      }
      if (route === 'upload') {
        // Netlify's binary request limit is about 4.5 MB after encoding overhead.
        const body = await bytes(request, 4 * 1024 * 1024);
        const ext = extension(body);
        const key = `${randomUUID()}.${ext}`;
        await mediaStore.set(key, body, { metadata: { contentType: imageTypes[ext] }, onlyIfNew: true });
        return send(201, { image: `/portfolio-media/${key}` });
      }
      if (route === 'gallery') {
        const input = await jsonBody(request, 256 * 1024);
        const current = await readGallery();
        if (input.revision !== revision(current.data)) throw fail(409, 'The gallery changed in another tab. Copy your edits, then reload before saving.');
        const data = { artworks: await validateGallery(input.artworks) };
        const result = await galleryStore.setJSON('gallery', data, current.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
        if (!result.modified) throw fail(409, 'The gallery changed in another tab. Copy your edits, then reload before saving.');
        return send(200, { ...data, revision: revision(data) });
      }
      throw fail(404, 'This action does not exist.');
    } catch (error) {
      if (!error.status) console.error('[online-portfolio-cms]', error);
      return send(error.status ?? 500, { error: error.status ? error.message : 'Could not reach portfolio storage. Try again shortly.' });
    }
  };
}
