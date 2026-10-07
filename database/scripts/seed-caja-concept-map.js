/* eslint-disable no-console */
/**
 * CG.10b — siembra la LISTA DE TRABAJO del mapa cuenta-de-caja → concepto de Kepler.
 *
 * ── Lo que este script NO hace, y por qué ──────────────────────────────────────────────────────
 *
 * **No propone el concepto.** La tentación era derivarlo, y se investigó a fondo antes de
 * descartarlo:
 *
 *   · `Doctos.ConceptoD` parecía el gancho al concepto de Kepler. **No lo es.** Medido sobre las
 *     116,503 filas (2008→2026): tiene **3 valores distintos en 18 años** —`1` (×14,858), `4`
 *     (×1,098) y `2` (×39)— contra los **2,645 conceptos** del catálogo de Kepler. Es una bandera
 *     de tres estados, no una llave foránea. Su uso además se apagó solo: 31% de las filas en 2018,
 *     **0.7% en 2026**.
 *   · El TEXTO tampoco alcanza. Los textos más repetidos de 2026 (`G JOSE LEONARDO LOGISTICA`
 *     ×231, `MORELIA DEL DIA 03-01-2026` ×110) aparecen repartidos en **12 a 19 cuentas
 *     distintas** cada uno → el texto no determina la cuenta, y menos el concepto.
 *
 * O sea: **nadie hizo nunca ese mapeo**, y no hay de dónde derivarlo. Inventarlo pondría conceptos
 * equivocados en la contabilidad, que es exactamente el daño que ADR-070 viene a evitar. Entonces
 * se siembra la PREGUNTA, no una respuesta fabricada: cada cuenta entra con
 * `kepler_cuenta`/`kepler_concepto` en **NULL** (el CHECK de la tabla obliga a que los dos sean
 * nulos o los dos llenos) y con su `support` real, para que Finanzas vea **por dónde empezar**.
 *
 * ── Por qué eso ya es valor ────────────────────────────────────────────────────────────────────
 *
 * La tabla estaba en **0 filas**: nadie podía decir cuánto faltaba. Medido en el corpus real,
 * **72 de 122 cuentas tuvieron movimiento en 2026 y las 20 más grandes son el 97.9% del dinero**
 * — o sea que el trabajo no son 122 decisiones, son ~20 que importan. `finance.v_caja_concept_map_coverage`
 * lo publica, y el autorrelleno empieza a servir en cuanto se confirma la primera.
 *
 * Idempotente. **Nunca pisa una fila confirmada** (`confirmed_at IS NOT NULL`): eso es trabajo
 * humano y sólo se le refresca el `support`.
 *
 *   node database/scripts/seed-caja-concept-map.js              # dry-run
 *   node database/scripts/seed-caja-concept-map.js --apply
 *   node database/scripts/seed-caja-concept-map.js --apply --desde=2025-01-01
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const M = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const DESDE = (process.argv.find((a) => a.startsWith('--desde=')) || '').split('=')[1] || '2026-01-01';
const CAJA = (process.argv.find((a) => a.startsWith('--caja=')) || '').split('=')[1] || '20';
const URL = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;

(async () => {
  if (!URL) throw new Error('falta DATABASE_URL_NEW');
  const c = new Client({ connectionString: URL, statement_timeout: 180000 });
  await c.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [M]);

    const ods = await c.query(`SELECT to_regclass('caja_general_ods.cuenta') t`);
    if (!ods.rows[0].t) throw new Error('no existe caja_general_ods.cuenta — corré primero el shipper');

    // El catálogo de la caja + cuánto pesa cada cuenta de verdad. El `support` es el número de
    // movimientos: es lo que ordena la lista de trabajo, y es medido, no estimado.
    const filas = await c.query(`
      SELECT ct.idcuenta::text                         AS legacy_cuenta,
             NULLIF(btrim(ct.nombrecuenta), '')        AS legacy_nombre,
             coalesce(m.movs, 0)::int                  AS support,
             coalesce(m.monto, 0)::numeric             AS monto
        FROM caja_general_ods.cuenta ct
        LEFT JOIN (
          SELECT cuenta::text AS c, count(*)::int AS movs,
                 sum(coalesce(ingreso,0) + coalesce(gasto,0) + coalesce(deposito,0))::numeric AS monto
            FROM caja_general_ods.doctos
           WHERE source_caja = $1 AND fecha >= $2
           GROUP BY 1) m ON m.c = ct.idcuenta::text
       WHERE ct.source_caja = $1
       ORDER BY coalesce(m.monto, 0) DESC`, [CAJA, DESDE]);

    const conMov = filas.rows.filter((r) => r.support > 0);
    const total = conMov.reduce((a, r) => a + Number(r.monto), 0);
    const top20 = conMov.slice(0, 20).reduce((a, r) => a + Number(r.monto), 0);

    console.log(`=== CG.10b siembra del mapa de conceptos (${APPLY ? 'APPLY' : 'DRY-RUN'}) · caja ${CAJA} · desde ${DESDE} ===\n`);
    console.log(`  ${filas.rowCount} cuentas en el catálogo · ${conMov.length} con movimiento`);
    console.log(`  las 20 más grandes son el ${total ? (top20 / total * 100).toFixed(1) : '0.0'}% del dinero`
      + ` → el trabajo real son ~20 decisiones, no ${filas.rowCount}\n`);

    if (!APPLY) {
      console.log('  top 10 que Finanzas tendría que resolver primero:');
      for (const r of conMov.slice(0, 10)) {
        console.log(`    ${r.legacy_cuenta.padStart(9)}  ${String(r.legacy_nombre || '(sin nombre)').slice(0, 36).padEnd(36)}`
          + `  ${String(r.support).padStart(5)} movs  $${Number(r.monto).toLocaleString('es-MX', { maximumFractionDigits: 0 })}`);
      }
      console.log('\n  (dry-run: no se escribió nada. Agregá --apply)');
      return;
    }

    let nuevas = 0; let refrescadas = 0; let protegidas = 0;
    for (const r of filas.rows) {
      // ⛔ Una fila CONFIRMADA es trabajo humano: sólo se le refresca el peso, jamás el concepto.
      const res = await c.query(`
        INSERT INTO finance.caja_kepler_concept_map
               (tenant_id, source_caja, legacy_cuenta, legacy_nombre, support, source)
        VALUES ($1, $2, $3, $4, $5, 'derivado')
        ON CONFLICT (tenant_id, source_caja, legacy_cuenta, COALESCE(sucursal, ''))
        DO UPDATE SET legacy_nombre = excluded.legacy_nombre,
                      support       = excluded.support,
                      updated_at    = now()
          WHERE finance.caja_kepler_concept_map.legacy_nombre IS DISTINCT FROM excluded.legacy_nombre
             OR finance.caja_kepler_concept_map.support       IS DISTINCT FROM excluded.support
        RETURNING (xmax = 0) AS insertada, confirmed_at`,
      [M, CAJA, r.legacy_cuenta, r.legacy_nombre, r.support]);
      if (!res.rowCount) { protegidas++; continue; }
      if (res.rows[0].insertada) nuevas++; else refrescadas++;
    }
    console.log(`  ${nuevas} nuevas · ${refrescadas} refrescadas · ${protegidas} sin cambio\n`);

    const cov = await c.query(`SELECT * FROM finance.v_caja_concept_map_coverage`);
    for (const r of cov.rows) {
      console.log(`  COBERTURA caja ${r.source_caja}: ${r.cuentas} cuentas · ${r.con_propuesta} con propuesta`
        + ` · ${r.sin_propuesta} SIN concepto · ${r.confirmadas} confirmadas · ${r.por_confirmar} por confirmar`);
    }
    console.log('\n  El autorrelleno propone en cuanto se confirme la primera. Hoy propone NADA, y eso');
    console.log('  es correcto: no hay de dónde derivar el concepto (ver la cabecera de este archivo).');
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => { console.error('\n💥', e.message); process.exitCode = 1; });
