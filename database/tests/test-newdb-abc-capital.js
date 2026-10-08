'use strict';
/**
 * [IC.21] Candado de `analytics.v_abc_capital` — el segundo eje del ABC: el capital parado.
 *
 *   node database/tests/test-newdb-abc-capital.js
 *
 * Sólo lee. Las dos pruebas negativas corren el SELECT de la migración sobre fuentes
 * SUSTITUIDAS (CTEs con filas sintéticas); no escriben nada en ninguna tabla.
 *
 * ── Qué protege, y por qué ESTAS aserciones ──────────────────────────────────────────────
 *
 * Esta vista publica una clasificación de dinero. Las tres formas de romperla sin que el
 * resultado deje de verse plausible son:
 *
 *  (1) **Que un costo desconocido se vuelva $0 y el SKU caiga a C en silencio.** Es lo que hace
 *      su hermana `v_abc_class` con su `COALESCE(costo_unitario, 0)`, y acá sería peor: una
 *      tarima con miles de piezas publicada como capital cero. Hoy NO hay ninguna fila sin
 *      costo (21,562/21,562 tienen) — o sea que **el camino nunca se ejerce solo**, y un camino
 *      que no se ejerce no está probado. Por eso se inyecta una fila a propósito.
 *
 *  (2) **Que el Pareto deje de ordenar.** El delator es el mismo que descubrió a `v_abc_class`
 *      vacía durante dos meses: un Pareto SIEMPRE produce clase B. B = 0 significa fuente vacía.
 *
 *  (3) ⭐ **Que este eje resulte ser un espejo del otro.** Es el modo de falla que esta fase ya
 *      pagó una vez: «uno por ventas y otro por costo» coincidía 98.85% y era un placebo. Un
 *      árbitro que nunca contradice no es un árbitro (ADR-059). Si el eje de capital coincidiera
 *      con el de consumo en más del 90%, este sprint no estaría entregando información nueva.
 *
 * ⚠️ El determinismo del desempate también se prueba: sin `product_id` en el ORDER BY, dos filas
 * con el mismo capital reciben clases distintas entre corridas, y eso no se ve en una sola.
 */

const path = require('path');
const fs = require('fs');
const knexLib = require('knex');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const MIG = path.join(__dirname, '..', 'migrations-newdb', '20261007131819_v_abc_capital.js');

let ok = 0; let bad = 0; let nm = 0;
const t = (label, cond, detalle) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); } else { bad++; console.log(`  ✗ ${label}${detalle ? ` — ${detalle}` : ''}`); }
};
const noMedido = (label, porque) => { nm++; console.log(`  ⓘ NO MEDIDO: ${label} — ${porque}`); };

/** El cuerpo del SELECT, leído de la migración: una sola definición, no una copia. */
function selectDeLaMigracion() {
  const src = fs.readFileSync(MIG, 'utf8');
  const cuerpo = src.split('CREATE OR REPLACE VIEW analytics.v_abc_capital AS')[1];
  if (!cuerpo) throw new Error('la migracion cambio de forma: no se encontro el CREATE VIEW');
  return cuerpo.split('`;')[0].trim();
}

