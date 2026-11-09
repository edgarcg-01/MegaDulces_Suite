'use strict';
/**
 * `[GX.91]`–`[GX.97]` **Datos de demo para probar «Mis gastos» v2 en LOCAL.** Uno de cada caso que
 * midió la auditoría del 2026-11-05 (ver docs/MODULOS/finanzas-mis-gastos-v2.md).
 *
 *   node database/scripts/dev-seed-gx91-mis-gastos.js --usuario <username>   crea (o re-crea)
 *   node database/scripts/dev-seed-gx91-mis-gastos.js --limpiar                 borra todo lo suyo
 *
 * ⛔ Sólo contra un destino seguro (`assertSafeTarget`): escribe vales Y filas de `kepler_ods.kdm1`
 * (la copia local de Kepler). Las de Kepler van en un rango de folios propio (`099xxxx`, sucursal 00):
 * si ese rango ya tiene filas que este script no creó, se niega en vez de pisarlas.
 * Idempotente: cada corrida borra lo de la anterior antes de crear.
 *
 * El usuario es el que firma los vales en la API local: `full_name || username` del token. En la
 * base local no hay nombre completo, así que es el username. Se pide: `--usuario <tu usuario local>`
 * (o la variable `DEV_SEED_USUARIO`). Sin él no hace nada: el repo es público y no lleva usuarios reales.
 */
require('dotenv').config({ quiet: true });
const { assertSafeTarget } = require('../tests/_lib/assert-safe-target');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const DB_URL = (process.env.DATABASE_URL_NEW || '').replace('localhost', '127.0.0.1');
const MARCA = 'gx91';
const SUC = '00';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const USUARIO = arg('--usuario') || process.env.DEV_SEED_USUARIO || '';
if (!USUARIO && !process.argv.includes('--limpiar')) {
  console.error('Falta --usuario <tu usuario local> (o DEV_SEED_USUARIO): los vales se crean a su nombre.');
  process.exit(1);
}
const APROBO = 'DEMO APROBADOR';
const IMG = (t) => `https://placehold.co/600x800/png?text=${encodeURIComponent(t)}`;
const archivo = (role, t) => ({ role, url: IMG(t), kind: 'image', name: `${t}.png` });

/**
 * Cada caso: la solicitud de Kepler (estado y si tiene gasto) y el vale de la Suite (o ninguno).
 *  · `kepler`: estado de la solicitud XA15 (N/A/F/C) · `gasto`: 'vivo' | 'cancelado' | null
 *  · `vale`: estado del vale, o null (= asignado, sin vale) · `hace`: días atrás del vale/solicitud
 */
