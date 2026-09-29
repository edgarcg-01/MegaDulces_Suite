'use strict';
/**
 * [IC.4] El score de prioridad de conteo — las 4 señales de la decisión D2.
 *
 * ── ⛔ LA ASERCIÓN CENTRAL: que la señal ausente NO hunda a nadie ───────────────────────
 *
 * `tasa_descuadre` es NULL donde hay menos de 2 conteos, y eso es la mitad del catálogo (la
 * 02 tiene 7 conteos, la 01 y la 06 tienen UNO, la 07 y la 08 ninguno). Si esa señal se
 * contara como CERO, los almacenes sin historia saldrían sistemáticamente más abajo y el top
 * ignoraría justo las plazas que nunca se han contado.
 *
 * Por eso los pesos se renormalizan fila por fila sobre las señales disponibles. El bloque 2
 * lo comprueba comparando el score medio de los almacenes CON historia contra los SIN — si la
 * renormalización se rompe, la brecha se abre y esto se pone rojo. Es una aserción sobre la
 * AUSENCIA de sesgo, que es lo que no se ve mirando una tabla de resultados.
 *
 *   node database/tests/test-newdb-count-priority-score.js
 *
 * Sólo lee. Si las vistas no están aplicadas, ejerce el SQL de las migraciones.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const PESOS = { abc: 0.30, venta: 0.25, parado: 0.20, descuadre: 0.25 };

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const selectDe = (archivo) => {
  const mig = fs.readFileSync(path.resolve(__dirname, '..', 'migrations-newdb', archivo), 'utf8');
  const m = mig.split('WITH (security_invoker = true) AS')[1];
  if (!m) throw new Error(`no se pudo extraer el SELECT de ${archivo}`);
  return m.split('`);')[0].trim().replace(/\$\{PESOS\.(\w+)\}/g, (_, k) => String(PESOS[k]));
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IC.4] score de prioridad de conteo ===\n');

  try {
    await db.raw(`SET statement_timeout = '180s'`);
    const [{ hayS, hayH }] = (await db.raw(
      `SELECT to_regclass('analytics.v_count_priority_score') IS NOT NULL AS "hayS",
              to_regclass('analytics.v_sku_count_variance_history') IS NOT NULL AS "hayH"`)).rows;

    let PRE = '', S = 'analytics.v_count_priority_score';
    if (!hayS) {
      let s4 = selectDe('20260929120000_count_priority_score_view.js');
      const partes = [];
      if (!hayH) {
        partes.push(`_h AS (${selectDe('20260928290000_sku_count_variance_history_view.js')})`);
        s4 = s4.replace(/analytics\.v_sku_count_variance_history/g, '_h');
      }
      partes.push(`_s AS (${s4})`);
      PRE = `WITH ${partes.join(', ')} `;
      S = '_s';
      console.log('  ⓘ la vista NO está aplicada → se ejerce el SELECT de la migración');
      console.log('    ⚠️ ESO MIDE LA LÓGICA, NO EL RENDIMIENTO REAL: montar las vistas como CTE');
      console.log('       anidado es varias veces más lento que leerlas creadas.\n');
    }
    const q = (sql) => db.raw(PRE ? PRE + sql : sql);

    // ── 1. Responde y expone sus componentes ─────────────────────────────────
    const t0 = Date.now();
    const [tot] = (await q(
      `SELECT count(*)::int AS filas,
              count(*) FILTER (WHERE score IS NULL)::int AS sin_score,
              count(*) FILTER (WHERE s_abc IS NULL OR s_venta IS NULL OR s_parado IS NULL)::int AS sin_componentes
         FROM ${S}`)).rows;
    const ms = Date.now() - t0;
    t('responde y calcula score para todas las filas',
      Number(tot.filas) > 0 && Number(tot.sin_score) === 0, JSON.stringify(tot));
    t('⛔ las 3 componentes siempre calculables NUNCA vienen nulas',
      Number(tot.sin_componentes) === 0, `${tot.sin_componentes} filas`);
    console.log(`     ${tot.filas} filas en ${ms} ms`);
    if (ms > 3000) {
      console.log(`  ⚠️ DECLARADO: ${ms} ms. ${hayS ? 'Con la vista creada esto es lento: evaluar materializar.'
        : 'Es el modo CTE; el rendimiento real NO SE PUEDE MEDIR hasta aplicar las vistas.'}`);
    }

    // ── 2. ⛔ LA RENORMALIZACIÓN NO INTRODUCE SESGO ──────────────────────────
    const { rows: porGrupo } = await q(
      `SELECT (senales_usadas = 4) AS con_historia,
              count(*)::int AS filas,
              round(avg(score)::numeric, 4) AS score_medio
         FROM ${S}
        WHERE score_salvedad IS DISTINCT FROM 'sin_datos'
        GROUP BY 1 ORDER BY 1`);
    const conH = porGrupo.find((r) => r.con_historia === true);
    const sinH = porGrupo.find((r) => r.con_historia === false);
    t('hay filas de los DOS tipos (con y sin historia de conteo)',
      !!conH && !!sinH, JSON.stringify(porGrupo));
    if (conH && sinH) {
      const brecha = Math.abs(Number(conH.score_medio) - Number(sinH.score_medio));
      console.log(`     con historia: ${conH.score_medio} (${conH.filas})`
        + ` · sin historia: ${sinH.score_medio} (${sinH.filas}) · brecha ${brecha.toFixed(4)}`);
      t('⛔ la señal ausente NO hunde a los almacenes sin historia (brecha < 0.15)',
        brecha < 0.15,
        `brecha ${brecha.toFixed(4)} — si crece, la renormalización se rompió y el top`
        + ' ignora las plazas que nunca se contaron');
    }

    // ── 3. senales_usadas dice la verdad ─────────────────────────────────────
    const [su] = (await q(
      `SELECT count(*) FILTER (WHERE senales_usadas = 4 AND s_descuadre IS NULL)::int AS miente_4,
              count(*) FILTER (WHERE senales_usadas = 3 AND s_descuadre IS NOT NULL)::int AS miente_3,
              count(DISTINCT senales_usadas)::int AS variedad
         FROM ${S}`)).rows;
    t('⛔ senales_usadas coincide con las señales que de verdad hay',
      Number(su.miente_4) === 0 && Number(su.miente_3) === 0, JSON.stringify(su));
    t('PRUEBA NEGATIVA: senales_usadas DISCRIMINA (no es una constante)',
      Number(su.variedad) > 1, `${su.variedad} valores distintos`);

    // ── 4. ⛔ "Sin datos" no se disfraza de baja prioridad ────────────────────
    // El CEDIS tiene 10,106 SKUs clasificados y casi ningún dato: 9,858 sin nada con qué
    // juzgarlos. Un score bajo ahí significa "no se sabe", no "no hace falta contarlo" — y
    // es el único almacén que NUNCA se contó.
    const [sd] = (await q(
      `SELECT count(*) FILTER (WHERE score_salvedad = 'sin_datos')::int AS sin_datos,
              count(*) FILTER (WHERE score_salvedad = 'sin_datos'
                               AND (coalesce(annual_value,0) <> 0
                                 OR coalesce(avg_daily_units,0) <> 0
                                 OR coalesce(on_hand,0) <> 0))::int AS mal_marcadas
         FROM ${S}`)).rows;
    t('⛔ las filas sin ningún dato se DECLARAN (no se publican como prioridad baja)',
      Number(sd.sin_datos) > 0, JSON.stringify(sd));
    t('⛔ ninguna fila marcada sin_datos tiene datos de verdad',
      Number(sd.mal_marcadas) === 0, `${sd.mal_marcadas} filas mal marcadas`);
    console.log(`     sin_datos: ${sd.sin_datos} filas`);

    // ── 5. El score está acotado y ordena de verdad ──────────────────────────
    const [rango] = (await q(
      `SELECT count(*) FILTER (WHERE score < 0 OR score > 1)::int AS fuera_rango,
              round(min(score)::numeric,4) AS minimo, round(max(score)::numeric,4) AS maximo,
              count(DISTINCT score)::int AS distintos
         FROM ${S}`)).rows;
    t('el score vive en [0,1]', Number(rango.fuera_rango) === 0, JSON.stringify(rango));
    t('PRUEBA NEGATIVA: el score DISCRIMINA (no colapsa a un puñado de valores)',
      Number(rango.distintos) > 100, `${rango.distintos} valores distintos`);
    console.log(`     rango ${rango.minimo} – ${rango.maximo} · ${rango.distintos} valores`);
  } catch (e) {
    bad++; console.log(`  ✘ excepción: ${e.message.slice(0, 220)}`);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ ===\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
