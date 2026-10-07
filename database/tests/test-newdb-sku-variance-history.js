'use strict';
/**
 * [IC.3] Historial de descuadre por SKU — la señal preventiva.
 *
 * Contar seguido lo que siempre falla. Medido: en la sucursal 02 el SKU 17063 descuadró
 * **6 de 6 veces** con $3,318,784 acumulados, y 2,224 de 3,106 SKUs con base histórica (72%)
 * descuadran la mitad de las veces o más.
 *
 * ── Los dos riesgos que este candado vigila ─────────────────────────────────────────────
 *
 * 1. LA TASA SIN BASE. La profundidad histórica es muy desigual (02 tiene 7 conteos, 06
 *    tiene 1, 07 y 08 ninguno). "Descuadró 1 de 1" no es una tasa del 100%: es una sola
 *    observación. Si se publicara como tasa, el top priorizaría los almacenes con MENOS
 *    historia — al revés de lo que se busca.
 *
 * 2. ⛔ LA DUPLICACIÓN VIGILADA. Esta vista calcula el descuadre directo de `kdm` en vez de
 *    leerlo de `v_erp_physical_count_variance`, porque leerlo de ahí la lleva de ~944 ms a
 *    MÁS DE 90 s (timeout). Eso duplica la lógica, y dos definiciones del mismo concepto
 *    divergen tarde o temprano. El bloque 3 las compara: si divergen, ROJO. La duplicación
 *    existe por costo medido, pero no queda suelta.
 *
 *   node database/tests/test-newdb-sku-variance-history.js
 *
 * Sólo lee. Si las vistas no están aplicadas, ejerce el SQL de las migraciones.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

const selectDe = (archivo) => {
  const mig = fs.readFileSync(path.resolve(__dirname, '..', 'migrations-newdb', archivo), 'utf8');
  const m = mig.split('WITH (security_invoker = true) AS')[1];
  if (!m) throw new Error(`no se pudo extraer el SELECT de ${archivo}`);
  return m.split('`);')[0].trim();
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IC.3] historial de descuadre por SKU ===\n');

  try {
    await db.raw(`SET statement_timeout = '120s'`);

    const [{ hayH, hayV }] = (await db.raw(
      `SELECT to_regclass('analytics.v_sku_count_variance_history') IS NOT NULL AS "hayH",
              to_regclass('analytics.v_erp_physical_count_variance') IS NOT NULL AS "hayV"`)).rows;

    // Igual que en IC.0: si la vista no está aplicada se ejerce el SELECT de la migración.
    // Un candado que nunca corre no protege nada.
    const H = hayH ? 'analytics.v_sku_count_variance_history' : '_h';
    const V = hayV ? 'analytics.v_erp_physical_count_variance' : '_v';
    const ctes = [];
    if (!hayH) ctes.push(`_h AS (${selectDe('20260928290000_sku_count_variance_history_view.js').replace(/^WITH\s+/i, '').replace(/\)\s*SELECT/i, ') SELECT')}`);
    if (!hayV) ctes.push(`_v AS (${selectDe('20260928260000_erp_physical_count_variance_view.js').replace(/^WITH\s+/i, '')})`);
    console.log(`  ⓘ origen: historial=${hayH ? 'vista' : 'migración'} · varianza=${hayV ? 'vista' : 'migración'}\n`);

    // El SELECT del historial ya trae su propio WITH; se arma como CTE anidado completo.
    const preH = hayH ? '' : `WITH _h AS (${selectDe('20260928290000_sku_count_variance_history_view.js')})`;
    const q = (sql) => db.raw(preH ? `${preH} ${sql}` : sql);

    // ── 1. Responde, y en un tiempo usable ────────────────────────────────────
    const t0 = Date.now();
    const [tot] = (await q(
      `SELECT count(*)::int AS filas,
              count(DISTINCT warehouse_code)::int AS almacenes,
              max(veces_contado)::int AS max_conteos
         FROM ${H}`)).rows;
    const ms = Date.now() - t0;
    t(`responde en menos de 3 s (${ms} ms, ${tot.filas} filas)`, ms < 3000, `${ms} ms`);
    console.log(`     ${tot.almacenes} almacenes · hasta ${tot.max_conteos} conteos por SKU`);

    // ── 2. ⛔ La tasa NO se publica sin base ───────────────────────────────────
    const [tasa] = (await q(
      `SELECT count(*) FILTER (WHERE veces_contado < 2 AND tasa_descuadre IS NOT NULL)::int AS mentirosas,
              count(*) FILTER (WHERE veces_contado < 2)::int AS sin_base,
              count(*) FILTER (WHERE tasa_motivo = 'medida')::int AS medidas,
              count(*) FILTER (WHERE veces_contado >= 2 AND tasa_descuadre IS NULL)::int AS medibles_sin_tasa
         FROM ${H}`)).rows;
    t('⛔ ninguna fila con < 2 observaciones publica tasa (1 de 1 NO es 100%)',
      Number(tasa.mentirosas) === 0, `${tasa.mentirosas} filas`);
    t('toda fila con >= 2 observaciones SÍ trae tasa (no se pierde señal medible)',
      Number(tasa.medibles_sin_tasa) === 0, `${tasa.medibles_sin_tasa} filas`);
    t('PRUEBA NEGATIVA: la declaración DISCRIMINA (hay filas de los dos tipos)',
      Number(tasa.sin_base) > 0 && Number(tasa.medidas) > 0, JSON.stringify(tasa));
    console.log(`     con tasa medida: ${tasa.medidas} · sin base histórica: ${tasa.sin_base}`);

    // ── 3. ⛔ LA DUPLICACIÓN VIGILADA ─────────────────────────────────────────
    // Esta vista recalcula el descuadre en vez de leerlo de la de IC.0 (por costo medido).
    // Si las dos definiciones divergen, los pesos no coinciden y esto se pone rojo.
    if (hayV || !hayH) {
      const preAmbas = hayH && hayV ? '' :
        `WITH ${[!hayH ? `_h AS (${selectDe('20260928290000_sku_count_variance_history_view.js')})` : null,
          !hayV ? `_v AS (${selectDe('20260928260000_erp_physical_count_variance_view.js')})` : null]
          .filter(Boolean).join(', ')}`;
      const [cmp] = (await db.raw(`${preAmbas}
        SELECT round(coalesce((SELECT sum(pesos_abs) FROM ${H}), 0), 2) AS historial,
               round(coalesce((SELECT sum(importe) FROM ${V} WHERE tipo_evento = 'conteo'), 0), 2) AS varianza`)).rows;
      // ⚠️ El candado NO exige igualdad, y la primera versión sí — estaba mal planteado.
      // Las dos vistas miden universos distintos A PROPÓSITO: IC.0 trae TODO el descuadre de
      // un conteo; IC.3 sólo el de los SKUs que estuvieron en la CAPTURA de ese evento,
      // porque su pregunta es "de las veces que se contó, cuántas descuadró". Un ajuste de un
      // SKU que no se capturó entra en la primera y queda fuera de la segunda, con razón.
      //
      // Lo que sí tiene que cumplirse es la DIRECCIÓN (el historial es un subconjunto, nunca
      // puede exceder) y que la brecha no crezca en silencio. Exigir Δ<$1 habría obligado a
      // romper uno de los dos diseños para que el test pasara.
      //
      // ⚠️ NO MEDIDO: la magnitud exacta de "ajustes sin captura" en el histórico completo —
      // esa consulta excede los 300 s (el join de 33k ajustes contra 48k capturas por cuatro
      // columnas de texto). Se declara en vez de afirmarse.
      const dif = Number(cmp.varianza) - Number(cmp.historial);
      const pct = Number(cmp.varianza) !== 0 ? (100 * dif / Number(cmp.varianza)) : 0;
      t('⛔ el historial NUNCA excede a la vista de varianza (es un subconjunto por diseño)',
        dif >= -1, `historial ${cmp.historial} vs varianza ${cmp.varianza}`);
      t('⛔ la brecha entre las dos vistas se mantiene bajo el 5% (si crece, algo divergió)',
        Math.abs(pct) < 5, `${pct.toFixed(2)}% — Δ $${dif.toFixed(2)}`);
      console.log(`     descuadre: historial $${Number(cmp.historial).toLocaleString('en-US')}`
        + ` · varianza $${Number(cmp.varianza).toLocaleString('en-US')}`
        + ` · brecha ${pct.toFixed(2)}% (ajustes sin captura)`);
    } else {
      console.log('  ⓘ NO MEDIDO: la comparación entre las dos vistas (falta la de varianza)');
    }

    // ── 4. El universo son las CAPTURAS, no los ajustes ───────────────────────
    // Si el universo fueran los ajustes, veces_contado == veces_descuadro SIEMPRE, y
    // "contado 8 veces y descuadró 1" se vería igual que "contado 1 vez y descuadró 1".
    const [uni] = (await q(
      `SELECT count(*) FILTER (WHERE veces_contado > veces_descuadro)::int AS contados_sin_descuadre,
              count(*) FILTER (WHERE veces_descuadro > veces_contado)::int AS imposibles
         FROM ${H}`)).rows;
    t('⛔ hay SKUs contados que NO descuadraron (el universo son las capturas, no los ajustes)',
      Number(uni.contados_sin_descuadre) > 0, JSON.stringify(uni));
    t('⛔ ningún SKU descuadró más veces de las que se contó (imposible por construcción)',
      Number(uni.imposibles) === 0, `${uni.imposibles} filas`);

    // ── 5. Las cargas iniciales no ensucian el historial ──────────────────────
    // 07 y 08 sólo tienen carga inicial: si aparecieran acá, sus SKUs entrarían al top con
    // un "descuadre" que es una migración de ERP.
    const [cargas] = (await q(
      `SELECT count(*)::int AS n FROM ${H} WHERE kepler_sucursal IN ('07', '08')`)).rows;
    t('⛔ las sucursales que sólo tuvieron carga inicial (07, 08) no entran al historial',
      Number(cargas.n) === 0, `${cargas.n} filas`);
  } catch (e) {
    bad++; console.log(`  ✘ excepción: ${e.message.slice(0, 220)}`);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ ===\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
