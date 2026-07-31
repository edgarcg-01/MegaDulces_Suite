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
        const routeNumber = normalizeRouteNumber(o.name);
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
          .first('id', 'vehicle_id', 'route_manual');

        let trackerId: string;
        let effectiveVehicleId: string | null;

        if (existing) {
          // route_number auto solo si no está asignado a mano.
          const upd = existing.route_manual ? mergeable : { ...mergeable, route_number: routeNumber };
          await trx('logistics.trackers').where({ id: existing.id }).update(upd);
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
              route_number: routeNumber,
              route_manual: false,
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

  /**
   * Última posición de cada tracker (para el mapa en vivo). Scoped por RLS.
   * `fleet`: 'route' = solo camionetas de ruta (route_number no nulo, dominio
   * Auditoría en Ruta); 'logistics' = solo flota logística (route_number nulo);
   * undefined = todas. Es la separación estricta ruta ↔ logística.
   */
  async listLive(fleet?: 'route' | 'logistics') {
    return this.tk.run(async (trx) => {
      const rows = await trx('logistics.trackers as t')
        .leftJoin('logistics.vehicles as v', function () {
          this.on('v.tenant_id', 't.tenant_id').andOn('v.id', 't.vehicle_id');
        })
        .where('t.active', true)
        .whereNull('t.deleted_at')
        .modify((qb) => {
          if (fleet === 'route') qb.whereNotNull('t.route_number');
          else if (fleet === 'logistics') qb.whereNull('t.route_number');
        })
        .select(
          't.id',
          't.imei',
          't.external_name',
          't.protocol',
          't.route_code',
          't.route_number',
          't.operator_name',
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

      // Unidad de ruta: el operador autoritativo del proveedor (operator_name)
      // gana; si no hay, cae al vendedor asignado a la ruta (vendor_sales_routes).
      const vendorByRoute = await this.routeVendorMap(trx);
      return rows.map((r: any) => ({
        ...r,
        vendor_name: r.operator_name || (r.route_number != null ? vendorByRoute.get(r.route_number) ?? null : null),
      }));
    });
  }

  /**
   * LT.7 — Sync autoritativo ruta↔operador↔camión desde la API oficial
   * (travels.php + operators.php). Puebla trackers.route_number/operator_* por
   * IMEI. Marca route_manual=true para que el sync de posiciones (que deriva del
   * nombre del GPS) no lo pise. Reemplaza el parseo frágil de "R-NN" del nombre.
   */
  async syncRoutesOperators(tenantId: string = DEFAULT_TENANT_ID): Promise<{ operators: number; travels: number; linked: number }> {
    if (!this.provider.fetchTravels) return { operators: 0, travels: 0, linked: 0 };
    const [operators, travels] = await Promise.all([
      this.provider.fetchOperators ? this.provider.fetchOperators() : Promise.resolve([]),
      this.provider.fetchTravels(),
    ]);
    const opName = new Map(operators.map((o) => [o.id, o.name]));
    const digits = (s: string) => {
      const m = (s || '').replace(/\D/g, '');
      return m ? parseInt(m, 10) : null;
    };
    let linked = 0;
    await this.tk.run(tenantId, async (trx) => {
      for (const t of travels) {
        if (!t.imei) continue;
        const patch: any = {
          route_code: t.noPlaneacion,
          route_number: digits(t.noPlaneacion),
          route_manual: true,
          operator_id: t.operatorId ?? null,
          operator_name: t.operatorId ? opName.get(t.operatorId) ?? null : null,
          updated_at: trx.fn.now(),
        };
        const n = await trx('logistics.trackers').where({ imei: t.imei }).update(patch);
        if (n) linked++;
      }
    });
    this.logger.log(`syncRoutesOperators: ${operators.length} operadores, ${travels.length} rutas, ${linked} trackers vinculados`);
    return { operators: operators.length, travels: travels.length, linked };
  }

  /** Mapa número-de-ruta → nombre del vendedor asignado (vendor_sales_routes). */
  private async routeVendorMap(trx: Knex.Transaction): Promise<Map<number, string>> {
    const rows = await trx('commercial.vendor_sales_routes as vsr')
      .leftJoin('public.users as u', 'u.id', 'vsr.user_id')
      .whereNotNull('vsr.sales_route')
      .select('vsr.sales_route', trx.raw('COALESCE(u.nombre, u.username) as vendor_name'));
    const map = new Map<number, string>();
    for (const r of rows as any[]) {
      const n = normalizeRouteNumber(r.sales_route);
      if (n != null && r.vendor_name && !map.has(n)) map.set(n, r.vendor_name);
    }
    return map;
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

  /**
   * Asigna manualmente la ruta de un tracker (para los camiones cuyo nombre de
   * GPS no trae ruta). `routeNumber = null` revierte a automático (se recalcula
   * del nombre en el próximo sync). Marca route_manual para que el sync no pise.
   */
  async setRoute(trackerId: string, routeNumber: number | null) {
    if (!UUID_REGEX.test(trackerId)) throw new BadRequestException('trackerId inválido');
    if (routeNumber != null && (!Number.isInteger(routeNumber) || routeNumber < 0 || routeNumber > 999))
      throw new BadRequestException('route_number inválido (0–999)');
    return this.tk.run(async (trx) => {
      const t = await trx('logistics.trackers').where({ id: trackerId }).first('id', 'external_name');
      if (!t) throw new NotFoundException('Tracker no encontrado');
      const patch = routeNumber != null
        ? { route_number: routeNumber, route_manual: true, updated_at: trx.fn.now() }
        : { route_number: normalizeRouteNumber(t.external_name), route_manual: false, updated_at: trx.fn.now() };
      const [row] = await trx('logistics.trackers').where({ id: trackerId }).update(patch)
        .returning(['id', 'route_number', 'route_manual']);
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

/**
 * Número canónico de ruta desde cualquiera de las 3 grafías:
 *   "R-21" / "R21" / "RUTA 21" / "R0021" → 21.
 * Requiere R (o RUTA) seguido de separador/ceros opcionales y 1–3 dígitos, así
 * "RAM 700" o "RANGER" NO matchean como ruta.
 */
export function normalizeRouteNumber(text: string | null): number | null {
  if (!text) return null;
  const m = text.toUpperCase().match(/R(?:UTA)?[\s-]*0*(\d{1,3})\b/);
  return m ? parseInt(m[1], 10) : null;
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
