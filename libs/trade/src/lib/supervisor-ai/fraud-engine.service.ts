import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Motor de FRAUDE / INTEGRIDAD (Sprint H2.4).
 *
 * CERO LLM: reglas deterministas de física + tiempo sobre daily_captures (datos que
 * SIEMPRE existen: GPS validado, hora_inicio/fin). Detecta:
 *   - fraud_gps_mismatch     : captura lejos de la tienda que dice visitar (necesita store coords).
 *   - fraud_impossible_speed : salto imposible entre capturas consecutivas del mismo vendedor.
 *   - fraud_fast_visit       : visita demasiado corta para la cantidad de exhibiciones.
 *   - fraud_overlap          : capturas del mismo vendedor con intervalos de tiempo solapados.
 *   - fraud_recycled_photo   : misma fotoUrl reutilizada en capturas distintas.
 * (El cruce declarado-vs-observado de visión ya vive como `vision_mismatch`, H2.2.)
 *
 * GUARDARRAÍL ADR-020: detecta, NO acusa. Los hallazgos de fraude NO generan acción
 * de co-piloto automática (no están en ACTION_FOR): van a la bandeja con su evidencia
 * para que el SUPERVISOR confirme/descarte. Acusar a un colaborador es acto humano.
 *
 * Hallazgos agregados por colaborador (source='fraud'), idempotentes, respetan
 * decisiones humanas y auto-resuelven lo que ya no aplica. Acceso KNEX_CONNECTION +
 * tenant explícito.
 */
const FRAUD = {
  gps_mismatch_m: 300, // captura a > 300 m de su tienda
  impossible_kmh: 130, // velocidad sostenida entre capturas
  min_move_m: 500, // ignora jitter de GPS para el cálculo de velocidad
  sec_per_exhibition: 15, // visita más rápida que esto por exhibición es sospechosa
  min_visit_sec: 25,
  min_exhibitions_for_fast: 2,
  window_days: 30,
};

const toNum = (v: any): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

type FAgg = {
  label: string | null;
  gps_mismatch: number;
  impossible_speed: number;
  fast_visit: number;
  overlap: number;
  recycled: number;
  sample: Record<string, string | null>;
  maxSpeed: number;
  maxDist: number;
  minDur: number | null;
};

