/**
 * [VSO.18] El motor de promos era CIEGO a Kepler — y se volvía más ciego cada mes.
 *
 * ── Qué se midió, antes de tocar nada ────────────────────────────────────────────────────
 * `analytics.v_seller_sales_lines` es el universo con el que se CALCULA Y SE PAGA un incentivo.
 * Leía de `wincaja.v_sales_lines` + `analytics.route_push_lines`, y **de `kepler_ods` no leía
 * nada**. No estaba mal cuando se escribió: cuando nació, todo era Wincaja. Se pudre un poco con
 * cada cutover, y nadie lo notó **porque sigue devolviendo números** — un cero se investiga, un
 * número más chico se cobra.
 *
 * Cobertura del motor contra el sell-out, medida en prod el 2026-09-29:
 *
 *   ene 94.5% · feb 88.3% · mar 85.4% · abr 82.6% · may 83.1% · jun 82.6%
 *   jul 66.5%  ← Padre Hidalgo cortó el 27-jun
 *   ago 56.8%  ← Canindo cortó el 15-ago
 *   sep 31.7%  ← Morelia Madero 08-sep y Abastos 19-sep
 *
 * Los tres escalones caen EXACTAMENTE en los cortes. Por canal, en septiembre:
 * mostrador **24%**, mayoreo **23%**, vecinal **14%**.
 *
 * ⛔ **RUTA NO estaba afectado, y conviene decirlo**: la venta de camioneta sube por
 * `route_push_lines`, que el motor sí tiene (jun–sep: 6.0/7.4/7.3/6.0 MDP y ~1,500–2,000 clientes
 * distintos, sin una sola caída en los cortes). El canal `ruta` de Kepler es residual — UN
 * documento en agosto, con el cliente literal `RUTA 28`. Una primera lectura mía dijo que las
 * promos de ruta pagaban a la mitad: **era falso** y la medición lo corrigió.
 *
 * ── Qué hace esta migración ──────────────────────────────────────────────────────────────
 * Agrega la pierna Kepler a grano de LÍNEA, con cliente y vendedor, respetando el corte.
 *
 * ⚠️ El decode de canal es una **segunda copia** del que vive en `mv_kepler_sales_daily`, y eso
 * es deuda declarada, no un descuido: la alternativa era rebasar esa matvista sobre esta vista y
 * reconstruir 289 MB con sus dependientes. Se elige la copia **y se le pone candado**:
 * `test-newdb-promo-engine-coverage.js` exige que las dos coincidan por canal y por mes, así que
 * si alguien toca una y no la otra, se pone rojo. Una copia medida no es una copia suelta.
 *
 * Validado contra el árbitro antes de escribirse — ago-2026, mismo filtro de corte:
 *   pierna nueva   mostrador 15.95 · mayoreo 7.38 · vecinal 2.03 · ruta 0.38 MDP
 *   mv_kepler_...  mostrador 15.95 · mayoreo 7.38 · vecinal 2.03 · ruta 0.38 MDP
 *
 * ⚠️ El vocabulario de canal del motor de promos NO es el del sell-out: acá es
 * `ruta|vecinal|mayoreo|mostrador` (lo que declara la tool de la IA), así que la `preventa`
 * canónica entra como `vecinal` y `contado_nf` como `mostrador`, igual que hace la pierna Wincaja.
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** La pierna Kepler, a grano de línea. Se define una vez y se usa en el up. */
const KEPLER_LEG = `
  SELECT '${TENANT}'::uuid                                   AS tenant_id,
         h.c9::date                                          AS business_date,
         btrim(l.c8)                                         AS sku,
         p.id                                                AS product_id,
         abs(COALESCE(l.c9::numeric, 0))                     AS qty,
         round(COALESCE(NULLIF(regexp_replace(l.c13::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2) AS importe,
         -- El folio de Kepler NO es único entre doctypes (lección de [reference_kepler_orden_entrada_xa2001]),
         -- así que el "ticket" se identifica con doctype + folio. tickets cuenta DISTINCT de esto.
         btrim(h.c4::text) || '-' || btrim(h.c6)              AS consecutivo,
         NULLIF(btrim(h.c10), '')                            AS cliente,
         CASE
           WHEN btrim(v.c3) ILIKE 'RUTA VECINAL%' OR btrim(h.c12) ~ '^[0-9]+V[0-9]' THEN 'vecinal'
           WHEN btrim(v.c3) ILIKE 'RUTA %'        OR btrim(h.c12) ~ '^1V'           THEN 'ruta'
           WHEN btrim(h.sucursal) = '06' AND h.c4::integer = 10 AND btrim(h.c67) ~ '^500[1-9]$' THEN 'ruta'
           WHEN h.c4::integer = 8                                                   THEN 'mayoreo'
           ELSE 'mostrador'
         END                                                 AS canal,
         COALESCE(NULLIF(btrim(h.c12), ''), '(sin vendedor)') AS vendedor,
         'kepler'::text                                      AS vendedor_origen,
         NULL::text                                          AS route_no,
         CASE WHEN abs(COALESCE(l.c9::numeric, 0)) <> 0
              THEN round(COALESCE(NULLIF(regexp_replace(l.c13::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2)
                   / abs(COALESCE(l.c9::numeric, 0))
              ELSE NULL::numeric END                         AS precio_unitario,
         btrim(h.sucursal)                                   AS source_branch
    FROM kepler_ods.kdm1 h
    JOIN kepler_ods.kdm2 l
      ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
     AND l.c2 = h.c2 AND l.c3 = h.c3
     AND l.c4::integer = h.c4::integer AND l.c5::integer = h.c5::integer
     AND btrim(l.c6) = btrim(h.c6)
    LEFT JOIN kepler_ods.kduv v
      ON btrim(v.sucursal) = btrim(h.sucursal) AND btrim(v.c2) = btrim(h.c12)
    JOIN catalog.products p
      ON p.tenant_id = '${TENANT}'::uuid AND btrim(p.sku::text) = btrim(l.c8) AND p.deleted_at IS NULL
   WHERE h.c2 = 'U' AND h.c3 = 'D' AND h.c4::integer IN (8, 10, 12)
     -- ⛔ Anti doble conteo entre réplicas: cada base de sucursal trae copias de documentos de
     -- otras. Sin esto, la venta de 8 Esquinas de oct-dic 2025 (que lleva c1='02') se contaría
     -- dos veces. Medido: los 32,274 documentos existen en las DOS réplicas.
     AND btrim(h.c1) = btrim(h.sucursal)
     AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'          -- cancelado
     AND COALESCE(btrim(l.c11), '') <> 'SER'                    -- servicio, no mercancía
     AND abs(COALESCE(l.c9::numeric, 0)) > 0
     AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date
     -- El corte sale del RESOLVEDOR, nunca de un literal ([SB.1]).
     AND EXISTS (
       SELECT 1 FROM analytics.v_branch_erp_cutover x
        WHERE x.tenant_id = '${TENANT}'::uuid
          AND x.kepler_code = btrim(h.sucursal)
          AND h.c9::date >= x.cutover_date)`;

