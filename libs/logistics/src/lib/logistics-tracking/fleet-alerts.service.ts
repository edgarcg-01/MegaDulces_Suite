import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TENANT_ID =
  process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// Umbrales. offline: entre 90 min y 24 h (perdió señal recientemente, no dado de
// baja hace días → evita spam de las unidades muertas). speed: km/h.
const OFFLINE_MIN = 90;
const OFFLINE_MAX = 1440;
const SPEED_KMH = 90;

export interface ScanResult {
  opened: number;
  resolved: number;
  scanned: number;
}

function fmtMins(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

@Injectable()
export class FleetAlertsService {
  private readonly logger = new Logger(FleetAlertsService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** Escanea trackers y abre/actualiza/resuelve alertas. Idempotente. */
  async scan(tenantId: string = DEFAULT_TENANT_ID): Promise<ScanResult> {
    const now = Date.now();
    return this.tk.run(tenantId, async (trx) => {
      const trackers = await trx('logistics.trackers')
        .whereNull('deleted_at')
        .select('id', 'vehicle_id', 'last_seen_at', 'last_speed_kmh');
      let opened = 0;
      let resolved = 0;

      for (const t of trackers) {
        const mins = t.last_seen_at
          ? Math.floor((now - new Date(t.last_seen_at).getTime()) / 60000)
          : null;
        const conditions = [
          {
            kind: 'offline',
            on: mins != null && mins >= OFFLINE_MIN && mins <= OFFLINE_MAX,
            severity: 'danger',
            value: mins ?? 0,
            message: mins != null ? `Sin señal hace ${fmtMins(mins)}` : 'Sin señal',
          },
          {
            kind: 'speed',
            on: (t.last_speed_kmh ?? 0) >= SPEED_KMH,
            severity: 'warn',
            value: t.last_speed_kmh ?? 0,
            message: `Exceso de velocidad: ${t.last_speed_kmh} km/h`,
          },
        ];

        for (const c of conditions) {
          const open = await trx('logistics.fleet_alerts')
            .where({ tracker_id: t.id, kind: c.kind, status: 'open' })
            .first('id');
          if (c.on) {
            if (open) {
              await trx('logistics.fleet_alerts')
                .where({ id: open.id })
                .update({ last_seen_at: trx.fn.now(), value: c.value, message: c.message, severity: c.severity });
            } else {
              await trx('logistics.fleet_alerts').insert({
                tenant_id: trx.raw('public.current_tenant_id()'),
                tracker_id: t.id,
                vehicle_id: t.vehicle_id,
                kind: c.kind,
                severity: c.severity,
                message: c.message,
                value: c.value,
                status: 'open',
              });
              opened++;
            }
          } else if (open) {
            await trx('logistics.fleet_alerts')
              .where({ id: open.id })
              .update({ status: 'resolved', resolved_at: trx.fn.now() });
            resolved++;
          }
        }
      }
      if (opened || resolved) this.logger.log(`scan: +${opened} abiertas, -${resolved} resueltas`);
      return { opened, resolved, scanned: trackers.length };
    });
  }

  /** Alertas abiertas (o reconocidas) con nombre del tracker. Scoped por RLS. */
  async listActive() {
    return this.tk.run(async (trx) => {
      return trx('logistics.fleet_alerts as a')
        .leftJoin('logistics.trackers as t', function () {
          this.on('t.tenant_id', 'a.tenant_id').andOn('t.id', 'a.tracker_id');
        })
        .whereIn('a.status', ['open', 'ack'])
        .select(
          'a.id',
          'a.tracker_id',
          'a.vehicle_id',
          'a.kind',
          'a.severity',
          'a.message',
          'a.value',
          'a.status',
          'a.first_seen_at',
          'a.last_seen_at',
          't.external_name',
          't.route_code',
        )
        .orderBy('a.severity', 'asc')
        .orderBy('a.last_seen_at', 'desc');
    });
  }

  /** Reconoce (silencia) una alerta abierta. */
  async acknowledge(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const [row] = await trx('logistics.fleet_alerts')
        .where({ id })
        .whereIn('status', ['open', 'ack'])
        .update({ status: 'ack', acknowledged_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new NotFoundException('Alerta no encontrada');
      return row;
    });
  }
}
