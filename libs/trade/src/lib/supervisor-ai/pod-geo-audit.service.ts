import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * LTV.3 — Auditoría georreferenciada de POD (prueba de entrega).
 *
 * CERO LLM: cruza el punto GPS capturado al marcar "entregado"
 * (logistics.guide_recipients.gps_lat/gps_lng) contra el domicilio del cliente
 * (commercial.customers.latitude/longitude). Detecta POD marcados lejos del
 * cliente o sin GPS. Escribe a la bandeja Horus (commercial.supervisor_findings,
 * source='fraud') — GUARDARRAÍL ADR-020: detecta, NO acusa ni acciona.
 *
 * Hallazgos agregados por chofer (collaborator), idempotentes, respetan decisiones
 * humanas (dismissed/confirmed) y auto-resuelven lo que ya no aplica. El auto-resolve
 * scopea por finding_type LIKE 'pod_%' para NO tocar los hallazgos del FraudEngine
 * (mismo source='fraud').
 *
 * v2 (diferido): cross-check con GPS del camión (vehicle_positions ± ventana) →
 * 'pod_truck_absent'.
 */
const POD = {
  far_from_customer_m: 300,
  critical_m: 1000,
  window_days: 30,
};

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const toNum = (v: any): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

@Injectable()
export class PodGeoAuditService {
  private readonly logger = new Logger(PodGeoAuditService.name);
  private running = false;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  async generateForTenant(tenantId: string): Promise<{ open: number; resolved: number }> {
    if (!tenantId) return { open: 0, resolved: 0 };

    const recs = await this.knex('logistics.guide_recipients as gr')
      .join('logistics.delivery_guides as g', function () {
        this.on('g.tenant_id', 'gr.tenant_id').andOn('g.id', 'gr.guide_id');
      })
      .leftJoin('logistics.drivers as d', function () {
        this.on('d.tenant_id', 'g.tenant_id').andOn('d.id', 'g.driver_id');
      })
      .leftJoin('commercial.customers as c', function () {
        this.on('c.tenant_id', 'gr.tenant_id').andOn('c.id', 'gr.customer_id');
      })
      .where('gr.tenant_id', tenantId)
      .where('gr.status', 'entregado')
      .whereRaw(`gr.delivered_at >= now() - interval '${POD.window_days} days'`)
      .select(
        'gr.id as recipient_id',
        'gr.gps_lat',
        'gr.gps_lng',
        'gr.customer_id',
        'g.driver_id',
        'd.user_id as driver_user_id',
        'd.full_name as driver_name',
        'c.latitude',
        'c.longitude',
      );

    // Agregar por chofer (collaborator).
    type Agg = { label: string | null; far: number; maxDist: number; noGps: number; sampleFar: string | null; sampleNoGps: string | null };
    const agg = new Map<string, Agg>();
    const bump = (subjectId: string, name: string | null): Agg => {
      let a = agg.get(subjectId);
      if (!a) { a = { label: name, far: 0, maxDist: 0, noGps: 0, sampleFar: null, sampleNoGps: null }; agg.set(subjectId, a); }
      return a;
    };

    for (const r of recs) {
      const subjectId = r.driver_user_id || r.driver_id;
      if (!subjectId) continue; // sin chofer no se puede atribuir
      const a = bump(subjectId, r.driver_name);
      const podLat = toNum(r.gps_lat);
      const podLng = toNum(r.gps_lng);
      if (podLat == null || podLng == null) {
        a.noGps++; a.sampleNoGps = a.sampleNoGps || r.recipient_id;
        continue;
      }
      const cLat = toNum(r.latitude);
      const cLng = toNum(r.longitude);
      if (cLat != null && cLng != null) {
        const d = haversineM(podLat, podLng, cLat, cLng);
        if (d > POD.far_from_customer_m) {
          a.far++; a.maxDist = Math.max(a.maxDist, Math.round(d)); a.sampleFar = a.sampleFar || r.recipient_id;
        }
      }
    }

    const findings: any[] = [];
    const add = (type: string, severity: string, subjectId: string, label: string | null, score: number, evidence: any) => {
      findings.push({
        tenant_id: tenantId,
        dedup_key: `${type}:collaborator:${subjectId}`,
        finding_type: type,
        severity,
        subject_type: 'collaborator',
        subject_id: subjectId,
        label: label ? String(label).slice(0, 160) : null,
        capture_id: null,
        score: Math.round(score * 100) / 100,
        evidence: JSON.stringify(evidence),
        source: 'fraud',
        status: 'open',
      });
    };

    for (const [subjectId, a] of agg) {
      if (a.far >= 1)
        add('pod_far_from_customer', a.maxDist >= POD.critical_m ? 'critical' : 'warn', subjectId, a.label, a.far, {
          events: a.far, max_distance_m: a.maxDist, threshold_m: POD.far_from_customer_m, sample_recipient_id: a.sampleFar,
        });
      if (a.noGps >= 1)
        add('pod_no_gps', 'info', subjectId, a.label, a.noGps, { events: a.noGps, sample_recipient_id: a.sampleNoGps });
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

    // Auto-resolver los POD ya no vigentes — SOLO finding_type pod_% (no toca FraudEngine).
    const resolved = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, source: 'fraud', status: 'open' })
      .where('finding_type', 'like', 'pod%')
      .modify((qb) => { if (keys.length) qb.whereNotIn('dedup_key', keys); })
      .update({ status: 'resolved', updated_at: this.knex.fn.now() });

    if (findings.length || resolved) this.logger.log(`POD audit tenant=${tenantId}: ${findings.length} abiertos, ${resolved} resueltos`);
    return { open: findings.length, resolved };
  }

  // 04:15 MX — después del nightly on-prem (03:00) para auditar con la data del día ya cargada.
  @Cron('0 15 4 * * *', { timeZone: 'America/Mexico_City' })
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
      this.logger.error(`POD audit nightly falló: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
