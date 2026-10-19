/* eslint-disable no-console */
/**
 * `[VEC.25]` — **Qué ES cada tipo de documento de venta: UNA definición, no seis `CASE`.**
 *
 * ── Lo que lo motivó, textual ───────────────────────────────────────────────────────────────
 * Edgar, 2026-10-16: *«este sistema debe funcionar en general. si otra ruta comienza a vender a
 * crédito debe funcionar, debe ser todo un sistema y no solo parches por ruta»*.
 *
 * Tenía razón y el defecto es de diseño:
 *
 *   - `analytics.v_route_credit_sales` lleva `c4::integer = 8` escrito **en tres CTEs**. Una ruta
 *     que facture con otro tipo no aparece, y nada avisa.
 *   - `analytics.v_kepler_vecinal_sales_docs` lleva `c4::integer = 10`. Una ruta que no cobre en
 *     caja —`1V006 «RUTA VECINAL MORELIA ABASTOS»`, medido: **$721,860.44 en 47 documentos**—
 *     sencillamente **no existe** para la pantalla.
 *   - Y `doc_label` no es un resolvedor: es `CASE (h.c4)::int WHEN 8 THEN 'Factura Telemarketing'
 *     ELSE 'Venta a crédito'`, **copiado en 6 migraciones**.
 *
 * ── ⛔ Lo que NO se pudo derivar, y por qué no se finge ──────────────────────────────────────
 * Primero se buscó la clasificación DENTRO del ERP, que sería lo correcto. `kepler_ods.kdmm`
 * trae banderas por tipo y la hipótesis era `c8='S' → contado`, `c7='S' → crédito`. **Se probó
 * contra el catálogo completo y FALLA:**
 *
 *   UD0901 'Ticket Crédito' ....... c7=S y c8=S  → la regla diría «contado» y el nombre dice crédito
 *   UD4501 'Remisión' ............. c8=S         → no es una venta
 *   UD2301 'Corte de Caja POS' .... c7=S         → tampoco
 *
 * O sea que `c8` es **«se folia por caja»** y `c7` es **«afecta cartera»** —los 9,167 tickets de
 * contado de 2026 generan cargo en `kdue`, medido—, y ninguna de las dos es contado-vs-crédito.
 * ⚠️ Peor: `UD1201` tiene **`c7` distinto entre las 9 sucursales**, así que una regla sobre esa
 * bandera se comportaría distinto por sucursal.
 *
 * ⭐ Por eso la clase es **un dato NUESTRO**, no una derivación inventada: tabla propia con su
 * `tenant_id`, auditoría y PK, que es lo que las reglas permiten para una decisión humana. Lo que
 * sí sale del ERP es el **UNIVERSO** (`kdmm`): la vista cruza los dos, y lo que nadie clasificó
 * sale `sin_clasificar` **con su importe a la vista** en vez de desaparecer (ADR-056).
 *
 * ── Lo que entrega ──────────────────────────────────────────────────────────────────────────
 *   1. `analytics.kepler_sale_doc_class` — la decisión, una fila por tipo.
 *   2. `analytics.v_kepler_sale_doc_class` — universo del ERP × la decisión. Nada se cae.
 *   3. `analytics.v_vecinal_route_doc_coverage` — ruta × tipo × clase × importe, con el universo
 *      de rutas tomado de `kduv`: una ruta nueva aparece sola, y una que no cobra en caja también.
 *
 * ⚠️ El `down` NO borra la tabla de clases (regla: no se borran tablas en prod). Quita las dos
 * vistas, que es lo reversible.
 */
'use strict';

