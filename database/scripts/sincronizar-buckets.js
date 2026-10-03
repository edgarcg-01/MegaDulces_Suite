#!/usr/bin/env node
/*
 * `[K3S.22]` Sincroniza un bucket S3 hacia otro. UNA herramienta, las dos direcciones.
 *
 *   node database/scripts/sincronizar-buckets.js            # DRY-RUN: cuenta y no escribe
 *   node database/scripts/sincronizar-buckets.js --apply    # copia
 *   node database/scripts/sincronizar-buckets.js --etags    # además compara ETag por objeto
 *
 * Origen  : ORIGEN_ENDPOINT  ORIGEN_BUCKET  ORIGEN_KEY  ORIGEN_SECRET   (+ ORIGEN_REGION)
 * Destino : DESTINO_ENDPOINT DESTINO_BUCKET DESTINO_KEY DESTINO_SECRET  (+ DESTINO_REGION)
 *
 * ── Para qué sirve, en las dos direcciones ──────────────────────────────────────────────────
 *   MUDANZA  Tigris → Garage : traer los comprobantes al bucket propio.
 *   RESPALDO Garage → afuera : la copia FUERA de `md` que convierte al bucket propio en algo
 *                              que se puede usar sin bajar la durabilidad.
 *
 * ⛔ TENER EL DATO DOS VECES EN EL MISMO DISCO NO ES TENER RESPALDO. `md` es una sola máquina,
 *    con un solo NVMe, que se cayó seis veces el 2026-10-02 y no tiene UPS (deuda `VL.8`).
 *    El destino del respaldo tiene que estar en otro lado — ver el runbook.
 *
 * ── Idempotente, y por qué compara TAMAÑO y no sólo existencia ──────────────────────────────
 * Una copia truncada por un corte de red EXISTE en el destino. Si se comparara nada más que la
 * presencia, se saltearía para siempre. Con `--etags` la comparación pasa a ser por contenido
 * (el ETag es el MD5 en subidas simples), que es lo único que permite decir "es el mismo
 * archivo" en vez de "mide lo mismo".
 *
 * ⚠️ En objetos subidos en varias partes el ETag NO es el MD5 del contenido y lleva un `-N`.
 *    Esos se cuentan aparte como `no comparable` en vez de darlos por buenos o por malos.
 */
'use strict';

