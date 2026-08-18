import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_NOTIFIER_PORT } from '@megadulces/contracts';
import type { FinanceNotifierPort } from '@megadulces/contracts';

/** Una fuente de movimientos que vigilamos por crecimiento (feed Kepler / ContPAQi). */
interface FeedSource {
  key: string;
  label: string;        // nombre para el aviso
  table: string;        // analytics.<tabla> (sin RLS → filtro tenant explícito)
  tsCol: string;        // columna timestamp que el importer bumpea SOLO en filas nuevas/cambiadas
  route: string;        // deep-link de la campana
}

/**
 * CB (WS) — Aviso de FEED NUEVO para los usuarios de Finanzas.
 *
 * Detecta cuándo el feed de Kepler y/o ContPAQi trajo movimientos NUEVOS o CAMBIADOS
 * (los importers son churn-free / incrementales → `computed_at` avanza solo en las filas
 * que realmente cambiaron) y empuja un aviso `finance_feed` a la campana (WS `/alerts`,
 * vía FINANCE_NOTIFIER_PORT.notify → AlertsService). La campana lo muestra solo a quien
 * tiene el módulo de Finanzas y hace deep-link a `/finanzas/bancos`.
 *
 * Watermark en memoria por (tenant × fuente): en el PRIMER scan tras el arranque fija la
 * línea base al máximo actual SIN avisar (evita un aluvión histórico al bootear); de ahí
 * en adelante cuenta lo que superó el watermark. Un reinicio del API no reenvía histórico
 * (el dato sigue visible en la página). Best-effort: sin binding del puerto, no avisa.
 */
@Injectable()
export class FinanceFeedScannerService {
  private readonly logger = new Logger(FinanceFeedScannerService.name);
  private running = false;
  /** `${tenantId}:${sourceKey}` → última marca vista (Date). Sin entrada = aún sin línea base. */
  private readonly watermarks = new Map<string, Date>();

  private readonly SOURCES: FeedSource[] = [
    { key: 'kepler_bank',   label: 'Kepler · Tesorería',  table: 'analytics.kepler_bank_movements',   tsCol: 'computed_at', route: '/finanzas/bancos' },
    { key: 'contpaqi_bank', label: 'ContPAQi · Bancos',   table: 'analytics.contpaqi_bank_movements', tsCol: 'computed_at', route: '/finanzas/bancos' },
  ];

  private readonly THRESHOLD = Math.max(1, Number(process.env.FINANCE_FEED_NOTIFY_MIN_ROWS || 1));

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  // Cada 30 min. TZ MX explícito (el contenedor corre en MX; convención del repo).
  @Cron('0 */30 * * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: scan previo aún corriendo'); return; }
    await this.scanAll('cron');
  }

  /** Recorre todos los tenants activos. Devuelve el total de avisos emitidos. */
  async scanAll(source = 'cron'): Promise<{ tenants: number; avisos: number }> {
    this.running = true;
    let avisos = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try {
          const r = await this.tenantCtx.run({ tenantId: t.id }, () => this.scanTenant(t.id));
          avisos += r;
        } catch (e: any) {
          this.logger.warn(`scan tenant ${t.id} falló: ${e?.message || e}`);
        }
      }
      this.logger.log(`scan ${source}: ${tenants.length} tenants · ${avisos} aviso(s) de feed.`);
      return { tenants: tenants.length, avisos };
    } finally {
      this.running = false;
    }
  }

  /** Revisa cada fuente del tenant; avisa si crecieron los movimientos desde el watermark. */
  private async scanTenant(tenantId: string): Promise<number> {
    let avisos = 0;
    for (const s of this.SOURCES) {
      try {
        // ¿existe la tabla? (prod puede no tener el feed configurado aún)
        const reg = await this.knex.raw(`SELECT to_regclass(?) AS t`, [s.table]);
        if (!reg.rows[0]?.t) continue;

        const wmKey = `${tenantId}:${s.key}`;
        const wm = this.watermarks.get(wmKey);

        if (wm == null) {
          // Línea base: fija el watermark al máximo actual SIN avisar (evita spam histórico).
          const { rows } = await this.knex.raw(
            `SELECT max("${s.tsCol}") AS mx FROM ${s.table} WHERE tenant_id = ?`, [tenantId]);
          this.watermarks.set(wmKey, rows[0]?.mx ? new Date(rows[0].mx) : new Date(0));
          continue;
        }

        const { rows } = await this.knex.raw(
          `SELECT count(*)::int AS n, max("${s.tsCol}") AS mx
             FROM ${s.table} WHERE tenant_id = ? AND "${s.tsCol}" > ?`, [tenantId, wm]);
        const n = Number(rows[0]?.n || 0);
        const mx = rows[0]?.mx ? new Date(rows[0].mx) : wm;

        const notify = this.notifier?.notify?.bind(this.notifier);
        if (n >= this.THRESHOLD && notify) {
          await notify(tenantId, {
            key: `feed_${s.key}`,
            severity: 'info',
            title: `${s.label}: ${n} movimiento(s) nuevo(s)`,
            message: `El feed de ${s.label} trajo ${n} movimiento(s) nuevo(s) o modificado(s). Ábrelo para conciliar.`,
            route: s.route,
            data: { source_key: s.key, count: n },
          }).then(() => { avisos++; })
            .catch((e) => this.logger.warn(`notify ${s.key} falló: ${e?.message || e}`));
        }
        if (mx > wm) this.watermarks.set(wmKey, mx);
      } catch (e: any) {
        this.logger.warn(`fuente ${s.key} tenant ${tenantId} falló: ${e?.message || e}`);
      }
    }
    return avisos;
  }

  /**
   * Smoke: emite un aviso `finance_feed` de prueba al tenant del request (para verificar
   * que la campana lo recibe y hace deep-link). No toca watermarks.
   */
  async emitTest(): Promise<{ ok: boolean }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const notify = this.notifier?.notify?.bind(this.notifier);
    if (!notify) return { ok: false };
    await notify(tenantId, {
      key: 'feed_test',
      severity: 'info',
      title: 'Prueba: feed de Finanzas',
      message: 'Aviso de prueba — Kepler/ContPAQi trajo movimientos nuevos.',
      route: '/finanzas/bancos',
      data: { test: true },
    });
    return { ok: true };
  }
}
