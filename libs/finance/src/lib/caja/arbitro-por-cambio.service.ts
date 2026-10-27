import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Knex } from 'knex';
import { KNEX_NEW_DB, KNEX_NEW_DB_ADMIN, latirCron } from '@megadulces/platform-core';
import { MedicionArbitro, VeredictoArbitro, veredictoArbitro } from './arbitro-por-cambio.engine';

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const KEY = 'arbitro_por_cambio';
const LABEL = 'Árbitro de tesorería y pólizas mantenidas por trigger (ADR-104)';

/**
 * `[OPS-AUD.11.6]` (ADR-104) — Compara lo que mantienen los triggers contra la regla aplicada a
 * todo el ODS, una vez al día, y lo publica en Salud BD.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Desde ADR-104 la tesorería (`analytics.bank_movement_legs`) y el reporte de pólizas de Kepler se
 * mantienen POR CAMBIO, sin recalcular. Lo que se ganó (35,730 s en 27 h de REFRESH que ya no se
 * pagan) tiene un costo: si un trigger tiene un hueco, la tabla queda desfasada sin un solo
 * error. El árbitro es el único que lo ve.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *   1. mide `bank_movement_legs_drift()` y `gl_polizas_kepler_drift(<mes>)` para cada `kdc2YYMM`;
 *   2. si hay diferencia, REPARA (reconstruye ese objeto) y vuelve a medir;
 *   3. late con `fallas` si hubo diferencia — aunque se haya reparado: una diferencia significa que
 *      el trigger tiene un hueco, y repararla en silencio lo escondería para siempre;
 *   4. también es falla un error registrado por los triggers en las últimas 25 h.
 *
 * ⚠️ No es un barrido que mantenga el dato (eso lo hacen los triggers): es una ALARMA. Una vez al
 *    día alcanza para eso; el costo medido en prod es 8.2 s la tesorería y unos segundos por mes
 *    de pólizas. Si da cero todos los días, cumplió.
 */
@Injectable()
export class ArbitroPorCambioService {
  private readonly logger = new Logger(ArbitroPorCambioService.name);
  private running = false;

  /** Igual que `CajaAutofillRefreshService`: reparar exige el dueño; el latido va por la conexión de siempre. */
  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    @Inject(KNEX_NEW_DB_ADMIN) private readonly admin: Knex | null,
  ) {}

  @Cron('0 20 7 * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_ARBITRO_POR_CAMBIO === 'false') return;
    if (this.running) { this.logger.warn('Skip: árbitro en curso'); return; }
    await this.arbitrar().catch((e) => this.logger.error(`árbitro: ${e?.message ?? e}`));
  }

  async arbitrar(): Promise<VeredictoArbitro> {
    this.running = true;
    const t0 = Date.now();
    const mediciones: MedicionArbitro[] = [];
    const errores: Record<string, number> = {};
    const fueraDeHora: Record<string, number> = {};
    try {
      if (!this.admin) throw new Error('KNEX_NEW_DB_ADMIN es null (falta DATABASE_URL_NEW): no se puede arbitrar');
      const db = this.admin;

      mediciones.push(await this.medir(db, 'tesoreria',
        `SELECT faltan::int AS faltan, sobran::int AS sobran FROM analytics.bank_movement_legs_drift()`,
        `SELECT analytics.bank_movement_legs_rebuild()`));

      const meses = (await db.raw(
        `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'kepler_ods' AND c.relname ~ '^kdc2[0-9]{4}$' ORDER BY 1`)).rows as { t: string }[];
      for (const { t } of meses) {
        // `t` sale del catálogo y pasa la regex de arriba: no es entrada de usuario. Va por binding igual.
        mediciones.push(await this.medir(db, `polizas:${t}`,
          [`SELECT faltan::int AS faltan, sobran::int AS sobran FROM analytics.gl_polizas_kepler_drift(?)`, [t]],
          [`SELECT analytics.kepler_poliza_rebuild(?, NULL)`, [t]]));
      }

      // [OPS-AUD.13.2] Pólizas fuera de las 00:00: tras la normalización deben ser CERO siempre.
      for (const { t } of meses) {
        const r = await db.raw(
          `SELECT count(*)::int AS n FROM kepler_ods.${t}
            WHERE (c2 AT TIME ZONE 'America/Mexico_City')::time <> '00:00'`);
        fueraDeHora[t] = Number(r.rows[0].n);
      }

      for (const tabla of ['analytics.bank_movement_legs_errors', 'analytics.gl_polizas_kepler_errors']) {
        const r = await db.raw(`SELECT count(*)::int AS n FROM ${tabla} WHERE created_at > now() - interval '25 hours'`);
        errores[tabla] = Number(r.rows[0].n);
      }
    } catch (e) {
      mediciones.push({ objeto: 'árbitro', faltan: null, sobran: null, error: (e instanceof Error ? e.message : String(e)).slice(-400) });
    } finally {
      this.running = false;
    }

    const v = veredictoArbitro(mediciones, errores, fueraDeHora);
    if (v.fallas.length) this.logger.error(`árbitro por cambio: ${v.fallas.join(' | ')}`);
    await latirCron(this.knex, {
      jobKey: KEY,
      label: LABEL,
      tenantId: MEGA,
      // Lo ENTREGADO: objetos arbitrados sin diferencias.
      rowsAffected: v.limpios,
      durationMs: Date.now() - t0,
      fallas: v.fallas,
      note: v.nota,
    });
    return v;
  }

  private async medir(
    db: Knex, objeto: string,
    drift: string | [string, string[]], reparar: string | [string, string[]],
  ): Promise<MedicionArbitro> {
    const correr = (q: string | [string, string[]]) => (typeof q === 'string' ? db.raw(q) : db.raw(q[0], q[1]));
    try {
      const d = (await correr(drift)).rows[0] as { faltan: number; sobran: number };
      const m: MedicionArbitro = { objeto, faltan: Number(d.faltan), sobran: Number(d.sobran) };
      if (m.faltan || m.sobran) {
        await correr(reparar);
        const d2 = (await correr(drift)).rows[0] as { faltan: number; sobran: number };
        m.tras_reparar = { faltan: Number(d2.faltan), sobran: Number(d2.sobran) };
      }
      return m;
    } catch (e) {
      return { objeto, faltan: null, sobran: null, error: (e instanceof Error ? e.message : String(e)).slice(-400) };
    }
  }
}
