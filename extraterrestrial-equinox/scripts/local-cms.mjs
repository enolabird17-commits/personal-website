import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCmsAuth } from './cms-auth.mjs';

const prefix = '/__portfolio-cms/';
const maxUpload = 10 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(fail(413, 'This file is too large. Choose an image under 10 MB.'));
      } else {
        chunks.push(chunk);
      }
    });
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
    req.once('aborted', () => reject(fail(400, 'The upload was interrupted. Try again.')));
  });
}

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw fail(400, 'Choose a JPEG, PNG, GIF, or WebP image.');
}

// Only fixed gallery data and raster image uploads are writable. No arbitrary paths.
export function createCmsMiddleware(root) {
  const auth = createCmsAuth(root);
  const galleryFile = path.join(root, 'src/data/artworks.json');
  const publicDir = path.join(root, 'public');
  const uploadDir = path.join(publicDir, 'artwork');
  let pendingSave = Promise.resolve();

  async function readGallery() {
    const bytes = await readFile(galleryFile);
    return { ...JSON.parse(bytes), revision: digest(bytes) };
  }

  async function validateArtworks(artworks) {
    if (!Array.isArray(artworks) || artworks.length > 500) throw fail(400, 'The gallery must contain at most 500 artworks.');
    const publicRoot = await realpath(publicDir);
    return Promise.all(artworks.map(async (art) => {
      if (typeof art?.title !== 'string' || !art.title.trim() || art.title.length > 160) {
        throw fail(400, 'Each artwork needs a title of 1–160 characters.');
      }
      if (typeof art.image !== 'string' || !/^\/(?!\/)[a-zA-Z0-9_./-]+\.(?:jpe?g|png|gif|webp)$/i.test(art.image)
        || art.image.split('/').some((part) => part === '..')) {
        throw fail(400, 'Each artwork needs an uploaded image.');
      }
      let imagePath;
      try { imagePath = await realpath(path.join(publicDir, art.image.slice(1))); }
      catch { throw fail(400, `The image for “${art.title}” could not be found. Choose it again.`); }
      if (!imagePath.startsWith(publicRoot + path.sep)) throw fail(400, 'Images must be inside this project.');
      return { title: art.title.trim(), image: art.image };
    }));
  }

  return async (req, res, next) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    let decodedPath;
    try { decodedPath = decodeURIComponent(pathname); }
    catch { res.writeHead(400); res.end('Invalid URL'); return; }
    if (decodedPath.toLowerCase().split('/').includes('.cms-auth')) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (pathname === '/admin' || pathname === '/admin/') {
      res.writeHead(302, { Location: '/admin/index.html' });
      res.end();
      return;
    }
    if (!pathname.startsWith(prefix)) return next();

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    try {
      const host = new URL(`http://${req.headers.host ?? ''}`);
      const peer = req.socket.remoteAddress;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)
        || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
        throw fail(403, 'The editor is available only on this computer.');
      }
      if ((req.headers.origin && req.headers.origin !== host.origin)
        || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
        throw fail(403, 'Open the editor from this local site.');
      }
      if (req.method === 'GET' && pathname === `${prefix}session`) {
        return send(200, await auth.status(req, host.origin));
      }
      const session = auth.current(req, host.origin);
      const authRoute = [`${prefix}setup`, `${prefix}login`].includes(pathname);
      if (!session && !authRoute) throw fail(401, 'Log in to edit your portfolio.');
      if (req.method === 'GET' && pathname === `${prefix}gallery`) {
        return send(200, { ...await readGallery(), token: session.token });
      }
      if (req.method !== 'POST') throw fail(405, 'This action is not supported.');
      if (req.headers.origin !== host.origin || req.headers['x-cms-token'] !== auth.csrf(req, host.origin)) {
        throw fail(403, 'Reload the editor and try again.');
      }
      if (authRoute) {
        if (req.headers['content-type'] !== 'application/json') throw fail(415, 'Expected login details.');
        let credentials;
        try { credentials = JSON.parse((await readBody(req, 4096)).toString()); }
        catch { throw fail(400, 'The login details could not be read.'); }
        if (!credentials || typeof credentials !== 'object') throw fail(400, 'Enter a username and password.');
        return send(200, await auth[pathname.endsWith('/setup') ? 'setup' : 'login'](req, res, host.origin, credentials));
      }
      if (pathname === `${prefix}logout`) return send(200, auth.logout(req, res));
      if (pathname === `${prefix}gallery`) {
        if (req.headers['content-type'] !== 'application/json') throw fail(415, 'Expected gallery data.');
        let payload;
        try { payload = JSON.parse((await readBody(req, 256 * 1024)).toString()); }
        catch (error) { throw error.status ? error : fail(400, 'The gallery data could not be read.'); }
        // Serialize saves so two tabs cannot silently overwrite each other.
        const save = pendingSave.then(async () => {
          const current = await readGallery();
          if (payload.revision !== current.revision) throw fail(409, 'The gallery changed in another tab. Copy your edits, then reload before saving.');
          const artworks = await validateArtworks(payload.artworks);
          const bytes = JSON.stringify({ artworks }, null, 2) + '\n';
          const temporary = path.join(path.dirname(galleryFile), `.cms-${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, bytes, { flag: 'wx' });
            await rename(temporary, galleryFile);
          } finally { await unlink(temporary).catch(() => {}); }
          return { artworks, revision: digest(bytes) };
        });
        pendingSave = save.catch(() => {});
        return send(200, await save);
      }
      if (pathname === `${prefix}upload`) {
        const bytes = await readBody(req, maxUpload);
        const extension = imageExtension(bytes);
        await mkdir(uploadDir, { recursive: true });
        const actualDir = await realpath(uploadDir);
        const actualPublic = await realpath(publicDir);
        if (!actualDir.startsWith(actualPublic + path.sep)) throw fail(400, 'The upload folder must be inside this project.');
        const filename = `${randomUUID()}.${extension}`;
        await writeFile(path.join(actualDir, filename), bytes, { flag: 'wx' });
        return send(201, { image: `/artwork/${filename}` });
      }
      throw fail(404, 'This action does not exist.');
    } catch (error) {
      if (!error.status) console.error('[portfolio-cms]', error);
      send(error.status ?? 500, { error: error.status ? error.message : 'Could not access the project files. Check the development server and try again.' });
    }
  };
}

export default function localCms() {
  return {
    name: 'portfolio-local-cms',
    apply: 'serve',
    config(config) {
      // Vite replaces fs.deny when configured; retain its defaults as well.
      const deny = config.server?.fs?.deny ?? [
        '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
      ];
      return { server: { fs: { deny: [...deny, '**/.cms-auth/**'] } } };
    },
    configureServer(server) {
      server.middlewares.use(createCmsMiddleware(server.config.root));
    },
  };
}
