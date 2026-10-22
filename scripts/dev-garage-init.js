#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[MS.ADJ.0.3]` Prepara el Garage de DESARROLLO para probar adjuntos en local: asigna el nodo, crea el bucket y una
 * llave de acceso, y IMPRIME las variables `S3_*` para que las pegues en tu `.env`. Es idempotente: se puede correr
 * otra vez (reutiliza el bucket y la llave que ya existan).
 *
 *   docker compose -f docker-compose.dev.yml --profile s3 up -d garage
 *   node scripts/dev-garage-init.js
 *
 * ⛔ Sólo habla con el contenedor `tm-garage` de TU máquina (`docker exec`). No toca prod ni escribe tu `.env`:
 *    la llave que imprime es de un almacén local que no sale de 127.0.0.1.
 */
const { execFileSync } = require('node:child_process');

const CONTENEDOR = 'tm-garage';
const BUCKET = 'mesa-dev';
const LLAVE = 'mesa-dev-key';

function garage(...args) {
  return execFileSync('docker', ['exec', CONTENEDOR, '/garage', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/** Corre un comando y devuelve la salida; si falla con un mensaje tolerable (ya existe), devuelve `null`. */
function intentar(tolerables, ...args) {
  try {
    return garage(...args);
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    if (tolerables.some((t) => msg.toLowerCase().includes(t))) return null;
    throw new Error(`garage ${args.join(' ')} falló: ${msg.trim()}`);
  }
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarNodo() {
  for (let i = 0; i < 30; i++) {
    try {
      return garage('node', 'id', '-q').trim().split('@')[0];
    } catch {
      await dormir(1000);
    }
  }
  throw new Error(`El contenedor ${CONTENEDOR} no responde. ¿Corriste «docker compose -f docker-compose.dev.yml --profile s3 up -d garage»?`);
}

(async () => {
  const nodo = await esperarNodo();

  // 1) Layout: un solo nodo, una zona. Sólo si todavía no hay uno aplicado.
  // `layout show` lista el nodo por los primeros 16 caracteres de su id cuando YA está en el layout aplicado.
  if (!garage('layout', 'show').includes(nodo.slice(0, 16))) {
    garage('layout', 'assign', '-z', 'dev', '-c', '1G', nodo);
    garage('layout', 'apply', '--version', '1');
  }

  // 2) Bucket y llave (si existen, se reutilizan).
  intentar(['already exists', 'ya existe'], 'bucket', 'create', BUCKET);
  // ⚠️ Garage PERMITE dos llaves con el mismo nombre (y después «bucket allow --key nombre» falla con «2 matching keys»):
  //    por eso se mira la lista ANTES de crear, no se confía en un «ya existe» que nunca llega.
  const cuantas = (garage('key', 'list').match(new RegExp(`\\b${LLAVE}\\b`, 'g')) ?? []).length;
  if (cuantas > 1) throw new Error(`Hay ${cuantas} llaves llamadas «${LLAVE}». Reinicia el almacén local: docker compose -f docker-compose.dev.yml --profile s3 down -v && vuelve a encender garage.`);
  if (cuantas === 0) garage('key', 'create', LLAVE);
  garage('bucket', 'allow', '--read', '--write', '--owner', BUCKET, '--key', LLAVE);

  const info = garage('key', 'info', LLAVE, '--show-secret');
  const id = /Key ID:\s*(\S+)/i.exec(info)?.[1];
  const secreto = /Secret key:\s*(\S+)/i.exec(info)?.[1];
  if (!id || !secreto) throw new Error('No pude leer la llave de Garage:\n' + info);

  console.log('✓ Garage local listo. Pega esto en tu .env (y reinicia el API):\n');
  console.log('S3_ENDPOINT=http://127.0.0.1:3900');
  console.log(`S3_BUCKET=${BUCKET}`);
  console.log('S3_REGION=auto');
  console.log(`S3_ACCESS_KEY_ID=${id}`);
  console.log(`S3_SECRET_ACCESS_KEY=${secreto}`);
})().catch((e) => {
  console.error('✖ ' + e.message);
  process.exit(1);
});
