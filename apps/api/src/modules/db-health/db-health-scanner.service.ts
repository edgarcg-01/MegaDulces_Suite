import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';
import { AlertsService } from '@megadulces/commercial';
import { MAILER_PORT, MailerPort } from '@megadulces/contracts';
import { DbHealthService, SourceHealth } from './db-health.service';

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
/**
 * Tenant de plataforma. Las fuentes de salud son de INFRAESTRUCTURA (feeds, CDC, réplicas, motor),
 * no de un cliente — se registran una sola vez, acá. Env por si algún día la plataforma corre con
 * otro tenant raíz; el default es Mega Dulces, el mismo que usan los feeds (`CRON_TENANT_ID`).
 */
const PLATFORM_TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

/** Cada cuánto se repite el correo de una alerta que sigue abierta. 24 h por decisión de Edgar. */
const REPEAT_HOURS = Number(process.env.DB_HEALTH_EMAIL_REPEAT_HOURS || 24);

@Injectable()
export class DbHealthScannerService {
  private readonly logger = new Logger(DbHealthScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB_ADMIN) private readonly knex: Knex | null,
    private readonly health: DbHealthService,
    private readonly alerts: AlertsService,
    // @Optional: sin binding de correo (o sin SMTP configurado) el scan corre igual. Mismo criterio
    // que usan MaatScannerService con FINANCE_NOTIFIER_PORT y BlindCountService con RECON_NOTIFIER_PORT.
    @Optional() @Inject(MAILER_PORT) private readonly mailer?: MailerPort,
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
    // Lo que amerita correo en ESTE ciclo. Se junta y se manda UNA sola vez al final: una cascada
    // (hoy fueron 3 réplicas + el CDC a la vez) tiene que llegar como un mensaje, no como cuatro.
    const porCorreo: Array<{ id: string; motivo: string; s: SourceHealth; desde: string | null }> = [];
    const recuperadas: Array<{ key: string; label: string }> = [];
    try {
      const report = await this.health.getReport();
      // Solo cuentan fallas reales: warn|critical. 'unknown' (no configurada / no alcanzable
      // desde este backend) NO es falla — lo evalúa el backend que sí alcanza la fuente.
      const failing = report.sources.filter((s) => s.status === 'warn' || s.status === 'critical');

      // DBH.4 — UN SOLO BARRIDO, no uno por tenant.
      //
      // Antes esto iteraba `identity.tenants` activos y abría UNA alerta por tenant del MISMO
      // problema. Pero estas fuentes no son de nadie en particular: el CDC de Kepler, la réplica de
      // Wincaja o el peso de la base no le pertenecen a `ws_iso_test`. Era un error de categoría, y
      // costaba caro — medido el 2026-09-01: 4 tenants activos, 3 de ellos restos de smokes de
      // aislamiento, 5 problemas reales → **20 filas, 15 de puro ruido**. Una bandeja que nadie
      // puede vaciar entrena a ignorarla, que es exactamente lo que pasó: 488 alertas creadas desde
      // el 30-jul y **cero** reconocidas en cinco semanas.
      //
      // Se barre bajo el tenant de plataforma. Los otros dejan de acumular copias; las que ya
      // tienen abiertas se resuelven abajo (no se borra ninguna fila ni ningún tenant).
      const tenants = await this.knex('identity.tenants')
        .where({ id: PLATFORM_TENANT, activo: true }).whereNull('deleted_at').select('id');
      resolved += await this.resolveForeignTenantAlerts();

      for (const t of tenants) {
        const tenantId = t.id as string;
        const open = await this.knex('analytics.db_health_alerts')
          .where({ tenant_id: tenantId }).whereNull('resolved_at')
          .select('id', 'source_key', 'status', 'first_seen_at', 'last_notified_at');
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
              porCorreo.push({ id: prev.id, motivo: 'escaló a crítico', s, desde: prev.first_seen_at });
            } else if (s.status === 'critical' && this.tocaRecordar(prev.last_notified_at)) {
              // Sigue rota y ya pasaron las horas del recordatorio. Sin esto, un correo único se
              // pierde igual que el toast: `wincaja_branch_stale` estuvo 20 días en critical.
              porCorreo.push({ id: prev.id, motivo: 'sigue sin resolverse', s, desde: prev.first_seen_at });
            }
          } else {
            const [ins] = await this.knex('analytics.db_health_alerts').insert({
              tenant_id: tenantId, source_key: s.key, source_label: s.label,
              group_key: s.group, ...row,
            }).returning('id');
            this.alerts.emitDbHealth(tenantId, {
              source_key: s.key, source_label: s.label, event: 'opened',
              status: s.status as 'warn' | 'critical', note: s.note, age_human: this.ageHuman(s.age_seconds),
            });
            opened++;
            // Sólo `critical` viaja por correo (decisión de Edgar). Los warn se ven en la bandeja:
            // de las 488 alertas creadas desde el 30-jul, la mayoría fueron warn que se resolvieron
            // solas — avisarlas todas serían ~14 correos por día y el correo dejaría de leerse.
            if (s.status === 'critical') {
              porCorreo.push({ id: (ins as any)?.id ?? ins, motivo: 'nueva', s, desde: null });
            }
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
          // Se avisa la recuperación SÓLO si se había avisado la falla: cierra el lazo sin
          // estrenar conversación. Si nunca te escribí por esto, no te escribo para decir que ya pasó.
          if (r.last_notified_at) recuperadas.push({ key: r.source_key, label: src?.label || r.source_key });
          resolved++;
        }
      }

      if (opened || escalated || resolved) {
        this.logger.log(`db-health: ${failing.length} fallando · abiertas +${opened} · escaladas +${escalated} · resueltas +${resolved}`);
      }
      await this.avisarPorCorreo(porCorreo, recuperadas).catch((e) =>
        this.logger.warn(`db-health correo: ${(e as Error).message}`));
      // Heartbeat propio (grupo Crons de Salud BD): prueba que este scanner corre.
      await this.recordCron('db_health_scan', 'Scanner Salud BD', 'ok', failing.length).catch(() => undefined);
      return { tenants: tenants.length, opened, escalated, resolved, failing: failing.length };
    } finally {
      this.running = false;
    }
  }

  /** ¿Ya toca recordar? NULL = nunca se avisó → sí. Si no, cuando pasaron las horas configuradas. */
  private tocaRecordar(lastNotifiedAt: Date | string | null): boolean {
    if (!lastNotifiedAt) return true;
    const horas = (Date.now() - new Date(lastNotifiedAt).getTime()) / 3_600_000;
    return horas >= REPEAT_HOURS;
  }

  /**
   * DBH.3 — el último tramo. Un correo por ciclo con lo que falló y lo que se recuperó.
   *
   * Degrada en silencio si no hay SMTP configurado o no hay destinatarios: el scan corre igual.
   * `last_notified_at` se marca **sólo si el envío salió** — si el correo falla, el próximo ciclo
   * reintenta en vez de dar por avisado algo que nadie leyó.
   */
  private async avisarPorCorreo(
    fallas: Array<{ id: string; motivo: string; s: SourceHealth; desde: string | null }>,
    recuperadas: Array<{ key: string; label: string }>,
  ): Promise<void> {
    if (!fallas.length && !recuperadas.length) return;
    if (!this.mailer?.isConfigured()) return;
    const to = (process.env.DB_HEALTH_ALERT_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!to.length) return;

    const url = (process.env.APP_PUBLIC_URL || '').replace(/\/+$/, '');
    const link = url ? `${url}/admin/db-health` : '/admin/db-health';
    const linea = (f: (typeof fallas)[number]) => {
      const desde = f.desde ? ` · sin resolverse desde el ${new Date(f.desde).toLocaleString('es-MX')}` : '';
      return `• ${f.s.label} (${f.s.key}) — ${f.motivo}${desde}\n  ${f.s.note || 'sin detalle'} · atraso ${this.ageHuman(f.s.age_seconds) || 'n/d'}`;
    };

    const titulo = fallas.length
      ? `[Salud BD] ${fallas.length} crítica(s): ${fallas.slice(0, 3).map((f) => f.s.label).join(', ')}${fallas.length > 3 ? '…' : ''}`
      : `[Salud BD] recuperado: ${recuperadas.map((r) => r.label).join(', ')}`;

    const cuerpo = [
      fallas.length ? `FALLANDO (${fallas.length})\n${fallas.map(linea).join('\n')}` : '',
      recuperadas.length ? `RECUPERADO (${recuperadas.length})\n${recuperadas.map((r) => `• ${r.label} (${r.key})`).join('\n')}` : '',
      `Ver el tablero: ${link}`,
      `Sólo se avisa de fallas CRÍTICAS; las atrasadas quedan en la bandeja. Recordatorio cada ${REPEAT_HOURS} h mientras sigan abiertas.`,
    ].filter(Boolean).join('\n\n');

    const r = await this.mailer.send({ to, subject: titulo, text: cuerpo });
    if (!r.ok || !fallas.length || !this.knex) return;
    await this.knex('analytics.db_health_alerts')
      .whereIn('id', fallas.map((f) => f.id))
      .update({ last_notified_at: this.knex.fn.now(), updated_at: this.knex.fn.now() });
  }

  /**
   * DBH.4 — cierra las alertas que quedaron abiertas bajo OTROS tenants cuando el barrido era
   * por-tenant. Se marcan resueltas, no se borran: la fila queda como historial de que existió.
   * Es idempotente — en régimen normal no encuentra nada y no hace nada.
   */
  private async resolveForeignTenantAlerts(): Promise<number> {
    if (!this.knex) return 0;
    const n = await this.knex('analytics.db_health_alerts')
      .whereNot({ tenant_id: PLATFORM_TENANT }).whereNull('resolved_at')
      .update({ resolved_at: this.knex.fn.now(), updated_at: this.knex.fn.now() });
    if (n > 0) this.logger.log(`db-health: ${n} alerta(s) de tenants ajenos cerradas (el barrido ya no es por tenant)`);
    return n;
  }

  /** Heartbeat de un cron interno del API → analytics.cron_runs (Salud BD grupo Crons). */
  async recordCron(jobKey: string, label: string, status: 'ok' | 'error', rows?: number, error?: string): Promise<void> {
    if (!this.knex) return;
    const MEGA = PLATFORM_TENANT;
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
