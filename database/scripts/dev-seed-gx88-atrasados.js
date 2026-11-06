'use strict';
/**
 * `[GX.88]` — Datos de PRUEBA para ver «Atrasados» y el buscador de gastos en local.
 *
 * Deja vales en todos los casos que la pantalla distingue, ligados a solicitudes REALES de la
 * copia local de Kepler (así se ven quién la pidió y el concepto):
 *
 *  · HOY sin firmar (2)                         → bandeja de hoy.
 *  · Sin firmar de hace 3 días                  → Atrasados · «te toca».
 *  · Comprobante subido hace 9 días (revision)  → Atrasados · «te toca» revisarlo.
 *  · Aprobado PROVISIONAL hace 15 días          → Atrasados · «espera a quien lo levantó».
 *  · Aprobado sin evidencia hace 6 días         → Atrasados · «espera a quien lo levantó».
 *  · Aprobado CON evidencia hace 2 días         → Atrasados · «te toca» darlo por comprobado.
 *  · Comprobado hace 40 días / rechazado hace 12 → no salen en pestañas: se encuentran con el buscador.
 *
 * Las solicitudes de Kepler que NO se ligan siguen «sin vale»: el buscador las encuentra aparte
 * (prueba «fumigacion», «contabilidad», «rrhh»).
 *
 * ⚠️ Sólo contra una base LOCAL (`assertSafeTarget`). Todo lo que crea lleva
 *    `capture_meta.demo = 'gx88'` y departamento «DEMO GX.88»: se borra con `--limpiar`.
 *    Correrlo dos veces no duplica: primero borra lo suyo.
 *
 * Uso:  node database/scripts/dev-seed-gx88-atrasados.js            (crea / re-crea)
 *       node database/scripts/dev-seed-gx88-atrasados.js --limpiar  (sólo borra lo de demo)
 */
require('dotenv').config({ quiet: true });
const { assertSafeTarget } = require('../tests/_lib/assert-safe-target');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const DB_URL = (process.env.DATABASE_URL_NEW || '').replace('localhost', '127.0.0.1');
const MARCA = 'gx88';
const DEPTO = 'DEMO GX.88';
const LEVANTO = 'demo.capturista';
const APROBO = 'DEMO APROBADOR';
const IMG = (t) => `https://placehold.co/600x800/png?text=${encodeURIComponent(t)}`;
const archivo = (role, t) => ({ role, url: IMG(t), kind: 'image', name: `${t}.png` });

/**
 * Los casos. `hace` = días atrás que se levantó; `folio`/`sucursal` = solicitud real de la copia
 * local de Kepler (se verifica que exista y que no tenga vale antes de usarla).
 */
const CASOS = [
  { caso: 'hoy, sin firmar', hace: 0, status: 'recibida', clasificacion: 'no_comprobable', proveedor: 'FUMIGACIONES DEL BAJIO (demo)',
    files: [archivo('solicitud_kepler', 'Solicitud firmada DEMO')] },
  { caso: 'hoy, sin firmar (2)', hace: 0, status: 'recibida', clasificacion: 'no_comprobable', proveedor: 'BONO INVENTARIO (demo)',
    files: [archivo('solicitud_kepler', 'Solicitud firmada DEMO')] },
  { caso: 'atrasado: sin firmar', hace: 3, status: 'recibida', clasificacion: 'no_comprobable', proveedor: 'COMISIONES RD (demo)',
    files: [archivo('solicitud_kepler', 'Solicitud firmada DEMO')] },
  { caso: 'atrasado: comprobante por revisar', hace: 9, status: 'revision', clasificacion: 'fiscal', proveedor: 'TALLER MOTOS LA PIEDAD (demo)',
    revision_nota: 'Subieron la factura después de aprobar: falta revisarla (demo).', aprobado: true,
    files: [archivo('solicitud_kepler', 'Solicitud DEMO'), archivo('comprobante_1', 'Factura DEMO'), archivo('evidencia_1', 'Foto DEMO')] },
  { caso: 'atrasado: aprobado provisional', hace: 15, status: 'aprobada', clasificacion: 'fiscal', proveedor: 'COMISIONES PERIODO 19 (demo)',
    provisional: true, aprobado: true,
    files: [archivo('solicitud_kepler', 'Solicitud DEMO'), archivo('cotizacion', 'Cotizacion DEMO')] },
  { caso: 'atrasado: aprobado sin evidencia', hace: 6, status: 'aprobada', clasificacion: 'fiscal', proveedor: 'INVENTARIO TRIMESTRAL (demo)',
    aprobado: true, files: [archivo('solicitud_kepler', 'Solicitud DEMO')] },
  { caso: 'atrasado: aprobado con evidencia', hace: 2, status: 'aprobada', clasificacion: 'fiscal', proveedor: 'REPARACION BALATAS (demo)',
    aprobado: true, files: [archivo('solicitud_kepler', 'Solicitud DEMO'), archivo('evidencia_1', 'Ticket DEMO')] },
  { caso: 'cerrado: comprobado', hace: 40, status: 'validada', clasificacion: 'no_comprobable', proveedor: 'COMISIONES CERRADAS (demo)',
    aprobado: true, files: [archivo('solicitud_kepler', 'Solicitud DEMO')] },
  { caso: 'cerrado: rechazado', hace: 12, status: 'rechazada', clasificacion: 'no_comprobable', proveedor: 'BALATAS RECHAZADO (demo)',
    motivo_rechazo: 'Falta el ticket (demo).', files: [archivo('solicitud_kepler', 'Solicitud DEMO')] },
];

