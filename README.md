# Lebbie_The_Stranger's Website

The editable portfolio is an Astro project in `extraterrestrial-equinox/`.

From this folder:

```sh
npm --prefix extraterrestrial-equinox install
npm run dev
```

Open the local URL printed in the terminal (normally http://localhost:4321).
The top-level `index.html` is a standalone preview using the three bundled
images; it does not read CMS changes. Use the Astro site for development and deployment.

```sh
npm run build
npm run preview
```

The deployable output is `extraterrestrial-equinox/dist/`. For a hosting provider,
set the project root to `extraterrestrial-equinox`, build command to `npm run build`,
and output directory to `dist`.

See the project's README for editing instructions.

## Netlify

Connect this repository and select **master** as the production branch. The
`main` branch does not contain the website. The root `netlify.toml` configures
the Astro base directory (`extraterrestrial-equinox`), build command
(`npm run build`), publish directory (`dist`, relative to the base), and Node 24.

Netlify installs the Astro dependencies from the base directory before building.
Deploy the generated site, rather than the standalone preview in the repository
root. After changing these settings, trigger a new production deploy.

### Set up the public editor

1. In Netlify, open **Project configuration → Environment variables** and add
   `PORTFOLIO_SETUP_KEY`. Choose a private random value of 24–256 characters
   (for example, a password-manager-generated value). Make it available to
   **Functions** or **all scopes** for the production context. Keep it out of Git.
2. Deploy the latest `master` commit. Environment variable changes require a
   new deploy.
3. Open `/admin/index.html` on the deployed website. Enter that setup key and
   choose your own username and password. Passwords must be 12–128 characters.
4. Log in, replace images or edit titles, and click **Save changes**. Changes
   publish immediately, without a Git commit or rebuild. Use **Change your
   password** in the editor to set a new password later.

The setup key only authorizes the first account creation. After setup, you can
remove it from Netlify and redeploy; your login is stored separately. Existing
accounts cannot be replaced using the setup key. To recover a forgotten password,
delete only `account` in Netlify's `portfolio-production-private` Blobs store,
set a new setup key, redeploy, and create a new login. Leave the gallery and media
stores intact. Old sessions are invalidated when you create the new account.

Netlify Functions and Blobs power the online editor. Titles/gallery order,
uploaded images, and private account/session data use separate site-wide stores
and survive production deploys. Images can be JPEG, PNG, GIF, or WebP, up to
**4 MB** each. Images become publicly accessible when uploaded; gallery changes
publish only when saved. Removed images are retained in storage. These operations
count toward your Netlify plan's Functions and Blobs usage.

The public page fetches the latest gallery when loaded and when you return to its
tab. Its built HTML remains a fallback for JavaScript-disabled/offline previews;
it reflects the repository gallery, not later online edits. Online edits are
stored in Netlify and do not change the Git repository. Preview deploys have
separate storage and cannot edit production data. Copy/export the production
Blobs stores if moving the website to a different Netlify project.

To edit artwork locally, open http://localhost:4321/admin/index.html with the dev server
running. The local editor saves titles and gallery order to the project and
uploads images into `extraterrestrial-equinox/public/artwork/`. No GitHub login
or browser folder permission is required. Create your editor username and password
on the first visit, then log in to edit. Run `npm run test:cms` to verify the CMS.
