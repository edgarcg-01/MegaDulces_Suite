import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';
import { RuleCalibrationService } from './rule-calibration.service';
import { SupervisorActionsService } from './supervisor-actions.service';
import { EventsService } from '../websocket/events.service';

/**
 * Horus — Sprint Horus.ACT.1 + ACT.4: "no visitó al cliente".
 *
 * Motor determinista de PLAN DE VISITA. Cruza la cartera planeada del día
 * (daily_assignments → rutas del vendedor para el ISODOW de hoy × clientes de esa
 * ruta con visit_days compatibles) contra las visitas reales (commercial.vendor_visits
 * de hoy). El delta = clientes NO visitados → finding `missed_visit` por colaborador.
 *
 * CERO LLM (motor decide, ADR-016/020). source='plan' propio para que el resolve del
 * motor de findings (source='engine') no lo pise (igual que fraud/vision).
 *
 * Canal híbrido (decisión 2026-07-21):
 *   - VENDEDOR (automático): al emitir el finding, crea coaching_notes(category='incident')
 *     + nudge WS `horus:nudge`. Es un aviso informativo/autocorrección, no una acción
 *     laboral → no rompe "nada laboral se dispara solo".
 *   - SUPERVISOR (aprobación): el co-piloto propone la acción `notify_missed_visit`
 *     (pending_approval); aprobarla escala la incidencia al supervisor en web (ADR-020).
 *
 * Corre en su PROPIO cron de fin de jornada (21:00 MX) — NO en el refresh de las
 * 02:30, porque a esa hora "hoy" ya cambió de día y nadie habría visitado aún
 * (falso positivo masivo). Guard hora≥18 salvo force para el endpoint manual.
 *
 * Conexión KNEX_CONNECTION (superuser, bypassa RLS) + tenant_id explícito, como el
 * resto de Horus. Ve public.daily_assignments/catalogs/users y commercial.*.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseEvidence(v: any): Record<string, any> {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) || {};
    } catch {
      return {};
    }
  }
  return {};
}

@Injectable()
export class MissedVisitEngineService {
  private readonly logger = new Logger(MissedVisitEngineService.name);
  private isRunning = false;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly calibration: RuleCalibrationService,
    private readonly actions: SupervisorActionsService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  /**
   * Cartera del vendedor para HOY (TZ MX): clientes cuya ruta está asignada al
   * vendedor este ISODOW y cuyos visit_days incluyen hoy (o están vacíos). Inline
   * (no import cross-lib) del fragmento canónico vendor-cartera.sql. Bind: [userId].
   */
  private plannedTodaySql(alias = 'c'): string {
    return `(
      (
        ${alias}.visit_days IS NULL
        OR cardinality(${alias}.visit_days) = 0
        OR ${alias}.visit_days @> ARRAY[EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::smallint]
      )
      AND EXISTS (
        SELECT 1
        FROM public.daily_assignments da
        JOIN public.catalogs cat
          ON cat.id = da.route_id AND cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL
        WHERE da.user_id = ?
          AND cat.value = ${alias}.sales_route
          AND da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int
      )
    )`;
  }

  // 03:00 UTC = 21:00 America/Mexico_City (fin de jornada). MX no observa DST → offset fijo.
  @Cron('0 0 3 * * *')
  async scheduledScan(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('missed_visit scan: corrida previa en curso, skip');
      return;
    }
    this.isRunning = true;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try {
          await this.scanForTenant(t.id, { force: false });
        } catch (e: any) {
          this.logger.error(`missed_visit scan tenant=${t.id} falló: ${e.message}`);
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  /** Genera findings + auto-nudge al vendedor y propone la acción del co-piloto. */
  async scanForTenant(tenantId: string, opts: { force?: boolean } = {}) {
    const gen = await this.generateForTenant(tenantId, opts);
    let actions: any = null;
    if (!(gen as any).skipped && !(gen as any).suppressed_all) {
      actions = await this.actions.proposeForTenant(tenantId);
    }
    return { tenant_id: tenantId, missed_visits: gen, actions };
  }

  /**
   * Núcleo determinista para un tenant. Idempotente por (tenant_id, dedup_key con
   * fecha MX). Resuelve los `missed_visit` de días previos (viven 1 día). El
   * auto-nudge al vendedor es idempotente por finding_id.
   */
  async generateForTenant(
    tenantId: string,
    opts: { force?: boolean } = {},
  ): Promise<Record<string, any>> {
    if (!tenantId) return { findings: 0 };

    const ctx = await this.knex.raw(
      `SELECT EXTRACT(HOUR FROM (now() AT TIME ZONE 'America/Mexico_City'))::int AS h,
              to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`,
    );
    const h = Number(ctx?.rows?.[0]?.h ?? 0);
    const dateStr = String(ctx?.rows?.[0]?.d ?? '');
    if (!opts.force && h < 18) {
      return { skipped: 'too_early', hour: h, findings: 0 };
    }

    const calMap = await this.calibration.getCalibration(tenantId);
    const rule = calMap.get('missed_visit:plan');
    if (rule?.suppressed) {
      return { suppressed_all: true, findings: 0, hour: h, date: dateStr };
    }

    // Vendedores con ruta asignada HOY (ISODOW MX).
    const vendors = await this.knex('public.daily_assignments as da')
      .join('public.users as u', 'u.id', 'da.user_id')
      .where('da.tenant_id', tenantId)
      .whereRaw(`da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int`)
      .distinct('da.user_id', 'u.nombre');

    const findings: any[] = [];
    for (const v of vendors) {
      const userId = String(v.user_id || '');
      if (!UUID_RE.test(userId)) continue;

      const planned = await this.knex('commercial.customers as c')
        .where('c.tenant_id', tenantId)
        .whereNull('c.deleted_at')
        .whereRaw(this.plannedTodaySql('c'), [userId])
        .select(
          'c.id',
          'c.name',
          this.knex.raw(
            `EXISTS (
               SELECT 1 FROM commercial.vendor_visits vv
               WHERE vv.customer_id = c.id AND vv.user_id = ?
                 AND (vv.visited_at AT TIME ZONE 'America/Mexico_City')::date
                     = (now() AT TIME ZONE 'America/Mexico_City')::date
             ) AS visited_today`,
            [userId],
          ),
        );

      const total = planned.length;
      if (!total) continue;
      const missedRows = planned.filter((p: any) => !p.visited_today);
      const missed = missedRows.length;
      if (!missed) continue;

      const frac = missed / total;
      let severity = frac >= 0.6 ? 'critical' : frac >= 0.3 ? 'warn' : 'info';
      if (rule?.cap === 'warn' && severity === 'critical') severity = 'warn';

      findings.push({
        tenant_id: tenantId,
        dedup_key: `missed_visit:collaborator:${userId}:${dateStr}`,
        finding_type: 'missed_visit',
        severity,
        subject_type: 'collaborator',
        subject_id: userId,
        label: v.nombre ? String(v.nombre).slice(0, 160) : null,
        score: missed,
        evidence: JSON.stringify({
          planned: total,
          visited: total - missed,
          missed,
          missed_customers: missedRows.slice(0, 50).map((m: any) => ({ id: m.id, name: m.name })),
          date: dateStr,
        }),
        source: 'plan',
        status: 'open',
      });
    }

    const keys = findings.map((f) => f.dedup_key);

    if (findings.length > 0) {
      await this.knex('commercial.supervisor_findings')
        .insert(findings)
        .onConflict(['tenant_id', 'dedup_key'])
        .merge({
          severity: this.knex.raw('EXCLUDED.severity'),
          label: this.knex.raw('EXCLUDED.label'),
          score: this.knex.raw('EXCLUDED.score'),
          evidence: this.knex.raw('EXCLUDED.evidence'),
          // Preserva decisiones humanas; reabre solo lo auto-resuelto/revisado.
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_findings.status IN ('dismissed','confirmed') THEN commercial.supervisor_findings.status ELSE 'open' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }

    // Los missed_visit viven 1 día: resuelve los de días previos (dedup con otra fecha).
    const resolved = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, source: 'plan', status: 'open' })
      .modify((qb) => {
        if (keys.length) qb.whereNotIn('dedup_key', keys);
      })
      .update({ status: 'resolved', updated_at: this.knex.fn.now() });

    // Auto-nudge al VENDEDOR (idempotente por finding_id): incidencia durable + WS.
    const nudged = await this.notifyCollaborators(tenantId, keys);

    return {
      findings: findings.length,
      resolved: Number(resolved) || 0,
      nudged,
      hour: h,
      date: dateStr,
    };
  }

  /** Crea la incidencia in-app + nudge WS para cada finding open del día. */
  private async notifyCollaborators(tenantId: string, keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    const rows = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, source: 'plan' })
      .whereIn('dedup_key', keys)
      .select('id', 'subject_id', 'evidence', 'status');

    let nudged = 0;
    for (const fr of rows) {
      if (fr.status !== 'open') continue; // respeta dismissed/confirmed
      const collaboratorId = String(fr.subject_id);
      if (!UUID_RE.test(collaboratorId)) continue;

      const existing = await this.knex('commercial.coaching_notes')
        .where({ tenant_id: tenantId, finding_id: fr.id })
        .whereNull('deleted_at')
        .first('id');
      if (existing) continue; // ya avisado

      const ev = parseEvidence(fr.evidence);
      const names: string[] = (ev.missed_customers || []).map((m: any) => m.name).filter(Boolean);
      const preview = names.slice(0, 5).join(', ');
      const extra = names.length > 5 ? ` y ${names.length - 5} más` : '';
      const message = `Hoy quedaron ${ev.missed ?? names.length} tienda(s) de tu ruta sin visitar${
        preview ? ': ' + preview + extra : ''
      }.`;

      const inserted = await this.knex('commercial.coaching_notes')
        .insert({
          tenant_id: tenantId,
          collaborator_id: collaboratorId,
          supervisor_id: null,
          action_id: null,
          finding_id: fr.id,
          category: 'incident',
          message: message.slice(0, 2000),
          status: 'open',
          created_by: null,
        })
        .returning('id');
      const noteId = inserted?.[0]?.id || inserted?.[0] || null;

      try {
        this.events?.emitFieldNudge({
          tenantId,
          userId: collaboratorId,
          kind: 'incident',
          title: message.slice(0, 120),
          refId: noteId,
        });
      } catch {
        /* best-effort */
      }
      nudged++;
    }
    return nudged;
  }
}