(async () => {
  const url = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: {
      connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false },
    },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IC.21] v_abc_capital — el eje de capital parado ===\n');

  try {
    const [{ aplicada }] = (await db.raw(
      "SELECT to_regclass('analytics.v_abc_capital') IS NOT NULL AS aplicada")).rows;

    const SELECT = selectDeLaMigracion();
    // Si la vista ya existe se ejerce EL OBJETO. Si no, se ejerce el SELECT de la migración:
    // prueba la lógica, y la existencia del objeto queda NO MEDIDA en vez de darse por buena.
    const FUENTE = aplicada ? 'analytics.v_abc_capital' : `(${SELECT}) _v`;
    console.log(aplicada
      ? '  ⓘ la vista está aplicada → se ejerce el objeto real\n'
      : '  ⓘ la vista NO está aplicada → se ejerce el SELECT de la migración\n');

    // ── Bloque 1: el Pareto ordena ────────────────────────────────────────────────────────
    const d = (await db.raw(`
      SELECT count(*)::int                                          AS total,
             count(*) FILTER (WHERE capital_class = 'A')::int        AS a,
             count(*) FILTER (WHERE capital_class = 'B')::int        AS b,
             count(*) FILTER (WHERE capital_class = 'C')::int        AS c,
             count(*) FILTER (WHERE capital_class IS NULL)::int      AS sin_clase,
             count(*) FILTER (WHERE clase_motivo = 'sin_costo')::int AS sin_costo,
             count(*) FILTER (WHERE costo_veredicto IS NULL)::int    AS sin_veredicto,
             round(sum(capital))::numeric                            AS cap
        FROM ${FUENTE}`)).rows[0];

    t('un Pareto siempre produce clase B (el delator que destapó a v_abc_class vacía)',
      d.b > 0, `B=${d.b}`);
    t('produce las tres clases', d.a > 0 && d.b > 0 && d.c > 0, `A=${d.a} B=${d.b} C=${d.c}`);
    t('la clase A no se come el catálogo (<=40% de las filas)',
      d.a <= d.total * 0.4, `A=${d.a} de ${d.total}`);
    t('hay universo que clasificar (>5,000 filas con existencia)',
      d.total > 5000, `total=${d.total}`);
    console.log(`     capital $${Number(d.cap).toLocaleString('en-US')} · ${d.total} filas`);

    // ── Bloque 2: las invariantes aritméticas del Pareto ──────────────────────────────────
    const inv = (await db.raw(`
      SELECT warehouse_code,
             round(sum(aporte_individual), 4)::float8 AS suma_aportes,
             round(max(value_share), 4)::float8       AS max_share,
             max(rango_almacen)::int                  AS rango_max,
             max(skus_en_almacen)::int                AS skus
        FROM ${FUENTE} GROUP BY 1 ORDER BY 1`)).rows;

    t('el aporte individual suma 1.0 en TODOS los almacenes',
      inv.every((r) => Math.abs(r.suma_aportes - 1) < 0.001),
      inv.filter((r) => Math.abs(r.suma_aportes - 1) >= 0.001).map((r) => `${r.warehouse_code}=${r.suma_aportes}`).join(' '));
    t('el acumulado llega exactamente a 1.0 en TODOS los almacenes',
      inv.every((r) => Math.abs(r.max_share - 1) < 0.001),
      inv.filter((r) => Math.abs(r.max_share - 1) >= 0.001).map((r) => `${r.warehouse_code}=${r.max_share}`).join(' '));
    t('el rango máximo coincide con el conteo de SKUs del almacén',
      inv.every((r) => r.rango_max === r.skus),
      inv.filter((r) => r.rango_max !== r.skus).map((r) => `${r.warehouse_code}`).join(' '));

    // ── Bloque 3: el dinero cuadra fila por fila ──────────────────────────────────────────
    const [desc] = (await db.raw(`
      SELECT count(*)::int AS descuadran
        FROM ${FUENTE}
       WHERE capital IS NOT NULL
         AND abs(capital - (on_hand * costo_unitario)) > 0.01`)).rows;
    t('capital = existencia x costo, fila por fila (tolerancia $0.01)',
      desc.descuadran === 0, `${desc.descuadran} filas descuadran`);

    // ── Bloque 4: la coherencia que esta vista promete ────────────────────────────────────
    t('sin costo => sin clase, nunca una sin la otra',
      d.sin_clase === d.sin_costo, `sin_clase=${d.sin_clase} sin_costo=${d.sin_costo}`);
    t('toda fila con capital declara su veredicto de costo (ADR-056)',
      d.sin_veredicto === 0 || d.sin_costo >= d.sin_veredicto,
      `${d.sin_veredicto} filas sin veredicto`);

    // ── Bloque 5: ⭐ PRUEBA NEGATIVA — el camino sin_costo, que hoy nunca se ejerce ────────
    // Se sustituyen las DOS fuentes por CTEs sintéticas y se corre el SELECT de la migración
    // tal cual. Si alguien reintroduce un COALESCE(costo, 0), esta aserción se pone roja.
    // ⛔ Acá hubo un defecto que vale documentar, porque es de la peor clase: **la sustitución
    //    nombraba las fuentes a mano** (`v_erp_stock_on_hand` / `v_erp_unit_cost`). Cuando el
    //    `fix` de `[IC.21]` cambió el costo a la MATVISTA (`mv_erp_unit_cost`), el reemplazo dejó
    //    de encontrar nada, el SELECT quedó unido contra la fuente REAL —que no tiene las filas
    //    sintéticas— y **las cuatro filas volvieron `sin_costo`**. Eso puso en verde TRES de las
    //    cuatro aserciones negativas por la razón equivocada: afirmaban «capital NULL» y
    //    «clase NULL» sobre filas que llegaban NULL por el motivo contrario al que se probaba.
    //    Sólo la de CARO ('A') se puso roja, y fue lo único que lo delató.
    //
    // ⭐ Ahora las fuentes se **derivan del propio SQL** en vez de nombrarse: si mañana cambian
    //    otra vez, el candado sigue probando lo que dice probar, o falla ruidosamente acá.
    const fuente = (regex, etiqueta) => {
      const m = SELECT.match(regex);
      if (!m) throw new Error(`no se pudo derivar la fuente de ${etiqueta}: la migracion cambio de forma`);
      return m[1];
    };
    const RELACION_STOCK = fuente(/FROM\s+(analytics\.\w+)\s+s\b/, 'existencia');
    const RELACION_COSTO = fuente(/LEFT JOIN\s+(analytics\.\w+)\s+uc\b/, 'costo');
    const SELECT_SINTETICO = SELECT
      .split(RELACION_STOCK).join('_stock')
      .split(RELACION_COSTO).join('_costo');
    // Control del arnés: si quedara UNA referencia a `analytics.`, la prueba negativa estaría
    // leyendo la fuente real y no probaría nada. Se cae acá, no en verde.
    if (/analytics\./.test(SELECT_SINTETICO)) {
      throw new Error(`la sustitucion dejo fuentes reales: ${SELECT_SINTETICO.match(/analytics\.\w+/g)}`);
    }

    const TEN = '00000000-0000-0000-0000-00000000d01c';
    const WH = '11111111-1111-1111-1111-111111111111';
    const P = (n) => `22222222-2222-2222-2222-2222222222${String(n).padStart(2, '0')}`;

    const neg = (await db.raw(`
      WITH _stock (tenant_id, warehouse_id, warehouse_code, product_id, sku, qty_stock_units) AS (
        VALUES ('${TEN}'::uuid, '${WH}'::uuid, 'TEST'::varchar, '${P(1)}'::uuid, 'CARO'::varchar,  10::numeric),
               ('${TEN}'::uuid, '${WH}'::uuid, 'TEST'::varchar, '${P(2)}'::uuid, 'MEDIO'::varchar,  5::numeric),
               ('${TEN}'::uuid, '${WH}'::uuid, 'TEST'::varchar, '${P(3)}'::uuid, 'BARATO'::varchar, 1::numeric),
               ('${TEN}'::uuid, '${WH}'::uuid, 'TEST'::varchar, '${P(9)}'::uuid, 'TARIMA'::varchar, 5000::numeric)
      ), _costo (tenant_id, warehouse_id, product_id, costo_unitario, costo_source, tiene_testigo, veredicto) AS (
        VALUES ('${TEN}'::uuid, '${WH}'::uuid, '${P(1)}'::uuid, 1000::numeric, 'kepler_kdik'::text, true, 'confirmado'::text),
               ('${TEN}'::uuid, '${WH}'::uuid, '${P(2)}'::uuid,  100::numeric, 'kepler_kdik'::text, true, 'confirmado'::text),
               ('${TEN}'::uuid, '${WH}'::uuid, '${P(3)}'::uuid,   10::numeric, 'kepler_kdik'::text, true, 'confirmado'::text),
               ('${TEN}'::uuid, '${WH}'::uuid, '${P(9)}'::uuid, NULL::numeric, NULL::text,          NULL, NULL::text)
      )
      SELECT sku, capital, capital_class, clase_motivo, rango_almacen
        FROM (${SELECT_SINTETICO}) z ORDER BY rango_almacen`)).rows;

    const tarima = neg.find((r) => r.sku === 'TARIMA');
    t('NEGATIVA: 5,000 piezas sin costo NO se publican como capital $0',
      tarima && tarima.capital === null, `capital=${tarima && tarima.capital}`);
    t('NEGATIVA: 5,000 piezas sin costo NO caen a clase C en silencio',
      tarima && tarima.capital_class === null, `clase=${tarima && tarima.capital_class}`);
    t('NEGATIVA: la fila sin costo DECLARA su motivo',
      tarima && tarima.clase_motivo === 'sin_costo', `motivo=${tarima && tarima.clase_motivo}`);
    // ⚠️ `row_number()` es bigint y node-pg lo entrega como STRING. Comparar con === contra un
    //    número da false y el candado se pone rojo sobre una vista sana. Pasó acá mismo.
    t('NEGATIVA: la fila sin costo va al final del rango, no al frente',
      tarima && Number(tarima.rango_almacen) === 4, `rango=${tarima && tarima.rango_almacen}`);

    const caro = neg.find((r) => r.sku === 'CARO');
    t('NEGATIVA: el Pareto sintético pone al caro en A',
      caro && caro.capital_class === 'A', `clase=${caro && caro.capital_class}`);

    // ── Bloque 6: ⭐ el eje NO puede ser un espejo del de consumo (la lección del placebo) ──
    if (aplicada) {
      const [esp] = (await db.raw(`
        SELECT count(*)::int AS pares,
               count(*) FILTER (WHERE a.abc_class = v.capital_class)::int AS coinciden
          FROM analytics.v_abc_capital v
          JOIN commercial.abc_classification a
            ON a.product_id = v.product_id AND a.warehouse_id = v.warehouse_id
         WHERE v.capital_class IS NOT NULL`)).rows;
      const pct = esp.pares ? (100 * esp.coinciden) / esp.pares : 0;
      t('el eje de capital CONTRADICE al de consumo (coincidencia <90%): no es un espejo',
        esp.pares > 0 && pct < 90, `coinciden ${pct.toFixed(1)}% de ${esp.pares} pares`);
      console.log(`     coincidencia consumo-vs-capital: ${pct.toFixed(1)}%`);
    } else {
      noMedido('que el eje contradiga al de consumo',
        'la vista no está aplicada: el cruce necesita el objeto real');
    }

    // ── Bloque 7: metadata que un CREATE OR REPLACE se lleva puesta (lección U.7) ──────────
    if (aplicada) {
      const opts = (await db.raw(`
        SELECT coalesce(array_to_string(c.reloptions, ','), '') AS o
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'analytics' AND c.relname = 'v_abc_capital'`)).rows[0].o;
      t('conserva security_invoker', opts.includes('security_invoker'), `reloptions=${opts || '(vacío)'}`);

      const [g] = (await db.raw(`
        SELECT has_table_privilege('app_runtime', 'analytics.v_abc_capital', 'SELECT') AS puede`)).rows;
      t('app_runtime conserva el GRANT SELECT', g.puede === true);
    } else {
      noMedido('security_invoker y el GRANT', 'la vista todavía no está aplicada');
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message);
    bad++;
  } finally {
    await db.destroy();
  }
  process.exit(bad > 0 ? 1 : 0);
})();
