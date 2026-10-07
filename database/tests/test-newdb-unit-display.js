/* eslint-disable no-console */
/**
 * CANDADO — LA UNIDAD SE ELIGE Y SE NOMBRA (SO.U / EC.U).
 *
 * Edgar, 2026-09-12: *"aquí debería tener un selector de en qué unidad de medida se quiere ver, y
 * la unidad de medida. Nosotros siempre usaremos por default cajas."* — y después, sobre el resto
 * de las pantallas: *"hay que agregarlo en las pantallas necesarias"*.
 *
 * ── Qué asegura ─────────────────────────────────────────────────────────────────────────────
 *
 * El selector no es cosmético: publica una SEGUNDA cifra. Este candado existe para que esa cifra
 * no sea una invención, y para que el rótulo no sea un relleno.
 *
 *   1. ⭐ La cantidad base del sell-out REPRODUCE a Kepler. Si `sales_daily.units` no fuera la
 *      cantidad base del ERP, el modo "unidad del ERP" estaría publicando otra cosa con ese nombre.
 *   2. ⭐ PRUEBA NEGATIVA — la escalera de rótulos tiene más de un escalón. Si `base_label` fuera
 *      `PZA` en todo, el selector no agregaría nada sobre no tenerlo, y el rótulo sería decorado.
 *   3. ⭐⭐ PRUEBA NEGATIVA — la MEZCLA existe y está medida. Si ningún renglón mezclara unidades
 *      entre columnas, la rama `base_label_mixto` (la que RETIENE el total) nunca se ejercería, y
 *      un camino que nunca corre se lee igual que uno que funciona.
 *   4. La AUSENCIA se conserva. `base_label` llega NULL en miles de celdas y eso tiene que seguir
 *      siendo NULL: rellenarlo con `PZA` por conveniencia es exactamente lo que ADR-056 prohíbe —
 *      y Kepler además guarda ahí el GRAMAJE (`500`, `250`), que no es un nombre de unidad.
 *   5. El divisor de `/compras/existencia-crítica` NO es 1 en todo: si lo fuera, cajas y unidad
 *      nativa serían la misma columna con dos nombres.
 *
 * ⛔ Lo que este candado NO mide: que la PANTALLA muestre lo que el backend manda. Eso es
 * validación visual y se declara pendiente, no se pinta de verde acá.
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
// ⛔ Un campo ausente NO es un cero: Postgres devuelve los alias sin comillas en MINÚSCULAS, y
// `Number(n || 0)` convertía un alias mal escrito en un cero convincente.
const N = (n) => {
  if (n === undefined) throw new Error('N() recibió undefined: alias mal escrito. Un campo ausente '
    + 'no es un cero.');
  return Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
};

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '600s'`);
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  console.log('\n=== CANDADO: la unidad se elige y se nombra (SO.U / EC.U) ===\n');

  // El mes CERRADO anterior: un mes en curso compara un periodo contra sí mismo a medio llenar.
  const [per] = await q(`
    SELECT to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM-DD') AS f,
           to_char(date_trunc('month', current_date) - interval '1 day', 'YYYY-MM-DD')   AS t`);
  console.log(`Periodo: ${per.f} .. ${per.t} (mes cerrado anterior)\n`);

  // ── 1. ⭐ La cantidad base reproduce a Kepler ────────────────────────────────
  //
  // ⚠️ El universo tiene que ser EL MISMO de los dos lados, y la primera version de este bloque
  // lo tuvo mal: filtraba la pierna Wincaja con `channel NOT LIKE 'wincaja%'`, y en
  // `analytics.v_sellout_daily` **el ERP no viaja en `channel` sino en `source`** — la pierna
  // Wincaja trae canales con nombre normal ('mostrador', 'credito'…), asi que ese filtro no
  // excluia NADA. Reportaba +82.99% de diferencia y era mi consulta comparando 1.83M de unidades
  // de tres piernas contra las 999,866 de un solo doctype.
  //
  // La comparacion correcta es pierna contra pierna: `mv_kepler_sales_daily` (la pierna Kepler del
  // sell-out) contra los doctypes de venta de Kepler `U-D` 8/10/12, que son los que esa MV arma.
  console.log('\u2500\u2500 1. \u2b50 El `units` del fact ES la cantidad base de Kepler \u2500\u2500');
  const odsVivo = (await q(`SELECT to_regclass('kepler_ods.kdm2') t`))[0].t;
  if (!odsVivo) {
    nomedido('la identidad contra Kepler', 'kepler_ods.kdm2 no es alcanzable desde esta DB');
  } else {
    const [id] = await q(`
      WITH kep AS (
        SELECT sum(round(NULLIF(regexp_replace(d.c9::text, '[^0-9.-]', '', 'g'), '')::numeric, 4)) AS base
          FROM kepler_ods.kdm2 d
          JOIN kepler_ods.kdm1 h
            ON h.sucursal = d.sucursal AND h.c1 = d.c1 AND h.c2 = d.c2 AND h.c3 = d.c3
           AND h.c4 = d.c4 AND h.c5 = d.c5 AND h.c6 = d.c6
         WHERE d.c2 = 'U' AND d.c3 = 'D' AND btrim(d.c4::text) IN ('8', '10', '12')
           AND h.c9::date BETWEEN $1::date AND $2::date
           AND d.sucursal = btrim(d.c1)),
      fac AS (
        SELECT sum(k.units)::numeric AS base
          FROM analytics.mv_kepler_sales_daily k
         WHERE k.tenant_id = $3 AND k.business_date BETWEEN $1::date AND $2::date)
      SELECT kep.base AS kepler, fac.base AS fact,
             CASE WHEN kep.base > 0 THEN round(100 * (fac.base - kep.base) / kep.base, 4) END AS dif_pct
        FROM kep, fac`, [per.f, per.t, T]);
    if (id.kepler == null || Number(id.kepler) === 0) {
      nomedido('la identidad contra Kepler', 'Kepler no reporta cantidad base en el periodo');
    } else {
      console.log(`     KEPLER U-D 8/10/12 ${N(id.kepler)} u base · FACT ${N(id.fact)} u · dif ${id.dif_pct}%`);
      check('⭐ el `units` que publica el modo "unidad del ERP" reproduce la cantidad base de Kepler',
        Math.abs(Number(id.dif_pct)) <= 2,
        `${id.dif_pct}% — mas de 2 pp significa que ese campo no es lo que el rotulo dice que es`);
    }
  }

  // ── 2. ⭐ PRUEBA NEGATIVA: el rótulo tiene más de un valor ────────────────────────────────
  console.log('\n── 2. ⭐ PRUEBA NEGATIVA: los rótulos son varios, no uno solo ──');
  const [rot] = await q(`
    SELECT count(DISTINCT NULLIF(btrim(upper(base_label)), ''))::int AS distintos,
           count(*) FILTER (WHERE NULLIF(btrim(base_label), '') IS NULL)::int AS sin_rotulo,
           count(*)::int AS celdas
      FROM analytics.v_unit_truth WHERE tenant_id = $1`, [T]);
  const top = await q(`
    SELECT COALESCE(NULLIF(btrim(upper(base_label)), ''), '(sin rotulo)') AS rotulo,
           count(*)::int AS celdas
      FROM analytics.v_unit_truth WHERE tenant_id = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, [T]);
  console.log(`     ${N(rot.celdas)} celdas · ${N(rot.distintos)} rótulos distintos · `
    + `${N(rot.sin_rotulo)} sin rótulo`);
  console.log(`     ${top.map((r) => `${r.rotulo}:${N(r.celdas)}`).join(' · ')}`);
  check('⭐ hay MÁS DE UN rótulo de unidad base',
    rot.distintos >= 2,
    `${rot.distintos} — con uno solo el selector no agregaría nada y el rótulo sería decorado`);
  check('la AUSENCIA de rótulo se conserva (no se rellena con PZA)',
    rot.sin_rotulo > 0,
    'cero celdas sin rótulo sobre >100k: o alguien puso un default, o el campo dejó de ser nulable');

  // ── 3. ⭐⭐ PRUEBA NEGATIVA: la MEZCLA existe, y es la mayoría del dinero ─────────────────
  console.log('\n── 3. ⭐⭐ PRUEBA NEGATIVA: renglones que MEZCLAN unidades entre columnas ──');
  const MIX = `
    WITH v AS (
      SELECT s.product_id, s.warehouse_code, sum(s.monto) AS monto
        FROM analytics.v_sellout_daily s
       WHERE s.tenant_id = $1 AND s.business_date BETWEEN $2::date AND $3::date
         AND s.channel <> 'traspaso' AND s.is_promo = false
       GROUP BY 1, 2),
    r AS (
      SELECT v.product_id, sum(v.monto) AS monto,
             count(DISTINCT NULLIF(btrim(upper(ut.base_label)), ''))::int AS n
        FROM v
        LEFT JOIN analytics.v_unit_truth ut
          ON ut.tenant_id = $1 AND ut.product_id = v.product_id
         AND ut.warehouse_code = v.warehouse_code
       GROUP BY 1)
    SELECT count(*) FILTER (WHERE n > 1)::int  AS mezclan,
           count(*) FILTER (WHERE n = 1)::int  AS homogeneos,
           count(*) FILTER (WHERE n = 0)::int  AS sin_rotulo,
           count(*)::int                       AS filas,
           round(sum(monto) FILTER (WHERE n > 1)::numeric, 0) AS venta_mezclan,
           round(sum(monto)::numeric, 0)                      AS venta_total
      FROM r`;
  const [mx] = await q(MIX, [T, per.f, per.t]);
  const pctDinero = mx.venta_total > 0 ? 100 * Number(mx.venta_mezclan) / Number(mx.venta_total) : 0;
  console.log(`     ${N(mx.filas)} renglones · mezclan ${N(mx.mezclan)} · homogéneos `
    + `${N(mx.homogeneos)} · sin rótulo ${N(mx.sin_rotulo)}`);
  console.log(`     la mezcla vale $${N(mx.venta_mezclan)} de $${N(mx.venta_total)} = `
    + `${pctDinero.toFixed(1)}% del dinero`);
  check('⭐⭐ la mezcla EXISTE: la rama que retiene el total de la fila se ejerce de verdad',
    mx.mezclan > 0,
    'CERO renglones mixtos: o el rótulo se está aplanando antes de llegar, o el periodo quedó vacío');
  check('y NO es marginal: por eso el rótulo va en la CELDA y no en la fila',
    pctDinero > 10,
    `${pctDinero.toFixed(1)}% — si fuera marginal, rotular cada celda sería ruido y bastaría la fila`);
  console.log('     ⚠️  Esto NO es un defecto del dato: Kepler guarda la cantidad base y Wincaja la');
  console.log('        de su unidad de venta (ADR-055). Las dos celdas son correctas en SU unidad;');
  console.log('        lo que no existe es la SUMA de las dos.');

  // ── 4. El divisor del reabasto no es 1 en todo ───────────────────────────────────────────
  console.log('\n── 4. PRUEBA NEGATIVA: el divisor de /compras/existencia-crítica no es 1 ──');
  const plan = (await q(`SELECT to_regclass('analytics.replenishment_plan') t`))[0].t;
  if (!plan) {
    nomedido('el divisor del reabasto', 'analytics.replenishment_plan no existe en esta DB');
  } else {
    const [d] = await q(`
      SELECT count(*)::int filas,
             count(*) FILTER (WHERE GREATEST(COALESCE(display_bf, bf, 1), 1) > 1)::int con_divisor,
             count(DISTINCT GREATEST(COALESCE(display_bf, bf, 1), 1))::int divisores_distintos
        FROM analytics.replenishment_plan WHERE tenant_id = $1`, [T]);
    console.log(`     ${N(d.filas)} filas · con divisor > 1: ${N(d.con_divisor)} · `
      + `${N(d.divisores_distintos)} divisores distintos`);
    check('el divisor por almacén es real (hay filas con factor > 1)',
      d.con_divisor > 100,
      `${N(d.con_divisor)} — con el divisor en 1 en todo, "cajas" y "unidad del ERP" serían la `
      + 'misma columna con dos nombres');
  }

  // ── 5. Lo que este candado NO mide ───────────────────────────────────────────────────────
  console.log('\n── 5. Lo que este candado no mide ──');
  console.log('     ⚠️  Que la PANTALLA muestre lo que el backend manda: eso es validación visual');
  console.log('        (los dev servers los levanta Edgar) y queda declarada pendiente.');
  console.log('     ⚠️  `KG` y `KGS` son el MISMO kilo escrito de dos formas y el conteo los lee');
  console.log('        como una mezcla. Medido: 1 renglón / $2,998. Se deja como está — normalizar');
  console.log('        rótulos en silencio es el primer paso para normalizar unidades en silencio.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
