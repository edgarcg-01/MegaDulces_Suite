import type { Knex } from 'knex';
import { SUCURSAL_CAJA_GENERAL, type CandadoCajaDto } from '@megadulces/contracts';
import { hoyMx, jornadasSinCorte } from './caja-jornadas.query';
import { candadoDeCaptura, type Candado, type LlaveVigente } from './caja-candado.engine';

/** `[CGS.14]` El candado para quien pregunta: el contrato de `libs/contracts` (ADR-052). */
export type CandadoCaja = CandadoCajaDto;

/**
 * `[CGS.14]` Lee de la base lo que el candado necesita y decide con el motor puro.
 *
 * ⚠️ Interruptor de emergencia: `CAJA_CANDADO_CAPTURA=off` lo apaga (y la respuesta lo DECLARA con
 * `activo: false`, no lo esconde). Por omisión está PRENDIDO: es la decisión D1 de Edgar.
 *
 * ⚠️ Si la tabla de llaves todavía no existe (la migración `20261021112928` no se aplicó), el
 * candado funciona igual y simplemente no hay llave posible: la única salida es cerrar el corte.
 * Se pregunta por `to_regclass` en vez de dejar que la consulta truene: un error acá tumbaría TODA
 * captura, que es peor que el hueco que el candado cierra.
 *
 * ⚠️ RLS: quien llama tiene que haber fijado `app.tenant_id` en esta transacción.
 */
export async function leerCandado(
  trx: Knex.Transaction, tenantId: string, userId: string | null,
): Promise<Candado & { hoy: string }> {
  const activo = String(process.env['CAJA_CANDADO_CAPTURA'] ?? '').toLowerCase() !== 'off';
  const hoy = await hoyMx(trx);
  if (!activo) {
    return { ...candadoDeCaptura({ hoy, sinCorte: [], borradorAnterior: null, llave: null, activo }), hoy };
  }

  const { jornadas } = await jornadasSinCorte(trx, tenantId, 0);
  const borrador = await trx('finance.cash_ledger_cuts')
    .where({ tenant_id: tenantId, sucursal: SUCURSAL_CAJA_GENERAL, estado: 'borrador' })
    .where('fecha', '<', hoy)
    .orderBy('fecha', 'asc')
    .first('folio', trx.raw(`to_char(fecha, 'YYYY-MM-DD') AS fecha`));

  let llave: LlaveVigente | null = null;
  if (userId) {
    const hayTabla = (await trx.raw(`SELECT to_regclass('finance.cash_ledger_llaves') IS NOT NULL AS t`)).rows[0]?.t === true;
    if (hayTabla) {
      const l = await trx('finance.cash_ledger_llaves')
        .where({ tenant_id: tenantId, sucursal: SUCURSAL_CAJA_GENERAL, para_usuario: userId })
        .where('vence_at', '>', trx.fn.now())
        .orderBy('created_at', 'desc')
        .first('otorgada_por_username', 'motivo', 'vence_at');
      if (l) {
        llave = {
          otorgada_por_username: (l.otorgada_por_username ?? null) as string | null,
          motivo: String(l.motivo),
          vence_at: new Date(l.vence_at as string).toISOString(),
        };
      }
    }
  }

  const c = candadoDeCaptura({
    hoy,
    sinCorte: jornadas,
    borradorAnterior: borrador ? { folio: String(borrador.folio), fecha: String(borrador.fecha) } : null,
    llave,
    activo,
  });
  return { ...c, hoy };
}
