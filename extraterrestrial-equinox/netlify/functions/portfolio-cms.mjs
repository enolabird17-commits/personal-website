import { getStore } from '@netlify/blobs';
import initialGallery from '../../src/data/artworks.json' with { type: 'json' };
import { createOnlineCms } from '../../scripts/online-cms.mjs';

export default async (request, context) => {
  // Preview deploys get their own stores and cannot modify the production gallery.
  const scope = context.deploy?.context === 'production' ? 'production' : `preview-${context.deploy?.id ?? 'local'}`;
  const store = (kind) => getStore({ name: `portfolio-${scope}-${kind}`, consistency: 'strong' });
  return createOnlineCms({ privateStore: store('private'), galleryStore: store('gallery'), mediaStore: store('media'),
    initialGallery, setupKey: process.env.PORTFOLIO_SETUP_KEY })(request, context);
};

export const config = { path: ['/__portfolio-cms/*', '/portfolio-data', '/portfolio-media/*'] };
