/**
 * `[PGP.117]` Las dos lecturas de la liberación a la semana. Viven aparte del servicio para que el
 * texto que corre en producción sea el MISMO que se mide contra prod (se importa, no se copia).
 * La regla está en `@megadulces/contracts` (`decidirVencido`); el cierre de Kepler es `SQL_CIERRE_KEPLER`.
 */
import { DIAS_ANTES_BANCO, DIAS_PARA_LIBERAR, TOLERANCIA_BANCO } from '@megadulces/contracts';
import type { Knex } from 'knex';

/**
 * Los pagos pendientes cuyo día pasó hace `DIAS_PARA_LIBERAR` días o más. Parámetros:
 * `[tenant_id, hoy (YYYY-MM-DD)]`. Las fechas salen como texto para no depender de la zona del proceso.
 */
export const SQL_PENDIENTES_VENCIDOS = `
  SELECT a.id::text AS id, to_char(l.lot_date, 'YYYY-MM-DD') AS lot_date,
         to_char(a.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS alta,
         a.amount_assigned::float8 AS monto, a.classification, a.created_by, a.authorized_by, a.notes,
         l.status AS lot_status, a.bank_account_id::text AS cuenta,
         (a.kepler_payment_folio IS NOT NULL OR a.paid_bank_movement_id IS NOT NULL) AS ligado
    FROM finance.payment_allocations a
    JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
   WHERE a.tenant_id = ? AND a.status = 'pending'
     AND l.lot_date <= ?::date - ${DIAS_PARA_LIBERAR}
   ORDER BY l.lot_date, a.id`;

/**
 * ¿Salió del banco un importe igual al del pago (±$1) desde 3 días antes de su día hasta hoy? Y si no salió,
 * ¿se puede afirmar? Parámetros, en el orden del texto:
 * `[tenant, tenant, hoy, tenant, hoy, hoy, ids (uuid[]), montos (numeric[]), días (date[]), cuentas (uuid[])]`.
 * Una fila por pago: `salio` y `cubierto`.
 * Cualquier movimiento sirve, aunque ya esté conciliado con otra cosa: el ruido sólo CONSERVA.
 *
 * ⛔ `[PGP.149]` **El testigo del banco son DOS: el libro y la descarga.** Hasta el 2026-11-18 sólo se leía el libro
 * (`bank_movements`), que se quedó en el 10-nov porque ninguna cuenta «usa el banco»; «no está en el libro» se leía
 * como «no salió». El 17-nov se liberaron así 7 pagos del 10-nov que SÍ habían salido ($1,893,556.02, placebo +$100:
 * 0 de 16) y sus facturas volvieron a ofrecerse para pagar. Ahora cuenta también la descarga del propio banco
 * (`bank_statement_lines`), y **«no salió» sólo se afirma si la descarga cubre esos días**: de la cuenta preparada, o
 * de TODAS las de banco activas si nadie la preparó. Si no cubre, `cubierto = false` y el pago se conserva
 * (`banco_sin_medir`): lo que no se pudo medir no se libera.
 */
export const SQL_SALIDA_DE_BANCO = `
  WITH cobertura AS (
    SELECT ba.id, max(f.date_to) AS hasta
      FROM finance.bank_accounts ba
      LEFT JOIN finance.bank_statement_files f ON f.bank_account_id = ba.id AND f.tenant_id = ba.tenant_id
     WHERE ba.tenant_id = ? AND ba.kind = 'bank' AND ba.active
     GROUP BY ba.id)
  SELECT p.id::text AS id,
         EXISTS (
           SELECT 1 FROM finance.bank_movements b
            WHERE b.tenant_id = ? AND b.deleted_at IS NULL
              AND abs(coalesce(b.amount_out, 0) - p.monto) < ${TOLERANCIA_BANCO}
              AND b.movement_date BETWEEN p.dia - ${DIAS_ANTES_BANCO} AND ?::date
         ) OR EXISTS (
           SELECT 1 FROM finance.bank_statement_lines s
             JOIN finance.bank_accounts ba ON ba.id = s.bank_account_id AND ba.kind = 'bank'
            WHERE s.tenant_id = ?
              AND abs(coalesce(s.amount_out, 0) - p.monto) < ${TOLERANCIA_BANCO}
              AND s.movement_date BETWEEN p.dia - ${DIAS_ANTES_BANCO} AND ?::date
         ) AS salio,
         NOT EXISTS (
           SELECT 1 FROM cobertura c
            WHERE (p.cuenta IS NULL OR c.id = p.cuenta)
              AND (c.hasta IS NULL OR c.hasta < least(p.dia + ${DIAS_ANTES_BANCO}, ?::date))
         ) AS cubierto
    FROM unnest(?::uuid[], ?::numeric[], ?::date[], ?::uuid[]) AS p(id, monto, dia, cuenta)`;

/** Los parámetros de `SQL_SALIDA_DE_BANCO`, en su orden (para que el servicio y la medición no se equivoquen). */
export function paramsSalidaDeBanco(tenantId: string, hoy: string, pagos: readonly { id: string; monto: number; lot_date: string; cuenta: string | null }[]): Knex.RawBinding[] {
  return [tenantId, tenantId, hoy, tenantId, hoy, hoy,
    pagos.map((p) => p.id), pagos.map((p) => p.monto), pagos.map((p) => p.lot_date),
    // pg recibe el arreglo con sus null (uuid[]); el tipo de knex no contempla null dentro de un arreglo.
    pagos.map((p) => p.cuenta) as unknown as string[]];
}

