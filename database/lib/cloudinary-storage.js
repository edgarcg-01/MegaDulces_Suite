/**
 * Helper standalone Cloudinary para scripts CLI (no es parte del bundle Nest).
 * Reusa misma config del CLOUDINARY_URL del .env.
 *
 * Env vars requeridas (cualquiera de las dos formas):
 *   CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
 *   ó
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 */
const cloudinary = require('cloudinary').v2;
const https = require('https');
const http = require('http');

if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ secure: true });
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function fetchBuffer(url, { timeoutMs = 15000, maxBytes = 8 * 1024 * 1024, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const start = (u, hops) => {
      const client = u.startsWith('https://') ? https : http;
      const req = client.get(u, { timeout: timeoutMs }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
          res.resume();
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, u).toString();
          return start(next, hops - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`fetchBuffer ${res.statusCode} for ${u}`));
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) {
            req.destroy(new Error(`Image > ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    };
    start(url, redirects);
  });
}

async function uploadFromUrl({ url, publicId, folder = 'products', tags = [] }) {
  const { buffer } = await fetchBuffer(url);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        folder,
        resource_type: 'image',
        overwrite: true,
        tags,
        transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }],
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

async function deleteByPublicId(publicId) {
  return cloudinary.uploader.destroy(publicId);
}

function deliveryUrl(publicId, opts = {}) {
  const { w = 400, h = 400 } = opts;
  return cloudinary.url(publicId, {
    secure: true,
    transformation: [{ width: w, height: h, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }],
  });
}

module.exports = { cloudinary, uploadFromUrl, deleteByPublicId, deliveryUrl, fetchBuffer };
