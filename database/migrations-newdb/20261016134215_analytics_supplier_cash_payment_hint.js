'use strict';
/**
 * `[CGA-C.4]` — **La semilla de «quién cobra en efectivo»: el HECHO, al lado de la DECLARACIÓN.**
 *
 * `[CGA-C.2]` agregó `catalog.suppliers.cash_payment_mode`, que es una **declaración de una
 * persona**. Esta vista publica, para la misma lista, **lo que de verdad pasó** — y las dos cosas
 * juntas, para que la pantalla muestre *sugerido vs declarado* y la persona corrija en vez de
 * capturar de cero sobre 1,331 proveedores.
 *
 * ⛔ **VISTA, no tabla.** Es derivable de `analytics.erp_supplier_payments` (que a su vez deriva
 * del ODS) y de `catalog.suppliers`. Materializarla sería una segunda copia del mismo hecho.
 *
 * ── Lo medido antes, contra prod el 2026-10-16 ──────────────────────────────────────────────
 *
 *   nunca   (0 % caja)    187 proveedores   $281,906,926.64
 *   siempre (100 % caja)  111 proveedores   $ 33,443,523.46
 *   mixto                  22 proveedores   $128,468,923.05   ← $23,908,142.47 en caja (41.7 %)
 *
 * ⛔⛔ **POR QUÉ NO HAY TOLERANCIA EN PORCENTAJE, aunque la iba a poner.** Medí los dos bordes y
 * un umbral haría lo incorrecto en LOS DOS:
 *
 *   · arriba — 2 proveedores entre 99 % y 100 %: `CB013` BOTANAS PAU con **$9.09** fuera de caja
 *     y `CA022` ABARROTES con **$2.00**. Un humano ve «$9.09» y decide en un segundo.
 *   · abajo  — 5 proveedores por debajo del 1 %, y **no son ruido**: `CD015` DISTRIBUIDORA DE LA
 *     ROSA está en **0.21 %**… que son **$133,117.65 en efectivo**. Más que el total anual de
 *     muchos proveedores clasificados `siempre`. Un umbral de «<1 % es nunca» **esconde $133 K**.
 *
 * ⭐ *Un porcentaje esconde el importe absoluto, y acá el importe es lo que decide.* Por eso el
 * modo sugerido es **estricto** (cero efectivo = `nunca`, cero no-efectivo = `siempre`, lo demás
 * `mixto`) y la vista publica **el peso y el porcentaje juntos**: quien decide ve los $9.09 y ve
 * los $133,117.65, y no hay un umbral escondido eligiendo por él.
 *
 * ⚠️ **El universo se DECLARA, no se asume** (ADR-056): `primer_pago`/`ultimo_pago` viajan en la
 * vista porque el feed arranca el **2025-12-23**, no «siempre». Un proveedor sin pagos en ese
 * rango sale con `modo_sugerido = NULL` — *«no hay con qué sugerir»*, que no es `nunca`.
 *
 * ⚠️ Incluye los **borrados** (`borrado = true`) a propósito: `[CGA-C.3]` midió que **22
 * proveedores soft-deleted siguen cobrando** ($11,220,546.79) y 10 de ellos en efectivo.
 * Filtrarlos acá repetiría el defecto que esa fase encontró.
 *
 * `security_invoker = true` como `analytics.v_vecinal_conciliacion` (el precedente más reciente):
 * `catalog.suppliers` tiene RLS forzado y así la aplica el que consulta, no el dueño de la vista.
 *
 * Idempotente (`CREATE OR REPLACE` + `GRANT` explícito).
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_supplier_cash_payment_hint';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA}
    WITH (security_invoker = true) AS
    WITH pagos AS (
      SELECT p.proveedor_code,
             max(p.proveedor_nombre)                                        AS proveedor_nombre,
             count(*)::int                                                  AS pagos,
             sum(p.monto)                                                   AS monto_total,
             coalesce(sum(p.monto) FILTER (WHERE p.medio_pago = 'caja'), 0) AS monto_caja,
             coalesce(sum(p.monto) FILTER (WHERE p.medio_pago <> 'caja'), 0) AS monto_otro,
             count(*) FILTER (WHERE p.medio_pago = 'caja')::int             AS pagos_caja,
             min(p.pago_date)                                               AS primer_pago,
             max(p.pago_date)                                               AS ultimo_pago,
             max(p.pago_date) FILTER (WHERE p.medio_pago = 'caja')          AS ultimo_pago_caja,
             -- Lo que NO es ni caja ni banco: factoraje, ajuste a saldo, devoluciones. Viaja
             -- aparte porque mezclarlo con "banco" fue lo que corrompió la primera medición.
             coalesce(sum(p.monto) FILTER (WHERE p.medio_pago NOT IN ('caja','banco')), 0) AS monto_no_tesoreria
        FROM analytics.erp_supplier_payments p
       GROUP BY p.proveedor_code
    )
    SELECT s.tenant_id,
           s.id                                   AS supplier_id,
           btrim(s.code)                          AS proveedor_code,
           s.name                                 AS proveedor_nombre,
           (s.deleted_at IS NOT NULL)             AS borrado,
           -- EL HECHO
           g.pagos, g.pagos_caja,
           g.monto_total, g.monto_caja, g.monto_otro, g.monto_no_tesoreria,
           round(100.0 * g.monto_caja / nullif(g.monto_total, 0), 4) AS pct_caja,
           g.primer_pago, g.ultimo_pago, g.ultimo_pago_caja,
           -- EL MODO SUGERIDO: estricto, sin umbral escondido. NULL = no hay con qué sugerir.
           CASE WHEN g.proveedor_code IS NULL OR g.monto_total IS NULL THEN NULL
                WHEN g.monto_caja = 0                        THEN 'nunca'
                WHEN g.monto_total - g.monto_caja = 0        THEN 'siempre'
                ELSE 'mixto' END                  AS modo_sugerido,
           -- LA DECLARACIÓN
           s.cash_payment_mode                    AS modo_declarado,
           s.cash_payment_reason                  AS motivo,
           s.cash_payment_updated_by              AS declarado_por,
           s.cash_payment_updated_at              AS declarado_el,
           -- ¿Coinciden? NULL cuando falta cualquiera de los dos: "sin declarar" no es
           -- "no coincide", y pintarlos igual sería dibujar un hueco como un desacuerdo.
           CASE WHEN s.cash_payment_mode IS NULL OR g.proveedor_code IS NULL THEN NULL
                ELSE s.cash_payment_mode = (
                  CASE WHEN g.monto_caja = 0 THEN 'nunca'
                       WHEN g.monto_total - g.monto_caja = 0 THEN 'siempre'
                       ELSE 'mixto' END)
           END                                     AS coincide
      FROM catalog.suppliers s
      LEFT JOIN pagos g ON g.proveedor_code = btrim(s.code)
  `);

  await knex.raw(`COMMENT ON VIEW ${VISTA} IS '${[
    'CGA-C.4 - Semilla de "quien cobra en efectivo": el HECHO (medio_pago de erp_supplier_payments)',
    'al lado de la DECLARACION (catalog.suppliers.cash_payment_mode).',
    'modo_sugerido es ESTRICTO, sin tolerancia: un umbral en % esconderia los $133,117.65 en caja',
    'de CD015 (0.21%) y marcaria como mixto a CB013 por $9.09. El peso y el % viajan juntos para',
    'que decida una persona. modo_sugerido NULL = sin pagos en el feed (desde 2025-12-23), que NO',
    'es "nunca". Incluye borrados a proposito: CGA-C.3 midio 22 soft-deleted que siguen cobrando.',
  ].join(' ').replace(/'/g, "''")}'`);

  // Mismo grant que sus hermanas de `analytics` (`erp_supplier_payments`, `v_vecinal_conciliacion`):
  // prod corre como `postgres` (superusuario, no necesita grant) y `dev_ro` es quien la consulta.
  await knex.raw(`GRANT SELECT ON ${VISTA} TO dev_ro`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
