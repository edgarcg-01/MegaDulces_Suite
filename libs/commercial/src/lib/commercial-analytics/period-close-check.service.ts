import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';
import { HEALTH_NOTIFIER_PORT, HealthNotifierPort } from '@megadulces/contracts';

/** Un mes cerrado cuya cifra dejó de coincidir con el recálculo de hoy. */
export interface PeriodDrift {
  periodo: string;
  estado: 'difiere_fuente' | 'difiere_definicion';
  delta_monto: number;
  delta_filas: number;
}

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/**
 * [VP.4.3] El comparador de cierres — recalcula los meses congelados y DECLARA la diferencia
 * (ADR-056).
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────
 * VP.4.1 congeló la cifra oficial de cada mes. Sin este servicio, ese congelado sería un archivo
 * muerto: nadie volvería a mirarlo y la deriva seguiría siendo invisible, que es el problema que la
 * fase vino a resolver (*"a menudo me dicen que existen cambios en los números de la empresa"*).
 *
 * La decisión de Edgar fue **congelado manda, la diferencia se declara**. Este cron es la segunda
 * mitad: recalcula, compara, y **nunca cambia el número** — deja el veredicto en
 * `analytics.period_close.last_check_*` y, si hay deriva, avisa.
 *
 * ── LO QUE HACE ÚTIL AL AVISO: NOMBRA LA CAUSA ───────────────────────────────────────────
 * `verificar_periodo` distingue dos cosas que en la cifra se ven idénticas y piden acciones
 * OPUESTAS:
 *   · `difiere_fuente`     → llegó dato (o se corrigió el ERP). Probablemente correcto: **re-cerrar**.
 *   · `difiere_definicion` → alguien editó la vista. **Revisar el cambio**, no el ERP.
 * Un aviso que sólo dijera "enero cambió" mandaría a buscar al lugar equivocado la mitad de las veces.
 *
 * ── CORRE DESPUÉS DEL REFRESH, A PROPÓSITO ───────────────────────────────────────────────
 * 07:10 MX, después del `@Cron('0 20 6 * * *')` de `AnalyticsRefreshService`. Comparar contra
 * matvistas sin refrescar reportaría una deriva que se arregla sola en veinte minutos — y una alarma
 * que se desmiente sola enseña a ignorar el tablero (la lección de las 488 alertas con cero
 * reconocidas, OBS.8).
 *
 * ── EL AVISO ES RARO POR DISEÑO ──────────────────────────────────────────────────────────
 * `HEALTH_NOTIFIER_PORT` está marcado **sólo para crítico** porque lo que vibra tiene que ser raro
 * para significar algo. Un mes cerrado que cambia califica: la mayoría de las noches todo coincide,
 * y cuando no, alguien tiene que enterarse el mismo día en vez de que se lo diga la empresa.
 */
@Injectable()
export class PeriodCloseCheckService {
  private readonly logger = new Logger(PeriodCloseCheckService.name);

  constructor(
    @Inject(KNEX_NEW_DB_ADMIN) private readonly adminKnex: Knex | null,
    @Optional() @Inject(HEALTH_NOTIFIER_PORT) private readonly notifier?: HealthNotifierPort,
  ) {}

  /** 07:10 MX — después del refresh nocturno (06:20). Ver la nota del encabezado. */
  @Cron('0 10 7 * * *', { timeZone: 'America/Mexico_City' })
  async scheduledCheck(): Promise<void> {
    await this.check('cron');
  }

