import type { Knex } from 'knex';
import { diaDeFecha } from '@megadulces/contracts';

/**
 * `[CGA-A.43]` **Desde qué día la caja vive en el libro nuevo**: la fecha del PRIMER corte de
 * `finance.cash_ledger_cuts`. Una sola definición para todo el módulo.
 *
 * ── Por qué es el borde de la cola ───────────────────────────────────────────────────────────
 *
 * El Access Control dejó de capturar el 10-oct 12:39 y el primer corte del libro (`CC-2026-00001`,
 * 12-oct) abre con el fondo del arqueo `A23641` de ese día. Lo anterior a ese corte es de la era
 * Control: medido el 2026-10-20 con el Cuadre de `/finanzas/caja`, de 541 documentos de Kepler
 * del 1 al 11-oct que la cola tenía «pendientes», Control ya había saldado todos salvo 15. Antes de
 * septiembre son 11,404 más. Ninguno de ésos es trabajo del libro.
 *
 * Desde el corte en adelante, en cambio, la cola es exacta: medido ese día, 61 documentos /
 * $779,568.24. Por eso la bandeja deja de necesitar una ventana de días (Edgar, 2026-10-20: «ya
 * sabemos qué movimientos están pendientes»).
 *
 * Sale de los DATOS, no de una constante: si el libro arrancara otro día, o se reiniciara, el borde
 * se mueve solo.
 *
 * @returns `YYYY-MM-DD`, o `null` si todavía no hay ningún corte (y entonces el llamador decide su
 *          ventana de siempre).
 */
export async function primerCorteDelLibro(trx: Knex | Knex.Transaction, tenantId: string): Promise<string | null> {
  const r: { fecha: unknown } | undefined = await trx('finance.cash_ledger_cuts')
    .where('tenant_id', tenantId).orderBy('fecha', 'asc').first('fecha');
  return r ? diaDeFecha(r.fecha) ?? null : null;
}
