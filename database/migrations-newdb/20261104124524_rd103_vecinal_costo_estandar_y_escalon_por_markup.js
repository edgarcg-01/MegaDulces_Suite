'use strict';
/**
 * `[RD.103.2]` — Lo que el motor necesita para pagar a las vecinales con LA REGLA QUE YA SE USA:
 * el costo de su venta, un escalón por markup y el piso de venta del chofer.
 *
 * ── De dónde sale la regla (2026-11-04) ─────────────────────────────────────────────────────
 * El libro de Comercial «COMISIONES RV <plaza> 2026» (Morelia completo; Padre Hidalgo, la hoja de
 * gasto), leído con fórmulas — `FASE_RD_COMISIONES_MOTOR.md` §`[RD.103.0]`:
 *  · la tasa total sale de un escalón por MARKUP (subtotal ÷ costo − 1), no por venta:
 *    < 12.01 % → 2.73 · < 13.01 % → 2.95 · < 15.01 % → 3.13 · < 18.01 % → 3.41 · < 25 % → 4.00;
 *  · 80 % chofer / 20 % supervisor, los dos sobre el subtotal (el motor ya lo hace: `share_supervisor_pct`);
 *  · el chofer cobra sólo si la venta de la catorcena pasa de $129,999.99, y se le resta su sueldo
 *    base de banco (el motor ya resta `nomina_banco`);
 *  · el periodo es la catorcena — el MISMO calendario de `commission_periods` (la 21 va del 8 al
 *    21 de octubre en los dos), así que no hay calendario nuevo.
 *
 * ── Lo medido antes (pg-prod, sólo lectura, sid 7688376744939610156, 2026-11-04) ─────────────
 *  · El costo vecinal no llega al motor: `v_route_sales_lines` lo trae NULL y el motor lo busca en
 *    `v_rd_commission_cogs` (sólo Ruta Directa) o en `costo_wincaja`. Sin costo no hay markup.
 *  · Árbitro del costo: la columna COSTO del libro en los 27 días que ya cuadran AL CENTAVO en
 *    venta contra el neto de `kdm1` (sucursal 07, `2V001`/`2V003`, catorcenas 20–22):
 *        cantidad × kdii.c77 (00, si no otra) .... error mediano 0.51 %, 18 de 27 dentro de ±1 %
 *        kdm2.c62 ............................... error mediano 35 %   (mezcla unidades, RD.103.0)
 *    ⚠️ `c77` es el costo estándar de HOY, no el de la fecha de venta: se declara en
 *    `costo_status = 'estandar_kepler_hoy'` y el motor lo publica como su propio veredicto.
 *
 * ── Lo que hace ─────────────────────────────────────────────────────────────────────────────
 *  1. `v_rd_route_daily`: la rama vecinal publica `costo` = Σ cantidad × `kdii.c77` de la sucursal `00`
 *     (9,569 de 9,581 SKUs; ordenar los 86k renglones de `kdii` por sucursal costaba +2.2 s).
 *     Un día con algún SKU sin costo sale `estandar_kepler_incompleto`: medido, < 0.01 % del
 *     importe en 7 de 8 rutas y 1.19 % en 1V001.
 *     Push y Wincaja quedan EXACTAMENTE iguales. Mismas columnas, mismo orden y tipos.
 *  2. `v_rd_commission_sales`: + `costo_vecinal` AL FINAL (un CREATE OR REPLACE sólo admite
 *     columnas nuevas al final) y `costo_vecinal_status`.
 *  3. `commission_scales.gate_field` admite `markup`; + `piso_chofer_venta` (NULL = sin piso).
 *  4. `commission_run_lines.scale_id`: con qué versión se calculó CADA línea — con un tabulador
 *     por familia, el `scale_id` de la corrida ya no alcanza para explicar una línea vecinal.
 *
 * ⛔ Compatible con la API desplegada (expand): todo es nulable o con DEFAULT, y ninguna escala
 *    vecinal se siembra aquí. La API vieja elige la escala vigente SIN mirar la familia: una
 *    escala vecinal sembrada hoy podría pagarle a Ruta Directa con ella. La versión vecinal se
 *    ESTRENA por `POST /commercial/commissions/scales` con `familia: 'vecinal'`, después de
 *    desplegar el código que filtra por familia (D-V1: la persona estrena, no la migración).
 * ⚠️ La matview `mv_rd_route_daily_200d` toma el costo vecinal en su refresco de 30 min.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

// Sin `?` en el patrón: knex lo tomaría por un parámetro.
const COSTO_VALIDO = `btrim(COALESCE(k.c77, '')) ~ '^[0-9]+([.][0-9]+){0,1}$'`;

const VISTA_DIARIA = `
CREATE OR REPLACE VIEW analytics.v_rd_route_daily AS
 WITH tasa AS (
         SELECT btrim(k.c1) AS articulo,
            abs(COALESCE(k.c18, 0::numeric)) AS iva_pct,
            abs(COALESCE(k.c19, 0::numeric)) AS ieps_pct
           FROM kepler_ods.kdii k
          WHERE k.sucursal = '00'
        ), tasa_cualquiera AS (
         SELECT DISTINCT ON (btrim(k.c1)) btrim(k.c1) AS articulo,
            abs(COALESCE(k.c18, 0::numeric)) AS iva_pct,
            abs(COALESCE(k.c19, 0::numeric)) AS ieps_pct
           FROM kepler_ods.kdii k
          ORDER BY btrim(k.c1), (k.sucursal = '00') DESC, k.sucursal
        ), costo_std AS (
         SELECT btrim(k.c1) AS articulo,
            btrim(k.c77)::numeric AS costo_u
           FROM kepler_ods.kdii k
          WHERE k.sucursal = '00' AND ${COSTO_VALIDO} AND btrim(k.c77)::numeric > 0
        )
 SELECT sl.tenant_id,
    sl.source_branch AS route_code,
    sl.business_date,
    sl.source,
    round(sum(
        CASE
            WHEN sl.source = 'push'::text THEN sl.importe / ((1::numeric + t.ieps_pct / 100.0) * (1::numeric + t.iva_pct / 100.0))
            WHEN sl.source = 'kepler_vecinal'::text THEN sl.importe / ((1::numeric + tv.ieps_pct / 100.0) * (1::numeric + tv.iva_pct / 100.0))
            ELSE sl.importe
        END), 2) AS subtotal,
        CASE
            WHEN sl.source = 'push'::text THEN
              CASE WHEN bool_and(t.articulo IS NOT NULL) THEN 'derivado_tasa_kepler'::text
                   ELSE 'derivado_tasa_kepler_incompleto'::text END
            WHEN sl.source = 'kepler_vecinal'::text THEN
              CASE WHEN bool_and(tv.articulo IS NOT NULL) THEN 'derivado_tasa_kepler'::text
                   ELSE 'derivado_tasa_kepler_incompleto'::text END
            ELSE 'erp'::text
        END AS subtotal_origen,
    round(sum(
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN sl.importe
            ELSE sl.importe * (1::numeric + COALESCE(sl.iva, 0::numeric) / 100.0 + COALESCE(sl.ieps, 0::numeric) / 100.0)
        END), 2) AS venta,
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN 'erp'::text
            ELSE 'derivado_tasa_linea'::text
        END AS venta_origen,
        CASE
            WHEN sl.source = 'push'::text THEN NULL::numeric
            WHEN sl.source = 'kepler_vecinal'::text THEN round(sum(sl.qty * cs.costo_u), 2)
            ELSE round(sum(sl.costo), 2)
        END AS costo,
        CASE
            WHEN sl.source = 'push'::text THEN 'sin_dato_en_la_fuente'::text
            WHEN sl.source = 'kepler_vecinal'::text THEN
              CASE WHEN bool_and(cs.articulo IS NOT NULL) THEN 'estandar_kepler_hoy'::text
                   ELSE 'estandar_kepler_incompleto'::text END
            ELSE 'erp_reexpresado_cada_corrida'::text
        END AS costo_status,
    count(*)::integer AS lineas,
    count(DISTINCT sl.consecutivo)::integer AS tickets
   FROM analytics.v_route_sales_lines sl
     LEFT JOIN tasa t ON t.articulo = btrim(sl.sku)
     LEFT JOIN tasa_cualquiera tv ON sl.source = 'kepler_vecinal'::text AND tv.articulo = btrim(sl.sku)
     LEFT JOIN costo_std cs ON sl.source = 'kepler_vecinal'::text AND cs.articulo = btrim(sl.sku)
  GROUP BY sl.tenant_id, sl.source_branch, sl.business_date, sl.source`;

/** `[RD.103.0]` `20261104103527`, tal cual: la restaura el down. */
const VISTA_DIARIA_ANTES = `
CREATE OR REPLACE VIEW analytics.v_rd_route_daily AS
 WITH tasa AS (
         SELECT btrim(k.c1) AS articulo,
            abs(COALESCE(k.c18, 0::numeric)) AS iva_pct,
            abs(COALESCE(k.c19, 0::numeric)) AS ieps_pct
           FROM kepler_ods.kdii k
          WHERE k.sucursal = '00'
        ), tasa_cualquiera AS (
         SELECT DISTINCT ON (btrim(k.c1)) btrim(k.c1) AS articulo,
            abs(COALESCE(k.c18, 0::numeric)) AS iva_pct,
            abs(COALESCE(k.c19, 0::numeric)) AS ieps_pct
           FROM kepler_ods.kdii k
          ORDER BY btrim(k.c1), (k.sucursal = '00') DESC, k.sucursal
        )
 SELECT sl.tenant_id,
    sl.source_branch AS route_code,
    sl.business_date,
    sl.source,
    round(sum(
        CASE
            WHEN sl.source = 'push'::text THEN sl.importe / ((1::numeric + t.ieps_pct / 100.0) * (1::numeric + t.iva_pct / 100.0))
            WHEN sl.source = 'kepler_vecinal'::text THEN sl.importe / ((1::numeric + tv.ieps_pct / 100.0) * (1::numeric + tv.iva_pct / 100.0))
            ELSE sl.importe
        END), 2) AS subtotal,
        CASE
            WHEN sl.source = 'push'::text THEN
              CASE WHEN bool_and(t.articulo IS NOT NULL) THEN 'derivado_tasa_kepler'::text
                   ELSE 'derivado_tasa_kepler_incompleto'::text END
            WHEN sl.source = 'kepler_vecinal'::text THEN
              CASE WHEN bool_and(tv.articulo IS NOT NULL) THEN 'derivado_tasa_kepler'::text
                   ELSE 'derivado_tasa_kepler_incompleto'::text END
            ELSE 'erp'::text
        END AS subtotal_origen,
    round(sum(
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN sl.importe
            ELSE sl.importe * (1::numeric + COALESCE(sl.iva, 0::numeric) / 100.0 + COALESCE(sl.ieps, 0::numeric) / 100.0)
        END), 2) AS venta,
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN 'erp'::text
            ELSE 'derivado_tasa_linea'::text
        END AS venta_origen,
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN NULL::numeric
            ELSE round(sum(sl.costo), 2)
        END AS costo,
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN 'sin_dato_en_la_fuente'::text
            ELSE 'erp_reexpresado_cada_corrida'::text
        END AS costo_status,
    count(*)::integer AS lineas,
    count(DISTINCT sl.consecutivo)::integer AS tickets
   FROM analytics.v_route_sales_lines sl
     LEFT JOIN tasa t ON t.articulo = btrim(sl.sku)
     LEFT JOIN tasa_cualquiera tv ON sl.source = 'kepler_vecinal'::text AND tv.articulo = btrim(sl.sku)
  GROUP BY sl.tenant_id, sl.source_branch, sl.business_date, sl.source`;