/** La decisión de hoy, medida y con su testigo. Se siembra; después se edita como dato. */
const CLASES = [
  /**
   * Contado en caja: es lo que `v_kepler_vecinal_sales_docs` ya publicaba con `c4 = 10`.
   *
   * ⚠️ **Van las DIEZ, no cinco.** El catálogo de una sola sucursal muestra `UD1001`–`UD1005`,
   * pero mirando las 9 existen hasta `UD1010` (cajas 6-10, en una sucursal) — y las rutas
   * vecinales ya facturaron **80 documentos en `UD1008/1009/1010`**. El filtro viejo los incluía
   * por tipo; sembrar sólo cinco los habría dejado `sin_clasificar` y los habría SACADO. Es
   * justo el error que esta migración existe para no repetir.
   */
  ['UD1001', 'contado_caja', 'Ticket Contado Caja 1'],
  ['UD1002', 'contado_caja', 'Ticket Contado Caja 2'],
  ['UD1003', 'contado_caja', 'Ticket Contado Caja 3'],
  ['UD1004', 'contado_caja', 'Ticket Contado Caja 4'],
  ['UD1005', 'contado_caja', 'Ticket Contado Caja 5'],
  ['UD1006', 'contado_caja', 'Ticket Contado Caja 6'],
  ['UD1007', 'contado_caja', 'Ticket Contado Caja 7'],
  ['UD1008', 'contado_caja', 'Ticket Contado Caja 8'],
  ['UD1009', 'contado_caja', 'Ticket Contado Caja 9'],
  ['UD1010', 'contado_caja', 'Ticket Contado Caja 10'],
  // Crédito: el ERP les abre cargo con vencimiento y saldo. UD1301 son $3,245,522.84 en 340
  // documentos de 2026 que NINGUNA pantalla miraba.
  ['UD0801', 'credito', 'Factura Telemarketing'],
  ['UD1301', 'credito', 'Factura Cred No Fiscal'],
  ['UD0301', 'credito', 'Factura TK Credito'],
  ['UD0901', 'credito', 'Ticket Credito'],
  // Espejo: re-emiten un documento que YA se contó. Sumarlos duplica la venta.
  // Medido para UD1201 en rutas vecinales: 98.2 % de solape con el ticket, placebo 0.
  ['UD0501', 'espejo_factura', 'Factura TK Contado'],
  ['UD1201', 'espejo_factura', 'Factura Cont No Fiscal'],
  ['UD0601', 'espejo_factura', 'Factura global'],
  ['UD0701', 'espejo_factura', 'Factura Global Contado'],
  // No son venta: no mueven dinero de cliente.
  ['UD3501', 'no_venta', 'Cotizacion'],
  ['UD3601', 'no_venta', 'Cotizacion produccion'],
  ['UD4001', 'no_venta', 'Pedido'],
  ['UD4101', 'no_venta', 'Embarque Telemarketing'],
  ['UD4102', 'no_venta', 'Embarque Sucursal'],
  ['UD4501', 'no_venta', 'Remision'],
  ['UD9001', 'no_venta', 'Saldar Documentos'],
  ['UD9101', 'no_venta', 'Resolucion-Rechazo venta'],
];

