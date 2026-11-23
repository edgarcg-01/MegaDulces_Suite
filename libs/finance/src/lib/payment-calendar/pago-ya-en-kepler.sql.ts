/**
 * `[PGP.206]` **Lo pagado en la Suite que Kepler ya tiene no se resta dos veces.**
 *
 * Caso (Francisco, 2026-11-23): INDULMI (`CI008`), factura 08 `0000095` por $33,188.98. Tesorería la pagó el
 * 14-nov con $27,578.05 (Kepler `X-D-26` 0001077) descontando una devolución ($2,805.35) y una nota de crédito
 * ($2,805.58) que se había hecho por error y luego se canceló. La factura quedó debiendo $2,805.35 en Kepler y el
 * Calendario la escondía: para la deuda de Kepler el disponible era `pendiente de Kepler − reservado − pagado`
 * = 2,805.35 − 0 − 27,578.05 < 0. El pendiente de Kepler YA descuenta la transferencia: restar otra vez el pago
 * ejecutado lo contaba dos veces. El estado de cuenta decía además «Kepler aún no la aplica: no la vuelvas a
 * programar», porque el pago no estaba ligado (`[PGP.132]` sólo liga cuando TODAS las facturas del pago quedaron
 * saldadas).
 *
 * Medido en prod (sólo lectura, 2026-11-23): 437 renglones ejecutados de deuda de Kepler, 21 sin ligar, ninguna
 * factura con más de un pago ejecutado. 21 facturas con pago ejecutado siguen debiendo más de $1: en 5 Kepler ya
 * tiene ese dinero (INDULMI, Canel's, Charly —$472,501.51— y Pepsico escondidas del todo; Arrendamex con $47,472
 * de menos) y en 16 todavía no: ahí restar es lo correcto y se sigue haciendo.
 *
 * **La regla, por renglón ejecutado de la factura:**
 *  · LIGADO (`kepler_payment_folio`): Kepler lo tiene si ese documento está vivo, con dinero, entre las
 *    aplicaciones de la factura.
 *  · SIN LIGAR: Kepler lo tiene si, desde el día en que se armó el pago (`created_at`, como el cierre de
 *    `[PGP.132]`), le aplicó a la factura con dinero al menos su neto, sin contar documentos ligados a otro pago
 *    ejecutado de la misma factura. Con DOS o más pagos ejecutados sin ligar en la misma factura no se adivina
 *    cuál es cuál: se siguen restando.
 *
 * ⛔ Lo que falla, falla escondiendo: si algo no casa (un `c2` con relleno, otra serie, un pago reprogramado cuyo
 *    documento de Kepler es anterior a moverlo), el pago se sigue restando, como antes. Nunca se ofrece dos veces
 *    lo mismo.
 * ⛔ El descuento al pagar (`[PGP.91]`) no es de esta regla: lo decide quien la usa (el Calendario lo sigue
 *    apartando hasta que llega la nota de crédito).
 * ⛔ Lo vivo con el MISMO cruce que `analytics.v_supplier_payables` y que el cierre (`TIPOS_CANCELADOS_QUE_NO_SALDAN`):
 *    una transferencia cancelada no cuenta.
 *
 * `c1` y `c2` van sin `btrim` para usar la llave de `kdxf` (`sucursal, c1, c2, …`): medido el 2026-11-23, en las
 * 40,466 aplicaciones vivas `c1` es exactamente la sucursal y `c2` no trae relleno (0 de 40,466).
 */
import { esPagoConDinero, tipoPagoKepler } from '@megadulces/contracts';
import { TIPOS_CANCELADOS_QUE_NO_SALDAN } from './cierre-kepler.sql';

/** Los tipos `X-D` que son dinero, sacados de la regla del contrato (`esPagoConDinero`): no se reescribe la lista. */
export const TIPOS_CON_DINERO: readonly number[] = Array.from({ length: 100 }, (_, t) => t)
  .filter((t) => esPagoConDinero(tipoPagoKepler(t, 1)) || esPagoConDinero(tipoPagoKepler(t, 2)));

/** La factura de Kepler, como expresiones SQL de quien llama (`v.sucursal`, `?::text`…). `tipo`/`sub` numéricos. */
export interface LlaveFacturaSql { suc: string; prov: string; tipo: string; sub: string; folio: string }

/** Folio de Kepler comparable: sin espacios ni ceros a la izquierda (`0016796` = `16796`). */
const folioSql = (e: string) => `ltrim(btrim(${e}), '0')`;