const CASOS = [
  { caso: 'te toca: devuelto con la solicitud viva', folio: '0990001', kepler: 'A', gasto: null, vale: 'rechazada', hace: 3,
    motivo: 'Falta el ticket del gasto (demo).', espera: 'Te toca · «Te lo devolvieron…» (antes: oculto a las 24 h)' },
  { caso: 'oculto: devuelto y Kepler canceló', folio: '0990002', kepler: 'C', gasto: null, vale: 'rechazada', hace: 3,
    motivo: 'Duplicado (demo).', espera: 'NO aparece (Kepler canceló la solicitud)' },
  { caso: 'oculto: devuelto y recapturado', folio: '0990003', kepler: 'A', gasto: null, vale: 'rechazada', hace: 4,
    motivo: 'Foto ilegible (demo).', recaptura: true, espera: 'el rechazado NO aparece; el nuevo, en «Esperan a Finanzas»' },
  { caso: 'te toca: aprobado que debe la factura', folio: '0990004', kepler: 'A', gasto: null, vale: 'aprobada', hace: 10,
    provisional: true, espera: 'Te toca · «Te toca subir la factura del pago»' },
  { caso: 'Finanzas: recién mandado', folio: '0990005', kepler: 'N', gasto: null, vale: 'recibida', hace: 0,
    espera: 'Esperan a Finanzas · «Espera «Revisado» de Finanzas»' },
  { caso: 'Kepler: autorizada sin gasto (atorado)', folio: '0990006', kepler: 'A', gasto: null, vale: 'validada', hace: 40,
    espera: 'Esperan a Kepler · «Autorizada: falta generar el gasto» · atorado' },
  { caso: 'Kepler: sin autorizar', folio: '0990007', kepler: 'N', gasto: null, vale: 'validada', hace: 5,
    espera: 'Esperan a Kepler · «Falta que la autoricen en Kepler»' },
  { caso: 'cerrado: cancelada en Kepler', folio: '0990008', kepler: 'C', gasto: null, vale: 'validada', hace: 20,
    espera: 'Cerrados · «Solicitud cancelada en Kepler» (antes: atorado para siempre)' },
  { caso: 'cerrado + HALLAZGO: cancelada con gasto', folio: '0990009', kepler: 'C', gasto: 'cancelado', vale: 'validada', hace: 25,
    espera: 'Cerrados en Mis gastos · en Aprobación › Esperan a Kepler: «¿salió dinero?»' },
  { caso: 'cerrado: gasto aplicado', folio: '0990010', kepler: 'A', gasto: 'vivo', vale: 'validada', hace: 30,
    espera: 'Cerrados · «Gasto aplicado en Kepler» · XA1001-0995010' },
  { caso: 'te toca: asignado sin vale', folio: '0990011', kepler: 'A', gasto: null, vale: null, hace: 2,
    espera: 'Te toca · «Falta que subas la evidencia» (sin abrir visor)' },
  { caso: 'oculto: asignado de antes del arranque', folio: '0990012', kepler: 'A', gasto: null, vale: null, fechaFija: '2025-01-02',
    espera: 'NO aparece (es de antes de que existiera la Suite)' },
  { caso: 'para probar el doble clic en la captura', folio: '0990013', kepler: 'N', gasto: null, vale: null, hace: 0, otraPersona: true,
    espera: 'captúrala en /finanzas/gastos con doble clic: debe quedar UN vale' },
  // ── [GX.98]–[GX.100] Para APROBAR: levantados por OTRA persona (quien levantó un vale no lo aprueba,
  //    [GX.65.4a]), de hoy, con sus departamentos de Kepler (kdm6 → kdc3). Uno repartido entre dos.
  { caso: 'aprobar: repartido Morelia/Canindo', folio: '0990020', kepler: 'A', gasto: null, vale: 'recibida', hace: 0,
    levanto: 'demo.capturista', importe: 1250, proveedor: 'PAPELERIA DEL CENTRO (demo)', deps: [['1-02-30-00', 646.55], ['1-03-50-00', 431.03]],
    espera: 'Aprobación › Bandeja de hoy · «MORELIA ABASTOS y 1 más»; elegir MORELIA: «$750 de $1,250»' },
  { caso: 'aprobar: logística', folio: '0990021', kepler: 'A', gasto: null, vale: 'recibida', hace: 0,
    levanto: 'demo.capturista', importe: 3400, proveedor: 'COMBUSTIBLES LA PIEDAD (demo)', deps: [['1-08-12-00', 3400]],
    espera: 'Aprobación › Bandeja de hoy · LOGISTICA GENERAL · con «Revisado»' },
  { caso: 'aprobar: sistemas', folio: '0990022', kepler: 'A', gasto: null, vale: 'recibida', hace: 0,
    levanto: 'demo.capturista', importe: 2150, proveedor: 'COMPUTO OCCIDENTE (demo)', deps: [['1-09-01', 2150]],
    espera: 'Aprobación › Bandeja de hoy · SISTEMAS' },
  { caso: 'aprobar: sin departamento en Kepler', folio: '0990023', kepler: 'A', gasto: null, vale: 'recibida', hace: 0,
    levanto: 'demo.capturista', importe: 450, proveedor: 'FERRETERIA LA ESQUINA (demo)', deps: [],
    espera: 'Aprobación › Bandeja de hoy · «Sin departamento en Kepler»' },
  { caso: 'aprobar: atrasado de logística', folio: '0990024', kepler: 'A', gasto: null, vale: 'recibida', hace: 4,
    levanto: 'demo.capturista', importe: 1800, proveedor: 'TALLER MOTOS LA PIEDAD (demo)', deps: [['1-08-12-00', 1800]],
    espera: 'Aprobación › Atrasados · LOGISTICA GENERAL · 4 días' },
];