const TENANT = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  const existe = await knex.schema.withSchema('analytics').hasTable('kepler_sale_doc_class');
  if (!existe) {
    await knex.schema.withSchema('analytics').createTable('kepler_sale_doc_class', (t) => {
      t.uuid('tenant_id').notNullable();
      /** `UD` + tipo(2) + subtipo(2), como lo arma Kepler en `k_doc7`. */
      t.text('doc_code').notNullable();
      /**
       * ⛔ Las cinco clases son distintas A PROPÓSITO y ninguna es «otros»:
       *   contado_caja   — se cobra en una caja registradora; cuadra contra el arqueo.
       *   credito        — abre cargo en cartera; se cobra después y en otra cuenta.
       *   espejo_factura — re-emite algo ya contado. Sumarlo DUPLICA la venta.
       *   no_venta       — pedido, embarque, cotización: no mueve dinero de cliente.
       *   sin_clasificar — nadie lo decidió todavía. No se guarda: lo produce la vista.
       */
      t.text('clase').notNullable();
      t.text('nota');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by');
      t.text('updated_by');
      t.timestamp('deleted_at', { useTz: true });
      t.primary(['tenant_id', 'doc_code']);
    });
    await knex.raw(`ALTER TABLE analytics.kepler_sale_doc_class
      ADD CONSTRAINT kepler_sale_doc_class_clase_chk
      CHECK (clase IN ('contado_caja','credito','espejo_factura','no_venta'))`);
  }

  // Idempotente: re-correrla no duplica ni pisa una clase que alguien ya corrigió a mano.
  for (const [doc_code, clase, nota] of CLASES) {
    await knex('analytics.kepler_sale_doc_class')
      .insert({ tenant_id: TENANT, doc_code, clase, nota, created_by: 'migracion [VEC.25]' })
      .onConflict(['tenant_id', 'doc_code']).ignore();
  }

  /**
   * El UNIVERSO sale del ERP y la DECISIÓN de nuestra tabla. Un tipo nuevo en Kepler aparece acá
   * al día siguiente con `clase = 'sin_clasificar'`, que es justamente lo que se quiere ver.
   *
   * ⚠️ `kdmm` está replicado por sucursal (9 copias) y hay un tipo —`UD1201`— cuyas banderas NO
   * coinciden entre ellas. Por eso se agrupa por `doc_code` y se publica `sucursales` y
   * `nombres_distintos`: si un día el nombre discrepa, se ve, en vez de que `DISTINCT ON` elija
   * uno en silencio.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_kepler_sale_doc_class AS
    WITH cat AS (
      SELECT 'UD' || lpad((m.c3)::int::text, 2, '0') || lpad((m.c4)::int::text, 2, '0') AS doc_code,
             min(btrim(m.c5))                        AS nombre,
             count(DISTINCT btrim(m.sucursal))::int   AS sucursales,
             count(DISTINCT btrim(m.c5))::int         AS nombres_distintos
        FROM kepler_ods.kdmm m
       WHERE btrim(m.c1) = 'U' AND btrim(m.c2) = 'D'
       GROUP BY 1)
    SELECT '${TENANT}'::uuid                       AS tenant_id,
           cat.doc_code,
           cat.nombre,
           cat.sucursales,
           cat.nombres_distintos,
           COALESCE(k.clase, 'sin_clasificar')     AS clase,
           k.nota,
           (k.doc_code IS NOT NULL)                AS clasificado
      FROM cat
      LEFT JOIN analytics.kepler_sale_doc_class k
             ON k.tenant_id = '${TENANT}'::uuid
            AND k.doc_code = cat.doc_code
            AND k.deleted_at IS NULL`);

  /**
   * Ruta × tipo de documento × clase, con el universo de RUTAS tomado del catálogo `kduv` y no de
   * «las rutas que resulta que emitieron un ticket».
   *
   * ⭐ Ese cambio de universo es el punto: `1V006` vendió $721,860.44 y no aparecía en ningún
   * lado porque nunca emitió un `U-D-10`. Acá aparece, con su clase y su importe.
   *
   * ⚠️ Se filtra `c1 = sucursal` igual que la vista de documentos: sin eso, los movimientos que
   * una sucursal registra contra otra se cuentan dos veces.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_vecinal_route_doc_coverage AS
    WITH rutas AS (
      SELECT DISTINCT btrim(v.sucursal) AS warehouse_code,
                      btrim(v.c2)       AS route_no,
                      btrim(v.c3)       AS route_name
        FROM kepler_ods.kduv v
       WHERE btrim(COALESCE(v.c2, '')) ~ '^[0-9]V[0-9]'),
    docs AS (
      SELECT btrim(h.sucursal) AS warehouse_code,
             btrim(h.c12)      AS route_no,
             'UD' || lpad((h.c4)::int::text, 2, '0') || lpad((h.c5)::int::text, 2, '0') AS doc_code,
             h.c9::date        AS business_date,
             h.c16             AS importe
        FROM kepler_ods.kdm1 h
       WHERE h.c2 = 'U' AND h.c3 = 'D'
         AND btrim(COALESCE(h.c12, '')) ~ '^[0-9]V[0-9]'
         AND btrim(COALESCE(h.c1, '')) = btrim(h.sucursal)
         AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
         AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date)
    SELECT '${TENANT}'::uuid                AS tenant_id,
           r.warehouse_code,
           r.route_no,
           r.route_name,
           d.doc_code,
           -- ⛔ El nombre se toma del catálogo, pero el doc_code sale del DOCUMENTO. Al revés,
           -- un tipo que kdm1 usa y kdmm no tiene —pasa: el catálogo está replicado por
           -- sucursal y una sucursal puede no traer el suyo— llegaba con clase en NULL, que es
           -- la misma desaparición silenciosa que esto viene a cerrar.
           c.nombre                         AS doc_nombre,
           COALESCE(c.clase, 'sin_clasificar') AS clase,
           count(d.importe)::int            AS docs,
           COALESCE(sum(d.importe), 0)      AS importe,
           min(d.business_date)             AS desde,
           max(d.business_date)             AS hasta
      FROM rutas r
      LEFT JOIN docs d
             ON d.warehouse_code = r.warehouse_code AND d.route_no = r.route_no
      LEFT JOIN analytics.v_kepler_sale_doc_class c
             ON c.doc_code = d.doc_code
     GROUP BY 1,2,3,4,5,6,7`);

  await knex.raw(`GRANT SELECT ON analytics.v_kepler_sale_doc_class TO PUBLIC`);
  await knex.raw(`GRANT SELECT ON analytics.v_vecinal_route_doc_coverage TO PUBLIC`);
  await knex.raw(`GRANT SELECT ON analytics.kepler_sale_doc_class TO PUBLIC`);
};

exports.down = async function down(knex) {
  // ⛔ La tabla de clases NO se borra: es un dato propio y hay una regla dura al respecto.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_vecinal_route_doc_coverage`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_sale_doc_class`);
};
