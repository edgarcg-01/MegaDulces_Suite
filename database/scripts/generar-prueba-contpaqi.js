#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.24]` — **Los dos archivos de prueba para la contadora.**
 *
 * ── Por qué DOS y no uno ────────────────────────────────────────────────────────────────────
 * El minuto de la contadora tiene que contestar **tres** preguntas, y un solo archivo las
 * confunde: si falla, no se sabe cuál falló.
 *
 *   A · `prueba-A-formato.txt`     P + 2 renglones M1.         ¿Acepta ContPAQi nuestro formato?
 *                                                              ¿Respeta el `Guid` que mandamos?
 *   B · `prueba-B-con-ad.txt`      lo mismo + un renglón `AD`.  ¿Se pueden prender los `AD`?
 *
 * ⭐ Si A entra y B no, el problema es el `AD` y no el layout. Si A no entra, B ni se prueba.
 * *No se confunden las variables.*
 *
 * ── ⭐⭐ La forma salió del archivo REAL, no de foros ────────────────────────────────────────
 * Medido sobre la exportación real de ContPAQi (`poliza-contpaqi-real-2026-09.txt`): su **primera
 * póliza es exactamente `P M1 M1 M1 AD`** — sin `AM`, sin `AP`, sin `I`/`W2`/`V`.
 *
 * Eso contesta de paso lo que §10.5 dejó abierto: **esos renglones NO son obligatorios.**
 *
 * ⛔ Y corrige a la fuente externa: §9.1 decía que el `AD` va *"después del `P`"*. **En el archivo
 * real va al FINAL de la póliza**, después de todos los `M1`. Las 14 pólizas lo confirman, y los
 * 62 renglones `AD` miden 40 caracteres exactos.
 *
 * ── Lo que el archivo contiene, y por qué así ───────────────────────────────────────────────
 * · **$1.00**, para que no mueva nada. El objetivo es el FORMATO, no el saldo.
 * · Cuentas **reales y afectables** leídas de `analytics.contpaqi_accounts` — una póliza con una
 *   cuenta inventada se rechazaría por la cuenta y no probaría nada del layout.
 * · El **concepto dice BORRAR** y lleva el token del puente, que es justo lo que hay que mirar.
 * · El `Guid` lo mandamos nosotros: **si ContPAQi lo conserva, el puente tiene llave estructural**
 *   y el token en el concepto pasa a ser de respaldo.
 *
 * ⚠️ **La póliza se borra después.** Borrarla deshace también la asociación del CFDI del archivo B.
 *
 * READ-ONLY sobre las bases. Escribe sólo los dos .txt en el directorio que se le indique.
 *
 *   node database/scripts/generar-prueba-contpaqi.js --out <carpeta>
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const LIB = path.resolve(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib');
const { parsearTxt } = require(path.join(LIB, 'purchase-book', 'poliza-txt.ts'));
const { tokenDe } = require(path.join(LIB, 'contpaqi', 'token.ts'));
/**
 * ⛔⛔ **El archivo sale del SINK, no de `construirTxt`.**
 *
 * La primera versión de este script llamaba a `construirTxt` directo y emitió la fecha como
 * **`2026-10-`** — el campo mide 8 y `YYYY-MM-DD` mide 10, así que se recortó. El archivo real
 * dice `20260901`. Habría llegado a la contadora con una fecha basura.
 *
 * ⭐ El sink **sí** hace la conversión (exige `YYYY-MM-DD`, la pasa a `yyyyMMdd` por posición y
 * rechaza con `fecha_invalida` si no cumple). Saltármelo fue el error: *el archivo de prueba
 * tiene que salir del MISMO camino que usará el puente, o no prueba el puente.*
 */
const { ContpaqiTxtSinkAdapter } = require(path.join(LIB, 'contpaqi', 'txt-sink.adapter.ts'));
const { Client } = require('pg');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const OUT = arg('out', path.join(process.env.TEMP || '/tmp', 'contpaqi-prueba'));
const FECHA = arg('fecha', new Date().toISOString().slice(0, 10));
const TIPO_POLIZA_EGRESO = '2';

/** `AD ` + UUID(36) + espacio = 40. Medido en los 62 renglones del archivo real. */
const lineaAD = (uuid) => {
  const u = String(uuid).trim();
  if (u.length !== 36) throw new Error(`el UUID debe medir 36, mide ${u.length}: ${u}`);
  const l = `AD ${u} `;
  if (l.length !== 40) throw new Error(`la línea AD debe medir 40, mide ${l.length}`);
  return l;
};

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await pg.connect();

  // Una cuenta de banco REAL que el crosswalk de CP.2 ya enlazó, y una de gasto REAL.
  // `afectable` porque una cuenta de acumulación no admite movimientos: se rechazaría por eso
  // y no por el layout, que es lo que se quiere probar.
  const { rows: banco } = await pg.query(
    `SELECT a.codigo, a.nombre FROM analytics.contpaqi_accounts a
      WHERE a.codigo LIKE '102%' AND a.afectable = 1 AND coalesce(a.es_baja,false) = false
        AND EXISTS (SELECT 1 FROM finance.bank_accounts b WHERE b.contpaqi_cuenta = a.codigo)
      ORDER BY a.codigo LIMIT 1`);
  // ⚠️ Se prefiere una cuenta NEUTRA (`VARIOS` / `NO DEDUCIBLES`). La primera versión tomaba la
  // primera alfabética y salió `SUELDOS` — una prueba de $1 en sueldos se ve como un error de
  // nómina a quien la revise, y el punto es que la póliza sea obviamente una prueba.
  const { rows: gasto } = await pg.query(
    `SELECT codigo, nombre FROM analytics.contpaqi_accounts
      WHERE codigo LIKE '52%' AND afectable = 1 AND coalesce(es_baja,false) = false
      ORDER BY CASE codigo WHEN '5200800000' THEN 0 WHEN '5201000000' THEN 1 ELSE 2 END, codigo
      LIMIT 1`);
  const { rows: cfdi } = await pg.query(
    `SELECT upper(uuid) uuid, emisor_nombre, total
       FROM fiscal.cfdis
      WHERE uuid IS NOT NULL AND length(uuid) = 36 AND fecha >= date '2026-01-01'
      ORDER BY fecha DESC LIMIT 1`);
  await pg.end();

  if (!banco.length || !gasto.length) throw new Error('no se encontró cuenta de banco o de gasto afectable');
  if (!cfdi.length) throw new Error('no se encontró un CFDI con UUID de 36');

  const token = tokenDe('prueba_formato', `${FECHA}-A`);
  const concepto = 'PRUEBA DE FORMATO PUENTE SUITE - BORRAR DESPUES';

  const sink = new ContpaqiTxtSinkAdapter();
  const r = await sink.entregar({
    evento_tipo: 'prueba_formato',
    evento_id: `${FECHA}-A`,
    tipo_poliza: Number(TIPO_POLIZA_EGRESO),
    fecha: FECHA,
    concepto,
    token,
    total: 1,
    movimientos: [
      { cuenta: gasto[0].codigo, abono: false, importe: 1, concepto, referencia: 'PRUEBA' },
      { cuenta: banco[0].codigo, abono: true, importe: 1, concepto, referencia: 'PRUEBA' },
    ],
  });
  // ⛔ Si el sink la rechaza, NO se entrega un archivo "casi bien": el motivo es el resultado.
  if (r.estado !== 'entregada' || !r.archivo) {
    throw new Error(`el sink rechazó el asiento de prueba: ${r.motivo || '(sin motivo)'}`);
  }
  const A = r.archivo.contenido;
  const B = A.replace(/\r\n$/, '') + '\r\n' + lineaAD(cfdi[0].uuid) + '\r\n';

  // ⛔ Compuerta antes de entregar: lo que se emite tiene que poder leerse de vuelta con el
  // MISMO parser que lee los archivos reales. Si no, no se entrega.
  for (const [nombre, txt] of [['A', A], ['B', B]]) {
    const p = parsearTxt(txt);
    const n = Array.isArray(p) ? p.length : (p && p.movimientos ? p.movimientos.length : 0);
    if (!n) throw new Error(`el archivo ${nombre} no se pudo releer con parsearTxt`);
  }
  const anchos = A.split('\r\n').filter(Boolean).map((l) => l.length);
  const anchosB = B.split('\r\n').filter(Boolean).map((l) => l.length);

  fs.mkdirSync(OUT, { recursive: true });
  const fA = path.join(OUT, 'prueba-A-formato.txt');
  const fB = path.join(OUT, 'prueba-B-con-ad.txt');
  fs.writeFileSync(fA, A, 'latin1');
  fs.writeFileSync(fB, B, 'latin1');

  console.log(`\n[CP.8.24] archivos de prueba para ContPAQi · fecha ${FECHA}`);
  console.log(`  cargo : ${gasto[0].codigo} ${String(gasto[0].nombre).trim()}`);
  console.log(`  abono : ${banco[0].codigo} ${String(banco[0].nombre).trim()}`);
  console.log(`  importe: $1.00  ·  tipo de poliza: 2 (Egreso)  ·  folio: 0 (lo asigna ContPAQi)`);
  console.log(`  Guid: lo asigna el sink (ver el archivo)`);
  console.log(`  token en el concepto: ${token}`);
  console.log(`  UUID del AD (solo archivo B): ${cfdi[0].uuid}  [${String(cfdi[0].emisor_nombre || '').trim()}]`);
  console.log(`\n  A → ${fA}   (${anchos.length} lineas, anchos ${anchos.join('/')})`);
  console.log(`  B → ${fB}   (${anchosB.length} lineas, anchos ${anchosB.join('/')})`);
  console.log('\n  ✓ los dos se releyeron con el parser que lee los archivos reales');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