/** `[GX.98]` Los nombres de los departamentos de demo (`kdc3` vacío en local). Marca en `c15`. */
const DEPTOS = [
  ['1-02-30-00', 'MORELIA ABASTOS.'], ['1-03-50-00', 'CANINDO .'], ['1-08-12-00', 'LOGISTICA GENERAL.'], ['1-09-01', 'SISTEMAS.'],
];
const PDF_DEMO = 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';

const FOLIOS = CASOS.map((k) => k.folio);
const gastoDe = (folio) => `0995${folio.slice(-3)}`;

(async () => {
  assertSafeTarget('dev-seed-gx91-mis-gastos', { url: DB_URL });
  const limpiar = process.argv.includes('--limpiar');
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT]);
    await db.query('BEGIN');

    // ¿El rango de Kepler está libre o es nuestro? Lo nuestro lleva el concepto con la marca.
    const { rows: ajenas } = await db.query(`
      SELECT c4::text AS tipo, btrim(c6) AS folio FROM kepler_ods.kdm1
       WHERE sucursal = $1 AND c2 = 'X' AND c3 = 'A' AND btrim(c4::text) IN ('10', '15')
         AND (btrim(c6) = ANY($2) OR btrim(c6) = ANY($3))
         AND coalesce(c24, '') NOT LIKE '%[demo ' || $4 || ']%'`,
      [SUC, FOLIOS, FOLIOS.map(gastoDe), MARCA]);
    if (ajenas.length) throw new Error(`el rango de folios demo ya tiene ${ajenas.length} fila(s) de Kepler que no son de este script; no se pisan`);

    const v = await db.query(
      "DELETE FROM finance.expense_proofs WHERE tenant_id = $1 AND (capture_meta->>'demo' = $2 OR (sucursal = $3 AND folio_solicitud = ANY($4)))",
      [TENANT, MARCA, SUC, FOLIOS]);
    const k = await db.query(`
      DELETE FROM kepler_ods.kdm1 WHERE sucursal = $1 AND c2 = 'X' AND c3 = 'A' AND btrim(c4::text) IN ('10', '15')
         AND coalesce(c24, '') LIKE '%[demo ' || $2 || ']%'`, [SUC, MARCA]);
    const k6 = await db.query(`DELETE FROM kepler_ods.kdm6 WHERE sucursal = $1 AND coalesce(c9, '') LIKE '%[demo ' || $2 || ']%'`, [SUC, MARCA]);
    const k3 = await db.query(`DELETE FROM kepler_ods.kdc3 WHERE sucursal = $1 AND c15 = $2`, [SUC, `[demo ${MARCA}]`]);
    console.log(`borrados de una corrida anterior: ${v.rowCount} vale(s), ${k.rowCount} fila(s) de Kepler, ${k6.rowCount} renglón(es) y ${k3.rowCount} departamento(s) de demo`);
    if (limpiar) { await db.query('COMMIT'); console.log('listo: sólo se limpió lo de demo.'); return; }

    for (const [clave, nombre] of DEPTOS) {
      await db.query(`INSERT INTO kepler_ods.kdc3 (sucursal, c1, c2, c15) VALUES ($1, $2, $3, $4) ON CONFLICT (sucursal, c1) DO NOTHING`,
        [SUC, clave, nombre, `[demo ${MARCA}]`]);
    }
    const solicitanteKepler = USUARIO.toUpperCase();
    for (const [i, c] of CASOS.entries()) {
      const fecha = c.fechaFija ? `('${c.fechaFija}'::timestamp)` : `((now() AT TIME ZONE 'America/Mexico_City')::date - ${Number(c.hace) | 0})`;
      const importe = c.importe ?? 500 + i * 125.5;
      const levanto = c.levanto ?? USUARIO;
      const proveedor = c.proveedor ?? `PROVEEDOR DEMO ${i + 1}`;
      const concepto = `${c.caso} [demo ${MARCA}]`;
      // La solicitud XA15: lo que la vista analytics.expense_requests lee (c1 = sucursal, c48 = quien la pide).
      await db.query(`
        INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16, c24, c32, c43, c48)
        VALUES ($1, $1, 'X', 'A', 15, 1, $2, ${fecha}, $3, $4, $5, $6, $7)`,
        [SUC, c.folio, importe, concepto, proveedor, c.kepler, c.otraPersona ? 'OTRA_PERSONA_DEMO' : levanto.toUpperCase()]);
      // `[GX.98]` Los renglones de la solicitud con su departamento (kdm6.c16). El texto lleva la marca.
      for (const [j, [dep, imp]] of (c.deps ?? []).entries()) {
        await db.query(`
          INSERT INTO kepler_ods.kdm6 (sucursal, c1, c2, c3, c4, c5, c6, c7, c9, c11, c16)
          VALUES ($1, $1, 'X', 'A', 15, 1, $2, $3, $4, $5, $6)`,
          [SUC, c.folio, j + 1, `renglón ${j + 1} [demo ${MARCA}]`, imp, dep]);
      }
      // El gasto XA10 que apunta a la solicitud (c39). Cancelado = c43 'C': cuenta como «aplicada»
      // en la vista de solicitudes, pero no como gasto vivo en analytics.expense_documents.
      if (c.gasto) {
        await db.query(`
          INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16, c24, c39, c43)
          VALUES ($1, $1, 'X', 'A', 10, 1, $2, ${fecha}, $3, $4, $5, $6)`,
          [SUC, gastoDe(c.folio), importe, `gasto de ${concepto}`, c.folio, c.gasto === 'cancelado' ? 'C' : null]);
      }
      if (c.vale) {
        const decidido = c.vale !== 'recibida';
        await db.query(`
          INSERT INTO finance.expense_proofs
            (tenant_id, solicitante, departamento, sucursal, fecha_gasto, folio_solicitud, proveedor, importe, files,
             comentarios, status, clasificacion, forma_pago, provisional, motivo_rechazo,
             created_by, created_at, updated_at, validated_by, validated_at, capture_meta)
          VALUES ($1, $2, 'DEMO GX.91', $3, ${fecha}::date, $4, $5, $6, $7::jsonb,
                  $8, $9, 'no_comprobable', 'efectivo', $10, $11,
                  $12, now() - make_interval(days => $13::int), now(), $14,
                  CASE WHEN $15::boolean THEN now() - make_interval(days => $13::int) + interval '1 hour' END, $16::jsonb)`,
          [TENANT, levanto.toUpperCase(), SUC, c.folio, proveedor, importe,
            JSON.stringify(c.levanto
              ? [archivo('comprobante_1', `Vale DEMO ${c.folio}`),
                  { role: 'cotizacion', url: PDF_DEMO, kind: 'pdf', name: 'cotizacion-demo.pdf' },
                  { ...archivo('adicional', `Ticket DEMO ${c.folio}`), motivo: 'Llegó el ticket del proveedor (demo)', agregado_por: levanto, agregado_at: new Date().toISOString() }]
              : [archivo('comprobante_1', `Vale DEMO ${c.folio}`)]),
            concepto, c.vale, c.provisional === true, c.motivo ?? null,
            levanto, Number(c.hace) | 0, decidido ? APROBO : null, decidido, JSON.stringify({ demo: MARCA, caso: c.caso })]);
        if (c.recaptura) {
          await db.query(`
            INSERT INTO finance.expense_proofs
              (tenant_id, solicitante, departamento, sucursal, fecha_gasto, folio_solicitud, proveedor, importe, files,
               comentarios, status, clasificacion, forma_pago, created_by, created_at, updated_at, capture_meta)
            VALUES ($1, $2, 'DEMO GX.91', $3, ${fecha}::date, $4, $5, $6, $7::jsonb, $8, 'recibida', 'no_comprobable', 'efectivo',
                    $9, now(), now(), $10::jsonb)`,
            [TENANT, solicitanteKepler, SUC, c.folio, `PROVEEDOR DEMO ${i + 1}`, importe,
              JSON.stringify([archivo('comprobante_1', `Vale DEMO ${c.folio} (recaptura)`)]),
              `${concepto} (recaptura)`, USUARIO, JSON.stringify({ demo: MARCA, caso: `${c.caso} (recaptura)` })]);
        }
      }
      console.log(`  ${SUC}-${c.folio}  ${c.caso.padEnd(44)} → ${c.espera}`);
    }
    await db.query('COMMIT');
    console.log(`listo: ${CASOS.length} casos para «${USUARIO}». Reinicia la API local si estaba vieja y entra a /finanzas/mis-gastos.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
