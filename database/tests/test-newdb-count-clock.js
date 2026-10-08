'use strict';
/**
 * [IC.16] Candado del RELOJ de la cadencia — `analytics.v_count_clock`.
 *
 *   node database/tests/test-newdb-count-clock.js
 *
 * Sólo lee.
 *
 * ── Qué arregla, y por qué estas aserciones ──────────────────────────────────────────────
 *
 * `cycleDue()` sacaba `last_counted_at` de `MAX(reconciled_at)` de folios `reconciled`, y en
 * prod hay CERO. O sea que todo el catálogo salía NULL, el `dueExpr` daba verdadero siempre y
 * **el 100% figuraba vencido, para siempre**. Una pantalla que grita «39,480 pendientes» no
 * prioriza: enseña a ignorarla.
 *
 * ⛔ El bug de fondo era FUNDIR DOS AUSENCIAS: «nunca se contó» y «se contó y venció» se
 * escribían igual (NULL) y se mostraban igual, cuando piden acciones distintas — arrancar
 * contra volver (ADR-056).
 *
 * ⭐ Y lo que lo destraba no fue contar más, sino MIRAR lo que ya estaba: el físico de Kepler
 * tiene fechas reales (sep-2026) para el 48–87% de los SKUs según el almacén. *El dato existía;
 * el reloj no lo miraba.*
 *
 * Las aserciones son las formas de volver a romperlo sin que se note:
 *  (1) que `nunca_contado` se funda otra vez con `vencido`
 *  (2) que la rejilla deje de ser completa — si sólo emitiera filas CON historia, un SKU sin
 *      contar llegaría ausente a un LEFT JOIN, saldría NULL y **se leería como sano**
 *  (3) que el **diario** empiece a decir «vencido», inventando una cadencia por SKU que nadie
 *      definió (su regla es cupo por sucursal, `[IC.18]`)
 *  (4) que la fuente de la fecha deje de declararse: folio propio y Kepler NO son lo mismo
 */

const path = require('path');
const knexLib = require('knex');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

let ok = 0; let bad = 0; let nm = 0;
const t = (label, cond, detalle) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); } else { bad++; console.log(`  ✗ ${label}${detalle ? ` — ${detalle}` : ''}`); }
};
const noMedido = (label, porque) => { nm++; console.log(`  ⓘ NO MEDIDO: ${label} — ${porque}`); };

const ESTADOS = ['nunca_contado', 'al_dia', 'vencido', 'sin_cadencia'];

