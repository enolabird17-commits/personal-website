# Lebbie the Stranger's Art Portfolio

An Astro portfolio with a local gallery editor at `/admin/index.html`.

## Run locally

Use Node.js 22.23.4 or newer, as specified in `package.json`.

```sh
npm install
npm run dev
```

Open the URL printed in the terminal, normally http://localhost:4321.
For a background server, use `npm run dev -- --background`.
Manage it with `npm run astro -- dev status`, `npm run astro -- dev logs`,
and `npm run astro -- dev stop`.

## Edit the gallery

### Theme styles

The woodland sketchbook palette is in `public/theme.css`. The portfolio layout
and paper frames are in `public/portfolio.css`; editor and login styles are in
`public/admin/editor.css`. All styling stays in separate CSS files. The standalone
preview in the parent folder reuses the same portfolio styles.

### Gallery editor

Open http://localhost:4321/admin/index.html while the development server is running.
The editor works in the in-app browser, Chrome, Edge, Safari, or Firefox without
GitHub sign-in or selecting a project directory. On the first visit, create a
username and a password of 12–128 characters. Later visits require those credentials.
Use **Log out** when finished. Sessions last up to eight hours and end when the
development server restarts; the account itself persists across restarts.

- Change artwork titles directly in the form.
- Choose a JPEG, PNG, GIF, or WebP image under 10 MB to upload it.
- Use **Add artwork**, **Move up**, **Move down**, and **Remove artwork** to arrange the gallery.
- Click **Save changes** to update the gallery. The portfolio preview updates automatically.

Saves go to `src/data/artworks.json`; uploads go to `public/artwork/`. Removing an
artwork removes its gallery entry but keeps the image file. Uploads are stored
when selected; gallery changes are only published to the local preview when saved.
Changes stay on this computer until separately committed and pushed.

The editor warns about unsaved changes and refuses stale saves from another tab,
so a second editor cannot silently overwrite a newer gallery. If a conflict occurs,
copy the edits you want to keep, then reload the editor.

The local API is a development-only Vite plugin in `scripts/local-cms.mjs`. It
accepts requests only from the loopback interface and the same local origin,
requires login for gallery reads, saves, and uploads, validates gallery data and image uploads,
and uses a session token for writes. It is not included in the
production site or available through `npm run preview`.

The password is stored as a salted scrypt hash in `.cms-auth/account.json`, with
owner-only filesystem permissions. This private directory is ignored by Git,
blocked by the dev server, and omitted from production builds. Sessions use
HttpOnly, SameSite cookies; repeated failed logins are rate limited. Keep this
directory when moving the local project if you want to keep its login.

The editor is a static HTML page so saving files does not reload the editor.
`/admin` and `/admin/` redirect to `/admin/index.html` during development.

### Manual edits

The gallery file has this structure:

```json
{
  "artworks": [
    { "title": "Mountains", "image": "/mountains.jpeg" }
  ]
}
```

Images live in `public/`; their URLs omit `public`. An empty list displays a
message instead of leaving a blank gallery. Click an image on the portfolio
to view it full size.

The older `/admin/sveltia.html` URL redirects to the same login screen.

## Verify, build, and deploy

```sh
npm run test:cms
npm run build
npm run preview
```

The CMS integration tests use temporary files and a temporary loopback server.
They check persistent saves, upload handling, conflicting edits, origin/token/host
validation, invalid paths, empty galleries, account setup, password checks,
logout, session expiry, server restarts, private-file blocking, and login rate limits.

Deploy the generated `dist/` directory to a static host. If configuring the host
from the parent folder, set its project root to `extraterrestrial-equinox`.
Production builds contain the portfolio and static editor assets, but no file-writing
API. The local editor needs `npm run dev` to save changes; rebuild and deploy after
local edits to update the public site.
