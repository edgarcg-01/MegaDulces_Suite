/**
 * `[PGP.17]` **Los descuentos de un acreedor, LOS DOS CASOS: lo que Kepler ya aplicó y lo que no.**
 *
 * Pedido de Edgar (2026-10-26): *«apliquemos ambos casos en Suite, pero especificando todo tipo de
 * descuento para que sepan qué aplicar desde Suite»*.
 *
 * `[PGP.14]` dejó la vista `v_supplier_unapplied_credits`, que sólo publicaba lo **no aplicado**.
 * Sirve para avisar, pero no para decidir: quien ve «trae $9,778.59 a favor» no sabe de qué tipo
 * es, de qué documento sale, ni si lo de al lado ya se aplicó. Esta vista publica **todos** los
 * documentos de crédito del acreedor con su estado, y el consumidor filtra.
 *
 * ── El ejemplo que la motivó, medido ────────────────────────────────────────────────────────
 *
 * **Caso aplicado** (el 99 % de las veces): proveedor `CL005`, Padre Hidalgo. Factura `X-A-20`
 * folio 0000084 del 27-jun por **$3,230,102.16**; nota de crédito `X-D-55` folio 0000033 del
 * 30-sep por **$2,649,765.94**. `kdxf` aplicó **$2,173,299.73** contra esa factura y la factura
 * **desapareció de la pantalla de Pagos**. Nadie en la Suite hizo nada.
 *
 * **Caso sin aplicar**: `CD024` nota 0001057 (ref `DC-030`) por $9,388.63 — Kepler aplicó
 * $8,123.45 y **sobraron $1,265.18** que nadie volvió a mirar, mientras le debemos $3,061,217.88.
 *
 * ⭐ Por eso hacen falta los dos: el aplicado explica el mecanismo, el pendiente pide acción.
 *
 * ── Todos los tipos, y dónde está la plata ──────────────────────────────────────────────────
 *
 * | tipo | qué es | sin aplicar (2026-10-26) |
 * |---|---|---|
 * | `X-D-60` | Anticipo a proveedor | **$6,996,830** · 57 docs |
 * | `X-D-40` | Devolución de compra | **$1,253,956** · 139 docs |
 * | `X-D-55` · `X-D-56` | Nota de crédito · Nota de crédito CFDI | $13,391 · 5 docs |
 * | `X-D-45` | Bonificación | — |
 * | `X-D-30` · `X-D-35` | Salida / Aplica devolución | — |
 * | `X-D-50` | Ajuste de abono | — |
 *
 * ⛔ **Las notas de crédito NO son el problema** (se aplican casi al 100 %): la plata está en
 * **anticipos y devoluciones**. Publicar los tipos por separado es lo que deja verlo.
 *
 * ⛔ `X-D-25` y `X-D-26` (cheque y transferencia) **quedan fuera**: son PAGOS, no descuentos.
 * ⛔ En `kdxf` el abono es `c4/c5/c6`; `c7/c8/c9` es el cargo que salda.
 *
 * ⚠️ **Piso, no dictamen**: el control de cheques da 105 % aplicado (`kdxf` sobre-cuenta por
 * replicación de sucursal), y sobre-contar lo aplicado **sub-cuenta** lo pendiente.
 */
const CRED = '30,35,40,45,50,55,56,60';

exports.up = async function up(knex) {
  // La de PGP.14 queda subsumida: publicaba un subconjunto de ésta.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_supplier_unapplied_credits;`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_supplier_credits AS
    WITH ab AS (
      SELECT k.sucursal,
             btrim(k.c2) AS proveedor,
             k.c4 AS doc_tipo,
             k.c5 AS doc_sub,
             btrim(k.c6) AS folio,
             nullif(btrim(k.c16), '') AS referencia,
             CASE WHEN k.c7 >= '1900-01-01 00:00:00'::timestamp without time zone
                  THEN k.c7::date ELSE NULL::date END AS fecha,
             k.c11 AS importe
        FROM kepler_ods.kdxe k
       WHERE btrim(k.c1) = k.sucursal AND btrim(k.c3) = 'D' AND k.c4::int IN (${CRED})
    ), ap AS (
      SELECT f.sucursal, f.c4 AS t, f.c5 AS s, btrim(f.c6) AS folio, sum(f.c10) AS aplicado
        FROM kepler_ods.kdxf f
       WHERE btrim(f.c1) = f.sucursal AND f.c4::int IN (${CRED})
       GROUP BY 1, 2, 3, 4
    )
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           ab.sucursal, ab.proveedor, p.nombre AS proveedor_nombre,
           ab.doc_tipo, ab.doc_sub, ab.folio, ab.referencia, ab.fecha,
           ab.importe,
           COALESCE(ap.aplicado, 0::numeric) AS aplicado,
           greatest(ab.importe - COALESCE(ap.aplicado, 0::numeric), 0::numeric) AS a_favor,
           (ab.importe - COALESCE(ap.aplicado, 0::numeric)) > 0.005 AS pendiente,
           CASE ab.doc_tipo::int
             WHEN 30 THEN 'Salida por devolución'
             WHEN 35 THEN 'Aplica devolución'
             WHEN 40 THEN 'Devolución de compra'
             WHEN 45 THEN 'Bonificación'
             WHEN 50 THEN 'Ajuste de abono'
             WHEN 55 THEN 'Nota de crédito'
             WHEN 56 THEN 'Nota de crédito CFDI'
             WHEN 60 THEN 'Anticipo a proveedor'
           END AS clase
      FROM ab
      LEFT JOIN ap ON ap.sucursal = ab.sucursal AND ap.t = ab.doc_tipo
                  AND ap.s = ab.doc_sub AND ap.folio = ab.folio
      LEFT JOIN (
        SELECT DISTINCT ON ((btrim(d.c2))) btrim(d.c2) AS ck, d.c3 AS nombre
          FROM kepler_ods.kdxd d
         ORDER BY (btrim(d.c2)), (d.sucursal <> '00'::text), d.sucursal
      ) p ON p.ck = ab.proveedor;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_supplier_credits;`);
};
