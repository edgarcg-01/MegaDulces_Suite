import { cierreCompleto, esPagoConDinero, type CierreKeplerPago, type PagoKeplerDelCierre } from '@megadulces/contracts';

/**
 * `[PGP.132]` **Lo que Kepler ya pagó, pagado en la Suite.** Edgar, 2026-11-17 (reporte de Contabilidad: «los pagos se
 * están atrasando y duplicando»). Medido ese día en prod: de 95 pagos de días pasados que seguían «pendientes», **48
 * ($10.5 M) ya los había pagado Tesorería en Kepler**. La pantalla los pintaba como «pagado» (`[PGP.114]`) y el aviso
 * los separaba (`[PGP.95]`), pero su estado seguía `pending`: todo lo que cuenta por estado los veía atrasados. La
 * única vía para marcarlos pagados era el estado de cuenta (`[PGP.121]`), y no se sube desde el 10-nov.
 *
 * La regla es la del cierre de `[PGP.94]` (`cierreCompleto`): TODAS sus facturas saldadas en Kepler desde que se
 * programó, y al menos una con dinero (`estado = 'pagado'`). Un pago saldado sólo con notas o devoluciones
 * (`saldado_sin_dinero`) NO se da por pagado: no salió dinero; se queda como está (la pantalla ya lo dice).
 */
export const AUTOR_PAGO_EN_KEPLER = 'sistema:kepler';
export const EVENTO_PAGADO_EN_KEPLER = 'pagado_en_kepler';
export const EVENTO_LIGADO_A_KEPLER = 'ligado_a_kepler';

export type MetodoPago = 'transferencia' | 'cheque' | 'efectivo';

export interface DecisionKepler {
  /** El documento de Kepler al que se liga: el pago con dinero más reciente que tocó sus facturas. */
  doc: PagoKeplerDelCierre;
  /** El método que dice Kepler (si el pago no tenía uno). `null` si Kepler no lo distingue. */
  metodo: MetodoPago | null;
}

const METODO: Partial<Record<PagoKeplerDelCierre['tipo'], MetodoPago>> = {
  transferencia: 'transferencia', banco: 'transferencia', cheque: 'cheque', efectivo: 'efectivo',
};

/** ¿Kepler ya pagó este pago con dinero, entero? Si sí, con qué documento. Pura. */
export function decidirPagoEnKepler(c: CierreKeplerPago | null | undefined): DecisionKepler | null {
  if (!c || !cierreCompleto(c) || c.estado !== 'pagado') return null;
  const doc = c.pagos.find((p) => esPagoConDinero(p.tipo));
  if (!doc) return null;
  return { doc, metodo: METODO[doc.tipo] ?? null };
}

/**
 * Los pagos que todavía no están ligados a un documento de Kepler: los pendientes cuyo día ya llegó (para darlos por
 * pagados) y los que ya pagó el banco o el comprobante (para ligarlos a la captura de Tesorería y sacarlos de la fila
 * del escritor de `X-D-26`). Últimos 90 días. Parámetros: `[tenant, hoy, hoy]`.
 */
export const SQL_POR_LIGAR_A_KEPLER = `
SELECT a.id::text AS id, a.status, to_char(l.lot_date, 'YYYY-MM-DD') AS dia,
       to_char(a.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS alta,
       a.amount_assigned::float8 AS importe,
       (a.authorized_at IS NOT NULL OR l.status IN ('released', 'executing', 'closed')) AS autorizado
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE a.tenant_id = ? AND a.status IN ('pending', 'executed')
   AND a.kepler_payment_folio IS NULL AND a.kepler_payment_linked_by IS NULL
   AND l.lot_date BETWEEN ?::date - 90 AND ?::date`;
