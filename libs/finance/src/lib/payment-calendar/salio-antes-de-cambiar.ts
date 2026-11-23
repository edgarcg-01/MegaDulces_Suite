/**
 * `[PGP.199]` **Un pago cuyo dinero ya salió no se cancela, ni se marca fallido, ni se reprograma.** Edgar, 2026-11-23,
 * después del pago doble a CD031: el pago del Calendario del 9-nov se canceló aunque Tesorería ya había mandado el dinero;
 * su factura volvió a «por pagar» y el 13-nov se pagó otra vez. Medido ese día (prod, sólo lectura): 16 pagos cancelados
 * tienen una salida del banco por su importe exacto dentro de los 30 días siguientes que ningún otro pago explica
 * (control +$100: 1 de 177), y de ese patrón salieron también los pagos dobles de CH001 y CF005. `[PGP.149]` ya lo
 * cuidaba en la liberación automática; cancelar, marcar fallido y reprogramar a mano no tenían guarda.
 *
 * Antes de esas tres acciones se miran dos testigos:
 *  · **el banco**: una salida por el importe (±$1) desde 3 días antes del día del pago hasta hoy, en el libro o en la
 *    descarga, que no se haya devuelto (`[PGP.201]`) ni sea ya la prueba de otro pago; o varias de la misma cuenta y día
 *    con la misma referencia que lo sumen (pago partido, `[PGP.201]`);
 *  · **Kepler**: el cierre del pago (`[PGP.94]`) completo y con dinero, es decir, Tesorería ya pagó todas sus facturas.
 * Si alguno lo prueba, la acción se niega con lo que se vio. Una persona puede seguir sólo diciendo por qué esa salida no
 * es de este pago (`aunque_salio`, queda en la bitácora con la evidencia).
 */
import type { CierreKeplerPago } from '@megadulces/contracts';
import { cierreCompleto, esPagoConDinero } from '@megadulces/contracts';
import { sqlDescargaNoDevuelta, sqlLibroNoDevuelta } from './pago-por-el-banco.sql';

/** Pesos de tolerancia (los mismos del carril del banco). */
const TOLERANCIA = 1;
/** Días antes del día del pago en que ya pudo salir (los mismos del carril del banco). */
export const DIAS_ANTES = 3;
/** Lo mínimo que tiene que explicar quien sigue aunque el banco diga que salió. */
export const MIN_MOTIVO_AUNQUE_SALIO = 10;
/** El evento de la bitácora cuando una persona sigue aunque salió. */
export const EVENTO_AUNQUE_SALIO = 'cambiado_aunque_salio';

/**
 * La primera salida del banco que paga ESTE pago. Parámetros: `[tenant, importe, día del pago, hoy, id del pago]`.
 * Una fila (`fuente`, `fecha`, `cuenta`, `importe`) o ninguna.
 */
