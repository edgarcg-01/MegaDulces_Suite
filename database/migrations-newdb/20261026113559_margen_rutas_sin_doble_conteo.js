'use strict';
/**
 * `[AB.38]` — **Rentabilidad cuenta cada venta de ruta UNA vez.** Hermana de `[AB.37]` (sell-out).
 *
 * `mv_sales_blended` (la venta y el costo de `/comercial/rentabilidad`, del Command Center y de
 * `/comercial/salidas`) une las rutas desde `analytics.sales_daily`, y esa tabla trae Padre Hidalgo
 * dos veces: el importer manda al mismo `RUTA-NN` lo que entra por el Kepler de 01 (`01-00N`, desde
 * el 20-ago) y lo que manda la camioneta. El tramo pasa a leer el envío (`route_push_lines`), que es
 * la única fuente completa (al Kepler de 01 le faltan 27 días enteros desde el 1-sep; ver AB.37).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-26, dos corridas iguales) ───────────────────
 *  · Venta de ruta: jul $2,841,330 → $2,834,952 · ago $4,981,875 → $4,134,669 ·
 *    sep $7,242,483 → $4,785,269 · oct (al 25) $5,898,106 → $3,805,967.
 *  · Venta total de la matview: sep $57.38 M → $54.93 M; oct $50.45 M → $48.36 M. Jun sin cambio.
 *  · ⭐ El margen % casi no se mueve (sep 11.070 → 11.071; oct 10.657 → 10.632): el costo de este
 *    tramo es venta ÷ (1 + margen del catálogo), así que al duplicar la venta se duplicaba también
 *    el costo. Lo inflado eran los PESOS — venta y utilidad —, no el porcentaje.
 *  · Tickets: iguales antes y después (sep 47,338 → 47,330): el importer no los duplicaba. Es el
 *    testigo de que el tramo nuevo cuenta los mismos documentos.
 *  · Canal y tickets por canal = `sales_daily` al peso donde ésta no duplica (Canindo sep–oct).
 *  · Ejercida up → down en la base local de pruebas con siembra sintética y ROLLBACK: la ruta pasa
 *    de 600 al envío (300) y vuelve; índices, lectores, comentario y rollup se conservan.
 *
 * ⛔ **ESCRITURA PESADA: se aplica FUERA DE HORARIO.** Reconstruye 1.8 GB (la nueva se arma al lado
 *    mientras la vieja sigue sirviendo; el candado exclusivo dura sólo el cambio de nombre y el
 *    rollup `mv_profitability_sales_agg`, 76 MB). Mientras corre, la migración retiene el candado
 *    de migraciones. Tiempo de construcción en prod: NO MEDIDO (lo imprime la propia migración).
 * ⚠️ NO toca el costo (D19 — que salga de Kepler — es un cambio aparte, con su antes/después).
 *
 * Idempotente: si quedó una construcción a medias, la borra antes de empezar.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_sales_blended';
const AGG = 'analytics.mv_profitability_sales_agg';

/** Tramo 1 (Kepler de sucursal, del ODS): VERBATIM de prod (pg_get_viewdef, 2026-10-26). */
const CABEZA = ` SELECT tenant_id,
    product_id,
    warehouse_id,
    channel,
    sale_date,
    unit_kind,
    sum(units) AS units,
    sum(revenue) AS revenue,
    sum(cost) AS cost,
    sum(tickets) AS tickets,
    max(updated_at) AS updated_at
   FROM ( SELECT k.tenant_id,
            k.product_id,
            w.id AS warehouse_id,
                CASE k.channel
                    WHEN 'mostrador'::text THEN 'tienda'::text
                    WHEN 'credito'::text THEN 'contado_nf'::text
                    ELSE k.channel
                END AS channel,
            k.business_date AS sale_date,
            k.unit_kind,
            k.units,
            k.monto AS revenue,
            round(k.monto / (1::numeric + COALESCE(p.markup_pct, 0::numeric) / 100.0), 2) AS cost,
                CASE
                    WHEN row_number() OVER (PARTITION BY k.tenant_id, k.business_date, k.source_branch, k.product_id, k.channel ORDER BY k.unit_kind) = 1 THEN COALESCE(ktc.tickets, 0::bigint)
                    ELSE 0::bigint
                END AS tickets,
            k.business_date::timestamp with time zone AS updated_at
           FROM analytics.mv_kepler_sales_daily k
             JOIN commercial.warehouses w ON w.tenant_id = k.tenant_id AND w.code::text = k.warehouse_code::text AND w.deleted_at IS NULL
             LEFT JOIN catalog.products p ON p.id = k.product_id
             LEFT JOIN analytics.v_kepler_ticket_count ktc ON ktc.tenant_id = k.tenant_id AND ktc.business_date = k.business_date AND ktc.source_branch = k.source_branch AND ktc.product_id = k.product_id AND ktc.channel = k.channel
          WHERE k.product_deleted = false AND (EXISTS ( SELECT 1
                   FROM analytics.v_branch_erp_cutover x
                  WHERE x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch AND k.business_date >= x.cutover_date))
        UNION ALL`;

