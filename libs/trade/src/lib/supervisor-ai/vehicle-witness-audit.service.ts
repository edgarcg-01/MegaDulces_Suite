import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * LTV.13 — Auditoría de "doble testigo": el GPS del camión de ruta como testigo
 * independiente de la ejecución en PdV. CERO LLM. Cruza las paradas del camión
 * (logistics.vehicle_stops, ya matcheadas a tienda) contra las capturas de
 * auditoría (public.daily_captures) por cercanía GPS + ventana temporal.
 *
 * Dos hallazgos → bandeja Horus (commercial.supervisor_findings, source='fraud',
 * ADR-020: detecta, NO acciona):
 *   - vehicle_stop_no_capture  (subject=store): la unidad estuvo en la tienda
 *     ≥5 min pero NADIE capturó → auditoría perdida con prueba GPS dura.
 *   - capture_no_vehicle_presence (subject=collaborator): capturas SIN ninguna
 *     parada de camión de ruta cerca. Auto-calibrado: solo se marca a quien SÍ
 *     tiene capturas con testigo (usa camión) → no castiga al que audita a pie.
 *
 * Auto-resolve scopeado a estos dos finding_type (no toca POD ni FraudEngine).
 */
const WITNESS = {
  stop_min_minutes: 5,
  capture_geofence_m: 150,
  witness_geofence_m: 200,
  window_days: 30,
  min_uncaptured_for_finding: 1,
  min_witnessless_for_finding: 2,
};

// Haversine SQL entre (dc.latitud/longitud) y (st.lat/st.lng), en metros.
const HAVERSINE_DC_ST = `2 * 6371000 * asin(sqrt(
  power(sin(radians(dc.latitud::float8 - st.lat::float8) / 2), 2) +
  cos(radians(st.lat::float8)) * cos(radians(dc.latitud::float8)) *
  power(sin(radians(dc.longitud::float8 - st.lng::float8) / 2), 2)
))`;

