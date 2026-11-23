/**
 * `[PGP.197]` **Una obligación capturada también es una factura de Kepler.** Edgar, 2026-11-23: *«estás causando mucha
 * desinformación en el calendario de pagos»*. Medido ese día en prod (sólo lectura): la factura 20-1-0009890 de CD031
 * (CEDIS) se pagó **dos veces** — Tesorería la pagó el 9-nov por fuera y el Calendario la volvió a pagar el 13-nov
 * (las dos salidas están en el banco). Era una obligación CAPTURADA (`supplier_payable`): el Calendario la medía sólo
 * contra lo que la Suite había pagado, nunca contra Kepler, así que:
 *  · la seguía ofreciendo para pagar (ese día 17 de las 24 capturadas que ofrecía ya estaban saldadas en Kepler);
 *  · el renglón del pago no decía «Kepler ya no la debe» (sólo lo decía de las derivadas);
 *  · el cierre contra Kepler (`[PGP.94]`/`[PGP.132]`) las daba por «sin medir», y un pago con una sola de ellas nunca
 *    se cerraba ni se ligaba: 2 de CF006 siguen «pendientes» desde el 26-oct con sus facturas pagadas en Kepler, y 5
 *    pagos que ya salieron del banco esperaban al escritor de `X-D-26` aunque Tesorería ya los había capturado.
 *
 * La llave de Kepler ya estaba en la obligación (`kepler_sucursal`, `kepler_doc_tipo`, `kepler_doc_sub`,
 * `kepler_folio`: 38 de 42 la traen); faltaba usarla. La cuenta del saldo es la de `analytics.v_supplier_payables`
 * (importe − lo aplicado por documentos vigentes), leída sólo para las obligaciones del renglón, no la vista entera.
 */
import { keplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';
import { TIPOS_CANCELADOS_QUE_NO_SALDAN, type ItemParaCierre } from './cierre-kepler.sql';

/**
 * Lo que Kepler debe HOY de la factura de una obligación capturada, para un `LEFT JOIN LATERAL (…) kd ON true` sobre
 * `commercial.supplier_payment_obligations` con alias `o`. Una fila con `debe` (0 = saldada) si la obligación trae su
 * llave y la factura existe en `kepler_ods.kdxe`; ninguna fila (→ `kd.debe` NULL, «no se pudo medir») si no.
 * Medido en prod el 2026-11-23: las 38 obligaciones con llave en 85 ms.
 * ⛔ `debe` sale `numeric`, como los importes de las otras patas: un `float8` aquí cambiaba el tipo de
 * `available_amount` en TODA la unión del listado.
 */
export function sqlDebeKeplerDeCapturada(o = 'o'): string {
  return `
  SELECT e.c11 - coalesce((
           SELECT sum(x.c10) FROM kepler_ods.kdxf x
            WHERE x.sucursal = e.sucursal AND x.c1 = e.c1 AND x.c2 = e.c2
              AND x.c7 = e.c4 AND x.c8 = e.c5 AND btrim(x.c9) = btrim(e.c6)
              AND NOT EXISTS (
                    SELECT 1 FROM kepler_ods.kdm1 m
                     WHERE m.c3 = 'D' AND m.c4 IN (${TIPOS_CANCELADOS_QUE_NO_SALDAN.map((t) => `'${t}'`).join(', ')}) AND m.c43 = 'C'
                       AND btrim(m.c1) = m.sucursal AND m.sucursal = x.sucursal AND m.c1 = x.c1 AND m.c10 = x.c2
                       AND m.c4 = x.c4 AND m.c5 = x.c5 AND m.c6 = x.c6)), 0) AS debe
    FROM kepler_ods.kdxe e
   WHERE ${o}.kepler_folio IS NOT NULL AND ${o}.kepler_sucursal IS NOT NULL
     AND e.sucursal = btrim(${o}.kepler_sucursal) AND btrim(e.c1) = e.sucursal AND e.c3 = 'A'
     AND e.c4 = ${o}.kepler_doc_tipo AND e.c5 = ${o}.kepler_doc_sub AND btrim(e.c6) = btrim(${o}.kepler_folio)
   LIMIT 1`;
}

/**
 * Lo disponible de una obligación capturada: lo que la Suite no ha reservado ni pagado, **topado por lo que Kepler
 * todavía debe** menos lo reservado (lo pendiente de la Suite aún no está en Kepler). Sin medida de Kepler, lo de antes.
 * `least` y no una resta: lo que la Suite pagó y ya escribió está en los dos lados, y restarlo dos veces escondería
 * deuda viva.
 */
export function sqlDisponibleDeCapturada(o = 'o', kd = 'kd'): string {
  const propio = `(${o}.original_amount - ${o}.reserved_amount - ${o}.paid_amount)`;
  return `CASE WHEN ${kd}.debe IS NULL THEN ${propio} ELSE least(${propio}, greatest(${kd}.debe - ${o}.reserved_amount, 0)) END`;
}

/** Pesos por debajo de los cuales Kepler ya no debe la factura (la misma que usa la vista: `pendiente > 0.005`). */
export const SALDADA_EN_KEPLER = 0.005;

/** La llave de Kepler de una obligación capturada, como sale de `commercial.supplier_payment_obligations`. */
export interface LlaveDeCapturada {
  id: string;
  sucursal: string | null;
  doc_tipo: string | number | null;
  doc_sub: string | number | null;
  folio: string | null;
}

/** El id con que la factura de esa obligación se mide en Kepler (`kepler_payable`), o `null` si le falta la llave. */
export function idKeplerDeCapturada(l: LlaveDeCapturada): string | null {
  const suc = l.sucursal?.trim(); const folio = l.folio?.trim();
  if (!suc || !folio || l.doc_tipo === null || l.doc_sub === null) return null;
  const tipo = Number(l.doc_tipo); const sub = Number(l.doc_sub);
  if (!Number.isFinite(tipo) || !Number.isFinite(sub)) return null;
  return keplerPayableId(suc, tipo, sub, folio);
}

/**
 * Los renglones de un pago, con cada obligación capturada que trae su llave convertida en la factura de Kepler que
 * es, para que el cierre (`armarCierres`) la mida igual que a una derivada. Las que no traen llave se quedan como
 * están (siguen «sin medir»: no se inventa a qué factura apuntan). Pura.
 */
export function conLlaveDeKepler(items: readonly ItemParaCierre[], llaves: readonly LlaveDeCapturada[]): ItemParaCierre[] {
  const porId = new Map<string, string>();
  for (const l of llaves) {
    const id = idKeplerDeCapturada(l);
    if (id) porId.set(l.id, id);
  }
  return items.map((it) => {
    if (it.obligation_source !== 'supplier_payable') return it;
    const id = porId.get(it.obligation_id);
    return id ? { ...it, obligation_source: 'kepler_payable', obligation_id: id } : it;
  });
}
