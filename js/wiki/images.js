// Saving pictures and GIFs for wiki pages. They're stored on this device as files
// (images/<page>-<random>.<ext>) and pushed to files/images/ in the data repo.
//
// Big pictures (over 1600 pixels or 1.5 MB) are made smaller so syncing stays quick.
// GIFs are kept exactly as they are, so animations keep working.

import { store } from '../core/store.js';
import { uid } from '../core/util.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_SIDE = 1600;
const SHRINK_OVER_BYTES = 1.5 * 1024 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;

export async function saveImage(file, pageId) {
  if (!file || !String(file.type).startsWith('image/')) {
    throw new Error("That file isn't a picture. Use a PNG, JPG, WebP or GIF.");
  }
  if (!EXT[file.type]) throw new Error(`This kind of picture (${file.type}) can't be used. Use a PNG, JPG, WebP or GIF.`);
  if (file.size > MAX_BYTES) throw new Error('That picture is bigger than 20 MB. Make it smaller first.');

  let blob = file;
  let type = file.type;
  if (type !== 'image/gif') {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error("This picture couldn't be opened."); }
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale < 1 || file.size > SHRINK_OVER_BYTES) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const smaller = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.9));
      if (smaller) { blob = smaller; type = 'image/webp'; }
    }
    bmp.close?.();
  }
  const path = `images/${pageId}-${uid()}.${EXT[type]}`;
  await store.putFile(path, blob, { source: 'editor' });
  return path;
}

/** True for a value that is one of the wiki's picture files (not text). */
export const isPicturePath = v => typeof v === 'string' && /^images\/[^\s]+\.(png|jpe?g|gif|webp)$/i.test(v);

/** Every picture file a page uses. */
export function filesOfPage(data) {
  const out = new Set();
  if (typeof data?.picture === 'string' && data.picture) out.add(data.picture);
  if (data?.fields && typeof data.fields === 'object') {
    for (const v of Object.values(data.fields)) if (isPicturePath(v)) out.add(v);
  }
  for (const b of Array.isArray(data?.body) ? data.body : []) {
    if (b?.type === 'image' && typeof b.src === 'string' && b.src) out.add(b.src);
  }
  return out;
}

/** Files that belong to a page by name (images/<page>-…), used when the page is deleted or undone. */
export const isFileOfPage = (path, pageId) => String(path).startsWith(`images/${pageId}-`);