/** Tramo 3 (Wincaja antes del corte) y el agregado final: VERBATIM. */
const COLA = `        UNION ALL
         SELECT mw.tenant_id,
            mw.product_id,
            w.id AS warehouse_id,
            'wincaja_'::text || mw.channel AS channel,
            mw.business_date AS sale_date,
            mw.unit_kind,
            mw.units,
            mw.monto AS revenue,
            mw.costo AS cost,
                CASE
                    WHEN row_number() OVER (PARTITION BY mw.tenant_id, mw.business_date, mw.source_branch, mw.product_id, mw.channel ORDER BY mw.unit_kind) = 1 THEN COALESCE(wtc.tickets, 0::bigint)
                    ELSE 0::bigint
                END AS tickets,
            mw.business_date::timestamp with time zone AS updated_at
           FROM analytics.mv_wincaja_sales_daily mw
             JOIN commercial.warehouses w ON w.tenant_id = mw.tenant_id AND w.code::text = mw.warehouse_code::text AND w.deleted_at IS NULL
             LEFT JOIN analytics.v_wincaja_ticket_count wtc ON wtc.tenant_id = mw.tenant_id AND wtc.business_date = mw.business_date AND wtc.source_branch = mw.source_branch AND wtc.product_id = mw.product_id AND wtc.channel = mw.channel
          WHERE mw.product_deleted = false AND (mw.wincaja_only = true OR (EXISTS ( SELECT 1
                   FROM analytics.v_branch_erp_cutover x
                  WHERE x.tenant_id = mw.tenant_id AND x.wincaja_source_branch = mw.source_branch AND mw.business_date < x.cutover_date)))) q
  GROUP BY tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind`;

/** Tramo 2 VIEJO — rutas desde `sales_daily`, que trae Padre Hidalgo dos veces. Sólo para el `down`. */
const RUTAS_SALES_DAILY = `         SELECT sd.tenant_id,
            sd.product_id,
            sd.warehouse_id,
            sd.channel,
            sd.sale_date,
            sd.unit_kind,
            sd.units,
            sd.revenue,
            sd.cost,
            sd.tickets,
            sd.updated_at
           FROM analytics.sales_daily sd
             JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.channel !~~ 'wincaja_%'::text AND w.code::text ~~ 'RUTA-%'::text AND sd.sale_date >= '2026-07-01'::date`;

/**
 * Tramo 2 NUEVO — rutas = el envío de cada camioneta, una vez. Mismas reglas que `sales_daily`
 * (medidas al peso en Canindo sep–oct): canal `tienda` si no hay cliente (contado), si no `credito`;
 * costo = venta ÷ (1 + margen del catálogo), NULL sin margen; tickets = folios distintos. Cantidad e
 * `unit_kind` como el tramo 1: en la base de Kepler, `weight` sólo si la unidad es KG. Desde el corte
 * de su plaza, igual que `v_sellout_daily` ([AB.37]).
 */
const RUTAS_ENVIO = `         SELECT rpl.tenant_id,
            p.id AS product_id,
            w.id AS warehouse_id,
                CASE
                    WHEN NULLIF(btrim(rpl.cliente), ''::text) IS NULL THEN 'tienda'::text
                    ELSE 'credito'::text
                END AS channel,
            rpl.business_date AS sale_date,
                CASE
                    WHEN upper(btrim(rpl.unidad)) = ANY (ARRAY['KGS'::text, 'KG'::text, 'KILO'::text, 'KILOS'::text]) THEN 'weight'::text
                    ELSE 'piece'::text
                END AS unit_kind,
            sum(rpl.qty) AS units,
            sum(rpl.importe) AS revenue,
            round(sum(rpl.importe) / NULLIF(1::numeric + p.markup_pct / 100.0, 0::numeric), 2) AS cost,
            count(DISTINCT rpl.folio) AS tickets,
            max(rpl.imported_at) AS updated_at
           FROM analytics.route_push_lines rpl
             JOIN commercial.warehouses w ON w.tenant_id = rpl.tenant_id AND w.deleted_at IS NULL AND w.code::text = ('RUTA-'::text || rpl.route_no)
             JOIN catalog.products p ON p.tenant_id = rpl.tenant_id AND btrim(p.sku::text) = btrim(rpl.sku) AND p.deleted_at IS NULL
          WHERE rpl.business_date >= CASE WHEN rpl.route_no ~ '^50[0-9]$' THEN '2026-08-13'::date ELSE '2026-07-01'::date END
            AND rpl.business_date <= (now() AT TIME ZONE 'America/Mexico_City'::text)::date
          GROUP BY rpl.tenant_id, p.id, w.id, (
                CASE
                    WHEN NULLIF(btrim(rpl.cliente), ''::text) IS NULL THEN 'tienda'::text
                    ELSE 'credito'::text
                END), rpl.business_date, (
                CASE
                    WHEN upper(btrim(rpl.unidad)) = ANY (ARRAY['KGS'::text, 'KG'::text, 'KILO'::text, 'KILOS'::text]) THEN 'weight'::text
                    ELSE 'piece'::text
                END), p.markup_pct`;

