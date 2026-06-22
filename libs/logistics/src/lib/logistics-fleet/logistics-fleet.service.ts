import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

// ─── Vehicles ───────────────────────────────────────────────────────────────

export interface CreateVehicleDto {
  plate: string;
  model?: string;
  brand?: string;
  year?: number;
  fuel_efficiency_km_l?: number;
  capacity_boxes?: number;
  capacity_kg?: number;
  status?: 'disponible' | 'en_ruta' | 'mantenimiento' | 'baja';
  notes?: string;
}
export type UpdateVehicleDto = Partial<CreateVehicleDto> & { active?: boolean };

export interface ListVehiclesQuery {
  active?: boolean;
  status?: string;
}

// ─── Drivers ────────────────────────────────────────────────────────────────

export type DriverRole = 'chofer' | 'ayudante' | 'cargador';

export type BloodType = 'O+' | 'O-' | 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-';

export interface CreateDriverDto {
  full_name: string;
  roles: DriverRole[];
  employee_type?: 'interno' | 'externo';
  status?: 'activo' | 'inactivo' | 'suspendido';
  nss?: string;
  phone?: string;
  emergency_contact?: string;
  emergency_phone?: string;
  user_id?: string;
  notes?: string;
  curp?: string;
  rfc?: string;
  blood_type?: BloodType;
  federal_license?: string;
  hire_date?: string;
  base_salary_biweekly?: number;
}
export type UpdateDriverDto = Partial<CreateDriverDto> & { active?: boolean };

export interface ListDriversQuery {
  active?: boolean;
  role?: DriverRole;
  search?: string;
}

const PLATE_REGEX = /^[A-Z0-9-]{2,20}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_DRIVER_ROLES: DriverRole[] = ['chofer', 'ayudante', 'cargador'];
const VALID_VEHICLE_STATUS = ['disponible', 'en_ruta', 'mantenimiento', 'baja'];
const VALID_DRIVER_STATUS = ['activo', 'inactivo', 'suspendido'];
const VALID_BLOOD_TYPES: BloodType[] = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
const CURP_REGEX = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z\d]\d$/;
const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{2,3}$/;

@Injectable()
export class LogisticsFleetService {
  constructor(private readonly tk: TenantKnexService) {}

  // ── VEHICLES ─────────────────────────────────────────────────────────────