  /**
   * Recalcula todos los periodos cerrados y escribe el veredicto. Devuelve los que derivaron.
   *
   * NO lanza al llamador del cron: un comparador que se cae deja de comparar en silencio, que es
   * peor que una corrida con error — por eso el fallo se registra en el latido y se re-lanza sólo
   * cuando lo invoca un humano (`source='manual'`).
   */
  async check(source: 'cron' | 'manual' = 'manual'): Promise<{ revisados: number; derivas: PeriodDrift[] }> {
    const admin = this.adminKnex;
    if (!admin) {
      this.logger.debug('Skip period-close check: KNEX_NEW_DB_ADMIN no disponible');
      return { revisados: 0, derivas: [] };
    }
    const t0 = Date.now();
    let revisados = 0;
    const derivas: PeriodDrift[] = [];
    let errMsg: string | null = null;

    try {
      const { rows } = await admin.raw(
        `SELECT periodo FROM analytics.period_close
          WHERE tenant_id = ? AND superficie = 'sell_out' ORDER BY periodo`, [MEGA]);

      for (const { periodo } of rows) {
        const r = (await admin.raw(
          `SELECT analytics.verificar_periodo(?, 'sell_out', ?) AS v`, [MEGA, periodo])).rows[0].v;
        revisados++;
        if (r.estado !== 'coincide') {
          derivas.push({
            periodo,
            estado: r.estado,
            delta_monto: Number(r.diff?.delta_monto ?? 0),
            delta_filas: Number(r.diff?.delta_filas ?? 0),
          });
        }
      }

      if (derivas.length) {
        // A nivel log queda el detalle completo; el aviso lleva sólo lo que cabe en un celular.
        for (const d of derivas) {
          this.logger.warn(
            `Cierre ${d.periodo}: ${d.estado} · Δ$${d.delta_monto.toFixed(2)} · Δ${d.delta_filas} filas`);
        }
        await this.avisar(derivas);
      } else {
        this.logger.log(`Cierres verificados: ${revisados}, todos coinciden (${Date.now() - t0}ms)`);
      }
    } catch (e: any) {
      errMsg = e?.message || String(e);
      this.logger.error(`Verificación de cierres falló: ${errMsg}`);
      if (source === 'manual') throw e;
    } finally {
      await this.latir(admin, revisados, derivas.length, Date.now() - t0, errMsg);
    }

    return { revisados, derivas };
  }

  /**
   * Latido a `analytics.cron_runs`. No es cosmético: sin él, este comparador sería justo el tipo de
   * job invisible que VP.0.4/VP.0.5 salieron a cazar — y `test-newdb-feed-observability` exige que
   * todo `job_key` que late tenga umbral en `CRON_JOBS`, así que registrarlo allá es obligatorio.
   * De paso, VP.3.3 le da historial solo.
   */
  private async latir(
    admin: Knex, revisados: number, derivas: number, ms: number, error: string | null,
  ): Promise<void> {
    try {
      await admin('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'period_close_check',
          label: 'Verificación de cierres de mes',
          last_start: admin.fn.now(),
          last_finish: admin.fn.now(),
          status: error ? 'error' : 'ok',
          rows_affected: revisados,
          duration_ms: ms,
          // La nota dice lo ACCIONABLE: cuántos derivaron, no sólo cuántos se miraron.
          note: error ? null : `${revisados} cierres · ${derivas} con deriva`,
          error: error ? error.slice(0, 500) : null,
          host: 'api',
          updated_at: admin.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch { /* el latido nunca rompe al que late (criterio de cron-heartbeat.js) */ }
  }

  /** Best-effort: el que avisa no puede caerse porque el aviso no salió. */
  private async avisar(derivas: PeriodDrift[]): Promise<void> {
    if (!this.notifier?.isConfigured?.()) {
      this.logger.warn(`${derivas.length} cierre(s) con deriva y sin canal de aviso configurado`);
      return;
    }
    const items = derivas.map((d) => ({
      key: `period_close:sell_out:${d.periodo}`,
      label: `Sell-out ${d.periodo} — la cifra cerrada ya no coincide`,
      // El motivo nombra la ACCIÓN, no el síntoma: son dos causas con arreglos opuestos.
      motivo: d.estado === 'difiere_definicion'
        ? `cambió la definición de la vista (Δ$${d.delta_monto.toFixed(2)}) — revisar el cambio, no el ERP`
        : `se movió una fuente (Δ$${d.delta_monto.toFixed(2)}, Δ${d.delta_filas} filas) — revisar y re-cerrar`,
      age_human: null,
    }));
    const r = await this.notifier.notifyCritical(items).catch((e) => ({ ok: false, error: e?.message }));
    if (!r?.ok) this.logger.warn(`Aviso de deriva no salió: ${r?.error ?? 'sin detalle'}`);
  }
}
