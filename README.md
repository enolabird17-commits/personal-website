# Wrenn's Website

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

To edit artwork, open http://localhost:4321/admin/index.html with the dev server
running. The local editor saves titles and gallery order to the project and
uploads images into `extraterrestrial-equinox/public/artwork/`. No GitHub login
or browser folder permission is required. Create your editor username and password
on the first visit, then log in to edit. Run `npm run test:cms` to verify the CMS.
