'use strict';
/**
 * `[RE.14.1]` — La misma recepción está capturada **dos veces**: en el Kepler de la sucursal y
 * otra vez en el servidor de **oficinas** (9.95, sucursal `'00'`). Esta migración le da a la
 * tabla de marcas lo que le falta para poder **cazarlas, cuadrarlas y mostrarlas como par**.
 *
 * Lo que ya había (RE.12, mig 20260820120000): `analytics.erp_goods_receipt_dedup` con
 * `cedis_folio → (dup_of_sucursal, dup_of_folio)`, que la vista lee por LEFT JOIN para **ocultar**
 * la copia de oficinas y no contar el dinero dos veces. Sirve para los KPIs, pero es insuficiente
 * para el proceso documental, por tres razones que salieron de medir la data:
 *
 *   1. **El apareo no es exacto.** Los dos servidores capturan por separado, así que los importes
 *      no siempre coinciden al centavo (HERSHEY 2026-08-17: sucursal 06 `$79,009.21` vs oficinas
 *      `$79,007.79`, **$1.42** de diferencia) y las fechas se corren días. Un predicado de
 *      igualdad estricta deja pares reales sin casar; hace falta **regla + score** por par.
 *   2. **Los nombres de proveedor NO son la misma llave**: cada servidor tiene su catálogo
 *      (`DIONICIO CALDERON` en la sucursal 06 = `BOTANAS CALDERON` en oficinas, mismo día y
 *      mismo importe). Un par apareado por importe+fecha con nombre distinto es *sugerencia*,
 *      no verdad → necesita **confirmación humana**, y esa decisión no la puede pisar el cron.
 *   3. **El par hay que poder verlo**, no sólo esconderlo: el usuario busca un folio y tiene que
 *      saber cuál es el de su sucursal y cuál el de oficinas, con el importe de cada lado. Eso
 *      pide el importe/fecha de las dos copias a mano (denormalizado, patrón `logistics.trackers`)
 *      para no barrer dos veces la vista viva sobre `kepler_ods`.
 *
 * Además: ocultar la copia de oficinas es una afirmación de dinero (esa compra deja de contarse),
 * así que ahora sólo la ocultan los pares **vigentes** — la vista exige
 * `dd.status IN ('auto','confirmado')`. Un par apenas *propuesto*, o uno **rechazado** por una
 * persona, dejan la fila visible y contable. La marca rechazada **se conserva** para que el
 * detector no la vuelva a proponer.
 *
 * `CREATE OR REPLACE VIEW` con el mismo contrato de 17 columnas: sólo cambia la condición del
 * LEFT JOIN. Idempotente. No borra datos.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

/** Igual a 20260820120000 + la condición extra en el JOIN de marcas. */
const VIEW = (extraJoin) => `
  CREATE OR REPLACE VIEW analytics.erp_goods_receipts AS
  SELECT
    '${M}'::uuid                                        AS tenant_id,
    ap.sucursal::text                                  AS sucursal,
    btrim(ap.c6::text)                                 AS folio,
    'XA2001'::text                                     AS doc_prefix,
    ap.c9::date                                        AS receipt_date,
    NULLIF(btrim(ap.c10::text),'')                     AS proveedor_code,
    NULLIF(btrim(ap.c32::text),'')                     AS proveedor_nombre,
    NULLIF(btrim(ap.c22::text),'')                     AS proveedor_rfc,
    oe.vale_folio                                      AS vale_folio,
    oe.oc_folio                                        AS oc_folio,
    NULLIF(btrim(ap.c24::text),'')                     AS concepto,
    round(coalesce(nullif(regexp_replace(ap.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS monto,
    ('md_'||ap.sucursal)::text                         AS source_branch,
    now()                                              AS computed_at,
    dd.dup_of_sucursal                                 AS dup_of_sucursal,
    dd.dup_of_folio                                    AS dup_of_folio,
    wk.id                                              AS warehouse_id
  FROM kepler_ods.kdm1 ap
  LEFT JOIN LATERAL (
    SELECT NULLIF(btrim(oe.c39::text),'') AS vale_folio,
           (SELECT NULLIF(btrim(v.c39::text),'') FROM kepler_ods.kdm1 v
              WHERE v.sucursal=oe.sucursal AND v.c2='X' AND v.c3='A' AND btrim(v.c4::text)='37'
                AND btrim(v.c6::text)=btrim(oe.c39::text)
              ORDER BY btrim(v.c6::text) LIMIT 1) AS oc_folio
      FROM kepler_ods.kdm1 oe
     WHERE oe.sucursal=ap.sucursal AND oe.c2='X' AND oe.c3='A' AND btrim(oe.c4::text)='40'
       AND btrim(oe.c6::text)=btrim(ap.c39::text)
     ORDER BY btrim(oe.c39::text) LIMIT 1
  ) oe ON true
  LEFT JOIN commercial.warehouses wk
    ON wk.tenant_id='${M}'::uuid AND wk.code=ap.sucursal::text AND wk.deleted_at IS NULL
  LEFT JOIN analytics.erp_goods_receipt_dedup dd
    ON dd.tenant_id='${M}'::uuid AND ap.sucursal::text='00' AND dd.cedis_folio=btrim(ap.c6::text)${extraJoin}
  WHERE ap.c2='X' AND ap.c3='A' AND btrim(ap.c4::text)='20' AND btrim(ap.c1::text)=ap.sucursal::text

  UNION ALL
  SELECT
    '${M}'::uuid,
    mp.source_branch::text,
    btrim(mp.documento::text),
    ('WCJ-'||btrim(mp.tipo::text)),
    mp.fecha::date,
    NULLIF(btrim(mp.tercero::text),''),
    pr.nombre,
    pr.rfc,
    NULL::text,
    NULL::text,
    NULL::text,
    round(coalesce(mp.valor::numeric,0)+coalesce(mp.iva::numeric,0)+coalesce(mp.ieps::numeric,0),2),
    ('wincaja_'||mp.source_branch)::text,
    now(),
    NULL::text,
    NULL::text,
    ww.id
  FROM wincaja.movimiento_proveedores mp
  JOIN wincaja.branches b
    ON b.tenant_id=mp.tenant_id AND b.source_branch=mp.source_branch AND b.kepler_code IS NULL AND b.warehouse_code LIKE 'MD-%'
  LEFT JOIN (
    SELECT source_branch, proveedor, max(nombre) AS nombre, max(rfc) AS rfc
      FROM wincaja.proveedores WHERE tenant_id='${M}'::uuid GROUP BY source_branch, proveedor
  ) pr ON pr.source_branch=mp.source_branch AND pr.proveedor=mp.tercero
  LEFT JOIN commercial.warehouses ww
    ON ww.tenant_id='${M}'::uuid AND ww.wincaja_source_branch=mp.source_branch AND ww.deleted_at IS NULL
  WHERE mp.tenant_id='${M}'::uuid AND mp.source_dataset='actual' AND mp.tipo IN ('CR','CC')
`;

