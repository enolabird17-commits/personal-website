import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const cookieName = 'portfolio_cms_session';
const lifetime = 8 * 60 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createCmsAuth(root) {
  const directory = path.join(root, '.cms-auth');
  const filename = path.join(directory, 'account.json');
  const bootstrapToken = randomBytes(32).toString('hex');
  const sessions = new Map();
  const attempts = new Map();

  async function readAccount() {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  function cookieId(req) {
    return (req.headers.cookie ?? '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  }

  function current(req, origin) {
    const id = cookieId(req);
    const session = sessions.get(id);
    if (session && session.expires > Date.now() && session.origin === origin) return session;
    if (session) sessions.delete(id);
    return null;
  }

  function start(req, res, origin, username) {
    sessions.delete(cookieId(req));
    for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    const id = randomBytes(32).toString('hex');
    const session = { username, origin, expires: Date.now() + lifetime, token: randomBytes(32).toString('hex') };
    sessions.set(id, session);
    res.setHeader('Set-Cookie', `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/__portfolio-cms/; Max-Age=${lifetime / 1000}`);
    return { authenticated: true, needsSetup: false, username, token: session.token };
  }

  return {
    current,
    async status(req, origin) {
      const session = current(req, origin);
      return session
        ? { authenticated: true, needsSetup: false, username: session.username, token: session.token }
        : { authenticated: false, needsSetup: !(await readAccount()), token: bootstrapToken };
    },
    csrf(req, origin) { return current(req, origin)?.token ?? bootstrapToken; },
    async setup(req, res, origin, { username, password }) {
      if (await readAccount()) throw fail(409, 'A login already exists. Log in with your username and password.');
      if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{1,80}$/.test(username.trim())) {
        throw fail(400, 'Choose a username using letters, numbers, dots, underscores, @, or hyphens.');
      }
      if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
        throw fail(400, 'Choose a password between 12 and 128 characters.');
      }
      const salt = randomBytes(32).toString('hex');
      const hash = (await deriveKey(password, salt, 64)).toString('hex');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `${randomBytes(16).toString('hex')}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, username: username.trim(), salt, hash }), { flag: 'wx', mode: 0o600 });
        // Linking a complete file atomically prevents two setup requests creating accounts.
        await link(temporary, filename);
      } catch (error) {
        if (error.code === 'EEXIST') throw fail(409, 'A login already exists. Reload and log in.');
        throw error;
      } finally { await unlink(temporary).catch(() => {}); }
      return start(req, res, origin, username.trim());
    },
    async login(req, res, origin, { username, password }) {
      const account = await readAccount();
      if (!account) throw fail(409, 'Create your editor login first.');
      const key = req.socket.remoteAddress;
      const now = Date.now();
      const previous = attempts.get(key);
      const window = previous && previous.until > now ? previous : { count: 0, until: now + 15 * 60 * 1000 };
      if (window.count >= 8) throw fail(429, 'Too many login attempts. Try again in 15 minutes.');
      window.count++;
      attempts.set(key, window);
      const validInput = typeof username === 'string' && typeof password === 'string' && password.length <= 128;
      const candidate = await deriveKey(validInput ? password : '', account.salt, 64);
      const matches = timingSafeEqual(candidate, Buffer.from(account.hash, 'hex'));
      if (!validInput || !matches || username.trim() !== account.username) throw fail(401, 'Username or password is incorrect.');
      attempts.delete(key);
      return start(req, res, origin, account.username);
    },
    logout(req, res) {
      sessions.delete(cookieId(req));
      res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/__portfolio-cms/; Max-Age=0`);
      return { authenticated: false };
    },
  };
}
