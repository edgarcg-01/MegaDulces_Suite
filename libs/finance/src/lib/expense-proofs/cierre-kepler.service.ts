import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KNEX_NEW_DB, latirCron } from '@megadulces/platform-core';
import type { Knex } from 'knex';
import {
  ESTADOS_QUE_CIERRA_KEPLER, FIRMA_CIERRE_KEPLER, valesQueCierraKepler,
  type SolicitudKepler, type ValeAbierto,
} from './cierre-kepler';

const MEGA = '00000000-0000-0000-0000-00000000d01c';

export interface MedicionCierreKepler {
  /** Vales con folio revisados. Cero acá NO es «todo bien»: es que no vimos la tabla (RLS). */
  universo: number;
  /** Vales todavía abiertos en la Suite. */
  abiertos: number;
  /** Los que se cerraron en esta pasada porque Kepler ya los tenía en `F`. */
  cerrados: number;
}

/**
 * `[GX.85]` **El vale se cierra solo cuando Kepler lo aplica** (la regla vive en `cierre-kepler.ts`).
 *
 * Dos viajes y no un JOIN: `analytics.expense_requests` es una vista sobre el ODS y cruzarla
 * con la tabla sale caro (medido en GX.15: >90 s). Primero los vales abiertos (pocos: 50 hoy),
 * después sólo esos folios en la vista.
 *
 * ⚠️ Su umbral vive en `CRON_JOBS` (`db-health.service.ts`). Sin esa entrada el sensor cae en
 * el `cfg ? classify : 'ok'` y un cron parado se pinta verde.
 */
@Injectable()
export class CierreKeplerService {
  private readonly logger = new Logger(CierreKeplerService.name);
  private running = false;

  constructor(@Inject(KNEX_NEW_DB) private readonly knex: Knex) {}

  @Cron('0 */10 * * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_GASTOS_CIERRE_KEPLER === 'false') return;
    if (this.running) { this.logger.warn('Skip: cierre en curso'); return; }
    await this.cerrar().catch((e) => this.logger.error(`cierre por Kepler: ${e?.message ?? e}`));
  }

  async cerrar(): Promise<MedicionCierreKepler> {
    this.running = true;
    const t0 = Date.now();
    const fallas: string[] = [];
    const m: MedicionCierreKepler = { universo: 0, abiertos: 0, cerrados: 0 };
    try {
      await this.knex.transaction(async (trx) => {
        // ⛔ `finance.expense_proofs` tiene RLS FORZADO (verificado en prod) y esto corre desde
        // un `@Cron`, sin request: sin fijar el tenant el universo es cero y el cero se lee
        // como «no hay nada que cerrar». Misma trampa que `[AUD-DAT.8]`.
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);

        const u = await trx('finance.expense_proofs')
          .where({ tenant_id: MEGA }).whereNotNull('folio_solicitud')
          .count<{ n: string }[]>({ n: '*' });
        m.universo = Number(u[0]?.n ?? 0);

        const abiertos: ValeAbierto[] = await trx('finance.expense_proofs')
          .where({ tenant_id: MEGA })
          .whereIn('status', ESTADOS_QUE_CIERRA_KEPLER as string[])
          .whereNotNull('folio_solicitud')
          .select('id', 'status', 'sucursal', 'folio_solicitud');
        m.abiertos = abiertos.length;
        if (!abiertos.length) return;

        const folios = [...new Set(abiertos.map((v) => String(v.folio_solicitud)))];
        const solicitudes: SolicitudKepler[] = await trx('analytics.expense_requests')
          .where({ tenant_id: MEGA, estado: 'F' })
          .whereIn('folio', folios)
          .select('sucursal', 'folio', 'estado');

        const ids = valesQueCierraKepler(abiertos, solicitudes);
        if (!ids.length) return;

        // El `whereIn('status', …)` se repite en el UPDATE: si alguien rechazó el vale entre
        // la lectura y la escritura, su decisión gana y éste no se toca.
        const hechos: { folio_solicitud: string; sucursal: string; status_antes?: string }[] =
          await trx('finance.expense_proofs')
            .where({ tenant_id: MEGA })
            .whereIn('id', ids)
            .whereIn('status', ESTADOS_QUE_CIERRA_KEPLER as string[])
            .update({
              status: 'validada',
              validated_by: FIRMA_CIERRE_KEPLER,
              validated_at: trx.fn.now(),
              motivo_rechazo: null,
              revision_nota: null,
              updated_at: trx.fn.now(),
            })
            .returning(['folio_solicitud', 'sucursal']);
        m.cerrados = hechos.length;
        for (const h of hechos) this.logger.log(`vale ${h.sucursal}-${h.folio_solicitud} cerrado: Kepler lo aplicó (F)`);
      });
    } catch (e) {
      fallas.push(e instanceof Error ? e.message : String(e));
    } finally {
      this.running = false;
    }

    // `rowsAffected` = el UNIVERSO revisado, no los cerrados: el día que no haya nada que cerrar
    // el latido no debe pintarse rojo por estar sano.
    await latirCron(this.knex, {
      jobKey: 'gastos_cierre_kepler',
      label: 'Gastos: cierra el vale cuando Kepler lo aplica (F)',
      tenantId: MEGA,
      rowsAffected: m.universo,
      durationMs: Date.now() - t0,
      fallas,
      note: `${m.abiertos} abiertos · ${m.cerrados} cerrados por Kepler`,
    });
    return m;
  }
}
