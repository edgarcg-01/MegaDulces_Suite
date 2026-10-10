'use strict';
/**
 * `[MCP.7.1]` — Notas de crédito / devoluciones de Kepler aplicadas a un TICKET de venta (Fase MCP, I1).
 *
 * Cuando un pedido de preventa no se entrega (3 intentos, I2), la cajera aplica en Kepler la
 * devolución y la nota de crédito. Esta función deja ver, EN VIVO desde el ODS, qué notas quedaron
 * ligadas al ticket, para que la mesa marque el pedido como "devuelto con NC" (saldado) o "NC parcial".
 *
 * ── La cadena (medida en prod, solo lectura, 2026-10-10) ───────────────────────────────────────
 * Kepler NO aplica la nota al ticket: la aplica a la factura que nace del ticket. La liga es el
 * documento ORIGEN de kdm1 (c36 naturaleza · c37 tipo · c38 serie/caja · c39 folio):
 *
 *   ticket U-D-10 (caja c5, folio c6)
 *     ← factura U-D-5 (fiscal) o U-D-12 (cliente CONTADO)   c36='D', c37=10, c38=caja, c39=folio del ticket
 *       ← nota U-A-21 (NC/dev POS fiscal) o U-A-25 (NoFis)   c36='D', c37=tipo, c38=serie, c39=folio de la factura
 *
 * Cobertura medida en 2026: 189/189 U-A-21 → U-D-5 y 475/475 U-A-25 → U-D-12 encuentran su factura;
 * 9,383/9,391 U-D-5 y 4,412/4,412 U-D-12 encuentran su ticket. Testigo independiente: el saldo de
 * la factura (c42) = total − Σ notas ligadas en 176/183 y 437/459 (el resto, centavos).
 * Ejemplo: ticket 04UD1003-0002051 $326.80 ← UD0501-0001768 (saldo 0.00) ← UA2101-0000106 $326.80
 * "CUCHARA ERA MAS GRANDE".
 *
 * ⛔ Lo que NO ve: notas hechas en Kepler SIN documento origen (en la 04, 2026: 24 U-A-21 y 104 U-A-25).
 * No se adivinan por cliente + importe (medido: candidato único en 6 de 52). Se declaran: la mesa pide
 * hacer la nota DESDE la factura del ticket (decisión de Francisco, 2026-10-10).
 * ⚠️ El marcador de factura cancelada se supone `c43 = 'C'` (como en las notas); no está medido.
 *
 * ── Por qué FUNCIÓN y no vista ───────────────────────────────────────────────────────────────
 * Derive-no-copy igual que una vista (lee kepler_ods en vivo, sin importer ni tabla), pero recibe el
 * LOTE de tickets: como vista, el planificador empieza por todas las notas de la sucursal y tarda
 * ~1 s por 300 tickets (medido); buscando primero las facturas de esos tickets, 97 ms. kdm1 no tiene
 * índice por c39 para U-D y no se crea (es la tabla de la réplica del CDC).
 *
 * El ODS es de Mega Dulces: la función devuelve el tenant fijo y el servicio filtra por él.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.erp_ticket_credit_notes(p_sucursal text[], p_caja int[], p_folio text[])
    RETURNS TABLE (
      tenant_id uuid, sucursal text, ticket_caja int, ticket_folio text,
      factura_folio text, saldo_factura numeric,
      nota_folio text, nota_tipo int, fecha date, cliente text, importe numeric, motivo text
    )
    LANGUAGE sql STABLE
    SET search_path = pg_catalog, public
    AS $fn$
      WITH tk AS (SELECT * FROM unnest(p_sucursal, p_caja, p_folio) AS t(suc, caja, folio)),
      fa AS MATERIALIZED (
        SELECT tk.suc, tk.caja, tk.folio, f.c1, f.c4, f.c5, f.c6, f.c42
          FROM tk
          JOIN kepler_ods.kdm1 f
            ON f.sucursal = tk.suc AND f.c1 = tk.suc AND f.c2 = 'U' AND f.c3 = 'D' AND f.c4 IN (5, 12)
           AND btrim(f.c36) = 'D' AND f.c37 = 10 AND f.c38 = tk.caja AND btrim(f.c39) = tk.folio
           AND btrim(coalesce(f.c43, '')) <> 'C'
      )
      SELECT '${M}'::uuid, fa.suc, fa.caja, fa.folio,
             'UD' || lpad(fa.c4::int::text, 2, '0') || lpad(fa.c5::int::text, 2, '0') || '-' || btrim(fa.c6),
             fa.c42::numeric,
             'UA' || lpad(a.c4::int::text, 2, '0') || lpad(a.c5::int::text, 2, '0') || '-' || btrim(a.c6),
             a.c4::int, a.c9::date, btrim(a.c10), a.c16::numeric, NULLIF(btrim(a.c24), '')
        FROM fa
        JOIN kepler_ods.kdm1 a
          ON a.sucursal = fa.suc AND a.c1 = fa.c1 AND a.c2 = 'U' AND a.c3 = 'A' AND a.c4 IN (21, 25)
         AND btrim(coalesce(a.c43, '')) <> 'C' AND btrim(a.c36) = 'D'
         AND a.c37 = fa.c4 AND a.c38 = fa.c5 AND btrim(a.c39) = btrim(fa.c6)
    $fn$`);
  await knex.raw(`COMMENT ON FUNCTION analytics.erp_ticket_credit_notes(text[], int[], text[]) IS
    'MCP.7.1 — notas de crédito/devoluciones de Kepler (U-A-21/25) ligadas a tickets U-D-10 vía su factura (U-D-5/12). En vivo del ODS, sin copia. Ver la migración 20261010042824.'`);
  // Lee kepler_ods con los permisos de quien llama (app_runtime ya lee kepler_ods).
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.erp_ticket_credit_notes(text[], int[], text[]) TO app_runtime`);

  // ── COMPUERTA: la función responde (con o sin datos) y no inventa filas sin lote ───────────
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM analytics.erp_ticket_credit_notes('{}'::text[], '{}'::int[], '{}'::text[])`);
  if (rows[0].n !== 0) throw new Error('[MCP.7.1] con un lote vacío la función devolvió filas: no está acotada al lote.');
  console.log('  [MCP.7.1] analytics.erp_ticket_credit_notes lista (lote vacío → 0 filas).');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.erp_ticket_credit_notes(text[], int[], text[])`);
};