const COMENTARIO_DIARIA = `'RD.2 / RD.95 / RD.103 - venta por ruta y dia. Push y vecinal (kepler_vecinal): subtotal derivado con la tasa de KEPLER (kdii.c18/c19; IEPS sobre la base, IVA sobre base+IEPS); la vecinal toma 00 y si falta, otra sucursal. Costo vecinal (RD.103.2) = cantidad x kdii.c77 de 00, costo estandar de HOY (costo_status estandar_kepler_hoy / _incompleto); medido contra el libro de Comercial: error mediano 0.51 %, 18 de 27 dias dentro de +-1 %.'`;
const COMENTARIO_DIARIA_ANTES = `'RD.2 / RD.95 / RD.103.0 - venta por ruta y dia. Push y vecinal (kepler_vecinal): subtotal derivado con la tasa de KEPLER (kdii.c18/c19; IEPS sobre la base, IVA sobre base+IEPS); la vecinal toma 00 y si falta, otra sucursal. Un dia con algun SKU sin tasa sale subtotal_origen = derivado_tasa_kepler_incompleto. Vecinal medido 2026-11-04 contra el neto del documento de Kepler, Q14-Q21: antes +9 a +13 %, despues dentro de +-0.9 %.'`;

const VENTAS_COLUMNAS = `
 SELECT tenant_id,
    route_code,
    business_date,
    sum(subtotal) AS subtotal,
    sum(venta) AS venta,
    sum(subtotal) FILTER (WHERE (source = 'push'::text)) AS subtotal_push,
    sum(subtotal) FILTER (WHERE (source = 'wincaja'::text)) AS subtotal_wincaja,
    sum(subtotal) FILTER (WHERE (source = 'kepler_vecinal'::text)) AS subtotal_vecinal,
    sum(costo) FILTER (WHERE (source = 'wincaja'::text)) AS costo_wincaja,
    (count(DISTINCT source))::integer AS fuentes,
    string_agg(DISTINCT source, '+'::text ORDER BY source) AS fuentes_dia,
    (count(DISTINCT source) > 1) AS dia_multifuente,
    (sum(tickets))::integer AS tickets`;

