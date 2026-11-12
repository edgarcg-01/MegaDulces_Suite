/**
 * `[PGP.117]` Las dos lecturas de la liberación a la semana. Viven aparte del servicio para que el
 * texto que corre en producción sea el MISMO que se mide contra prod (se importa, no se copia).
 * La regla está en `@megadulces/contracts` (`decidirVencido`); el cierre de Kepler es `SQL_CIERRE_KEPLER`.
 */
import { DIAS_ANTES_BANCO, DIAS_PARA_LIBERAR, TOLERANCIA_BANCO } from '@megadulces/contracts';

/**
 * Los pagos pendientes cuyo día pasó hace `DIAS_PARA_LIBERAR` días o más. Parámetros:
 * `[tenant_id, hoy (YYYY-MM-DD)]`. Las fechas salen como texto para no depender de la zona del proceso.
 */
export const SQL_PENDIENTES_VENCIDOS = `
  SELECT a.id::text AS id, to_char(l.lot_date, 'YYYY-MM-DD') AS lot_date,
         to_char(a.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS alta,
         a.amount_assigned::float8 AS monto, a.classification, a.created_by, a.authorized_by, a.notes,
         l.status AS lot_status,
         (a.kepler_payment_folio IS NOT NULL OR a.paid_bank_movement_id IS NOT NULL) AS ligado
    FROM finance.payment_allocations a
    JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
   WHERE a.tenant_id = ? AND a.status = 'pending'
     AND l.lot_date <= ?::date - ${DIAS_PARA_LIBERAR}
   ORDER BY l.lot_date, a.id`;

/**
 * ¿Salió del banco un importe igual al del pago (±$1) desde 3 días antes de su día hasta hoy?
 * Parámetros, en el orden del texto: `[tenant_id, hoy, ids (uuid[]), montos (numeric[]), días (date[])]`.
 * Una fila por pago.
 * Cualquier movimiento sirve, aunque ya esté conciliado con otra cosa: el ruido sólo CONSERVA.
 */
export const SQL_SALIDA_DE_BANCO = `
  SELECT p.id::text AS id,
         EXISTS (
           SELECT 1 FROM finance.bank_movements b
            WHERE b.tenant_id = ? AND b.deleted_at IS NULL
              AND abs(coalesce(b.amount_out, 0) - p.monto) < ${TOLERANCIA_BANCO}
              AND b.movement_date BETWEEN p.dia - ${DIAS_ANTES_BANCO} AND ?::date
         ) AS salio
    FROM unnest(?::uuid[], ?::numeric[], ?::date[]) AS p(id, monto, dia)`;

export interface FilaPendienteVencido {
  id: string; lot_date: string; alta: string; monto: number; classification: string;
  created_by: string | null; authorized_by: string | null; notes: string | null; lot_status: string | null; ligado: boolean;
}
