/**
 * `[PGP.14]` **El crédito a favor que nadie aplicó: $8.26 M que la pantalla de Pagos no ve.**
 *
 * Pregunta de Edgar el 2026-10-26: *«¿cómo sabemos cuándo debemos aplicar una nota de crédito o
 * alguna devolución?»*. La respuesta medida es que **Kepler ya las aplica** —`kdxf` casa el abono
 * contra el cargo y la deuda viva nace ya neteada—, pero **lo que nadie aplicó es invisible**:
 * `analytics.v_supplier_payables` sólo deja pasar documentos de clase `A` (cargos), así que un
 * abono con saldo a favor no aparece en ninguna pantalla.
 *
 * ── El decode, verificado y no adivinado ────────────────────────────────────────────────────
 *
 * Los doctypes salen de `kdmm` del módulo `X` (cuentas por pagar), clase `D`:
 *
 * | tipo | qué es | ¿entra acá? |
 * |---|---|---|
 * | 25 · 26 | Cheque / Transferencia a proveedor | ❌ **son PAGOS**, no crédito a favor |
 * | 30 · 35 | Salida por devolución · Aplica devolución | ✔ |
 * | 40 | Devolución compra crédito | ✔ |
 * | 45 | Bonificación | ✔ |
 * | 50 | Ajuste abono general | ✔ |
 * | 55 · 56 | Nota crédito · Nota crédito CFDI | ✔ |
 * | 60 | Anticipo a proveedor | ✔ |
 *
 * ⛔ **En `kdxf` el ABONO es `c4/c5/c6` y el CARGO es `c7/c8/c9`.** La primera medición unió por
 * el lado del cargo y devolvió «$0 aplicado» para TODO —incluidos los cheques, que obviamente se
 * aplican—. Ese imposible fue el control que delató el instrumento; la vista
 * `v_supplier_payables` ya usaba la llave correcta para su lado.
 *
 * ── Lo medido el 2026-10-26 ─────────────────────────────────────────────────────────────────
 *
 * - **$8,264,176 sin aplicar en 201 documentos.**
 * - Las **notas de crédito SÍ se aplican** (1,801 docs, $110.6 M, ~100 %): ese proceso funciona.
 *   Lo que se queda son **anticipos (58 % aplicado, $6.99 M sueltos)** y **devoluciones (40 %,
 *   $1.25 M)** — 6 de cada 10 devoluciones nunca se netearon.
 * - **54 proveedores tienen deuda viva Y crédito a favor**: les debemos $49.3 M y traen $4.48 M.
 *   Varios quedarían en **cero**: PRODUCTOS FRUTI FRESK debe $149,640 y trae $2,000,820.
 * - Control placebo: 15 proveedores con crédito ($2.95 M) **sin** deuda viva — ese no se puede
 *   netear hoy, y por eso la cifra accionable es $4.48 M y no $8.26 M.
 *
 * ⚠️ **Declarado:** el control de cheques da **105 %** aplicado, no 100 % — `kdxf` sobre-cuenta
 * un poco (replicación por sucursal). Sobre-contar lo aplicado hace **sub-contar** lo pendiente,
 * así que las cifras de esta vista son un **piso**, no un dictamen.
 *
 * Costo medido del SELECT completo: **134 / 216 / 134 ms** (regla dura: 500 ms).
 */
const CRED = '30,35,40,45,50,55,56,60';

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_supplier_unapplied_credits AS
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
      -- ⛔ El ABONO es c4/c5/c6. El cargo que salda es c7/c8/c9, y NO es lo que se agrupa acá.
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
           ab.importe - COALESCE(ap.aplicado, 0::numeric) AS a_favor,
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
      ) p ON p.ck = ab.proveedor
     WHERE ab.importe - COALESCE(ap.aplicado, 0::numeric) > 0.005;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_supplier_unapplied_credits;`);
};