const VISTA_VENTAS = `
CREATE OR REPLACE VIEW analytics.v_rd_commission_sales AS ${VENTAS_COLUMNAS},
    sum(costo) FILTER (WHERE (source = 'kepler_vecinal'::text)) AS costo_vecinal,
    max(costo_status) FILTER (WHERE (source = 'kepler_vecinal'::text)) AS costo_vecinal_status
   FROM analytics.v_rd_route_daily_rapido d
  GROUP BY tenant_id, route_code, business_date`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // 1–2. Las vistas. La de ventas lee la diaria por la matview, así que van en este orden.
  await knex.raw(VISTA_DIARIA);
  await knex.raw(`ALTER VIEW analytics.v_rd_route_daily SET (security_invoker = true)`);
  await knex.raw(`COMMENT ON VIEW analytics.v_rd_route_daily IS ${COMENTARIO_DIARIA}`);
  await knex.raw(VISTA_VENTAS);
  await knex.raw(`ALTER VIEW analytics.v_rd_commission_sales SET (security_invoker = true)`);
  await knex.raw(`COMMENT ON COLUMN analytics.v_rd_commission_sales.costo_vecinal IS
    'RD.103.2 - costo de la venta vecinal del dia: cantidad x kdii.c77 (costo estandar de HOY, no el de la fecha de venta). El motor lo usa sólo si no hay costo de embarque, de ERP ni de Wincaja.'`);

  // 3. El escalón por markup y el piso del chofer.
  await knex.raw(`ALTER TABLE commercial.commission_scales DROP CONSTRAINT IF EXISTS commission_scales_gate_valid`);
  await knex.raw(`ALTER TABLE commercial.commission_scales ADD CONSTRAINT commission_scales_gate_valid
    CHECK (gate_field IN ('subtotal', 'venta', 'markup'))`);
  if (!(await knex.schema.withSchema('commercial').hasColumn('commission_scales', 'piso_chofer_venta'))) {
    await knex.raw(`ALTER TABLE commercial.commission_scales ADD COLUMN piso_chofer_venta numeric(14,2)`);
  }
  const { rows: piso } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'commission_scales_piso_chofer_valido'`);
  if (!piso.length) {
    await knex.raw(`ALTER TABLE commercial.commission_scales ADD CONSTRAINT commission_scales_piso_chofer_valido
      CHECK (piso_chofer_venta IS NULL OR piso_chofer_venta >= 0)`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.commission_scales.gate_field IS
    'Sobre qué se elige el escalón: subtotal | venta (pesos) | markup (subtotal / costo - 1, en %). RD.103.2: el tabulador vecinal escalona por markup.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.commission_scales.piso_chofer_venta IS
    'RD.103.2 - el chofer cobra sólo si la VENTA del periodo es MAYOR que esto (libro vecinal: 129,999.99). NULL = sin piso. El supervisor no lo tiene.'`);

  // 4. Con qué versión se calculó cada línea.
  if (!(await knex.schema.withSchema('commercial').hasColumn('commission_run_lines', 'scale_id'))) {
    await knex.raw(`ALTER TABLE commercial.commission_run_lines ADD COLUMN scale_id uuid`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.commission_run_lines.scale_id IS
    'RD.103.2 - la versión del tabulador con que se calculó ESTA línea (cada familia tiene la suya). NULL en las corridas anteriores: ésas usaron la de commission_runs.scale_id.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. ⛔ Se niega si ya hay una escala por markup o con piso:
 *  quitar la columna la volvería una escala por venta en silencio. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [x] } = await knex.raw(
    `SELECT count(*)::int n FROM commercial.commission_scales
      WHERE gate_field = 'markup' OR piso_chofer_venta IS NOT NULL`);
  if (x.n > 0) {
    throw new Error(`commercial.commission_scales tiene ${x.n} escala(s) por markup o con piso: `
      + 'deshacer esta migración las pagaría por venta y sin piso. Ciérralas primero.');
  }
  await knex.raw(`ALTER TABLE commercial.commission_run_lines DROP COLUMN IF EXISTS scale_id`);
  await knex.raw(`ALTER TABLE commercial.commission_scales DROP CONSTRAINT IF EXISTS commission_scales_piso_chofer_valido`);
  await knex.raw(`ALTER TABLE commercial.commission_scales DROP COLUMN IF EXISTS piso_chofer_venta`);
  await knex.raw(`ALTER TABLE commercial.commission_scales DROP CONSTRAINT IF EXISTS commission_scales_gate_valid`);
  await knex.raw(`ALTER TABLE commercial.commission_scales ADD CONSTRAINT commission_scales_gate_valid
    CHECK (gate_field IN ('subtotal', 'venta'))`);
  // Una vista no suelta columnas con CREATE OR REPLACE: se recrea la de ventas sin las dos nuevas,
  // conservando su comentario y sus GRANT (un DROP se los lleva).
  const { rows: [doc] } = await knex.raw(
    `SELECT obj_description('analytics.v_rd_commission_sales'::regclass) AS d`);
  const { rows: grants } = await knex.raw(
    `SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'analytics' AND table_name = 'v_rd_commission_sales'
        AND grantee <> current_user`);
  await knex.raw(`DROP VIEW analytics.v_rd_commission_sales`);
  await knex.raw(`CREATE VIEW analytics.v_rd_commission_sales AS ${VENTAS_COLUMNAS}
   FROM analytics.v_rd_route_daily_rapido d
  GROUP BY tenant_id, route_code, business_date`);
  await knex.raw(`ALTER VIEW analytics.v_rd_commission_sales SET (security_invoker = true)`);
  if (doc?.d) await knex.raw('COMMENT ON VIEW analytics.v_rd_commission_sales IS ' + knex.raw('?', [doc.d]).toQuery());
  for (const g of grants) {
    await knex.raw(`GRANT ${g.privilege_type} ON analytics.v_rd_commission_sales TO "${g.grantee}"`);
  }
  await knex.raw(VISTA_DIARIA_ANTES);
  await knex.raw(`ALTER VIEW analytics.v_rd_route_daily SET (security_invoker = true)`);
  await knex.raw(`COMMENT ON VIEW analytics.v_rd_route_daily IS ${COMENTARIO_DIARIA_ANTES}`);
};
