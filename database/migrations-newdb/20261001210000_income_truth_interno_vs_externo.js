/* eslint-disable */
/**
 * `[IG.6]` — **El ingreso publicado incluye traspasos internos. Se separa, y se casa con el cobro.**
 *
 * Pedido de Edgar: *"desglosemos los ingresos … si una tienda generó ganancias, por mes, día,
 * trimestre … qué ticket, de dónde ingresó, con qué se pagó, cuántos pagos diferentes ligados a
 * esa venta … casar todos los ingresos a cada tienda y saber de dónde viene cada ingreso"*.
 *
 * ── ⛔⛔ LO QUE LA MEDICIÓN ENCONTRÓ ANTES DE CONSTRUIR NADA ────────────────────────────────────
 * `/finanzas/ingresos` publica **$55.6 M de agosto-2026**. Esa cifra es, casi exactamente, el
 * doctype `U-D-13` (*Factura Cred No Fiscal*) del CEDIS — **$55.96 M**. Abierto por cliente:
 *
 *     qué es el "cliente"                     docs   clientes      importe    %
 *     sucursal propia (10-00, 30-00, 42-00…)   295         10   41,250,743  73.8
 *     ruta propia (RUTA 21, RD 501, RV001…)    420         19    6,073,429  10.9
 *     cliente externo real                     673        180    8,635,525  15.4
 *
 * Los códigos `10 30 32 40 42 50 54` empatan **uno a uno** con `wincaja_source_branch` de
 * `analytics.v_branch_erp_cutover` (`10 → 01 PH`, `30 → 08`, `42 → 02`…). Es **el CEDIS
 * facturándole a sus propias tiendas**: el 84.7 % de lo que hoy se publica como ingreso es dinero
 * moviéndose dentro de la casa. Y no es un hallazgo nuevo — `docs/ERP_KEPLER.md` ya marcaba
 * `U-D-13` como *"el traspaso al CEDIS"* y la Fase AX lo excluyó por eso. **Fase IG lo incluyó.**
 * Dos fases del mismo repo se contradicen y la que está en pantalla es la que infla.
 *
 * ⭐ Esta migración NO cambia lo que publica `/finanzas/ingresos` hoy. Agrega el eje que faltaba
 * (`kind`) para que la pantalla pueda **separar** y **declarar**, en vez de que alguien tenga que
 * elegir a ciegas entre dos cifras. Corregir la cifra publicada es decisión de Dirección, no de
 * una migración; lo que acá se entrega es la medición para tomarla.
 *
 * ── ⚠️ Y LA SEGUNDA DUPLICACIÓN, DISTINTA DE LA PRIMERA ────────────────────────────────────────
 * `U-D-6` (*Factura global*) es el **envoltorio fiscal** de los tickets `U-D-10`, no una venta
 * aparte. Medido por sucursal en ago-2026, razón `U-D-6 / U-D-10`: 01 = 0.760 · 02 = 0.846 ·
 * 03 = 0.989 · 04 = 0.745 · 05 = 0.790 · 06 = 0.970. Sumarlos duplica el mostrador, así que la
 * vista lo marca `es_envoltorio_fiscal = true` y **el consumidor decide**, sin tener que saberlo.
 *
 * ── LAS TRES VISTAS ────────────────────────────────────────────────────────────────────────────
 * 1. `analytics.v_kepler_customer_kind` — el resolvedor: qué es cada cliente de Kepler.
 *    ⭐ No se inventa: sale del catálogo `kdud` del propio ERP (`c3` nombre, `c13` vendedor/ruta)
 *    cruzado con el resolvedor de corte que ya existe. `PV-01` agrupa exactamente a los 8 Puntos
 *    de Venta propios; hay clientes llamados literalmente *"TRASPASO YURECUARO"*.
 * 2. `analytics.v_erp_income_daily` — vendido por (sucursal, fecha, doctype, kind).
 * 3. `analytics.v_erp_collection_daily` — cobrado por (sucursal, fecha, cuenta), con el **medio**
 *    resuelto contra `kdb1`: efectivo (caja) vs qué banco. Es el *"¿se hizo depósito? ¿se dio
 *    efectivo?"* del pedido.
 *
 * ── ⛔ EL HUECO GRANDE, DECLARADO (ADR-056) ────────────────────────────────────────────────────
 * **El medio de pago del MOSTRADOR no existe en Kepler.** Medido: `kdm1.c45` (la cuenta de
 * tesorería, que es lo único que separa caja de banco) viene **vacía en el 100 %** de los
 * documentos de venta — sólo los cobros la traen. El ticket apenas dice `c30 = 'Pago de contado'`,
 * sin distinguir efectivo de tarjeta. Y el corte de caja no lo salva: `U-D-23` existe **1 de cada
 * 5 días** (PH, 26→30-sep: sólo el 30, y cubre el 62.2 % de sus tickets).
 * ⇒ De los $308,511 que PH vendió en mostrador el 30-sep, **no hay registro en Kepler de en qué
 * forma entraron**. La vista de cobro NO los inventa: no aparecen, y el puente lo declara.
 *
 * ⚠️ `U-D-5` (*Factura TK Contado*, $1.11 M en ago) **no está verificado**: "TK" sugiere que
 * también deriva del ticket, como `U-D-6`. Queda marcado `envoltorio_sin_verificar` — ni se suma
 * a ciegas ni se descarta a ciegas.
 * ⚠️ `kdm1.c9` **puede venir en el futuro** (medido: un cobro con fecha 2026-12-14), por eso la
 * vista publica `fecha_futura` en vez de esconderlo.
 * ⚠️ `kdm1.c10` es el **CLIENTE**, no la forma de pago: `CONTADO`, `ONLINE`, `TI001`, `RD 501` son
 * códigos del catálogo de clientes. Quien lo lea como medio de pago se equivoca.
 * ⚠️ Cancelados fuera con el predicado canónico `btrim(coalesce(c43,'')) <> 'C'` (mig 20260902170000).
 * ⚠️ `security_invoker` y los GRANT se re-aplican: CREATE OR REPLACE VIEW no los hereda (ADR-057).
 */