exports.up = async function up(knex) {
  const [{ exists }] = (await knex.raw(
    `SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'analytics' AND c.relname = 'v_seller_sales_lines') AS exists`)).rows;
  if (!exists) {
    // eslint-disable-next-line no-console
    console.log('  ⓘ analytics.v_seller_sales_lines no existe en este destino — nada que extender.');
    return;
  }

  const antes = (await knex.raw(
    `SELECT canal, round(sum(importe)::numeric, 2) AS mdp
       FROM analytics.v_seller_sales_lines
      WHERE business_date >= date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City'))::date
      GROUP BY 1 ORDER BY 1`)).rows;

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_kepler_seller_lines AS ${KEPLER_LEG}`);
  await knex.raw(`COMMENT ON VIEW analytics.v_kepler_seller_lines IS
    '[VSO.18] Venta Kepler a grano de LINEA con cliente y vendedor, filtrada por v_branch_erp_cutover. Alimenta v_seller_sales_lines (motor de promos), que antes solo veia Wincaja: su cobertura habia caido de 94.5% (ene-2026) a 31.7% (sep-2026), un escalon por cutover. Cuadra con mv_kepler_sales_daily por canal y mes -- lo vigila test-newdb-promo-engine-coverage.js.'`);

  const defVieja = (await knex.raw(
    `SELECT pg_get_viewdef('analytics.v_seller_sales_lines'::regclass, true) AS d`)).rows[0].d;
  // `CREATE OR REPLACE` exige MISMAS columnas en el mismo orden: se reusa la definición viva y se
  // le agrega la pierna. Así no se reescribe —ni se puede desincronizar— lo que ya funcionaba.
  const defNueva = `${defVieja.replace(/;\s*$/, '')}\nUNION ALL\n${KEPLER_LEG}`;
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_seller_sales_lines AS ${defNueva}`);

  const despues = (await knex.raw(
    `SELECT canal, round(sum(importe)::numeric, 2) AS mdp
       FROM analytics.v_seller_sales_lines
      WHERE business_date >= date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City'))::date
      GROUP BY 1 ORDER BY 1`)).rows;

  const mapa = (rows) => Object.fromEntries(rows.map((r) => [r.canal, Number(r.mdp)]));
  const a = mapa(antes); const b = mapa(despues);
  // eslint-disable-next-line no-console
  console.log('  ANTES/DESPUÉS del mes en curso, por canal (el motor de promos):');
  let subio = 0;
  for (const canal of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[canal] || 0; const y = b[canal] || 0;
    if (y > x + 0.01) subio++;
    // eslint-disable-next-line no-console
    console.log(`    ${canal.padEnd(11)} $${x.toLocaleString('en-US')} → $${y.toLocaleString('en-US')}`);
  }
  // ⛔ Un cambio que no mueve ningún número es un cambio que no se aplicó. Se exige que AL MENOS
  // un canal crezca: si el destino no tiene Kepler, el `if (!exists)` de arriba ya salió antes.
  if (!subio) throw new Error('La pierna Kepler no aportó nada: ningún canal creció. Revisar antes de dar por buena la migración.');
};

exports.down = async function down(knex) {
  const defActual = (await knex.raw(
    `SELECT pg_get_viewdef('analytics.v_seller_sales_lines'::regclass, true) AS d`)).rows[0].d;
  const i = defActual.lastIndexOf('UNION ALL');
  if (i > 0) {
    await knex.raw(`CREATE OR REPLACE VIEW analytics.v_seller_sales_lines AS ${defActual.slice(0, i)}`);
  }
  await knex.raw('DROP VIEW IF EXISTS analytics.v_kepler_seller_lines');
};