@Injectable()
export class VehicleWitnessAuditService {
  private readonly logger = new Logger(VehicleWitnessAuditService.name);
  private running = false;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  async generateForTenant(tenantId: string): Promise<{ open: number; resolved: number }> {
    if (!tenantId) return { open: 0, resolved: 0 };
    const w = WITNESS;

    // ── Hallazgo 1: unidad de ruta parada en tienda, sin captura ──
    const stopRows = await this.knex('logistics.vehicle_stops as st')
      .join('public.stores as s', 's.id', 'st.matched_store_id')
      .where('st.tenant_id', tenantId)
      .whereNotNull('st.matched_store_id')
      .whereRaw(`st.arrived_at >= now() - interval '${w.window_days} days'`)
      .where('st.minutes', '>=', w.stop_min_minutes)
      .whereRaw(`EXISTS (SELECT 1 FROM logistics.trackers tr WHERE tr.vehicle_id = st.vehicle_id AND tr.route_number IS NOT NULL)`)
      .whereRaw(`NOT EXISTS (
        SELECT 1 FROM public.daily_captures dc
        WHERE dc.tenant_id = st.tenant_id
          AND dc.hora_inicio BETWEEN st.arrived_at - interval '10 minutes' AND st.left_at + interval '10 minutes'
          AND dc.latitud IS NOT NULL AND dc.longitud IS NOT NULL
          AND ${HAVERSINE_DC_ST} <= ${w.capture_geofence_m}
      )`)
      .groupBy('st.matched_store_id', 's.nombre')
      .select('st.matched_store_id as store_id', 's.nombre as store_name')
      .count({ stop_events: '*' })
      .select(this.knex.raw('sum(st.minutes)::int as minutes_total'), this.knex.raw('max(st.arrived_at) as last_stop_at'));

    // ── Hallazgo 2: capturas sin testigo de unidad (auto-calibrado) ──
    const capRows = await this.knex('daily_captures as dc')
      .where('dc.tenant_id', tenantId)
      .whereRaw(`dc.hora_inicio >= now() - interval '${w.window_days} days'`)
      .whereNotNull('dc.latitud')
      .whereNotNull('dc.user_id')
      .groupBy('dc.user_id', 'dc.captured_by_username')
      .select('dc.user_id', 'dc.captured_by_username as name')
      .count({ total: '*' })
      .select(this.knex.raw(`count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM logistics.vehicle_stops st
        WHERE st.tenant_id = dc.tenant_id
          AND EXISTS (SELECT 1 FROM logistics.trackers tr WHERE tr.vehicle_id = st.vehicle_id AND tr.route_number IS NOT NULL)
          AND dc.hora_inicio BETWEEN st.arrived_at - interval '20 minutes' AND st.left_at + interval '20 minutes'
          AND ${HAVERSINE_DC_ST} <= ${w.witness_geofence_m}
      ))::int as witnessed`));

    const findings: any[] = [];
    const push = (type: string, severity: string, subjectType: string, subjectId: string, label: string | null, score: number, evidence: any) => {
      findings.push({
        tenant_id: tenantId,
        dedup_key: `${type}:${subjectType}:${subjectId}`,
        finding_type: type,
        severity,
        subject_type: subjectType,
        subject_id: subjectId,
        label: label ? String(label).slice(0, 160) : null,
        capture_id: null,
        score: Math.round(score * 100) / 100,
        evidence: JSON.stringify(evidence),
        source: 'fraud',
        status: 'open',
      });
    };

    for (const r of stopRows as any[]) {
      const events = Number(r.stop_events) || 0;
      if (events < w.min_uncaptured_for_finding) continue;
      push('vehicle_stop_no_capture', events >= 3 ? 'critical' : 'warn', 'store', r.store_id, r.store_name, events, {
        stop_events: events,
        minutes_total: Number(r.minutes_total) || 0,
        last_stop_at: r.last_stop_at,
        note: 'Unidad de ruta se detuvo en la tienda pero no hubo captura de auditoría',
      });
    }

    for (const r of capRows as any[]) {
      const total = Number(r.total) || 0;
      const witnessed = Number(r.witnessed) || 0;
      const without = total - witnessed;
      // Auto-calibrado: solo si el colaborador SÍ usa camión (>=1 con testigo).
      if (witnessed >= 1 && without >= w.min_witnessless_for_finding) {
        push('capture_no_vehicle_presence', without >= 5 ? 'critical' : 'warn', 'collaborator', r.user_id, r.name, without, {
          captures_without_witness: without,
          captures_witnessed: witnessed,
          total_captures: total,
          note: 'Capturas sin ninguna parada de camión de ruta cerca (posible captura sin la unidad)',
        });
      }
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
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_findings.status IN ('dismissed','confirmed') THEN commercial.supervisor_findings.status ELSE 'open' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }

    // Auto-resolver los de estos dos tipos que ya no aplican (no toca POD/FraudEngine).
    const resolved = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, source: 'fraud', status: 'open' })
      .whereIn('finding_type', ['vehicle_stop_no_capture', 'capture_no_vehicle_presence'])
      .modify((qb) => { if (keys.length) qb.whereNotIn('dedup_key', keys); })
      .update({ status: 'resolved', updated_at: this.knex.fn.now() });

    if (findings.length || resolved) this.logger.log(`witness audit tenant=${tenantId}: ${findings.length} abiertos, ${resolved} resueltos`);
    return { open: findings.length, resolved };
  }

  // 04:25 MX — 10 min después de pod-geo-audit, con el nightly (03:00) ya terminado.
  @Cron('0 25 4 * * *', { timeZone: 'America/Mexico_City' })
  async generateAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let tenants: Array<{ id: string }> = [];
      try {
        tenants = await this.knex('identity.tenants').select('id');
      } catch {
        const def = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
        tenants = [{ id: def }];
      }
      for (const t of tenants) await this.generateForTenant(t.id);
    } catch (e: any) {
      this.logger.error(`witness audit nightly falló: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