const COLS = [
  ['match_rule', 'text'],           // exacta | monto_fecha | centavos | sugerida | manual
  ['match_score', 'numeric(4,3)'],  // 0..1 — qué tan sólido es el par
  ['suc_date', 'date'],             // denorm de la canónica (la de sucursal)
  ['suc_monto', 'numeric(14,2)'],
  ['cedis_date', 'date'],           // denorm de la copia de oficinas
  ['cedis_monto', 'numeric(14,2)'],
  ['delta_monto', 'numeric(14,2)'], // cedis_monto - suc_monto: la diferencia que hay que explicar
  ['delta_dias', 'integer'],
  ['decided_by', 'text'],
  ['decided_at', 'timestamptz'],
];

exports.up = async function up(knex) {
  for (const [col, tipo] of COLS) {
    if (!(await knex.schema.withSchema('analytics').hasColumn('erp_goods_receipt_dedup', col))) {
      await knex.raw(`ALTER TABLE analytics.erp_goods_receipt_dedup ADD COLUMN ${col} ${tipo}`);
    }
  }
  // `status` — quién y cuánto se cree el par, y si oculta o no la copia de oficinas:
  //   'propuesto'  el detector encontró un candidato DUDOSO (importe y fecha casan pero el
  //                proveedor no, o la copia de oficinas trae productos propios) → NO oculta
  //                nada, espera a una persona. Es lo que evita que un apareo malo esconda una
  //                compra real del CEDIS.
  //   'auto'       espejo por regla fuerte + la copia de oficinas es de puro concepto (sin
  //                productos, así que no puede ser una recepción por su cuenta) → oculta.
  //   'confirmado' / 'rechazado'  lo dictaminó una persona; el detector NO los pisa.
  // Con NOT NULL DEFAULT las marcas viejas (RE.12) entran como 'auto', que es lo que ya hacían.
  if (!(await knex.schema.withSchema('analytics').hasColumn('erp_goods_receipt_dedup', 'status'))) {
    await knex.raw(`ALTER TABLE analytics.erp_goods_receipt_dedup ADD COLUMN status text NOT NULL DEFAULT 'auto'`);
  }
  await knex.raw('ALTER TABLE analytics.erp_goods_receipt_dedup DROP CONSTRAINT IF EXISTS chk_grd_status');
  await knex.raw(`ALTER TABLE analytics.erp_goods_receipt_dedup
                    ADD CONSTRAINT chk_grd_status CHECK (status IN ('propuesto','auto','confirmado','rechazado'))`);

  // Lookup inverso: dada la canónica de sucursal, ¿qué folio de oficinas le corresponde? Es el
  // que necesita la lista para poder decir "también está en oficinas como 00/0009136".
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_grd_canonica
                    ON analytics.erp_goods_receipt_dedup (tenant_id, dup_of_sucursal, dup_of_folio)`);
  // El par es 1:1: la PK ya impide que una copia de oficinas apunte a dos canónicas; esto impide
  // lo inverso (dos copias VIGENTES sobre la misma canónica), que es lo que rompería el cuadre.
  // Sólo aplica a las que ocultan: de las 'propuesto' puede haber varias compitiendo por la misma
  // canónica, y justamente por eso las tiene que resolver una persona.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_grd_canonica_viva
                    ON analytics.erp_goods_receipt_dedup (tenant_id, dup_of_sucursal, dup_of_folio)
                 WHERE status IN ('auto','confirmado') AND dup_of_folio IS NOT NULL`);

  // La vista sólo oculta la fila de oficinas cuando el par está vigente: una propuesta sin
  // dictaminar, o un par rechazado por una persona, dejan la fila visible (y contable).
  await knex.raw(VIEW(" AND dd.status IN ('auto','confirmado')"));

  await knex.raw(`COMMENT ON TABLE analytics.erp_goods_receipt_dedup IS
    'Pares de la MISMA recepción capturada dos veces (RE.12 + RE.14): copia de oficinas (sucursal 00, servidor 9.95) -> canónica de sucursal (la que trae los productos). match_rule/match_score = con qué regla se apareó; status propuesto|auto|confirmado|rechazado (sólo auto/confirmado ocultan; la decisión humana manda y el detector no la pisa); suc_*/cedis_* denormalizados para mostrar el par sin volver a barrer la vista viva. La mantiene detect-goods-receipt-duplicates.js. La vista erp_goods_receipts la lee por LEFT JOIN (status IN (auto,confirmado)) para no contar el dinero dos veces.'`);
};

exports.down = async function down(knex) {
  // Vuelve al JOIN sin condición de status (20260820120000). Las columnas quedan: son aditivas y
  // tirarlas perdería las confirmaciones humanas.
  await knex.raw(VIEW(''));
  await knex.raw('DROP INDEX IF EXISTS analytics.ux_grd_canonica_viva');
};
