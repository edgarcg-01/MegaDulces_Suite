import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';
import { FLEET_PROVIDER_PORT, FleetProviderPort, FleetObject } from './fleet-provider.port';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Tenant dueño de la cuenta del proveedor (la cuenta MagniTracking es global a
// la empresa = mega_dulces). Configurable por env; default del seed.
const DEFAULT_TENANT_ID =
  process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

export interface SyncResult {
  objects: number;
  created: number;
  updated: number;
  linked: number;
  positions: number;
  ms: number;
}

@Injectable()
export class LogisticsTrackingService {
  private readonly logger = new Logger(LogisticsTrackingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    @Inject(FLEET_PROVIDER_PORT) private readonly provider: FleetProviderPort,
  ) {}

  isProviderConfigured(): boolean {
    return this.provider.isConfigured();
  }

  /**
   * Trae la flota del proveedor y la vuelca a logistics.trackers (última posición
   * denormalizada) + logistics.vehicle_positions (histórico). Auto-vincula por
   * placa contra logistics.vehicles cuando el tracker aún no tiene vehicle_id.
   * Corre siempre contra el tenant dueño de la cuenta del proveedor.
   */
  async sync(tenantId: string = DEFAULT_TENANT_ID): Promise<SyncResult> {
    const started = Date.now();
    const objects = await this.provider.fetchObjects();
    let created = 0;
    let updated = 0;
    let linked = 0;
    let positions = 0;

    await this.tk.run(tenantId, async (trx) => {
      const vehicles: Array<{ id: string; plate: string }> = await trx('logistics.vehicles')
        .whereNull('deleted_at')
        .select('id', 'plate');
      const now = trx.fn.now();

      for (const o of objects) {
        if (!o.imei) continue;
        const routeCode = parseRoute(o.name);
        const matchId = matchVehicle(o.name, vehicles);

        const mergeable = {
          external_name: o.name || null,
          sim_number: o.simNumber ?? null,
          protocol: o.protocol ?? null,
          route_code: routeCode,
          last_lat: o.lat ?? null,
          last_lng: o.lng ?? null,
          last_speed_kmh: o.speedKmh ?? null,
          last_heading: o.heading ?? null,
          last_ignition: o.ignition ?? null,
          last_odometer: o.odometer ?? null,
          last_status: o.status,
          last_status_text: o.statusText ?? null,
          last_seen_at: o.capturedAt ?? null,
          last_synced_at: now,
          updated_at: now,
        };

        const existing = await trx('logistics.trackers')
          .where({ imei: o.imei })
          .first('id', 'vehicle_id');

        let trackerId: string;
        let effectiveVehicleId: string | null;

        if (existing) {
          await trx('logistics.trackers').where({ id: existing.id }).update(mergeable);
          updated++;
          trackerId = existing.id;
          effectiveVehicleId = existing.vehicle_id || null;
          if (!effectiveVehicleId && matchId) {
            await trx('logistics.trackers')
              .where({ id: existing.id })
              .whereNull('vehicle_id')
              .update({ vehicle_id: matchId });
            effectiveVehicleId = matchId;
            linked++;
          }
        } else {
          const [row] = await trx('logistics.trackers')
            .insert({
              tenant_id: trx.raw('public.current_tenant_id()'),
              provider: this.provider.providerName,
              imei: o.imei,
              vehicle_id: matchId,
              active: true,
              ...mergeable,
            })
            .returning(['id']);
          created++;
          trackerId = row.id;
          effectiveVehicleId = matchId;
          if (matchId) linked++;
        }

        // Histórico: solo si hay fix con coordenadas + timestamp.
        if (o.lat != null && o.lng != null && o.capturedAt) {
          const inserted = await trx('logistics.vehicle_positions')
            .insert({
              tenant_id: tenantId,
              tracker_id: trackerId,
              vehicle_id: effectiveVehicleId,
              captured_at: o.capturedAt,
              lat: o.lat,
              lng: o.lng,
              speed_kmh: o.speedKmh ?? null,
              heading: o.heading ?? null,
              ignition: o.ignition ?? null,
              odometer: o.odometer ?? null,
              altitude: o.altitude ?? null,
              status: o.status,
            })
            .onConflict(['tenant_id', 'tracker_id', 'captured_at'])
            .ignore();
          // rowCount>0 → fila nueva (no duplicado)
          if ((inserted as any)?.rowCount ?? 0) positions++;
        }
      }
    });

    const ms = Date.now() - started;
    this.logger.log(
      `sync: ${objects.length} objetos → ${created} nuevos, ${updated} act, ${linked} vinculados, ${positions} posiciones (${ms}ms)`,
    );
    return { objects: objects.length, created, updated, linked, positions, ms };
  }

  /** Última posición de cada tracker (para el mapa en vivo). Scoped por RLS. */
  async listLive() {
    return this.tk.run(async (trx) => {
      return trx('logistics.trackers as t')
        .leftJoin('logistics.vehicles as v', function () {
          this.on('v.tenant_id', 't.tenant_id').andOn('v.id', 't.vehicle_id');
        })
        .where('t.active', true)
        .whereNull('t.deleted_at')
        .select(
          't.id',
          't.imei',
          't.external_name',
          't.protocol',
          't.route_code',
          't.vehicle_id',
          'v.plate as vehicle_plate',
          't.last_lat',
          't.last_lng',
          't.last_speed_kmh',
          't.last_heading',
          't.last_ignition',
          't.last_status',
          't.last_status_text',
          't.last_seen_at',
          't.last_synced_at',
        )
        .orderBy('t.external_name', 'asc');
    });
  }

  /** Registro de dispositivos (admin / vinculación). Scoped por RLS. */
  async listTrackers() {
    return this.tk.run(async (trx) => {
      return trx('logistics.trackers')
        .whereNull('deleted_at')
        .select('*')
        .orderBy('external_name', 'asc');
    });
  }

  /** Recorrido histórico de un tracker en un rango (breadcrumbs). */
  async history(trackerId: string, from?: string, to?: string) {
    if (!UUID_REGEX.test(trackerId)) throw new BadRequestException('trackerId inválido');
    return this.tk.run(async (trx) => {
      // trackers tiene RLS → valida pertenencia al tenant.
      const tracker = await trx('logistics.trackers').where({ id: trackerId }).first('id');
      if (!tracker) throw new NotFoundException('Tracker no encontrado');
      let q = trx('logistics.vehicle_positions')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .where({ tracker_id: trackerId });
      if (from) q = q.where('captured_at', '>=', from);
      if (to) q = q.where('captured_at', '<=', to);
      return q
        .select(
          'captured_at',
          'lat',
          'lng',
          'speed_kmh',
          'heading',
          'ignition',
          'status',
        )
        .orderBy('captured_at', 'asc')
        .limit(5000);
    });
  }

  /**
   * Bootstrap: crea vehículos en logistics.vehicles a partir de los trackers sin
   * vincular (extrae la placa del nombre del GPS) y los vincula. Dos trackers con
   * la misma placa (GPS + dashcam) comparten el vehículo. Idempotente.
   */
  async bootstrapVehicles(tenantId: string = DEFAULT_TENANT_ID) {
    return this.tk.run(tenantId, async (trx) => {
      const trackers: Array<{ id: string; external_name: string | null }> = await trx('logistics.trackers')
        .whereNull('deleted_at')
        .whereNull('vehicle_id')
        .select('id', 'external_name');
      let created = 0;
      let linked = 0;
      let skipped = 0;
      for (const t of trackers) {
        const plate = extractPlate(t.external_name);
        if (!plate) { skipped++; continue; }
        let veh = await trx('logistics.vehicles').where({ plate }).whereNull('deleted_at').first('id');
        if (!veh) {
          const [row] = await trx('logistics.vehicles')
            .insert({
              tenant_id: trx.raw('public.current_tenant_id()'),
              plate,
              brand: extractBrand(t.external_name),
              status: 'disponible',
              active: true,
              notes: `Auto-creado desde rastreo GPS: ${t.external_name}`,
            })
            .returning('id');
          veh = row;
          created++;
        }
        await trx('logistics.trackers').where({ id: t.id }).update({ vehicle_id: veh.id, updated_at: trx.fn.now() });
        linked++;
      }
      this.logger.log(`bootstrapVehicles: ${created} vehículos creados, ${linked} trackers vinculados, ${skipped} sin placa`);
      return { created, linked, skipped };
    });
  }

  /** Vincula (o desvincula con null) un tracker a un vehículo. */
  async linkTracker(trackerId: string, vehicleId: string | null) {
    if (!UUID_REGEX.test(trackerId)) throw new BadRequestException('trackerId inválido');
    if (vehicleId && !UUID_REGEX.test(vehicleId))
      throw new BadRequestException('vehicleId inválido');
    return this.tk.run(async (trx) => {
      if (vehicleId) {
        const veh = await trx('logistics.vehicles')
          .where({ id: vehicleId })
          .whereNull('deleted_at')
          .first('id');
        if (!veh) throw new NotFoundException('Vehículo no encontrado');
      }
      const [row] = await trx('logistics.trackers')
        .where({ id: trackerId })
        .update({ vehicle_id: vehicleId, updated_at: trx.fn.now() })
        .returning(['id', 'vehicle_id']);
      if (!row) throw new NotFoundException('Tracker no encontrado');
      return row;
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** "NISSAN GP9249D (R-26) DASHCAM" → "R-26" */
export function parseRoute(name: string): string | null {
  const m = (name || '').match(/R[\s-]?(\d{1,3})\b/i);
  return m ? `R-${m[1]}` : null;
}

const KNOWN_BRANDS = [
  'NISSAN', 'CHEVROLET', 'FORD', 'RAM', 'DODGE', 'TOYOTA', 'HONDA', 'VOLKSWAGEN',
  'VW', 'AVANZA', 'ITALIKA', 'TRANSIT', 'SUBURBAN', 'SAVEIRO', 'JEEP', 'MAZDA',
  'HINO', 'ISUZU', 'INTERNATIONAL', 'FREIGHTLINER', 'KENWORTH',
];

/**
 * Extrae la placa del nombre del GPS. Quita paréntesis (rutas/DASHCAM) y toma el
 * último token 5–8 alfanumérico con letra+dígito que no sea una ruta R-NN.
 * "CHEVROLET S10 MW7947C (CAM)R-321" → "MW7947C"; "AVANZA PLU992A" → "PLU992A".
 */
export function extractPlate(name: string | null): string | null {
  if (!name) return null;
  const clean = name.toUpperCase().replace(/\([^)]*\)/g, ' ');
  const toks = clean.split(/[^A-Z0-9]+/).filter(Boolean);
  const cands = toks.filter(
    (t) => t.length >= 5 && t.length <= 8 && /[A-Z]/.test(t) && /\d/.test(t) && !/^R\d+$/.test(t),
  );
  return cands.length ? cands[cands.length - 1] : null;
}

/** Marca conocida (primer token que matchee la lista), o el primer token. */
export function extractBrand(name: string | null): string | null {
  if (!name) return null;
  const toks = name.toUpperCase().replace(/\([^)]*\)/g, ' ').split(/[^A-Z0-9]+/).filter(Boolean);
  return toks.find((t) => KNOWN_BRANDS.includes(t)) || toks[0] || null;
}

/** Empareja por placa: si algún token del nombre === placa de un vehículo. */
export function matchVehicle(
  name: string,
  vehicles: Array<{ id: string; plate: string }>,
): string | null {
  if (!name) return null;
  const tokens = new Set(
    name
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((t) => t.length >= 5),
  );
  for (const v of vehicles) {
    if (v.plate && tokens.has(v.plate.toUpperCase())) return v.id;
  }
  return null;
}