const COMENTARIO_NUEVO = 'PARIDAD/ODS: venta real consolidada Kepler(mv_kepler)+rutas(route_push_lines: el envío de cada camioneta, una vez; [AB.38] quitó sales_daily RUTA-%, que contaba Padre Hidalgo dos veces)+Wincaja(mv_wincaja), mismo schema que sales_daily. Fuente de /comercial/rentabilidad, de los KPIs network del Command Center y del scope de sucursales de /comercial/salidas. SB.1: el corte por sucursal sale de analytics.v_branch_erp_cutover. ⚠️ CUELGA de mv_kepler_sales_daily: un DROP...CASCADE de ese matview la mata (pasó 2026-09-08). Refresh nightly.';
const COMENTARIO_VIEJO = 'PARIDAD/ODS: venta real consolidada Kepler(mv_kepler)+rutas(sales_daily RUTA-%)+Wincaja(mv_wincaja), mismo schema que sales_daily. Fuente de los KPIs network del Command Center y del scope de sucursales de /comercial/salidas. SB.1: el corte por sucursal NO va en literales — sale de analytics.v_branch_erp_cutover, igual que v_sellout_daily. ⚠️ CUELGA de mv_kepler_sales_daily: un DROP...CASCADE de ese matview la mata (pasó 2026-09-08). Refresh nightly.';

/** Índices, lectores y comentario de una matview, leídos de la base: se re-crean idénticos. */
async function meta(knex, rel) {
  const [schema, name] = rel.split('.');
  const idx = (await knex.raw('SELECT indexdef FROM pg_indexes WHERE schemaname = ? AND tablename = ?', [schema, name])).rows.map((r) => r.indexdef);
  const lectores = (await knex.raw(
    `SELECT DISTINCT a.grantee::regrole::text r FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = ?::regclass AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner AND a.grantee <> 0`, [rel])).rows.map((r) => r.r);
  const comentario = (await knex.raw('SELECT obj_description(?::regclass) c', [rel])).rows[0].c;
  return { idx, lectores, comentario };
}

async function poner(knex, rel, m, comentario) {
  for (const i of m.idx) await knex.raw(i);
  for (const r of m.lectores) await knex.raw(`GRANT SELECT ON ${rel} TO "${r}"`);
  // COMMENT no acepta parámetros: literal con las comillas duplicadas.
  if (comentario) await knex.raw(`COMMENT ON MATERIALIZED VIEW ${rel} IS '${comentario.replace(/'/g, "''")}'`);
}

/**
 * Reemplaza la matview. La nueva se construye a un lado mientras la vieja sigue sirviendo, se
 * compara, y sólo al final se cambia: el candado exclusivo dura el cambio de nombre y el rollup, no
 * la construcción. Al terminar no conviven: la vieja se borra y la nueva toma su nombre.
 */