/** Las aplicaciones VIVAS con dinero a la factura `f`, con alias `x` (aplicación) y `p` (el documento que paga). */
function aplicacionesConDinero(f: LlaveFacturaSql): string {
  return `kepler_ods.kdxf x
      LEFT JOIN kepler_ods.kdxe p
        ON p.sucursal = x.sucursal AND p.c1 = x.c1 AND p.c2 = x.c2 AND p.c3 = 'D' AND p.c4 = x.c4 AND p.c5 = x.c5 AND p.c6 = x.c6
     WHERE x.sucursal = ${f.suc} AND x.c1 = ${f.suc} AND x.c2 = ${f.prov}
       AND x.c7 = ${f.tipo} AND x.c8 = ${f.sub} AND btrim(x.c9) = ${f.folio}
       AND x.c4 IN (${TIPOS_CON_DINERO.join(', ')})
       AND NOT EXISTS (
             SELECT 1 FROM kepler_ods.kdm1 m
              WHERE m.c3 = 'D' AND m.c4 IN (${TIPOS_CANCELADOS_QUE_NO_SALDAN.map((t) => `'${t}'`).join(', ')}) AND m.c43 = 'C' AND btrim(m.c1) = m.sucursal
                AND m.sucursal = x.sucursal AND m.c1 = x.c1 AND m.c10 = x.c2
                AND m.c4 = x.c4 AND m.c5 = x.c5 AND m.c6 = x.c6)`;
}

/**
 * Expresión booleana: el renglón `i` (`finance.payment_allocation_items`) de un pago EJECUTADO `a`
 * (`finance.payment_allocations`) ya está en Kepler, en la factura `f`. Sin `?`: se puede incrustar en una
 * consulta de knex. `i` debe exponer `id`, `obligation_source`, `obligation_id` y `applied_amount`.
 */
export function sqlEjecutadoYaEnKepler(f: LlaveFacturaSql, i = 'i', a = 'a'): string {
  // Otro renglón EJECUTADO de la misma factura (otro pago).
  const otroEjecutado = (al: string, it: string) => `finance.payment_allocation_items ${it}
        JOIN finance.payment_allocations ${al} ON ${al}.id = ${it}.allocation_id
       WHERE ${it}.obligation_source = ${i}.obligation_source AND ${it}.obligation_id = ${i}.obligation_id
         AND ${it}.id <> ${i}.id AND ${al}.status = 'executed'`;
  return `(${a}.status = 'executed' AND CASE
    WHEN nullif(btrim(${a}.kepler_payment_folio), '') IS NOT NULL THEN EXISTS (
      SELECT 1 FROM ${aplicacionesConDinero(f)}
         AND ${folioSql('x.c6')} = ${folioSql(`${a}.kepler_payment_folio`)}
         AND (${a}.kepler_payment_sucursal IS NULL OR x.sucursal = ${a}.kepler_payment_sucursal)
         AND (${a}.kepler_payment_doc_prefix IS NULL
              OR 'XD' || lpad(x.c4::int::text, 2, '0') || lpad(x.c5::int::text, 2, '0') = ${a}.kepler_payment_doc_prefix))
    ELSE NOT EXISTS (SELECT 1 FROM ${otroEjecutado('a2', 'i2')} AND nullif(btrim(a2.kepler_payment_folio), '') IS NULL)
     AND (SELECT coalesce(sum(x.c10), 0) FROM ${aplicacionesConDinero(f)}
             AND coalesce(p.c7, x.c3)::date >= (${a}.created_at AT TIME ZONE 'America/Mexico_City')::date
             AND NOT EXISTS (SELECT 1 FROM ${otroEjecutado('a3', 'i3')}
                               AND ${folioSql('a3.kepler_payment_folio')} = ${folioSql('x.c6')}
                               AND (a3.kepler_payment_sucursal IS NULL OR a3.kepler_payment_sucursal = x.sucursal))
         ) >= ${i}.applied_amount - 0.01
  END)`;
}

/**
 * Lo que los pagos EJECUTADOS de una factura de Kepler todavía apartan (columna `sin_kepler`, una fila): neto +
 * descuento de los que Kepler aún no tiene; de los que ya tiene, sólo el descuento al pagar (`[PGP.91]`: su nota
 * de crédito llega después). `filtro` va en el WHERE, con los alias `i` y `a`, y acota los renglones a la factura.
 */
export function sqlEjecutadoSinKepler(f: LlaveFacturaSql, filtro: string): string {
  return `SELECT coalesce(sum(CASE WHEN ${sqlEjecutadoYaEnKepler(f)} THEN i.discount_amount
                                   ELSE i.applied_amount + i.discount_amount END), 0) AS sin_kepler
    FROM finance.payment_allocation_items i
    JOIN finance.payment_allocations a ON a.id = i.allocation_id
   WHERE i.obligation_source = 'kepler_payable' AND a.status = 'executed' AND ${filtro}`;
}
