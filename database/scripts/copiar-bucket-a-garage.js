#!/usr/bin/env node
/*
 * `[K3S.22]` Copia los objetos del bucket de Tigris/Railway al bucket propio de `md` (Garage).
 *
 *   node database/scripts/copiar-bucket-a-garage.js            # DRY-RUN: cuenta y no escribe
 *   node database/scripts/copiar-bucket-a-garage.js --apply    # copia de verdad
 *
 * ── Qué NO hace ─────────────────────────────────────────────────────────────────────────────
 * ⛔ No corta nada. No toca `S3_ENDPOINT` ni la base. Después de correr esto, la aplicación
 *    sigue leyendo y escribiendo en Tigris exactamente igual. El corte es una decisión aparte,
 *    y no se toma hasta que esta copia cuadre **y** el bucket nuevo tenga respaldo fuera de `md`.
 *
 * ── Idempotente, y por qué de esta forma ────────────────────────────────────────────────────
 * Antes de copiar un objeto hace `HEAD` en el destino: si ya está **con el mismo tamaño**, lo
 * saltea. Comparar sólo la existencia dejaría pasar una copia truncada por un corte de red —
 * y esta máquina se cayó seis veces el 2026-10-02, así que un corte a mitad es el caso normal,
 * no el raro.
 *
 * ⚠️ El tamaño no es un hash. Dos objetos distintos del mismo tamaño se verían iguales. Para lo
 *    que esto hace —reanudar una copia propia— alcanza; para afirmar que el destino es idéntico
 *    al origen, **no**, y por eso el resumen final dice `cuadra por CONTEO Y BYTES`, que es lo
 *    que de verdad se midió, y no «verificado».
 *
 * Origen  : S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY  (los de la app)
 * Destino : GARAGE_ENDPOINT / GARAGE_BUCKET / GARAGE_KEY_ID / GARAGE_SECRET
 */
'use strict';

const {
  S3Client, ListObjectsV2Command, GetObjectCommand,
  PutObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const APLICAR = process.argv.includes('--apply');

const faltan = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
                'GARAGE_ENDPOINT', 'GARAGE_BUCKET', 'GARAGE_KEY_ID', 'GARAGE_SECRET']
  .filter((v) => !process.env[v]);
if (faltan.length) {
  console.error('⛔ faltan variables: ' + faltan.join(', '));
  process.exit(1);
}

const origen = new S3Client({
  region: process.env.S3_REGION || 'auto', endpoint: process.env.S3_ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});
const destino = new S3Client({
  region: 'auto', endpoint: process.env.GARAGE_ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: process.env.GARAGE_KEY_ID, secretAccessKey: process.env.GARAGE_SECRET },
});
const BO = process.env.S3_BUCKET, BD = process.env.GARAGE_BUCKET;

// ⛔ Origen y destino TIENEN que ser distintos. Si alguien apunta las dos mitades al mismo
//    lugar, el guion "copia" cada objeto sobre sí mismo y termina en verde sin haber movido
//    nada — el mismo éxito silencioso que esta casa persigue en los feeds.
if (process.env.S3_ENDPOINT === process.env.GARAGE_ENDPOINT && BO === BD) {
  console.error('⛔ origen y destino son el MISMO bucket. No copio.');
  process.exit(1);
}

const cuerpo = async (r) => Buffer.from(await r.Body.transformToByteArray());

(async () => {
  console.log(`  origen : ${BO} @ ${process.env.S3_ENDPOINT}`);
  console.log(`  destino: ${BD} @ ${process.env.GARAGE_ENDPOINT}`);
  console.log(`  modo   : ${APLICAR ? 'COPIANDO' : 'DRY-RUN (no escribe)'}\n`);

  let token, total = 0, bytes = 0, copiados = 0, saltados = 0, fallados = 0, bytesCopiados = 0;
  do {
    const pagina = await origen.send(new ListObjectsV2Command({ Bucket: BO, ContinuationToken: token }));
    for (const o of pagina.Contents || []) {
      total++; bytes += o.Size || 0;

      let yaEsta = false;
      try {
        const h = await destino.send(new HeadObjectCommand({ Bucket: BD, Key: o.Key }));
        yaEsta = Number(h.ContentLength) === Number(o.Size);
      } catch { /* no está: se copia */ }

      if (yaEsta) { saltados++; continue; }
      if (!APLICAR) { copiados++; continue; }

      try {
        const r = await origen.send(new GetObjectCommand({ Bucket: BO, Key: o.Key }));
        const buf = await cuerpo(r);
        await destino.send(new PutObjectCommand({
          Bucket: BD, Key: o.Key, Body: buf,
          ContentType: r.ContentType || 'application/octet-stream',
        }));
        copiados++; bytesCopiados += buf.length;
      } catch (e) {
        fallados++;
        console.log(`    ⛔ ${o.Key} → ${e.name}: ${e.message.split('\n')[0]}`);
      }
      if ((copiados + saltados) % 100 === 0) {
        console.log(`    … ${copiados + saltados}/${total} (copiados ${copiados}, saltados ${saltados})`);
      }
    }
    token = pagina.IsTruncated ? pagina.NextContinuationToken : null;
  } while (token);

  // ── El cuadre, contando el DESTINO de verdad, no asumiendo que lo escrito llegó ──────────
  let t2, nd = 0, bd = 0;
  do {
    const p = await destino.send(new ListObjectsV2Command({ Bucket: BD, ContinuationToken: t2 }));
    for (const o of p.Contents || []) { nd++; bd += o.Size || 0; }
    t2 = p.IsTruncated ? p.NextContinuationToken : null;
  } while (t2);

  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log('\n  ── resumen ──');
  console.log(`  origen : ${total} objetos · ${mb(bytes)}`);
  console.log(`  destino: ${nd} objetos · ${mb(bd)}`);
  console.log(`  copiados ${copiados} · saltados ${saltados} · fallados ${fallados}`);
  if (APLICAR) console.log(`  transferido en esta corrida: ${mb(bytesCopiados)}`);

  if (!APLICAR) { console.log('\n  DRY-RUN: no se escribió nada. Corré con --apply.'); process.exit(0); }
  if (fallados > 0) { console.log(`\n  ⛔ ${fallados} objeto(s) fallaron — volvé a correrlo, es idempotente.`); process.exit(1); }
  if (nd === total && bd === bytes) {
    console.log('\n  ✓ cuadra por CONTEO Y BYTES. (No es un hash: ver la cabecera.)');
    process.exit(0);
  }
  console.log(`\n  ⛔ NO cuadra: faltan ${total - nd} objeto(s) y ${mb(bytes - bd)}.`);
  process.exit(1);
})().catch((e) => { console.error('⛔ ' + e.name + ': ' + e.message.split('\n')[0]); process.exit(1); });
