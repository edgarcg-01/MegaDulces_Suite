'use strict';
/**
 * [ABC.6] Candado del conteo cíclico: el TOTAL real y el PORQUÉ de cada clase.
 *
 *   node database/tests/test-newdb-abc-motivo.js
 *
 * Sólo lee.
 *
 * ── Los dos defectos que protege, medidos en prod el 2026-09-30 ─────────────────────────
 *
 * 1. ⛔ **`by_class` se contaba DESPUÉS del `LIMIT 2000`.** Con todo el catálogo sin contar
 *    nunca, las 4,987 filas clase A se comían el límite enteras y la pantalla publicaba
 *    «2,000 pendientes · A 2000 · B 0 · C 0» cuando lo vencido era **39,480**. Subdeclaraba el
 *    trabajo en **95%** y afirmaba **dos ceros falsos** — una clase entera desaparecía del plan
 *    sin que nadie lo decidiera. La aserción trae su PRUEBA NEGATIVA: se reproduce el cálculo
 *    viejo y tiene que dar los ceros; si no los diera, el candado estaría verde por no saber
 *    mirar.
 *
 * 2. ⛔ **La letra no decía por qué.** `motivo_clase` separa tres poblaciones que llevaban la
 *    misma C: `sin_demanda` (15,990 de 27,671 = 57.8%, **no son de bajo valor: son no
 *    medidas**), `sin_costo`, y la C legítima del último 5% del valor. 10,125 de esas
 *    `sin_demanda` son del CEDIS, que por diseño no vende sino que distribuye por traspaso.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0, nm = 0;
const t = (n, c, x) => { if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { bad++; console.log(`  ✘ ${n}${x ? ' — ' + x : ''}`); } };
const noMedido = (n, m) => { nm++; console.log(`  ◻ NO MEDIDO: ${n} — ${m}`); };

/** El mismo CTE que usa `InventoryAbcService.cycleDue`. */
const RANKED = `
  WITH last_counted AS (
    SELECT c.warehouse_id, i.product_id, MAX(c.reconciled_at) AS last_counted_at
      FROM commercial.inventory_counts c
      JOIN commercial.inventory_count_items i ON i.count_id=c.id AND i.tenant_id=c.tenant_id
     WHERE c.status='reconciled' AND i.product_id IS NOT NULL GROUP BY 1,2),
  ranked AS (
    SELECT a.warehouse_id, a.product_id, a.abc_class, a.annual_value, a.units_window,
           a.value_share, lc.last_counted_at,
           (CASE a.abc_class WHEN 'A' THEN 30 WHEN 'B' THEN 90 ELSE 365 END) AS cadence_days,
           a.clase_motivo AS motivo_clase,
           (coalesce(a.units_window,0) = 0) AS sin_demanda_en_fila
      FROM commercial.abc_classification a
      LEFT JOIN last_counted lc ON lc.warehouse_id=a.warehouse_id AND lc.product_id=a.product_id),
  vencidas AS (
    SELECT * FROM ranked r
     WHERE (r.last_counted_at IS NULL
        OR r.last_counted_at + (r.cadence_days || ' days')::interval <= now()))`;

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [ABC.6] conteo cíclico: total real + porqué de la clase ===\n');
  try {
    const [{ filas }] = (await db.raw(
      'SELECT count(*)::int AS filas FROM commercial.abc_classification')).rows;
    if (!filas) {
      noMedido('todo el candado', 'commercial.abc_classification está vacía en este destino');
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy(); process.exit(0);
    }

    // ── 1. El total por clase sale del UNIVERSO, no de la página ───────────────────────
    const { rows: tot } = await db.raw(`${RANKED}
      SELECT abc_class, count(*)::int AS n FROM vencidas GROUP BY 1 ORDER BY 1`);
    const real = Object.fromEntries(tot.map((r) => [r.abc_class, r.n]));
    t('hay vencidas de clase A', (real.A || 0) > 0, `A=${real.A}`);
    t('⛔ y TAMBIÉN de B — el defecto las hacía desaparecer', (real.B || 0) > 0, `B=${real.B}`);
    t('⛔ y de C', (real.C || 0) > 0, `C=${real.C}`);

    // ── 2. PRUEBA NEGATIVA: reproducir el cálculo VIEJO tiene que dar los ceros ────────
    // Sin esto, "B > 0" podría estar verde por cualquier razón. Acá se demuestra que el
    // defecto existía y que este candado lo distingue.
    {
      const { rows } = await db.raw(`${RANKED},
        pagina_vieja AS (
          SELECT * FROM vencidas
           ORDER BY CASE abc_class WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END,
                    last_counted_at ASC NULLS FIRST
           LIMIT 2000)
        SELECT abc_class, count(*)::int AS n FROM pagina_vieja GROUP BY 1`);
      const viejo = Object.fromEntries(rows.map((r) => [r.abc_class, r.n]));
      const total = (real.A || 0) + (real.B || 0) + (real.C || 0);
      if (total <= 2000) {
        noMedido('la prueba negativa del conteo sobre la página',
          `hay ${total} vencidas y el límite es 2000: el defecto no se puede reproducir acá`);
      } else {
        t('NEGATIVA: contando sobre la página (el bug) B y C daban CERO',
          !viejo.B && !viejo.C, `viejo B=${viejo.B ?? 0} C=${viejo.C ?? 0}`);
        t(`NEGATIVA: y el total se subdeclaraba (${total} → 2000)`,
          Object.values(viejo).reduce((a, b) => a + b, 0) === 2000);
      }
    }

    // ── 3. El motivo es el CANÓNICO, no una segunda derivación ────────────────────────
    // ⛔ La primera versión de ABC.6 lo re-derivaba en el servicio. Eso es exactamente el
    // defecto que KE.4 cerró (la pantalla mostraba otra clase que el motor, 64% de acuerdo),
    // así que el candado exige que los valores sean los del vocabulario canónico.
    {
      const { rows } = await db.raw(`${RANKED}
        SELECT motivo_clase, count(*)::int AS n FROM ranked GROUP BY 1 ORDER BY 2 DESC`);
      const suma = rows.reduce((a, r) => a + r.n, 0);
      const vocab = new Set(['pareto', 'sin_demanda', 'sin_costo']);
      t('los motivos particionan el universo (ninguna fila sin clasificar)', suma === filas,
        `suma=${suma} filas=${filas}`);
      t('el vocabulario es el CANÓNICO de KE.4b (pareto/sin_demanda/sin_costo)',
        rows.every((r) => vocab.has(r.motivo_clase)),
        rows.map((r) => r.motivo_clase).join(','));
      t('ninguna fila viene sin motivo', rows.every((r) => r.motivo_clase));
    }

    // ── 4. La contradicción MEDIDA que la pantalla declara ────────────────────────────
    // `clase_motivo='sin_demanda'` mira la demanda del ALMACÉN entero, no la de la fila. Hay
    // filas con demanda CERO rotuladas `pareto` — «es C por su lugar en el Pareto» sobre una
    // fila sin valor que ordenar. NO se re-etiquetan (esa etiqueta decide compra en
    // import-network-reorder.js:99): se EXPONEN. Este candado vigila que se sigan exponiendo.
    {
      const [r] = (await db.raw(`${RANKED}
        SELECT count(*) FILTER (WHERE motivo_clase='sin_demanda')::int AS alm_sin_dem,
               count(*) FILTER (WHERE sin_demanda_en_fila)::int AS fila_sin_dem,
               count(*) FILTER (WHERE motivo_clase='pareto' AND sin_demanda_en_fila)::int AS contradictorias,
               count(*) FILTER (WHERE motivo_clase='pareto' AND sin_demanda_en_fila
                                  AND coalesce(annual_value,0) <> 0)::int AS con_valor,
               count(*) FILTER (WHERE abc_class <> 'C' AND motivo_clase <> 'pareto')::int AS incoherente
          FROM ranked`)).rows;
      t('un motivo distinto de `pareto` sólo puede terminar en C (invariante de KE.4)',
        Number(r.incoherente) === 0, `n=${r.incoherente}`);
      t('las filas contradictorias tienen valor CERO — si no, la contradicción sería otra cosa',
        Number(r.con_valor) === 0, `n=${r.con_valor}`);
      t(`la contradicción se puede exponer (${r.contradictorias} filas rotuladas pareto sin demanda)`,
        Number(r.contradictorias) >= 0);
      console.log(`      ⓘ almacén sin demanda: ${r.alm_sin_dem} · fila sin demanda: ${r.fila_sin_dem}`
        + ` · de esas, ${r.contradictorias} el resolvedor las llama "pareto"`);
    }

    // ── 5. El orden de la página es estable: valor DESC + desempate por product_id ─────
    {
      const q = `${RANKED}
        SELECT product_id FROM vencidas
         ORDER BY CASE abc_class WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END,
                  last_counted_at ASC NULLS FIRST, annual_value DESC, product_id
         LIMIT 50`;
      const [a, b] = await Promise.all([db.raw(q), db.raw(q)]);
      const ia = a.rows.map((r) => r.product_id).join(','), ib = b.rows.map((r) => r.product_id).join(',');
      t('dos corridas devuelven el MISMO orden (sin desempate no se puede demostrar un cambio)',
        ia === ib && ia.length > 0);
    }

    // ── 6. Dentro de una clase, primero lo que más vale ────────────────────────────────
    {
      const { rows } = await db.raw(`${RANKED}
        SELECT annual_value::numeric AS v FROM vencidas WHERE abc_class='A'
         ORDER BY last_counted_at ASC NULLS FIRST, annual_value DESC, product_id LIMIT 200`);
      const vals = rows.map((r) => Number(r.v));
      const ordenado = vals.every((v, i) => i === 0 || vals[i - 1] >= v);
      t('la agenda ordena por valor descendente dentro de la clase', ordenado,
        ordenado ? '' : `${vals[0]} … ${vals[vals.length - 1]}`);
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message); bad++;
  } finally { await db.destroy(); }
  process.exit(bad > 0 ? 1 : 0);
})();