(async () => {
  const url = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: {
      connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false },
      statement_timeout: 120000,
    },
    pool: { min: 1, max: 1 },
  });

  console.log('\n=== [IC.16] el reloj de la cadencia, por ritmo ===\n');

  try {
    const [{ existe }] = (await db.raw(
      `SELECT to_regclass('analytics.v_count_clock') IS NOT NULL AS existe`)).rows;
    if (!existe) {
      noMedido('todo el bloque', 'analytics.v_count_clock todavia no existe');
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy(); process.exit(0);
    }

    const r = (await db.raw(
      `SELECT ritmo, estado, count(*)::int AS filas,
              count(*) FILTER (WHERE fuente = 'kepler')::int       AS por_kepler,
              count(*) FILTER (WHERE fuente = 'folio_propio')::int AS por_folio,
              count(*) FILTER (WHERE fuente IS NULL)::int          AS sin_fuente,
              count(*) FILTER (WHERE last_counted_at IS NOT NULL)::int AS con_fecha
         FROM analytics.v_count_clock GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
    for (const x of r) console.log(`     ${x.ritmo.padEnd(11)} ${x.estado.padEnd(14)} ${String(x.filas).padStart(6)} filas`
      + ` · kepler ${x.por_kepler} · folio ${x.por_folio}`);

    const porRitmo = (ri) => r.filter((x) => x.ritmo === ri);
    const total = r.reduce((s, x) => s + x.filas, 0);
    const suma = (f) => r.filter(f).reduce((s, x) => s + x.filas, 0);

    t('la rejilla está COMPLETA: los 3 ritmos cubren el mismo universo', (() => {
      const n = ['diario', 'mensual', 'trimestral'].map((ri) => porRitmo(ri).reduce((s, x) => s + x.filas, 0));
      return n.length === 3 && n[0] > 0 && n.every((x) => x === n[0]);
    })(), `filas por ritmo: ${['diario', 'mensual', 'trimestral'].map((ri) => porRitmo(ri).reduce((s, x) => s + x.filas, 0))}`);

    t('el vocabulario de `estado` es cerrado', r.every((x) => ESTADOS.includes(x.estado)),
      [...new Set(r.map((x) => x.estado))].filter((e) => !ESTADOS.includes(e)).join(' '));

    // ⭐ (1) Las dos ausencias siguen separadas: si `nunca_contado` desapareciera y todo fuera
    //        `vencido`, estariamos de vuelta en el bug original.
    t('`nunca_contado` existe como estado propio, distinto de `vencido`',
      suma((x) => x.estado === 'nunca_contado') > 0);

    // (3) El diario NUNCA dice vencido: su regla es cupo por sucursal, no cadencia por SKU.
    t('el ritmo diario no inventa una cadencia por SKU',
      porRitmo('diario').every((x) => x.estado === 'sin_cadencia'),
      porRitmo('diario').map((x) => x.estado).join(' '));
    t('y ningún otro ritmo usa `sin_cadencia`',
      r.filter((x) => x.estado === 'sin_cadencia').every((x) => x.ritmo === 'diario'));

    // (4) La fuente se declara siempre que haya fecha, y nunca cuando no la hay.
    t('toda fila CON fecha declara su fuente', suma((x) => x.con_fecha > 0 && x.sin_fuente > 0) === 0,
      r.filter((x) => x.con_fecha > 0 && x.sin_fuente > 0).map((x) => `${x.ritmo}/${x.estado}`).join(' '));
    t('ninguna fila SIN fecha inventa una fuente',
      r.filter((x) => x.estado === 'nunca_contado').every((x) => x.por_kepler === 0 && x.por_folio === 0));

    // ⭐ Lo que esta fase arregla, con número: el reloj dejó de estar ciego.
    const conHistoria = suma((x) => x.estado === 'al_dia' || x.estado === 'vencido');
    t(`el reloj ya NO está ciego: ${conHistoria} filas con fecha real (antes 0)`, conHistoria > 0);
    const kepler = r.reduce((s, x) => s + x.por_kepler, 0);
    t('y esa fecha viene del físico de Kepler, que ya existía y nadie miraba', kepler > 0,
      `${kepler} filas`);

    // El mensual todavia no corrio: se DECLARA en vez de dibujarse.
    const mensualConFecha = porRitmo('mensual').reduce((s, x) => s + x.con_fecha, 0);
    if (mensualConFecha === 0) {
      noMedido('la cadencia del ritmo mensual', 'nunca corrio: todas sus filas son `nunca_contado`');
    } else {
      t(`el ritmo mensual ya tiene historia (${mensualConFecha} filas)`, true);
    }

    // Coherencia aritmetica: next_due solo donde hay fecha Y cadencia.
    const [{ incoherentes }] = (await db.raw(
      `SELECT count(*)::int AS incoherentes FROM analytics.v_count_clock
        WHERE (next_due IS NOT NULL AND (last_counted_at IS NULL OR cadence_days IS NULL))
           OR (estado = 'vencido' AND next_due > now())
           OR (estado = 'al_dia'  AND next_due <= now())`)).rows;
    t('`next_due` y `estado` no se contradicen', incoherentes === 0, `${incoherentes} filas`);

    const opts = (await db.raw(
      `SELECT coalesce(array_to_string(c.reloptions, ','), '') AS o
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'analytics' AND c.relname = 'v_count_clock'`)).rows[0].o;
    t('conserva security_invoker', opts.includes('security_invoker'), opts || '(vacío)');
    const [{ puede }] = (await db.raw(
      `SELECT has_table_privilege('app_runtime', 'analytics.v_count_clock', 'SELECT') AS puede`)).rows;
    t('app_runtime conserva el GRANT SELECT', puede === true);

    console.log(`\n     universo: ${total} filas (${total / 3} SKUs × 3 ritmos)`);
    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message);
    bad++;
  } finally {
    await db.destroy();
  }
  process.exit(bad > 0 ? 1 : 0);
})();
