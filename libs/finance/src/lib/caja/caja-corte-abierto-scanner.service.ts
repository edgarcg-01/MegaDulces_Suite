import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KNEX_NEW_DB, latirCron } from '@megadulces/platform-core';
import { FINANCE_NOTIFIER_PORT, type FinanceNotifierPort } from '@megadulces/contracts';
import type { Knex } from 'knex';
import {
  avisoCortesAbiertos, debeAvisar, huellaDeSituacion, UMBRAL_CORTE_ABIERTO_H,
  type CorteAbiertoFila, type MedicionCortesAbiertos,
} from './caja-corte-abierto.engine';
import { jornadasSinCorte } from './caja-jornadas.query';

const MEGA = '00000000-0000-0000-0000-00000000d01c';

export interface MedicionSensorCorte extends MedicionCortesAbiertos {
  /** Movimientos vivos del libro que se vieron. En 0 el latido se pone rojo: no se vio la tabla. */
  universo: number;
  /** Si este pase mandó aviso (o lo calló por ser la misma situación de hace menos de 6 h). */
  avisado: boolean;
}

/**
 * `[CGP-L.10]` El sensor del corte abierto.
 *
 * ⛔ El corte del 12-oct estuvo trabado tres jornadas y NINGÚN sistema avisó. Este escáner mide cada
 * hora los cortes en borrador viejos y las jornadas con movimientos sin corte, deja su LATIDO (con
 * umbral en `CRON_JOBS`, o un sensor parado se vería verde) y avisa a Finanzas por la campana.
 *
 * Calca a `CajaFechaFuturaScannerService`: mismo módulo, misma forma de medir, mismo latido y mismo
 * puerto de aviso. No es un mecanismo nuevo.
 */
@Injectable()
export class CajaCorteAbiertoScannerService {
  private readonly logger = new Logger(CajaCorteAbiertoScannerService.name);
  private running = false;
  /** Lo último que se avisó: el canal no agrupa, y repetir lo mismo cada hora es ruido. */
  private ultimoAviso: { huella: string; at: number } | null = null;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /** Cada hora, a los :20. Se apaga con `ENABLE_CAJA_CORTE_SCAN=false`. */
  @Cron('0 20 * * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_CAJA_CORTE_SCAN === 'false') return;
    if (this.running) { this.logger.warn('Skip: scan en curso'); return; }
    await this.scan().catch((e) => this.logger.error(`scan corte abierto: ${e?.message ?? e}`));
  }

  async scan(tenantId: string = MEGA, ahoraMs: number = Date.now()): Promise<MedicionSensorCorte> {
    this.running = true;
    const t0 = Date.now();
    const fallas: string[] = [];
    let m: MedicionSensorCorte = { abiertos: [], jornadasSinCorte: [], inicioLibro: null, universo: 0, avisado: false };
    try {
      await this.knex.transaction(async (trx) => {
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);

        const abiertos = await trx.raw(`
          SELECT folio, to_char(fecha, 'YYYY-MM-DD') AS fecha,
                 round((extract(epoch FROM now() - created_at) / 3600)::numeric, 1)::float AS horas
            FROM finance.cash_ledger_cuts
           WHERE tenant_id = ? AND estado = 'borrador'
           ORDER BY created_at`, [tenantId]);

        // Una jornada cuenta como "sin corte" recién cuando terminó hace más del umbral de aviso: si
        // no, avisaría cada madrugada aunque la cajera cierre al día siguiente temprano. La consulta
        // es la MISMA que usa la pantalla para ofrecer el corte atrasado (`[CGP-L.4]`).
        const sinCorte = await jornadasSinCorte(trx, tenantId, UMBRAL_CORTE_ABIERTO_H.aviso);
        const universo = await trx.raw(
          `SELECT count(*)::int AS n FROM finance.cash_ledger WHERE tenant_id = ? AND deleted_at IS NULL`, [tenantId]);

        m = {
          abiertos: abiertos.rows.map((r: CorteAbiertoFila) => ({ folio: r.folio, fecha: r.fecha, horas: Number(r.horas) })),
          jornadasSinCorte: sinCorte.jornadas.map((j) => j.fecha),
          inicioLibro: sinCorte.inicio,
          universo: Number(universo.rows[0]?.n ?? 0),
          avisado: false,
        };
      });
    } catch (e) {
      fallas.push(e instanceof Error ? e.message : String(e));
      this.logger.error(`corte abierto: ${fallas[0]}`);
    } finally {
      this.running = false;
    }

    const aviso = fallas.length ? null : avisoCortesAbiertos(m);
    await latirCron(this.knex, {
      jobKey: 'caja_corte_abierto',
      label: 'Caja: corte abierto y jornadas sin corte',
      tenantId,
      rowsAffected: m.universo,
      durationMs: Date.now() - t0,
      fallas,
      note: `${m.abiertos.length} abierto(s) · ${m.jornadasSinCorte.length} jornada(s) sin corte`
        + (aviso ? ` · ${aviso.severity}` : ' · sin aviso'),
    });

    if (aviso) {
      const huella = huellaDeSituacion(m, aviso);
      if (debeAvisar(this.ultimoAviso, huella, ahoraMs)) {
        const notify = this.notifier?.notify?.bind(this.notifier);
        if (notify) {
          await notify(tenantId, { ...aviso, route: '/finanzas/caja-general' });
          m.avisado = true;
          this.ultimoAviso = { huella, at: ahoraMs };
        }
      }
    } else {
      this.ultimoAviso = null;   // cuando se resuelve, el próximo problema se avisa de inmediato
    }
    return m;
  }
}