@Injectable()
export class FraudEngineService {
  private readonly logger = new Logger(FraudEngineService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private static parseArray(v: any): any[] {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try {
        const p = JSON.parse(v);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  async generateForTenant(tenantId: string): Promise<{ open: number; resolved: number }> {
    if (!tenantId) return { open: 0, resolved: 0 };

    const caps = await this.knex('daily_captures as dc')
      .where('dc.tenant_id', tenantId)
      .whereRaw(`dc.hora_inicio >= now() - interval '${FRAUD.window_days} days'`)
      .orderBy('dc.user_id')
      .orderBy('dc.hora_inicio')
      .select(
        'dc.id',
        'dc.user_id',
        'dc.captured_by_username',
        'dc.store_id',
        'dc.latitud',
        'dc.longitud',
        'dc.hora_inicio',
        'dc.hora_fin',
        'dc.exhibiciones',
      );

    const storeRows = await this.knex('stores')
      .where('tenant_id', tenantId)
      .whereNotNull('latitud')
      .whereNotNull('longitud')
      .select('id', 'latitud', 'longitud');
    const storeCoord = new Map<string, { lat: number; lng: number }>();
    for (const s of storeRows) {
      const lat = toNum(s.latitud);
      const lng = toNum(s.longitud);
      if (lat != null && lng != null && lat !== 0 && lng !== 0) storeCoord.set(s.id, { lat, lng });
    }

    // Foto reciclada: una fotoUrl presente en >= 2 capturas distintas.
    const urlCaptures = new Map<string, Set<string>>();
    for (const c of caps) {
      for (const e of FraudEngineService.parseArray(c.exhibiciones)) {
        if (e && typeof e.fotoUrl === 'string' && /^https?:\/\//.test(e.fotoUrl)) {
          let s = urlCaptures.get(e.fotoUrl);
          if (!s) {
            s = new Set();
            urlCaptures.set(e.fotoUrl, s);
          }
          s.add(c.id);
        }
      }
    }

    const agg = new Map<string, FAgg>();
    const ensure = (userId: string, label: string | null): FAgg => {
      let a = agg.get(userId);
      if (!a) {
        a = {
          label,
          gps_mismatch: 0,
          impossible_speed: 0,
          fast_visit: 0,
          overlap: 0,
          recycled: 0,
          sample: {},
          maxSpeed: 0,
          maxDist: 0,
          minDur: null,
        };
        agg.set(userId, a);
      }
      return a;
    };

    let prevByUser: Record<string, any> = {};
    for (const c of caps) {
      if (!c.user_id) continue;
      const a = ensure(c.user_id, c.captured_by_username || 'Colaborador');
      const lat = toNum(c.latitud);
      const lng = toNum(c.longitud);
      const start = c.hora_inicio ? new Date(c.hora_inicio).getTime() : null;
      const end = c.hora_fin ? new Date(c.hora_fin).getTime() : null;
      const exhibs = FraudEngineService.parseArray(c.exhibiciones);

      // gps_mismatch: captura lejos de su tienda.
      if (c.store_id && lat != null && lng != null && lat !== 0 && lng !== 0) {
        const sc = storeCoord.get(c.store_id);
        if (sc) {
          const d = haversineMeters(lat, lng, sc.lat, sc.lng);
          if (d > FRAUD.gps_mismatch_m) {
            a.gps_mismatch++;
            a.maxDist = Math.max(a.maxDist, Math.round(d));
            a.sample.gps_mismatch = a.sample.gps_mismatch || c.id;
          }
        }
      }

      // fast_visit: duración insuficiente para la cantidad de exhibiciones.
      if (start != null && end != null && end > start && exhibs.length >= FRAUD.min_exhibitions_for_fast) {
        const durSec = (end - start) / 1000;
        const minExpected = Math.max(FRAUD.min_visit_sec, exhibs.length * FRAUD.sec_per_exhibition);
        if (durSec < minExpected) {
          a.fast_visit++;
          a.minDur = a.minDur == null ? Math.round(durSec) : Math.min(a.minDur, Math.round(durSec));
          a.sample.fast_visit = a.sample.fast_visit || c.id;
        }
      }

      // recycled_photo: alguna fotoUrl de esta captura aparece en otra captura.
      let recycledHere = false;
      for (const e of exhibs) {
        if (e && typeof e.fotoUrl === 'string') {
          const set = urlCaptures.get(e.fotoUrl);
          if (set && set.size >= 2) {
            recycledHere = true;
            break;
          }
        }
      }
      if (recycledHere) {
        a.recycled++;
        a.sample.recycled = a.sample.recycled || c.id;
      }

      // Pares consecutivos del mismo vendedor (caps ya ordenadas por user, hora_inicio).
      const prev = prevByUser[c.user_id];
      if (prev) {
        const pEnd = prev.hora_fin ? new Date(prev.hora_fin).getTime() : null;
        // overlap: empieza antes de que termine la anterior.
        if (pEnd != null && start != null && start < pEnd) {
          a.overlap++;
          a.sample.overlap = a.sample.overlap || c.id;
        }
        // impossible_speed: salto físico imposible.
        const pLat = toNum(prev.latitud);
        const pLng = toNum(prev.longitud);
        const pStart = prev.hora_inicio ? new Date(prev.hora_inicio).getTime() : null;
        if (lat != null && lng != null && pLat != null && pLng != null && start != null && pStart != null) {
          const dtSec = (start - pStart) / 1000;
          const dist = haversineMeters(lat, lng, pLat, pLng);
          if (dtSec > 0 && dist >= FRAUD.min_move_m) {
            const kmh = dist / 1000 / (dtSec / 3600);
            if (kmh > FRAUD.impossible_kmh) {
              a.impossible_speed++;
              a.maxSpeed = Math.max(a.maxSpeed, Math.round(kmh));
              a.sample.impossible_speed = a.sample.impossible_speed || c.id;
            }
          }
        }
      }
      prevByUser[c.user_id] = c;
    }

    // Emite findings agregados por colaborador.
    const findings: any[] = [];
    const add = (type: string, severity: string, userId: string, a: FAgg, score: number, evidence: any) => {
      findings.push({
        tenant_id: tenantId,
        dedup_key: `${type}:collaborator:${userId}`,
        finding_type: type,
        severity,
        subject_type: 'collaborator',
        subject_id: userId,
        label: a.label ? String(a.label).slice(0, 160) : null,
        capture_id: a.sample[type.replace('fraud_', '')] || null,
        score: Math.round(score * 100) / 100,
        evidence: JSON.stringify(evidence),
        source: 'fraud',
        status: 'open',
      });
    };

    for (const [userId, a] of agg) {
      if (a.impossible_speed >= 1)
        add('fraud_impossible_speed', a.impossible_speed >= 2 ? 'critical' : 'warn', userId, a, a.impossible_speed, {
          events: a.impossible_speed,
          max_speed_kmh: a.maxSpeed,
        });
      if (a.overlap >= 1)
        add('fraud_overlap', a.overlap >= 2 ? 'critical' : 'warn', userId, a, a.overlap, { events: a.overlap });
      if (a.gps_mismatch >= 1)
        add('fraud_gps_mismatch', a.gps_mismatch >= 3 ? 'critical' : 'warn', userId, a, a.gps_mismatch, {
          events: a.gps_mismatch,
          max_distance_m: a.maxDist,
          threshold_m: FRAUD.gps_mismatch_m,
        });
      if (a.fast_visit >= 1)
        add('fraud_fast_visit', a.fast_visit >= 5 ? 'critical' : 'warn', userId, a, a.fast_visit, {
          events: a.fast_visit,
          min_duration_sec: a.minDur,
        });
      if (a.recycled >= 1)
        add('fraud_recycled_photo', a.recycled >= 3 ? 'critical' : 'warn', userId, a, a.recycled, {
          events: a.recycled,
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
          capture_id: this.knex.raw('EXCLUDED.capture_id'),
          score: this.knex.raw('EXCLUDED.score'),
          evidence: this.knex.raw('EXCLUDED.evidence'),
          status: this.knex.raw(
            `CASE WHEN commercial.supervisor_findings.status IN ('dismissed','confirmed') THEN commercial.supervisor_findings.status ELSE 'open' END`,
          ),
          updated_at: this.knex.fn.now(),
        });
    }

    const resolved = await this.knex('commercial.supervisor_findings')
      .where({ tenant_id: tenantId, source: 'fraud', status: 'open' })
      .modify((qb) => {
        if (keys.length) qb.whereNotIn('dedup_key', keys);
      })
      .update({ status: 'resolved', updated_at: this.knex.fn.now() });

    return { open: findings.length, resolved: Number(resolved) || 0 };
  }
}
