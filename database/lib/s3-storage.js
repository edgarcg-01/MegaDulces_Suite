/**
 * Helper standalone S3 para scripts CLI (no es parte del bundle Nest).
 * Usa @aws-sdk/client-s3 contra el bucket Railway (S3-compatible, Tigris-style).
 *
 * Env vars requeridas:
 *   S3_ENDPOINT       https://t3.storageapi.dev
 *   S3_BUCKET         indexed-carrier-r94gtps6l
 *   S3_ACCESS_KEY     tid_...
 *   S3_SECRET_KEY     tsec_...
 *   S3_REGION         auto
 *   S3_PUBLIC_BASE    https://t3.storageapi.dev/indexed-carrier-r94gtps6l
 */
const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

function makeClient() {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const region = process.env.S3_REGION || 'auto';

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY missing in env');
  }

  return new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

const client = makeClient();
const BUCKET = process.env.S3_BUCKET;
const PUBLIC_BASE = (process.env.S3_PUBLIC_BASE || '').replace(/\/+$/, '');

async function uploadBuffer({ key, buffer, contentType = 'image/jpeg', cacheControl = 'public, max-age=31536000, immutable' }) {
  if (!key) throw new Error('uploadBuffer: key required');
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: cacheControl,
    ACL: 'public-read',
  }));
  return { key, url: publicUrl(key), size: buffer.length };
}

async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return false;
    throw e;
  }
}

async function remove(key) {
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

function publicUrl(key) {
  if (PUBLIC_BASE) return `${PUBLIC_BASE}/${key}`;
  return `${process.env.S3_ENDPOINT.replace(/\/+$/, '')}/${BUCKET}/${key}`;
}

module.exports = { client, BUCKET, uploadBuffer, exists, remove, publicUrl };