(async () => {
  assertSafeTarget('dev-seed-gx88-atrasados', { url: DB_URL });
  const limpiar = process.argv.includes('--limpiar');
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT]);
    await db.query('BEGIN');
    const borrados = await db.query(
      "DELETE FROM finance.expense_proofs WHERE tenant_id = $1 AND capture_meta->>'demo' = $2", [TENANT, MARCA]);
    console.log(`borrados de una corrida anterior: ${borrados.rowCount}`);
    if (limpiar) { await db.query('COMMIT'); console.log('listo: sólo se limpió lo de demo.'); return; }

    // Solicitudes reales de la copia local de Kepler, sin vale todavía, del día más viejo al más nuevo.
    const { rows: libres } = await db.query(`
      SELECT r.sucursal, r.folio, r.importe::numeric AS importe, r.solicitante, to_char(r.fecha,'YYYY-MM-DD') AS fecha
        FROM analytics.expense_requests r
       WHERE r.tenant_id = $1 AND coalesce(btrim(r.estado),'') <> 'C' AND r.solicitante IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM finance.expense_proofs p
                          WHERE p.tenant_id = r.tenant_id AND p.sucursal = r.sucursal AND p.folio_solicitud = r.folio)
       ORDER BY r.fecha, r.sucursal, r.folio`, [TENANT]);
    if (libres.length < CASOS.length) {
      throw new Error(`hacen falta ${CASOS.length} solicitudes de Kepler sin vale en la copia local y hay ${libres.length}`);
    }
    // Se toma una de cada dos: las otras quedan «sin vale» para que el buscador tenga qué encontrar.
    const elegidas = libres.filter((_, i) => i % 2 === 0).slice(0, CASOS.length);
    if (elegidas.length < CASOS.length) elegidas.push(...libres.filter((_, i) => i % 2 === 1).slice(0, CASOS.length - elegidas.length));

    for (const [i, k] of CASOS.entries()) {
      const s = elegidas[i];
      const decidido = k.aprobado || k.status === 'rechazada';
      await db.query(`
        INSERT INTO finance.expense_proofs
          (tenant_id, solicitante, departamento, sucursal, fecha_gasto, folio_solicitud, proveedor, importe, files,
           comentarios, status, clasificacion, forma_pago, provisional, revision_nota, motivo_rechazo,
           created_by, created_at, updated_at, validated_by, validated_at, capture_meta)
        VALUES
          ($1, $2, $3, $4, (now() AT TIME ZONE 'America/Mexico_City')::date - $5::int, $6, $7, $8, $9::jsonb,
           $10, $11, $12, 'efectivo', $13, $14, $15,
           $16, now() - make_interval(days => $5::int), now(), $17,
           CASE WHEN $18::boolean THEN now() - make_interval(days => $5::int) + interval '1 hour' END, $19::jsonb)`,
        [TENANT, s.solicitante, DEPTO, s.sucursal, k.hace, s.folio, k.proveedor, s.importe, JSON.stringify(k.files),
          `[DEMO GX.88] ${k.caso}`, k.status, k.clasificacion, k.provisional === true, k.revision_nota ?? null, k.motivo_rechazo ?? null,
          LEVANTO, decidido ? APROBO : null, decidido, JSON.stringify({ demo: MARCA, caso: k.caso })]);
      console.log(`  ${k.caso.padEnd(36)} ${s.sucursal}-${s.folio}  hace ${String(k.hace).padStart(2)} d  ${k.status}`);
    }
    await db.query('COMMIT');
    const quedan = libres.length - CASOS.length;
    console.log(`listo: ${CASOS.length} vales de demo. Quedan ${quedan} solicitudes de Kepler sin vale para el buscador.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