export const SQL_SALIDA_QUE_LO_PAGO = `
WITH p AS (SELECT ?::uuid AS tenant, ?::numeric AS monto, ?::date AS dia, ?::date AS hoy, ?::uuid AS pago)
SELECT x.fuente, to_char(x.fecha, 'YYYY-MM-DD') AS fecha, x.cuenta, x.importe::float8 AS importe FROM (
  SELECT 'el libro del banco' AS fuente, b.movement_date AS fecha,
         coalesce(nullif(btrim(ba.alias), ''), ba.bank || ' ' || ba.account_label) AS cuenta, b.amount_out AS importe
    FROM p, finance.bank_movements b JOIN finance.bank_accounts ba ON ba.id = b.bank_account_id AND ba.kind = 'bank'
   WHERE b.tenant_id = p.tenant AND b.deleted_at IS NULL AND abs(b.amount_out - p.monto) < ${TOLERANCIA}
     AND b.movement_date BETWEEN p.dia - ${DIAS_ANTES} AND p.hoy
     AND ${sqlLibroNoDevuelta('b')}
     AND NOT EXISTS (SELECT 1 FROM finance.payment_allocations o
                      WHERE o.tenant_id = p.tenant AND o.id <> p.pago AND o.status <> 'cancelled' AND o.paid_bank_movement_id = b.id)
  UNION ALL
  SELECT 'la descarga del banco', s.movement_date,
         coalesce(nullif(btrim(ba.alias), ''), ba.bank || ' ' || ba.account_label), s.amount_out
    FROM p, finance.bank_statement_lines s JOIN finance.bank_accounts ba ON ba.id = s.bank_account_id AND ba.kind = 'bank'
   WHERE s.tenant_id = p.tenant AND abs(s.amount_out - p.monto) < ${TOLERANCIA}
     AND s.movement_date BETWEEN p.dia - ${DIAS_ANTES} AND p.hoy
     AND ${sqlDescargaNoDevuelta('s')}
  UNION ALL
  SELECT 'varias transferencias con la misma referencia', z.movement_date, z.cuenta, z.total FROM (
    SELECT g.movement_date, coalesce(nullif(btrim(ba.alias), ''), ba.bank || ' ' || ba.account_label) AS cuenta,
           substring(btrim(g.concept) FROM '([0-9]{6,})\\s*$') AS ref, sum(g.amount_out) AS total, count(*) AS n
      FROM p, finance.bank_movements g JOIN finance.bank_accounts ba ON ba.id = g.bank_account_id AND ba.kind = 'bank'
     WHERE g.tenant_id = p.tenant AND g.deleted_at IS NULL AND g.amount_out > 0
       AND g.movement_date BETWEEN p.dia - ${DIAS_ANTES} AND p.hoy
       AND ${sqlLibroNoDevuelta('g')}
     GROUP BY 1, 2, 3) z, p
   WHERE z.ref IS NOT NULL AND z.ref !~ '^0+$' AND z.n >= 2 AND abs(z.total - p.monto) < ${TOLERANCIA}
) x
ORDER BY x.fecha, x.fuente
LIMIT 1`;

/** La salida del banco que lo prueba, como sale de `SQL_SALIDA_QUE_LO_PAGO`. */
export interface SalidaQueLoPago { fuente: string; fecha: string; cuenta: string; importe: number }

export type AccionSobreElPago = 'cancelar' | 'marcar como fallido' | 'reprogramar';

const pesos = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * ¿Se niega la acción? El motivo, en las palabras que lee la persona; `null` si nada prueba que el dinero salió.
 * El banco gana sobre Kepler porque dice fecha y cuenta. Pura.
 */
export function motivoParaNoCambiar(accion: AccionSobreElPago, salida: SalidaQueLoPago | null | undefined,
  cierre: CierreKeplerPago | null | undefined): string | null {
  if (salida) {
    return `No se puede ${accion}: este pago ya salió del banco el ${salida.fecha} (${salida.cuenta}, ${pesos(Number(salida.importe))}, según ${salida.fuente}). `
      + 'Si es este pago, ya está pagado; si esa salida es de otro pago, pide a Sistemas que lo libere.';
  }
  if (cierre && cierreCompleto(cierre) && cierre.estado === 'pagado') {
    const doc = cierre.pagos.find((p) => esPagoConDinero(p.tipo));
    const cual = doc ? ` (${doc.doc_prefix}-${doc.folio}${doc.fecha ? ` del ${doc.fecha}` : ''})` : '';
    return `No se puede ${accion}: Tesorería ya pagó todas sus facturas en Kepler${cual}. El pago se liga solo a ese documento.`;
  }
  return null;
}

/** ¿El motivo de quien sigue aunque salió alcanza? Pura. */
export function motivoAunqueSalioValido(m: string | null | undefined): boolean {
  return (m ?? '').trim().length >= MIN_MOTIVO_AUNQUE_SALIO;
}
