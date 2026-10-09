'use strict';
/**
 * `[RD.56]` — **«Lo que faltó»: la pregunta que el Excel no puede contestar.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * La pantalla de comisiones era una transcripción del workbook: las mismas columnas, otra
 * tipografía. El Excel ya contesta *"cuánto se le paga a cada quien"* y repetirlo no agrega
 * nada. Lo que el Excel **no puede** contestar es *por qué no fue más*.
 *
 * El tabulador es ESCALONADO, no proporcional:
 *
 *     venta < 189,999.99  →  CERO          189,999.99 → 3.750%      194,999.99 → 4.250%
 *     199,999.99 → 4.562%                  215,999.99 → 5.000%
 *
 * Quedarse corto por poco no paga "un poco menos": paga el escalón de abajo, o nada.
 *
 * ── Lo medido sobre las 238 ruta-periodo del espejo, el 2026-10-08 ─────────────────────────
 *
 *   ⭐ Q13 · ruta 28 · Maria Elena Valadez Limon
 *      vendio $189,643.22 — le faltaron **$356.77** — cobro **$0** en vez de **$4,827.96**
 *
 *   34 ruta-periodo a menos de $5,000 del siguiente escalon  →  $42,694 de comision perdida
 *    6 de ellas NO COBRARON NADA, a menos de $10,000 del piso →  $30,264
 *   bonos perdidos por menos de $5,000 de venta:
 *      Lonche x10 ($8,000) · Chalan x3 ($3,000) · Lavadas x6 ($1,200)
 *
 * Total dejado sobre la mesa por quedarse corto **por menos del 2.5% de la venta**: ~$54,894.
 * Eso no es un reporte: es una lista de acciones para quien supervisa la ruta.
 *
 * ── ⚠️ La salvedad, que va en la vista y no en una nota al pie ──────────────────────────────
 * `escalon_ganancia` mantiene el SUBTOTAL fijo y sólo mueve el porcentaje. Vender más subiría
 * también el subtotal, así que la cifra **se queda corta a propósito**: es el piso de lo que se
 * habría ganado, no una proyección. Preferir el piso es lo correcto acá — una pantalla que
 * promete de más sobre el sueldo de alguien se deja de leer a la segunda vez.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_rd_commission_lo_que_falto';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW} AS
    WITH esc AS (  -- el tabulador, leido de la DB: cambiarlo es un INSERT, no un deploy
      SELECT tenant_id, min_amount, pct FROM commercial.commission_scale_tiers WHERE deleted_at IS NULL
    ), bon AS (    -- los bonos del chofer por VENTA, igual
      SELECT tenant_id, nombre, umbral, monto FROM commercial.commission_bonuses
       WHERE deleted_at IS NULL AND beneficiario = 'chofer' AND metrica = 'venta' AND route_code IS NULL
    ), reparto AS (
      SELECT tenant_id, (100 - share_supervisor_pct) / 100 AS parte_chofer
        FROM commercial.commission_scales WHERE deleted_at IS NULL AND valid_to IS NULL
    ), base AS (
      SELECT l.tenant_id, r.period_id, p.anio, p.period_no,
             to_char(p.date_to, 'YYYY-MM-DD') AS date_to,
             l.route_code, l.beneficiario_nombre, l.zona,
             l.venta, l.subtotal, l.pct_aplicado, l.comision, l.bonos, l.a_pagar,
             l.motivo_no_pago, r.origen, r.status
        FROM commercial.commission_run_lines l
        JOIN commercial.commission_runs r
          ON r.id = l.run_id AND r.deleted_at IS NULL AND r.status <> 'anulado'
        JOIN commercial.commission_periods p ON p.id = r.period_id
       WHERE l.deleted_at IS NULL AND l.beneficiario = 'chofer' AND l.venta IS NOT NULL
    )
    SELECT b.*,
           rp.parte_chofer,

           -- ── El siguiente ESCALON ────────────────────────────────────────────────────────
           sig.min_amount AS escalon_umbral,
           sig.pct        AS escalon_pct,
           round(sig.min_amount - b.venta, 2) AS escalon_falta,
           -- ⚠️ Subtotal FIJO: es el PISO de lo que se habria ganado, no una proyeccion.
           round(b.subtotal * (sig.pct - COALESCE(b.pct_aplicado, 0)) / 100 * rp.parte_chofer, 2)
             AS escalon_ganancia,

           -- ── El siguiente BONO ───────────────────────────────────────────────────────────
           sb.nombre AS bono_nombre,
           sb.umbral AS bono_umbral,
           round(sb.umbral - b.venta, 2) AS bono_falta,
           sb.monto  AS bono_monto,

           -- ── Lo que estaba al alcance, junto ─────────────────────────────────────────────
           -- Sólo cuenta el bono si el MISMO esfuerzo lo alcanzaba: si el bono pide más venta
           -- que el escalón, llegar al escalón no lo gana. Sumarlos sin mirar eso inflaría la
           -- oportunidad con dinero que no estaba ahí.
           round(COALESCE(
             round(b.subtotal * (sig.pct - COALESCE(b.pct_aplicado, 0)) / 100 * rp.parte_chofer, 2), 0)
             + CASE WHEN sb.umbral IS NOT NULL AND sig.min_amount IS NOT NULL
                     AND sb.umbral <= sig.min_amount THEN sb.monto ELSE 0 END, 2) AS oportunidad,

           -- ⭐ CUATRO estados, no dos. sin_cobrar_nada no es "difiere poco": es el
           -- acantilado -- la venta no llego al piso y la comision cae a CERO, no "a menos".
           CASE
             WHEN sig.min_amount IS NULL                              THEN 'en_el_tope'
             WHEN b.motivo_no_pago IS NOT NULL
              AND sig.min_amount - b.venta <= 10000                   THEN 'sin_cobrar_por_poco'
             WHEN b.motivo_no_pago IS NOT NULL                        THEN 'sin_cobrar'
             WHEN sig.min_amount - b.venta <= 5000                    THEN 'al_alcance'
             WHEN sig.min_amount - b.venta <= 15000                   THEN 'cerca'
             ELSE                                                          'lejos'
           END AS cercania

      FROM base b
      -- ⛔ LEFT, no CROSS. Con un CROSS, si reparto viniera vacio (ninguna escala vigente)
      -- la vista devolveria CERO FILAS en vez de decir que no sabe el reparto -- el mismo
      -- modo de falla que el hibrido de [RD.54] con la matvista vacia. Asi, la fila sobrevive
      -- y escalon_ganancia sale NULL: se DECLARA que no se pudo calcular.
      LEFT JOIN LATERAL (SELECT parte_chofer FROM reparto WHERE tenant_id = b.tenant_id LIMIT 1) rp ON true
      LEFT JOIN LATERAL (
        SELECT e.min_amount, e.pct FROM esc e
         WHERE e.tenant_id = b.tenant_id AND e.min_amount > b.venta
         ORDER BY e.min_amount LIMIT 1) sig ON true
      LEFT JOIN LATERAL (
        SELECT n.nombre, n.umbral, n.monto FROM bon n
         WHERE n.tenant_id = b.tenant_id AND n.umbral > b.venta
         ORDER BY n.umbral LIMIT 1) sb ON true`);

  await knex.raw(`ALTER VIEW ${VIEW} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    'RD.56 - cuanto le falto a cada ruta para el siguiente escalon o bono, y cuanto valia. El tabulador es ESCALONADO: quedarse corto por poco no paga un poco menos, paga el escalon de abajo o CERO. Medido sobre el espejo: Q13 ruta 28 vendio 189,643.22, le faltaron 356.77 y cobro 0 en vez de 4,827.96; 34 ruta-periodo quedaron a menos de 5,000 del siguiente escalon y eso vale 42,694. La columna escalon_ganancia mantiene el subtotal FIJO: es el piso de lo que se habria ganado, no una proyeccion.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