  async createVehicle(dto: CreateVehicleDto) {
    this.validateVehicleCreate(dto);
    return this.tk.run(async (trx) => {
      const dup = await trx('logistics.vehicles').where({ plate: dto.plate }).first();
      if (dup) throw new ConflictException(`Ya existe vehicle con placa "${dto.plate}"`);

      const [row] = await trx('logistics.vehicles')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          plate: dto.plate,
          model: dto.model || null,
          brand: dto.brand || null,
          year: dto.year || null,
          fuel_efficiency_km_l: dto.fuel_efficiency_km_l || null,
          capacity_boxes: dto.capacity_boxes || null,
          capacity_kg: dto.capacity_kg || null,
          status: dto.status || 'disponible',
          notes: dto.notes || null,
          active: true,
        })
        .returning('*');
      return row;
    });
  }

  async listVehicles(query: ListVehiclesQuery) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.vehicles').whereNull('deleted_at');
      if (typeof query.active === 'boolean') q = q.where({ active: query.active });
      if (query.status) q = q.where({ status: query.status });
      return q.orderBy('plate', 'asc');
    });
  }

  async findVehicle(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.vehicles')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!row) throw new NotFoundException(`Vehicle ${id} no encontrado`);
      return row;
    });
  }

  async updateVehicle(id: string, dto: UpdateVehicleDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.vehicles')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Vehicle ${id} no encontrado`);

      if (dto.plate && dto.plate !== existing.plate) {
        if (!PLATE_REGEX.test(dto.plate)) throw new BadRequestException('placa inválida');
        const dup = await trx('logistics.vehicles')
          .where({ plate: dto.plate })
          .whereNot({ id })
          .first();
        if (dup) throw new ConflictException(`Ya existe vehicle con placa "${dto.plate}"`);
      }

      if (dto.status !== undefined && !VALID_VEHICLE_STATUS.includes(dto.status)) {
        throw new BadRequestException(`status inválido: ${dto.status}`);
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      for (const k of ['plate', 'model', 'brand', 'year', 'fuel_efficiency_km_l', 'capacity_boxes', 'capacity_kg', 'status', 'notes', 'active'] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }

      const [row] = await trx('logistics.vehicles')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  async softDeleteVehicle(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const v = await trx('logistics.vehicles')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!v) throw new NotFoundException(`Vehicle ${id} no encontrado`);

      // No borrar si está en uso por un shipment activo
      const inUse = await trx('logistics.shipments')
        .where({ vehicle_id: id })
        .whereIn('status', ['programado', 'en_ruta'])
        .first();
      if (inUse) {
        throw new ConflictException(
          `Vehicle ${v.plate} está asignado a un embarque activo (${inUse.folio}). Cerrar embarque primero.`,
        );
      }

      await trx('logistics.vehicles')
        .where({ id })
        .update({ deleted_at: trx.fn.now(), active: false });
      return { deleted: true, id };
    });
  }

  // ── DRIVERS ──────────────────────────────────────────────────────────────

  async createDriver(dto: CreateDriverDto) {
    this.validateDriverCreate(dto);
    return this.tk.run(async (trx) => {
      const [row] = await trx('logistics.drivers')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          full_name: dto.full_name.trim(),
          roles: dto.roles,
          employee_type: dto.employee_type || 'interno',
          status: dto.status || 'activo',
          nss: dto.nss || null,
          phone: dto.phone || null,
          emergency_contact: dto.emergency_contact || null,
          emergency_phone: dto.emergency_phone || null,
          user_id: dto.user_id || null,
          notes: dto.notes || null,
          curp: dto.curp?.toUpperCase() || null,
          rfc: dto.rfc?.toUpperCase() || null,
          blood_type: dto.blood_type || null,
          federal_license: dto.federal_license || null,
          hire_date: dto.hire_date || null,
          base_salary_biweekly: dto.base_salary_biweekly ?? null,
          active: true,
        })
        .returning('*');
      return row;
    });
  }

  async listDrivers(query: ListDriversQuery) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.drivers').whereNull('deleted_at');
      if (typeof query.active === 'boolean') q = q.where({ active: query.active });
      if (query.role) {
        // roles es text[] → usar ANY operator
        q = q.whereRaw('? = ANY(roles)', [query.role]);
      }
      if (query.search) {
        q = q.whereILike('full_name', `%${query.search}%`);
      }
      return q.orderBy('full_name', 'asc');
    });
  }

  async findDriver(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.drivers')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!row) throw new NotFoundException(`Driver ${id} no encontrado`);
      return row;
    });
  }

  async updateDriver(id: string, dto: UpdateDriverDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.drivers')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Driver ${id} no encontrado`);

      if (dto.roles !== undefined) this.validateRoles(dto.roles);
      if (dto.status !== undefined && !VALID_DRIVER_STATUS.includes(dto.status)) {
        throw new BadRequestException(`status inválido: ${dto.status}`);
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.full_name !== undefined) patch.full_name = dto.full_name.trim();
      if (dto.roles !== undefined) patch.roles = dto.roles;
      if (dto.employee_type !== undefined) patch.employee_type = dto.employee_type;
      if (dto.status !== undefined) patch.status = dto.status;
      if (dto.nss !== undefined) patch.nss = dto.nss || null;
      if (dto.phone !== undefined) patch.phone = dto.phone || null;
      if (dto.emergency_contact !== undefined) patch.emergency_contact = dto.emergency_contact || null;
      if (dto.emergency_phone !== undefined) patch.emergency_phone = dto.emergency_phone || null;
      if (dto.user_id !== undefined) patch.user_id = dto.user_id || null;
      if (dto.notes !== undefined) patch.notes = dto.notes || null;
      if (dto.curp !== undefined) patch.curp = dto.curp ? dto.curp.toUpperCase() : null;
      if (dto.rfc !== undefined) patch.rfc = dto.rfc ? dto.rfc.toUpperCase() : null;
      if (dto.blood_type !== undefined) patch.blood_type = dto.blood_type || null;
      if (dto.federal_license !== undefined) patch.federal_license = dto.federal_license || null;
      if (dto.hire_date !== undefined) patch.hire_date = dto.hire_date || null;
      if (dto.base_salary_biweekly !== undefined) patch.base_salary_biweekly = dto.base_salary_biweekly ?? null;
      if (dto.active !== undefined) patch.active = dto.active;

      const [row] = await trx('logistics.drivers')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // J.9.9 — Vehicle usage logs (check-in / check-out)
  // ───────────────────────────────────────────────────────────────────────

  async checkInVehicle(dto: {
    vehicle_id: string;
    driver_id?: string;
    shipment_id?: string;
    check_in_km: number;
    check_in_notes?: string;
  }) {
    if (!dto.vehicle_id || typeof dto.check_in_km !== 'number' || dto.check_in_km < 0) {
      throw new BadRequestException('vehicle_id y check_in_km (>=0) requeridos');
    }
    return this.tk.run(async (trx) => {
      // Verificar que el vehicle no esté ya en otro uso activo
      const activeUse = await trx('logistics.vehicle_usage_logs')
        .where({ vehicle_id: dto.vehicle_id, status: 'en_uso' })
        .first();
      if (activeUse) {
        throw new ConflictException('El vehículo ya tiene un check-in activo. Cerralo antes de uno nuevo.');
      }
      const [row] = await trx('logistics.vehicle_usage_logs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          vehicle_id: dto.vehicle_id,
          driver_id: dto.driver_id || null,
          shipment_id: dto.shipment_id || null,
          check_in_km: dto.check_in_km,
          check_in_notes: dto.check_in_notes || null,
          status: 'en_uso',
        })
        .returning('*');
      // También marcamos el vehicle como en_ruta
      await trx('logistics.vehicles').where({ id: dto.vehicle_id }).update({ status: 'en_ruta', updated_at: trx.fn.now() });
      return row;
    });
  }

  async checkOutVehicle(usageId: string, dto: {
    check_out_km: number;
    fuel_loaded_liters?: number;
    check_out_notes?: string;
  }) {
    if (typeof dto.check_out_km !== 'number' || dto.check_out_km < 0) {
      throw new BadRequestException('check_out_km (>=0) requerido');
    }
    return this.tk.run(async (trx) => {
      const usage = await trx('logistics.vehicle_usage_logs').where({ id: usageId }).first();
      if (!usage) throw new NotFoundException(`Usage ${usageId} no encontrado`);
      if (usage.status === 'cerrado') throw new ConflictException('Usage ya está cerrado');
      if (dto.check_out_km < usage.check_in_km) {
        throw new BadRequestException(`check_out_km (${dto.check_out_km}) no puede ser menor a check_in_km (${usage.check_in_km})`);
      }
      const [row] = await trx('logistics.vehicle_usage_logs')
        .where({ id: usageId })
        .update({
          check_out_km: dto.check_out_km,
          check_out_at: trx.fn.now(),
          fuel_loaded_liters: dto.fuel_loaded_liters ?? null,
          check_out_notes: dto.check_out_notes || null,
          status: 'cerrado',
          updated_at: trx.fn.now(),
        })
        .returning('*');
      // Liberar el vehicle
      await trx('logistics.vehicles').where({ id: usage.vehicle_id }).update({ status: 'disponible', updated_at: trx.fn.now() });
      return row;
    });
  }

  async listVehicleUsage(opts: { vehicle_id?: string; status?: string; limit?: number } = {}) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.vehicle_usage_logs as u')
        .leftJoin('logistics.vehicles as v', 'v.id', 'u.vehicle_id')
        .leftJoin('logistics.drivers as d', 'd.id', 'u.driver_id')
        .leftJoin('logistics.shipments as s', 's.id', 'u.shipment_id')
        .select(
          'u.*',
          'v.plate as vehicle_plate',
          'v.model as vehicle_model',
          'd.full_name as driver_name',
          's.folio as shipment_folio',
        )
        .orderBy('u.check_in_at', 'desc');
      if (opts.vehicle_id) q = q.where('u.vehicle_id', opts.vehicle_id);
      if (opts.status) q = q.where('u.status', opts.status);
      if (opts.limit) q = q.limit(opts.limit);
      else q = q.limit(100);
      return q;
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // J.9.9 — Vehicle maintenance log
  // ───────────────────────────────────────────────────────────────────────

  async createMaintenance(dto: {
    vehicle_id: string;
    type: 'preventivo' | 'correctivo' | 'inspeccion';
    service_date: string;
    km_at_service?: number;
    vendor?: string;
    description: string;
    cost?: number;
    next_service_date?: string;
    next_service_km?: number;
    notes?: string;
  }) {
    if (!dto.vehicle_id) throw new BadRequestException('vehicle_id requerido');
    if (!['preventivo', 'correctivo', 'inspeccion'].includes(dto.type)) {
      throw new BadRequestException(`type inválido: ${dto.type}`);
    }
    if (!dto.description) throw new BadRequestException('description requerida');
    return this.tk.run(async (trx) => {
      const [row] = await trx('logistics.vehicle_maintenance')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          vehicle_id: dto.vehicle_id,
          type: dto.type,
          service_date: dto.service_date,
          km_at_service: dto.km_at_service ?? null,
          vendor: dto.vendor || null,
          description: dto.description,
          cost: dto.cost ?? 0,
          next_service_date: dto.next_service_date || null,
          next_service_km: dto.next_service_km ?? null,
          notes: dto.notes || null,
        })
        .returning('*');
      return row;
    });
  }

  async listMaintenance(opts: { vehicle_id?: string; type?: string; limit?: number } = {}) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.vehicle_maintenance as m')
        .leftJoin('logistics.vehicles as v', 'v.id', 'm.vehicle_id')
        .whereNull('m.deleted_at')
        .select('m.*', 'v.plate as vehicle_plate', 'v.model as vehicle_model')
        .orderBy('m.service_date', 'desc');
      if (opts.vehicle_id) q = q.where('m.vehicle_id', opts.vehicle_id);
      if (opts.type) q = q.where('m.type', opts.type);
      if (opts.limit) q = q.limit(opts.limit);
      else q = q.limit(100);
      return q;
    });
  }

  async softDeleteMaintenance(id: string) {
    return this.tk.run(async (trx) => {
      const m = await trx('logistics.vehicle_maintenance').where({ id }).whereNull('deleted_at').first();
      if (!m) throw new NotFoundException(`Maintenance ${id} no encontrado`);
      await trx('logistics.vehicle_maintenance').where({ id }).update({ deleted_at: trx.fn.now() });
      return { deleted: true, id };
    });
  }

  async softDeleteDriver(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const d = await trx('logistics.drivers')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!d) throw new NotFoundException(`Driver ${id} no encontrado`);

      // No borrar si tiene guías activas asignadas
      const activeGuides = await trx('logistics.delivery_guides')
        .where(function (this: any) {
          this.where({ driver_id: id })
            .orWhere({ helper1_id: id })
            .orWhere({ helper2_id: id });
        })
        .whereIn('status', ['pendiente', 'en_ruta'])
        .first();
      if (activeGuides) {
        throw new ConflictException(
          `Driver ${d.full_name} tiene guías activas asignadas (${activeGuides.number}). Reasignar primero.`,
        );
      }

      await trx('logistics.drivers')
        .where({ id })
        .update({ deleted_at: trx.fn.now(), active: false, status: 'inactivo' });
      return { deleted: true, id };
    });
  }

  // ── J12.6 Mantenimiento preventivo + combustible (sobre odómetro manual) ──

  /**
   * Vehículos con servicio vencido: odómetro actual (máx de vehicle_usage_logs)
   * ≥ next_service_km, o next_service_date ya pasó. Sobre el último mantenimiento
   * registrado por unidad. No requiere telemetría (usa el odómetro tecleado).
   */
  async maintenanceDue() {
    return this.tk.run(async (trx) => {
      const odo = (
        await trx.raw(`
          SELECT vehicle_id,
                 MAX(GREATEST(COALESCE(check_out_km,0), COALESCE(check_in_km,0))) AS odometer
            FROM logistics.vehicle_usage_logs
           GROUP BY vehicle_id`)
      ).rows;
      const odoByVehicle = new Map<string, number>(odo.map((r: any) => [r.vehicle_id, Number(r.odometer)]));

      const lastMaint = (
        await trx.raw(`
          SELECT DISTINCT ON (vehicle_id)
                 vehicle_id, next_service_km, next_service_date, service_date, description
            FROM logistics.vehicle_maintenance
           WHERE deleted_at IS NULL
             AND (next_service_km IS NOT NULL OR next_service_date IS NOT NULL)
           ORDER BY vehicle_id, service_date DESC`)
      ).rows;

      const vehicles = await trx('logistics.vehicles')
        .whereNull('deleted_at').where({ active: true })
        .select('id', 'plate', 'model', 'brand');
      const vById = new Map<string, any>(vehicles.map((v: any) => [v.id, v]));

      const today = new Date().toISOString().slice(0, 10);
      const due: any[] = [];
      for (const m of lastMaint) {
        const v = vById.get(m.vehicle_id);
        if (!v) continue;
        const odometer = odoByVehicle.get(m.vehicle_id) ?? null;
        const reasons: string[] = [];
        if (m.next_service_km != null && odometer != null && odometer >= Number(m.next_service_km)) {
          reasons.push(`odómetro ${odometer} ≥ ${m.next_service_km} km`);
        }
        if (m.next_service_date != null && String(m.next_service_date).slice(0, 10) <= today) {
          reasons.push(`fecha ${String(m.next_service_date).slice(0, 10)}`);
        }
        if (reasons.length) {
          due.push({
            vehicle_id: m.vehicle_id, plate: v.plate, model: v.model, brand: v.brand,
            odometer, next_service_km: m.next_service_km != null ? Number(m.next_service_km) : null,
            next_service_date: m.next_service_date, last_description: m.description, reasons,
          });
        }
      }
      return due;
    });
  }

  /**
   * Rendimiento real de combustible por unidad: km recorridos (de usage logs
   * cerrados) / litros cargados, comparado con el spec `fuel_efficiency_km_l`.
   * Detecta fugas/fraude cuando el real cae muy por debajo del spec.
   */
  async fuelEfficiency() {
    return this.tk.run(async (trx) => {
      const agg = (
        await trx.raw(`
          SELECT vehicle_id,
                 SUM(GREATEST(check_out_km - check_in_km, 0)) AS km,
                 SUM(COALESCE(fuel_loaded_liters, 0)) AS liters,
                 COUNT(*) AS trips
            FROM logistics.vehicle_usage_logs
           WHERE status='cerrado' AND check_out_km IS NOT NULL
           GROUP BY vehicle_id`)
      ).rows;
      const aggByVehicle = new Map<string, any>(agg.map((r: any) => [r.vehicle_id, r]));

      const vehicles = await trx('logistics.vehicles')
        .whereNull('deleted_at').where({ active: true })
        .select('id', 'plate', 'model', 'brand', 'fuel_efficiency_km_l');

      return vehicles.map((v: any) => {
        const a = aggByVehicle.get(v.id);
        const km = a ? Number(a.km) : 0;
        const liters = a ? Number(a.liters) : 0;
        const real = liters > 0 ? Math.round((km / liters) * 100) / 100 : null;
        const spec = v.fuel_efficiency_km_l != null ? Number(v.fuel_efficiency_km_l) : null;
        const deviation_pct = real != null && spec ? Math.round(((real - spec) / spec) * 1000) / 10 : null;
        return {
          vehicle_id: v.id, plate: v.plate, model: v.model, brand: v.brand,
          km, liters, trips: a ? Number(a.trips) : 0,
          real_km_l: real, spec_km_l: spec, deviation_pct,
          flag: deviation_pct != null && deviation_pct <= -15, // real ≥15% bajo spec
        };
      });
    });
  }

  // ── Validators ───────────────────────────────────────────────────────────

  private validateVehicleCreate(dto: CreateVehicleDto): void {
    if (!dto.plate || !PLATE_REGEX.test(dto.plate)) {
      throw new BadRequestException(
        'plate requerida: 2-20 chars [A-Z0-9-]. Ej: "ABC-1234".',
      );
    }
    if (dto.status && !VALID_VEHICLE_STATUS.includes(dto.status)) {
      throw new BadRequestException(`status inválido: ${dto.status}`);
    }
    if (dto.year !== undefined && (dto.year < 1980 || dto.year > 2100)) {
      throw new BadRequestException('year fuera de rango (1980-2100)');
    }
    if (dto.fuel_efficiency_km_l !== undefined && dto.fuel_efficiency_km_l < 0) {
      throw new BadRequestException('fuel_efficiency_km_l no puede ser negativo');
    }
  }

  private validateDriverCreate(dto: CreateDriverDto): void {
    if (!dto.full_name?.trim()) throw new BadRequestException('full_name requerido');
    this.validateRoles(dto.roles);
    if (dto.employee_type && !['interno', 'externo'].includes(dto.employee_type)) {
      throw new BadRequestException(`employee_type inválido: ${dto.employee_type}`);
    }
    if (dto.status && !VALID_DRIVER_STATUS.includes(dto.status)) {
      throw new BadRequestException(`status inválido: ${dto.status}`);
    }
    if (dto.user_id !== undefined && dto.user_id && !UUID_REGEX.test(dto.user_id)) {
      throw new BadRequestException('user_id debe ser UUID válido o null');
    }
    if (dto.curp && !CURP_REGEX.test(dto.curp.toUpperCase())) {
      throw new BadRequestException('curp inválida (formato XXXX######XXXXXX##)');
    }
    if (dto.rfc && !RFC_REGEX.test(dto.rfc.toUpperCase())) {
      throw new BadRequestException('rfc inválido (formato persona física)');
    }
    if (dto.blood_type && !VALID_BLOOD_TYPES.includes(dto.blood_type)) {
      throw new BadRequestException(`blood_type inválido. Permitidos: ${VALID_BLOOD_TYPES.join(', ')}`);
    }
    if (dto.base_salary_biweekly !== undefined && dto.base_salary_biweekly !== null && dto.base_salary_biweekly < 0) {
      throw new BadRequestException('base_salary_biweekly no puede ser negativo');
    }
  }

  private validateRoles(roles: DriverRole[]): void {
    if (!Array.isArray(roles) || roles.length === 0) {
      throw new BadRequestException('roles requerido: array no vacío de chofer|ayudante|cargador');
    }
    for (const r of roles) {
      if (!VALID_DRIVER_ROLES.includes(r)) {
        throw new BadRequestException(`rol inválido: "${r}". Permitidos: ${VALID_DRIVER_ROLES.join(', ')}`);
      }
    }
  }
}