const V_KIND = `
CREATE OR REPLACE VIEW analytics.v_kepler_customer_kind AS
 SELECT d.sucursal,
        btrim(d.c2)  AS cliente_code,
        btrim(d.c3)  AS cliente_nombre,
        btrim(d.c13) AS vendedor_code,
        w.kepler_code AS sucursal_destino,
        CASE
          -- 1. El código del cliente ES una sucursal de la red (10-00 = PH, 42-00 = La Piedad…).
          WHEN w.wincaja_source_branch IS NOT NULL                        THEN 'interno_sucursal'
          -- 2. Punto de venta propio: el ERP los agrupa bajo el vendedor PV-01 y los nombra "P.V. …".
          WHEN btrim(d.c13) = 'PV-01' OR btrim(d.c3) ILIKE 'P.V.%'        THEN 'interno_punto_venta'
          -- 3. Clientes que se llaman TRASPASO (existen tal cual en el catálogo).
          WHEN btrim(d.c3) ILIKE '%TRASPASO%'                             THEN 'interno_traspaso'
          -- 4. Telemarketing como cliente del CEDIS (RM-01 / "TLMKT …").
          WHEN btrim(d.c13) = 'RM-01' OR btrim(d.c3) ILIKE 'TLMKT%'       THEN 'interno_telemarketing'
          -- 5. Rutas propias facturadas como cliente.
          WHEN btrim(d.c2) ~ '^(RUTA|RD |RV)'                             THEN 'interno_ruta'
          ELSE 'externo'
        END AS kind
   FROM kepler_ods.kdud d
   LEFT JOIN analytics.v_branch_erp_cutover w
     ON w.wincaja_source_branch = split_part(btrim(d.c2), '-', 1)`;

