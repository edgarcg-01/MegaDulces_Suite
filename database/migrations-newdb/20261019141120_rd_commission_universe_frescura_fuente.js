'use strict';
/**
 * `[RD.71]` — **El universo decía quién COBRA y nunca si esa ruta todavía vende.**
 *
 * ── Lo medido antes, contra prod el 2026-10-19 (sólo lectura) ───────────────────────────────
 *  · `v_rd_commission_universe` decide `veredicto` mirando la config PRIMERO: una fila en
 *    `commission_route_config` con `activo = true` sale `comisiona` **sin preguntarle nunca a la
 *    venta**. Por eso dos fantasmas llevan meses adentro:
 *       321 -> último dato 2026-06-02, **139 días**, $0 en los últimos 30
 *       322 -> último dato 2026-07-01, **110 días**, $0 en los últimos 30
 *    y la 504 lleva **18 días** sin un dato sin que nada avise.
 *  · Al revés, las que venden y están fuera tampoco traían su monto: **2V003 vendió $521,077.25
 *    en 30 días** con veredicto `fuera_no_es_camion`. Sin la cifra al lado, la exclusión no se
 *    puede revisar — se lee como una lista de códigos raros.
 *  · ⛔ Y la frescura NO se puede medir con `max(business_date)` a secas: la ruta **22** tiene
 *    una venta fechada **2026-12-06**, 48 días en el futuro. Sin la poda, la ruta con el dato
 *    corrupto es la que se ve **más fresca de todas**. El filtro `<= current_date` es la parte
 *    que sostiene la columna, no un detalle.
 *
 * ── Qué cambia, y qué NO ────────────────────────────────────────────────────────────────────
 * ⭐ **Aditiva.** `veredicto` y `comisiona` salen **idénticos**: no se toca a quién se le paga —
 * eso es la decisión D1 de la fase y es de Dirección, no del código. Lo único que cambia es que
 * ahora la vista **declara el estado de la fuente de cada ruta**, para que una ruta que cobra sin
 * vender deje de ser invisible. Es ADR-056: la ausencia se publica, no se omite.
 *
 * ⛔ `fuente_estado` NO es `comisiona`. Una ruta puede estar `muerta` y seguir cobrando — eso es
 * exactamente lo que hay que poder VER antes de decidirlo. La vista describe; no decide.
 *
 * ── Por qué los umbrales son 3 y 30 ─────────────────────────────────────────────────────────
 * Medido sobre las 13 configuradas: con 3 días, las 9 que operan normal salen `viva` (su último
 * dato es de hace 0-2 días, porque el feed del domingo no existe) y ninguna da falso positivo.
 * Con 30, la 504 (18 días) cae en `rezagada` -- que es lo que es: dejó de reportar pero su
 * quincena todavía tiene nueve días de venta -- y los dos fantasmas de 110 y 139 días caen en
 * `muerta`. No hay ninguna ruta entre 18 y 110 días, así que el corte no parte un grupo real.
 *
 * Costo medido de la forma nueva: **23 ms** (la vieja: 23 ms). La matvista de 200 días ya estaba
 * en el FROM.
 *
 * Idempotente: CREATE OR REPLACE. Las columnas nuevas van **al final**, que es lo único que
 * CREATE OR REPLACE VIEW admite sin un DROP -- y un DROP acá tiraría los nueve consumidores.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_rd_commission_universe';

const SQL = `
CREATE OR REPLACE VIEW ${VIEW} WITH (security_invoker = true) AS
WITH llaves AS (
  -- Las tres procedencias de "esta ruta existe". UNION (no ALL) = el conjunto.
  SELECT tenant_id, route_no AS route_code FROM analytics.mv_rd_route_identity
  UNION
  SELECT tenant_id, route_code FROM commercial.commission_route_config WHERE deleted_at IS NULL
  UNION
  -- "Lo que vende" sale de la matvista de 200 dias, NO de route_push_lines ni de
  -- wincaja.branches: esas dos pierden las cuatro vecinales de Kepler (2V001, 2V003, 2V005,
  -- 3V001), que entran por kepler_vecinal (VEC.1). Ver la migracion 20261007190000.
  SELECT tenant_id, route_code FROM analytics.mv_rd_route_daily_200d
), ident AS (
  SELECT tenant_id, route_no, plaza, almacen_erp, suc_emisor, carga_desde, warehouse_id
    FROM analytics.mv_rd_route_identity
), cfg AS (
  SELECT tenant_id, route_code, nomina_banco, chofer_nombre, supervisor_nombre, zona, activo
    FROM commercial.commission_route_config WHERE deleted_at IS NULL
), kind AS (
  -- El tipo de ruta vive en trade.catalogs (VEC.1). Se une por DOS vocabularios porque la
  -- misma tabla nombra a los camiones por numero ("RUTA 21" / "21") y a las vecinales por su
  -- codigo de vendedor del ERP ("1V001"). Unir por uno solo pierde la mitad del catalogo.
  -- Sin \\s y sin signo de interrogacion en el regex: los dos fallan MUDOS en esta base.
  SELECT tc.tenant_id,
         coalesce(
           nullif(regexp_replace(btrim(tc.value), '^[Rr][Uu][Tt][Aa] *', ''), ''),
           btrim(tc.erp_vendor_code)
         )                                   AS route_code,
         btrim(tc.erp_vendor_code)           AS erp_vendor_code,
         max(tc.route_kind)                  AS route_kind
    FROM trade.catalogs tc
   WHERE tc.catalog_id = 'rutas' AND tc.deleted_at IS NULL
   GROUP BY 1, 2, 3
), kind_dos_llaves AS (
  SELECT tenant_id, route_code, route_kind FROM kind WHERE route_code IS NOT NULL
  UNION ALL
  SELECT tenant_id, erp_vendor_code, route_kind FROM kind WHERE erp_vendor_code IS NOT NULL
), kind_por_codigo AS (
  -- El GROUP BY va DESPUES del UNION: un route_code que entra por las dos llaves con route_kind
  -- distinto dejaria DOS filas, y el LEFT JOIN de abajo multiplica la ruta -- que en esta vista
  -- significa cobrarla dos veces. Una llave, una fila.
  SELECT tenant_id, route_code, max(route_kind) AS route_kind
    FROM kind_dos_llaves GROUP BY 1, 2
), fuente AS (
  -- [RD.71] El estado de la fuente de cada ruta.
  --
  -- La poda "business_date <= current_date" NO es defensiva: la ruta 22 tiene una venta fechada
  -- 2026-12-06 y sin la poda seria la ruta con el dato MAS nuevo de todas, o sea la que menos
  -- sospecha levanta. Por eso ultimo_dia_con_dato y tiene_dato_futuro se publican por separado:
  -- uno mide frescura, el otro denuncia el dato imposible. Pegarlos en una sola columna hace que
  -- el segundo desaparezca dentro del primero.
  SELECT tenant_id,
         route_code,
         max(business_date) FILTER (WHERE business_date <= current_date)  AS ultimo_dia,
         (max(business_date) > current_date)                             AS hay_futuro,
         sum(subtotal) FILTER (WHERE business_date >  current_date - 30
                                 AND business_date <= current_date)       AS subtotal_30d
    FROM analytics.mv_rd_route_daily_200d
   GROUP BY 1, 2
)
SELECT
  l.tenant_id,
  l.route_code,

  -- De donde se sabe que existe. Las tres son hechos distintos y se publican los tres.
  (i.route_no    IS NOT NULL)                        AS en_identidad,
  (c.route_code  IS NOT NULL)                        AS en_config,
  coalesce(c.activo, false)                          AS config_activa,

  k.route_kind,
  i.plaza,
  coalesce(i.plaza, c.zona)                          AS plaza_o_zona,
  i.almacen_erp,
  i.suc_emisor,
  i.carga_desde,
  i.warehouse_id,
  c.nomina_banco,
  c.chofer_nombre,
  c.supervisor_nombre,

  CASE
    WHEN c.route_code IS NOT NULL AND     c.activo           THEN 'comisiona'
    WHEN c.route_code IS NOT NULL AND NOT c.activo           THEN 'config_inactiva'
    WHEN k.route_kind IS NOT NULL AND k.route_kind <> 'camion' THEN 'fuera_no_es_camion'
    WHEN i.route_no   IS NOT NULL                            THEN 'camion_sin_config'
    WHEN k.route_kind = 'camion'                             THEN 'camion_sin_identidad'
    ELSE 'tipo_sin_declarar'
  END                                                AS veredicto,

  (c.route_code IS NOT NULL AND c.activo)            AS comisiona,

  -- ── [RD.71] El estado de la fuente. Columnas NUEVAS, al final: nada de arriba cambia. ──
  f.ultimo_dia                                       AS ultimo_dia_con_dato,
  (current_date - f.ultimo_dia)::int                 AS dias_sin_dato,
  round(coalesce(f.subtotal_30d, 0), 2)              AS subtotal_30d,

  -- NULL cuando no hay fuente: "sin_fuente" es un hecho, no un cero. Una ruta que entra por la
  -- config o por el resolvedor y nunca aparecio en la matvista de 200 dias cae aca.
  CASE
    WHEN f.ultimo_dia IS NULL                 THEN 'sin_fuente'
    WHEN current_date - f.ultimo_dia <= 3     THEN 'viva'
    WHEN current_date - f.ultimo_dia <= 30    THEN 'rezagada'
    ELSE                                           'muerta'
  END                                                AS fuente_estado,

  coalesce(f.hay_futuro, false)                      AS tiene_dato_futuro

FROM llaves l
LEFT JOIN ident           i ON i.tenant_id = l.tenant_id AND i.route_no   = l.route_code
LEFT JOIN cfg             c ON c.tenant_id = l.tenant_id AND c.route_code = l.route_code
LEFT JOIN kind_por_codigo k ON k.tenant_id = l.tenant_id AND k.route_code = l.route_code
LEFT JOIN fuente          f ON f.tenant_id = l.tenant_id AND f.route_code = l.route_code
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(SQL);
  // security_invoker y el GRANT van EXPLICITOS despues de cada CREATE OR REPLACE: no se
  // heredan. ADR-057 los perdio una vez y solo lo vio la asercion de metadata del candado.
  await knex.raw(`ALTER VIEW ${VIEW} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VIEW} IS $$[RD.17/RD.71] El universo de la comision de Ruta
Directa, DERIVADO. Cada route_code sale con su veredicto (comisiona / config_inactiva /
fuera_no_es_camion / camion_sin_config / camion_sin_identidad / tipo_sin_declarar) y, desde
RD.71, con el ESTADO DE SU FUENTE: ultimo_dia_con_dato, dias_sin_dato, subtotal_30d,
fuente_estado (viva <=3d / rezagada <=30d / muerta / sin_fuente) y tiene_dato_futuro. El
veredicto mira la config primero, asi que una ruta puede estar "muerta" y seguir cobrando:
medido el 2026-10-19, la 321 llevaba 139 dias y la 322 110, las dos con comisiona=true y $0 en
30 dias. La vista DESCRIBE esa contradiccion; no la resuelve -- a quien se le paga es decision
de Direccion. La frescura PODA business_date > current_date: la ruta 22 tiene una venta fechada
2026-12-06 y sin la poda seria la mas fresca de todas.$$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista sin las cinco columnas de RD.71. */
exports.down = async function down(knex) {
  // CREATE OR REPLACE no puede QUITAR columnas, asi que el down tiene que soltar la vista. Los
  // consumidores la vuelven a encontrar en cuanto corre el CREATE de la migracion 20261007190000.
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
