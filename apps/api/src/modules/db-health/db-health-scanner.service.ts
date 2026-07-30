import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';
import { AlertsService } from '@megadulces/commercial';
import { DbHealthService } from './db-health.service';

/**
 * Scanner de SALUD de datos → bandeja persistente + alerta WS.
 *
 * Cada 5 min corre `DbHealthService.getReport()` (frescura de todas las fuentes críticas)
 * y, para cada tenant activo, mantiene `analytics.db_health_alerts`:
 *   - fuente en warn/critical sin alerta abierta → ABRE + emite WS 'opened'
 *   - fuente que empeoró (warn→critical)         → actualiza + emite WS 'escalated'
 *   - fuente que sigue fallando                  → solo actualiza last_seen (sin re-emitir → anti-spam)
 *   - fuente que volvió a ok con alerta abierta   → RESUELVE + emite WS 'resolved'
 *
 * Así "desde prod se ve cuándo falla todo": la bandeja queda registrada aunque nadie
 * tenga la app abierta, y el toast avisa en el momento a quien esté conectado.
 *
 * Corre donde corra el api: en PROD monitorea las tablas de la app (que son el reflejo
 * downstream de los feeds on-prem) + cualquier fuente alcanzable. Usa KNEX_NEW_DB_ADMIN
 * (postgres, bypass RLS) y filtra/escribe tenant_id explícito.
 */
@Injectable()
export class DbHealthScannerService {
  private readonly logger = new Logger(DbHealthScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB_ADMIN) private readonly knex: Knex | null,
    private readonly health: DbHealthService,
    private readonly alerts: AlertsService,
  ) {}

  @Cron('0 */5 * * * *')
  async scheduled(): Promise<void> {
    if (process.env.DB_HEALTH_ALERTS === 'off') return; // escape hatch
    if (!this.knex) return;
    if (this.running) { this.logger.warn('Skip: scan anterior aún activo'); return; }
    try { await this.scanNow(); }
    catch (e) { this.logger.error(`db-health scan falló: ${(e as Error).message}`); }
  }

  /** Corre un ciclo. Devuelve resumen (para endpoint manual / smoke). */
  async scanNow(): Promise<{ tenants: number; opened: number; escalated: number; resolved: number; failing: number }> {
    if (!this.knex) return { tenants: 0, opened: 0, escalated: 0, resolved: 0, failing: 0 };
    this.running = true;
    let opened = 0, escalated = 0, resolved = 0;
    try {
      const report = await this.health.getReport();
      // Solo cuentan fallas reales: warn|critical. 'unknown' (no configurada / no alcanzable
      // desde este backend) NO es falla — lo evalúa el backend que sí alcanza la fuente.
      const failing = report.sources.filter((s) => s.status === 'warn' || s.status === 'critical');

      const tenants = await this.knex('identity.tenants')
        .where({ activo: true }).whereNull('deleted_at').select('id');

      for (const t of tenants) {
        const tenantId = t.id as string;
        const open = await this.knex('analytics.db_health_alerts')
          .where({ tenant_id: tenantId }).whereNull('resolved_at')
          .select('id', 'source_key', 'status');
        const openByKey = new Map(open.map((r: any) => [r.source_key, r]));
        const failingKeys = new Set(failing.map((s) => s.key));

        for (const s of failing) {
          const prev = openByKey.get(s.key);
          const row = {
            status: s.status,
            age_seconds: s.age_seconds ?? null,
            last_update: s.last_update ?? null,
            note: s.note ?? null,
            detail: JSON.stringify(s),
            last_seen_at: this.knex.fn.now(),
            updated_at: this.knex.fn.now(),
          };
          if (prev) {
            await this.knex('analytics.db_health_alerts').where({ id: prev.id }).update(row);
            if (prev.status === 'warn' && s.status === 'critical') {
              this.alerts.emitDbHealth(tenantId, {
                source_key: s.key, source_label: s.label, event: 'escalated',
                status: 'critical', note: s.note, age_human: this.ageHuman(s.age_seconds),
              });
              escalated++;
            }
          } else {
            await this.knex('analytics.db_health_alerts').insert({
              tenant_id: tenantId, source_key: s.key, source_label: s.label,
              group_key: s.group, ...row,
            });
            this.alerts.emitDbHealth(tenantId, {
              source_key: s.key, source_label: s.label, event: 'opened',
              status: s.status as 'warn' | 'critical', note: s.note, age_human: this.ageHuman(s.age_seconds),
            });
            opened++;
          }
        }

        // Recuperadas: alertas abiertas cuya fuente ya no está fallando.
        for (const r of open as any[]) {
          if (failingKeys.has(r.source_key)) continue;
          await this.knex('analytics.db_health_alerts').where({ id: r.id })
            .update({ resolved_at: this.knex.fn.now(), updated_at: this.knex.fn.now() });
          const src = report.sources.find((s) => s.key === r.source_key);
          this.alerts.emitDbHealth(tenantId, {
            source_key: r.source_key, source_label: src?.label || r.source_key,
            event: 'resolved', status: 'ok',
          });
          resolved++;
        }
      }

      if (opened || escalated || resolved) {
        this.logger.log(`db-health: ${failing.length} fallando · abiertas +${opened} · escaladas +${escalated} · resueltas +${resolved}`);
      }
      // Heartbeat propio (grupo Crons de Salud BD): prueba que este scanner corre.
      await this.recordCron('db_health_scan', 'Scanner Salud BD', 'ok', failing.length).catch(() => undefined);
      return { tenants: tenants.length, opened, escalated, resolved, failing: failing.length };
    } finally {
      this.running = false;
    }
  }

  /** Heartbeat de un cron interno del API → analytics.cron_runs (Salud BD grupo Crons). */
  async recordCron(jobKey: string, label: string, status: 'ok' | 'error', rows?: number, error?: string): Promise<void> {
    if (!this.knex) return;
    const MEGA = '00000000-0000-0000-0000-00000000d01c';
    await this.knex('analytics.cron_runs')
      .insert({
        tenant_id: MEGA, job_key: jobKey, label,
        last_start: this.knex.fn.now(), last_finish: this.knex.fn.now(),
        status, rows_affected: rows ?? null, error: error ? error.slice(0, 500) : null,
        host: 'api', updated_at: this.knex.fn.now(),
      })
      .onConflict(['tenant_id', 'job_key'])
      .merge(['label', 'last_finish', 'status', 'rows_affected', 'error', 'host', 'updated_at']);
  }

  private ageHuman(sec: number | null): string | null {
    if (sec == null) return null;
    const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
}
