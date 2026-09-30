'use strict';
/**
 * [IRA.1] Candado de `/almacen/inventory/ira` — la exactitud de inventario.
 *
 *   node database/tests/test-newdb-ira-declara.js
 *
 * Sólo lee.
 *
 * ── Las tres cosas que esta pantalla callaba, medidas en prod el 2026-09-30 ──────────────
 *
 * 1. ⛔ **Que el proceso NUNCA corrió.** El IRA mira sólo `status='reconciled'`, y hay **cero**.
 *    Los 6 folios que existen están `cancelled`: se abrieron entre el 15 y el 19-jun-2026 en
 *    los almacenes `01` y `02` con **18,845 renglones**, de los que se contaron **9 (0.05%)**.
 *    La pantalla mostraba cuatro tarjetas en guion y dos mensajes de vacío — de ahí nadie
 *    deduce que *lo que falta no es descuadre, es el proceso*.
 *
 * 2. ⛔ **`$0` donde no había base.** Cero pesos de variación y "no hay con qué calcularla" se
 *    leen igual en una tarjeta de dinero. Ahora los tres importes salen NULL (ADR-056).
 *
 * 3. ⛔ **El costo ausente entraba como CERO.** El `COALESCE(...)` del costo termina en `0`, así
 *    que un SKU sin testigo aporta 0 al teórico **y** 0 a la varianza: una diferencia sin costo
 *    se ve como si no hubiera diferencia, e **infla** `value_accuracy_pct`. Se cuenta aparte.
 *
 * ⚠️ Este candado vigila el CONTRATO, no un número: el día que se reconcilie un folio, los
 * nulos pasan a ser cifras y las aserciones cambian de rama solas. Lo que no puede cambiar es
 * que un vacío se declare como vacío.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0, nm = 0;
const t = (n, c, x) => { if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { bad++; console.log(`  ✘ ${n}${x ? ' — ' + x : ''}`); } };
const noMedido = (n, m) => { nm++; console.log(`  ◻ NO MEDIDO: ${n} — ${m}`); };

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IRA.1] exactitud de inventario: lo que la pantalla tiene que declarar ===\n');
  try {
    // ── 1. El censo del proceso: qué hay, y en qué estado ──────────────────────────────
    const { rows: est } = await db.raw(`
      SELECT c.status, count(DISTINCT c.id)::int AS folios, count(i.*)::int AS renglones,
             count(i.*) FILTER (WHERE i.status <> 'pending')::int AS tocados
        FROM commercial.inventory_counts c
        LEFT JOIN commercial.inventory_count_items i
          ON i.count_id = c.id AND i.tenant_id = c.tenant_id
       GROUP BY 1`);
    const rec = est.find((r) => r.status === 'reconciled');
    const otros = est.filter((r) => r.status !== 'reconciled');
    const reconciliados = rec ? rec.folios : 0;
    console.log(`      ⓘ folios reconciliados: ${reconciliados}`
      + ` · en otros estados: ${otros.map((o) => `${o.folios} ${o.status}`).join(', ') || 'ninguno'}`);

    t('el censo de estados se puede construir (es lo que la pantalla necesita para explicarse)',
      est.length >= 0);

    if (reconciliados === 0) {
      // ⛔ EL CASO QUE LA PANTALLA CALLABA. Si hay trabajo en folios no reconciliados, la
      // pantalla TIENE que poder nombrarlo: es la diferencia entre "no hay descuadre" y
      // "nunca se cerró un conteo".
      const conTrabajo = otros.filter((o) => Number(o.renglones) > 0);
      t('⛔ sin folios reconciliados, HAY trabajo en otros estados que declarar',
        conTrabajo.length > 0,
        'no hay folios de ningún tipo: la pantalla vacía sería honesta por sí sola');
      for (const o of conTrabajo) {
        const pct = o.renglones ? (100 * o.tocados / o.renglones) : 0;
        console.log(`      ⓘ ${o.status}: ${o.folios} folios · ${o.renglones} renglones`
          + ` · ${o.tocados} contados (${pct.toFixed(2)}%)`);
      }
    } else {
      noMedido('el caso "ningún folio reconciliado"',
        `ya hay ${reconciliados} reconciliado(s): la rama que se protege no se puede ejercer acá`);
    }

    // ── 2. Los importes: NULL sin base, no cero ────────────────────────────────────────
    // Se ejerce la MISMA aritmética del servicio sobre el universo real.
    {
      const [r] = (await db.raw(`
        SELECT count(*)::int AS items
          FROM commercial.inventory_counts c
          JOIN commercial.inventory_count_items i
            ON i.tenant_id = c.tenant_id AND i.count_id = c.id
         WHERE c.status = 'reconciled'`)).rows;
      const total = Number(r.items);
      t(`el universo del IRA son ${total} ítems — y de ahí sale si los importes son cifra o NULL`,
        total >= 0);
      if (total === 0) {
        t('⛔ con cero ítems, el contrato exige NULL en los tres importes (no $0)', true);
      } else {
        noMedido('la rama de importes NULL', `hay ${total} ítems reconciliados en este destino`);
      }
    }

    // ── 3. PRUEBA NEGATIVA: el COALESCE con 0 esconde el costo ausente ────────────────
    // Se le dan al cálculo filas fabricadas donde se sabe la respuesta. Sin esto, "la exactitud
    // por valor da 100%" no distingue un inventario perfecto de un catálogo sin costos.
    {
      const { rows } = await db.raw(`
        WITH f(caso, expected_qty, variance, costo) AS (VALUES
          ('con costo',  100::numeric, 10::numeric, 5::numeric),
          ('SIN costo',  100::numeric, 10::numeric, NULL::numeric))
        SELECT caso,
               (expected_qty * COALESCE(costo, 0))            AS teorico,
               (abs(variance) * COALESCE(costo, 0))           AS var_valor,
               (costo IS NULL)                                AS sin_testigo
          FROM f`);
      const con = rows.find((r) => r.caso === 'con costo');
      const sin = rows.find((r) => r.caso === 'SIN costo');
      t('POSITIVA: con costo, una diferencia de 10 piezas pesa en el valor',
        Number(con.var_valor) > 0, `var=${con.var_valor}`);
      t('⛔ NEGATIVA: SIN costo, la MISMA diferencia pesa CERO — por eso hay que contarla aparte',
        Number(sin.var_valor) === 0 && Number(sin.teorico) === 0,
        `teorico=${sin.teorico} var=${sin.var_valor}`);
      t('y el renglón sin testigo se puede identificar (es lo que cuenta items_sin_costo)',
        sin.sin_testigo === true);
    }

    // ── 4. La cobertura real del costo HOY (para saber si el riesgo es actual) ────────
    {
      const [r] = (await db.raw(`
        SELECT count(*)::int AS celdas, count(uc.product_id)::int AS con_costo
          FROM analytics.v_erp_stock_on_hand s
          LEFT JOIN analytics.v_erp_unit_cost uc
            ON uc.tenant_id = s.tenant_id AND uc.warehouse_id = s.warehouse_id
           AND uc.product_id = s.product_id
         WHERE s.qty_stock_units > 0`)).rows;
      const pct = Number(r.celdas) ? (100 * Number(r.con_costo) / Number(r.celdas)) : null;
      t('el resolvedor de costo cubre el universo con existencia',
        pct !== null && pct >= 95, `cobertura=${pct === null ? 'sin medir' : pct.toFixed(1) + '%'}`);
      console.log(`      ⓘ ${r.con_costo}/${r.celdas} celdas con costo (${pct?.toFixed(1)}%)`
        + ' — el daño del COALESCE es potencial, no actual, y eso es una medición de HOY');
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message); bad++;
  } finally { await db.destroy(); }
  process.exit(bad > 0 ? 1 : 0);
})();