async function reemplazar(knex, tramoRutas, comentario, etiqueta) {
  const deps = (await knex.raw(
    `SELECT DISTINCT d.ev_class::regclass::text o FROM pg_depend p JOIN pg_rewrite d ON d.oid = p.objid
      WHERE p.refobjid = ?::regclass AND p.classid = 'pg_rewrite'::regclass AND d.ev_class <> ?::regclass`, [MV, MV])).rows.map((r) => r.o);
  // El CASCADE sólo puede llevarse el rollup. Si alguien colgó otra cosa, se frena: no se borra en
  // silencio un objeto que esta migración no sabe recrear.
  if (deps.some((d) => d !== AGG)) throw new Error(`[${etiqueta}] dependen de ${MV} objetos que no sé recrear: ${deps.join(', ')}`);
  const mMv = await meta(knex, MV);
  const mAgg = deps.length ? await meta(knex, AGG) : null;
  const cuerpoAgg = deps.length ? (await knex.raw('SELECT pg_get_viewdef(?::regclass, true) d', [AGG])).rows[0].d.replace(/;\s*$/, '') : null;

  const tmp = `${MV}_${etiqueta.toLowerCase()}`;
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${tmp}`);
  const t0 = Date.now();
  await knex.raw(`CREATE MATERIALIZED VIEW ${tmp} AS\n${CABEZA}\n${tramoRutas}\n${COLA}\nWITH DATA`);
  console.log(`  · [${etiqueta}] ${tmp} construida en ${Math.round((Date.now() - t0) / 1000)} s`);

  // Compuerta: fuera de las rutas, la nueva es la vieja. Meses cerrados; la vieja es del último
  // refresco, así que se admite el asentamiento de ese lapso (0.5 %, el umbral de SD.1).
  const cmp = (await knex.raw(`
    WITH r AS (SELECT id FROM commercial.warehouses WHERE code ~~ 'RUTA-%'),
    a AS (SELECT to_char(sale_date, 'YYYY-MM') mes, sum(revenue) v FROM ${MV} WHERE warehouse_id NOT IN (SELECT id FROM r)
            AND sale_date < date_trunc('month', current_date) AND sale_date >= date_trunc('month', current_date) - interval '6 months' GROUP BY 1),
    b AS (SELECT to_char(sale_date, 'YYYY-MM') mes, sum(revenue) v FROM ${tmp} WHERE warehouse_id NOT IN (SELECT id FROM r)
            AND sale_date < date_trunc('month', current_date) AND sale_date >= date_trunc('month', current_date) - interval '6 months' GROUP BY 1)
    SELECT a.mes, a.v vieja, b.v nueva, abs(a.v - COALESCE(b.v, 0)) / NULLIF(a.v, 0) * 100 pct FROM a LEFT JOIN b ON b.mes = a.mes ORDER BY 1`)).rows;
  for (const c of cmp) console.log(`  · [${etiqueta}] fuera de rutas ${c.mes}: vieja ${Math.round(c.vieja)} · nueva ${Math.round(c.nueva)} (Δ ${Number(c.pct).toFixed(3)} %)`);
  if (!cmp.length || cmp.some((c) => !(Number(c.pct) <= 0.5))) throw new Error(`[${etiqueta}] la venta fuera de rutas se movió: no se reemplaza`);

  await knex.raw(`DROP MATERIALIZED VIEW ${MV} CASCADE`);
  await knex.raw(`ALTER MATERIALIZED VIEW ${tmp} RENAME TO ${MV.split('.')[1]}`);
  await poner(knex, MV, mMv, comentario);
  if (cuerpoAgg) {
    await knex.raw(`CREATE MATERIALIZED VIEW ${AGG} AS ${cuerpoAgg} WITH DATA`);
    await poner(knex, AGG, mAgg, mAgg.comentario);
    // La compuerta de [MR.8.5b]: re-agregar el rollup da el fact al centavo, en cada ventana.
    const v = (await knex.raw(`SELECT a.window_days w, abs(a.rev - f.rev) d FROM
        (SELECT window_days, sum(revenue) rev FROM ${AGG} GROUP BY 1) a
        CROSS JOIN LATERAL (SELECT COALESCE(sum(revenue), 0) rev FROM ${MV} WHERE sale_date >= CURRENT_DATE - a.window_days) f`)).rows;
    if (!v.length || v.some((x) => !(Number(x.d) <= 0.01))) throw new Error(`[${etiqueta}] el rollup no cuadra con el fact: ${JSON.stringify(v)}`);
    console.log(`  ✓ [${etiqueta}] rollup re-creado, al centavo en ${v.length} ventanas`);
  }
  console.log(`  ✓ [${etiqueta}] ${MV} reemplazada · ${mMv.idx.length} índices · lectores: ${mMv.lectores.join(', ')}`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '15s'`);
  await reemplazar(knex, RUTAS_ENVIO, COMENTARIO_NUEVO, 'AB38');
  // La ruta, ya en la matview, contra el envío: mes por mes, al peso.
  const malos = (await knex.raw(`
    WITH m AS (SELECT to_char(b.sale_date, 'YYYY-MM') mes, sum(b.revenue) v FROM ${MV} b JOIN commercial.warehouses w ON w.id = b.warehouse_id
                WHERE w.code ~~ 'RUTA-%' AND b.channel !~~ 'wincaja_%' AND b.sale_date >= DATE '2026-07-01' GROUP BY 1),
    e AS (SELECT to_char(sale_date, 'YYYY-MM') mes, sum(revenue) v FROM (${RUTAS_ENVIO}) x GROUP BY 1)
    SELECT m.mes, m.v, e.v e FROM m FULL JOIN e ON e.mes = m.mes WHERE abs(COALESCE(m.v, 0) - COALESCE(e.v, 0)) > 1`)).rows;
  if (malos.length) throw new Error(`[AB38] la ruta no es el envío: ${JSON.stringify(malos)}`);
  console.log('  ✓ [AB38] la ruta de la matview = el envío, mes por mes');
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve el tramo de `sales_daily` y el comentario de antes. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '15s'`);
  await reemplazar(knex, RUTAS_SALES_DAILY, COMENTARIO_VIEJO, 'AB38DOWN');
};