const V_INCOME = `
CREATE OR REPLACE VIEW analytics.v_erp_income_daily AS
 SELECT w.tenant_id,
        m.sucursal,
        w.id                                   AS warehouse_id,
        w.code                                 AS warehouse_code,
        w.name                                 AS warehouse_name,
        m.c9::date                             AS fecha,
        (m.c9::date > CURRENT_DATE)            AS fecha_futura,
        m.c2 || '-' || m.c3 || '-' || m.c4     AS doctype,
        m.c5                                   AS doctype_sub,
        mm.c5                                  AS doctype_label,
        -- ⛔ El cliente que NO está en el catálogo NO se dibuja como "externo": se DECLARA
        -- (ADR-056). Darle el default lo contaría como ingreso real sin que nadie lo haya visto,
        -- y es justo el error que esta migración vino a corregir en otro lado.
        COALESCE(k.kind, 'sin_catalogo')       AS kind,
        (COALESCE(k.kind,'sin_catalogo') LIKE 'interno%') AS es_interno,
        -- U-D-6 (Factura global) envuelve fiscalmente a los tickets U-D-10: sumarlos duplica.
        (m.c4 = '6')                           AS es_envoltorio_fiscal,
        -- U-D-5 "Factura TK Contado": el rótulo sugiere lo mismo, pero NO está verificado.
        (m.c4 = '5')                           AS envoltorio_sin_verificar,
        count(*)::int                          AS docs,
        sum(m.c16::numeric)                    AS importe
   FROM kepler_ods.kdm1 m
   JOIN commercial.warehouses w
     ON w.kepler_code = m.sucursal AND w.deleted_at IS NULL
   LEFT JOIN kepler_ods.kdmm mm
     ON mm.sucursal = m.sucursal AND mm.c1 = m.c2 AND mm.c2 = m.c3
    AND mm.c3 = m.c4 AND mm.c4 = m.c5
   LEFT JOIN analytics.v_kepler_customer_kind k
     ON k.sucursal = m.sucursal AND k.cliente_code = btrim(m.c10)
  WHERE m.c2 = 'U' AND m.c3 = 'D'
    AND m.c4 IN ('5','6','8','10','12','13')
    -- ANTI-RÉPLICA: el almacén tiene que pertenecer a la sucursal (conserva sub-almacenes).
    AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
    AND btrim(coalesce(m.c43::text,'')) <> 'C'
  -- ⚠️ Se agrupa por la EXPRESIÓN, no por k.kind: con el COALESCE en el SELECT y la columna
  -- cruda en el GROUP BY, las filas sin catálogo y las clasificadas caían en grupos distintos
  -- que imprimían la MISMA etiqueta. Medido en PH el 30-sep: la Caja 1 salía partida en
  -- 120 + 154 documentos, dos renglones idénticos a la vista.
  GROUP BY w.tenant_id, m.sucursal, w.id, w.code, w.name, m.c9::date,
           m.c2, m.c3, m.c4, m.c5, mm.c5, COALESCE(k.kind, 'sin_catalogo')`;

const V_COLLECT = `
CREATE OR REPLACE VIEW analytics.v_erp_collection_daily AS
 SELECT w.tenant_id,
        u.sucursal,
        w.id                                   AS warehouse_id,
        w.code                                 AS warehouse_code,
        u.c7::date                             AS fecha,
        (u.c7::date > CURRENT_DATE)            AS fecha_futura,
        'U-A-' || u.c4                         AS doctype,
        btrim(u.c22)                           AS cuenta_code,
        b.c2                                   AS cuenta_nombre,
        CASE WHEN b.c3 = 'EFECTIVO' THEN 'efectivo'
             WHEN b.c3 IS NOT NULL   THEN 'banco'
             ELSE 'sin_catalogo' END           AS medio,
        count(*)::int                          AS cobros,
        sum(u.c11::numeric)                    AS importe
   FROM kepler_ods.kdue u
   JOIN commercial.warehouses w
     ON w.kepler_code = u.sucursal AND w.deleted_at IS NULL
   LEFT JOIN kepler_ods.kdb1 b
     ON b.sucursal = u.sucursal AND btrim(b.c1) = btrim(u.c22)
  WHERE u.c28 = 'U' AND u.c29 = 'A' AND u.c4 IN ('5','7')
    AND (u.c1 = u.sucursal OR u.c1 LIKE u.sucursal || '-%')
  GROUP BY w.tenant_id, u.sucursal, w.id, w.code, u.c7::date, u.c4,
           btrim(u.c22), b.c2, b.c3`;

const VISTAS = [
  ['analytics.v_kepler_customer_kind', V_KIND],
  ['analytics.v_erp_income_daily', V_INCOME],
  ['analytics.v_erp_collection_daily', V_COLLECT],
];

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdud') IS NOT NULL
        AND to_regclass('kepler_ods.kdue') IS NOT NULL
        AND to_regclass('kepler_ods.kdb1') IS NOT NULL
        AND to_regclass('analytics.v_branch_erp_cutover') IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    throw new Error('faltan kdud/kdue/kdb1 o v_branch_erp_cutover — sin eso no se puede clasificar');
  }
  for (const [nombre, sql] of VISTAS) {
    await knex.raw(sql);
    await knex.raw(`ALTER VIEW ${nombre} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON ${nombre} TO app_runtime`);
    await knex.raw(`GRANT SELECT ON ${nombre} TO dev_ro`);
  }
};

exports.down = async function down(knex) {
  // Orden inverso: v_erp_income_daily depende de v_kepler_customer_kind.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_collection_daily`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_income_daily`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_customer_kind`);
};