/** `salio` gana; si no salió, sólo se afirma con la descarga cubriendo esos días. */
export function testigoDelBanco(f: { salio: boolean; cubierto: boolean } | undefined): boolean | null {
  if (!f) return null;
  if (f.salio) return true;
  return f.cubierto ? false : null;
}

export interface FilaPendienteVencido {
  id: string; lot_date: string; alta: string; monto: number; classification: string;
  created_by: string | null; authorized_by: string | null; notes: string | null; lot_status: string | null; ligado: boolean;
  /** `[PGP.149]` La cuenta preparada (null = nadie la preparó: se exige la cobertura de todas). */
  cuenta: string | null;
}

/** `[PGP.149]` El evento de la bitácora al regresar un pago que se liberó habiendo salido del banco. */
export const EVENTO_REABIERTO = 'reabierto_salio_del_banco';

/**
 * `[PGP.149]` **Lo que la liberación soltó y sí había salido del banco.** Pagos cancelados por `[PGP.117]` (su
 * último evento de liberación) con una salida por su importe (±$1) en el libro o en la descarga, desde 3 días antes
 * de su día hasta el día en que se liberaron: lo que la liberación debió ver. Se excluyen los que ya se regresaron
 * y aquellos cuyas facturas ya están en otro pago vivo (alguien las volvió a programar: ése manda, y se dice aparte).
 * Parámetros: `[tenant]`. La salida más temprana, con su cuenta.
 */
export const SQL_LIBERADOS_QUE_SALIERON = `
  SELECT a.id::text AS id, to_char(l.lot_date, 'YYYY-MM-DD') AS lot_date, a.amount_assigned::float8 AS monto, a.notes,
         to_char(h.liberado_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS liberado,
         x.fecha, x.cuenta, x.importe,
         EXISTS (
           SELECT 1 FROM finance.payment_allocation_items i
             JOIN finance.payment_allocation_items i2 ON i2.obligation_source = i.obligation_source
                                                     AND i2.obligation_id = i.obligation_id AND i2.allocation_id <> i.allocation_id
             JOIN finance.payment_allocations a2 ON a2.id = i2.allocation_id AND a2.status IN ('pending', 'executed')
            WHERE i.allocation_id = a.id
         ) AS reprogramado
    FROM finance.payment_allocations a
    JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
    JOIN LATERAL (
      SELECT max(h.created_at) AS liberado_at FROM finance.payment_allocation_history h
       WHERE h.allocation_id = a.id AND h.event = 'liberado_por_vencimiento'
    ) h ON h.liberado_at IS NOT NULL
    JOIN LATERAL (
      SELECT to_char(m.movement_date, 'YYYY-MM-DD') AS fecha, m.cuenta, m.importe FROM (
        SELECT b.movement_date, coalesce(nullif(btrim(ba.alias), ''), ba.bank || ' ' || ba.account_label) AS cuenta, b.amount_out::float8 AS importe
          FROM finance.bank_movements b JOIN finance.bank_accounts ba ON ba.id = b.bank_account_id
         WHERE b.tenant_id = a.tenant_id AND b.deleted_at IS NULL
           AND abs(coalesce(b.amount_out, 0) - a.amount_assigned) < ${TOLERANCIA_BANCO}
           AND b.movement_date BETWEEN l.lot_date - ${DIAS_ANTES_BANCO} AND (h.liberado_at AT TIME ZONE 'America/Mexico_City')::date
        UNION ALL
        SELECT s.movement_date, coalesce(nullif(btrim(ba.alias), ''), ba.bank || ' ' || ba.account_label), s.amount_out::float8
          FROM finance.bank_statement_lines s JOIN finance.bank_accounts ba ON ba.id = s.bank_account_id AND ba.kind = 'bank'
         WHERE s.tenant_id = a.tenant_id
           AND abs(coalesce(s.amount_out, 0) - a.amount_assigned) < ${TOLERANCIA_BANCO}
           AND s.movement_date BETWEEN l.lot_date - ${DIAS_ANTES_BANCO} AND (h.liberado_at AT TIME ZONE 'America/Mexico_City')::date
      ) m ORDER BY m.movement_date LIMIT 1
    ) x ON true
   WHERE a.tenant_id = ? AND a.status = 'cancelled'
     AND NOT EXISTS (SELECT 1 FROM finance.payment_allocation_history r
                      WHERE r.allocation_id = a.id AND r.event = '${EVENTO_REABIERTO}' AND r.created_at > h.liberado_at)
   ORDER BY l.lot_date, a.id`;

export interface FilaLiberadoQueSalio {
  id: string; lot_date: string; monto: number; notes: string | null; liberado: string;
  fecha: string; cuenta: string; importe: number; reprogramado: boolean;
}

/** La nota que se agrega al pago regresado (la evidencia completa va en la bitácora). */
export function notaReabierto(hoy: string, f: Pick<FilaLiberadoQueSalio, 'fecha' | 'cuenta' | 'importe' | 'liberado'>): string {
  return `[regresado ${hoy}] Salió del banco el ${f.fecha} (${f.cuenta}, $${f.importe.toFixed(2)}): la liberación del ${f.liberado} no lo vio porque el estado de cuenta del Calendario no tenía esa salida. Sus facturas vuelven a quedar apartadas por este pago.`;
}