const {
  S3Client, ListObjectsV2Command, GetObjectCommand,
  PutObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const APLICAR = process.argv.includes('--apply');
const ETAGS = process.argv.includes('--etags');

const REQ = ['ORIGEN_ENDPOINT', 'ORIGEN_BUCKET', 'ORIGEN_KEY', 'ORIGEN_SECRET',
             'DESTINO_ENDPOINT', 'DESTINO_BUCKET', 'DESTINO_KEY', 'DESTINO_SECRET'];
const faltan = REQ.filter((v) => !process.env[v]);
if (faltan.length) { console.error('⛔ faltan variables: ' + faltan.join(', ')); process.exit(1); }

const mk = (e, k, s, r) => new S3Client({
  region: r || 'auto', endpoint: e, forcePathStyle: true,
  credentials: { accessKeyId: k, secretAccessKey: s },
});
const O = mk(process.env.ORIGEN_ENDPOINT, process.env.ORIGEN_KEY, process.env.ORIGEN_SECRET, process.env.ORIGEN_REGION);
const D = mk(process.env.DESTINO_ENDPOINT, process.env.DESTINO_KEY, process.env.DESTINO_SECRET, process.env.DESTINO_REGION);
const BO = process.env.ORIGEN_BUCKET, BD = process.env.DESTINO_BUCKET;

// ⛔ Origen y destino TIENEN que ser distintos. Apuntadas las dos mitades al mismo lugar, esto
//    "copiaría" cada objeto sobre sí mismo y terminaría en verde sin haber movido nada — el
//    mismo éxito silencioso que esta casa persigue en los feeds.
if (process.env.ORIGEN_ENDPOINT === process.env.DESTINO_ENDPOINT && BO === BD) {
  console.error('⛔ origen y destino son el MISMO bucket. No copio.');
  process.exit(1);
}

const limpiar = (e) => String(e || '').replace(/"/g, '');
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

const listar = async (c, b) => {
  let t; const m = new Map();
  do {
    const p = await c.send(new ListObjectsV2Command({ Bucket: b, ContinuationToken: t }));
    for (const o of p.Contents || []) m.set(o.Key, { size: o.Size || 0, etag: limpiar(o.ETag) });
    t = p.IsTruncated ? p.NextContinuationToken : null;
  } while (t);
  return m;
};

(async () => {
  console.log(`  origen : ${BO} @ ${process.env.ORIGEN_ENDPOINT}`);
  console.log(`  destino: ${BD} @ ${process.env.DESTINO_ENDPOINT}`);
  console.log(`  modo   : ${APLICAR ? 'COPIANDO' : 'DRY-RUN (no escribe)'}${ETAGS ? ' · con cotejo de ETag' : ''}\n`);

  const orig = await listar(O, BO);
  let dest = await listar(D, BD);

  let copiados = 0, saltados = 0, fallados = 0, bytesCopiados = 0;
  for (const [k, o] of orig) {
    const d = dest.get(k);
    if (d && d.size === o.size) { saltados++; continue; }
    if (!APLICAR) { copiados++; continue; }
    try {
      const r = await O.send(new GetObjectCommand({ Bucket: BO, Key: k }));
      const buf = Buffer.from(await r.Body.transformToByteArray());
      await D.send(new PutObjectCommand({
        Bucket: BD, Key: k, Body: buf,
        ContentType: r.ContentType || 'application/octet-stream',
      }));
      copiados++; bytesCopiados += buf.length;
    } catch (e) {
      fallados++;
      console.log(`    ⛔ ${k} → ${e.name}: ${e.message.split('\n')[0]}`);
    }
    if ((copiados + saltados) % 100 === 0) {
      console.log(`    … ${copiados + saltados}/${orig.size} (copiados ${copiados}, saltados ${saltados})`);
    }
  }

  // El cuadre LISTA EL DESTINO de verdad en vez de suponer que lo escrito llegó.
  if (APLICAR) dest = await listar(D, BD);
  const bytesO = [...orig.values()].reduce((a, v) => a + v.size, 0);
  const bytesD = [...dest.values()].reduce((a, v) => a + v.size, 0);

  console.log('\n  ── resumen ──');
  console.log(`  origen : ${orig.size} objetos · ${mb(bytesO)}`);
  console.log(`  destino: ${dest.size} objetos · ${mb(bytesD)}`);
  console.log(`  copiados ${copiados} · saltados ${saltados} · fallados ${fallados}`);
  if (APLICAR) console.log(`  transferido en esta corrida: ${mb(bytesCopiados)}`);

  let etagMal = 0;
  if (ETAGS) {
    let ok = 0, multi = 0, ausentes = 0;
    for (const [k, o] of orig) {
      const d = dest.get(k);
      if (!d) { ausentes++; continue; }
      if (o.etag === d.etag) ok++;
      else if (o.etag.includes('-') || d.etag.includes('-')) multi++;
      else { etagMal++; if (etagMal <= 3) console.log(`    ETag distinto: ${k}`); }
    }
    console.log(`  ETag idéntico ${ok} · distinto ${etagMal} · no comparable ${multi} · ausentes ${ausentes}`);
  }

  if (!APLICAR) { console.log('\n  DRY-RUN: no se escribió nada. Corré con --apply.'); process.exit(0); }
  if (fallados > 0) { console.log(`\n  ⛔ ${fallados} objeto(s) fallaron — volvé a correrlo, es idempotente.`); process.exit(1); }
  if (etagMal > 0) { console.log(`\n  ⛔ ${etagMal} objeto(s) con contenido DISTINTO.`); process.exit(1); }
  if (dest.size >= orig.size && bytesD >= bytesO) {
    console.log(`\n  ✓ cuadra${ETAGS ? ' por CONTENIDO (ETag)' : ' por CONTEO Y BYTES (el tamaño no es un hash)'}.`);
    process.exit(0);
  }
  console.log(`\n  ⛔ NO cuadra: faltan ${orig.size - dest.size} objeto(s) y ${mb(bytesO - bytesD)}.`);
  process.exit(1);
})().catch((e) => { console.error('⛔ ' + e.name + ': ' + e.message.split('\n')[0]); process.exit(1); });
