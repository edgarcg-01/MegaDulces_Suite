import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import {
  VEHICLE_ASSIGNMENT_TEMPLATE,
  VEHICLE_ASSIGNMENT_TEMPLATE_VERSION,
  CONDITION_GRADES,
  validateCondition,
} from './vehicle-assignment-template';

/**
 * FC.1 — Derecho de uso de unidad + acta de asignación vehicular.
 *
 * Vive en `logistics-fleet` porque es materia de flotilla: quién puede usar qué
 * unidad y en qué estado se la entregaron. No cuelga del embarque.
 *
 * Servicio aparte y no dentro de `LogisticsFleetService` a propósito: ese ya
 * carga vehículos, personal, bitácoras de uso, mantenimiento y combustible.
 */

export type EntitlementCapacity = 'chofer' | 'responsable_administrativo' | 'ayudante';

const CAPACITIES: EntitlementCapacity[] = ['chofer', 'responsable_administrativo', 'ayudante'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GrantEntitlementDto {
  driver_id: string;
  vehicle_id: string;
  capacity?: EntitlementCapacity;
  valid_from?: string;
  notes?: string;
}

export interface CreateAssignmentDto {
  folio: string;
  vehicle_id: string;
  responsible_driver_id?: string;
  driver_id?: string;
  area?: string;
  warehouse_code?: string;
  odometer?: number;
  assigned_on: string;
  condition?: Record<string, 'M' | 'R' | 'B'>;
  observations?: string;
  scan_url?: string;
  signature_url?: string;
  /**
   * Si el chofer o el responsable todavía no tienen derecho sobre la unidad, el
   * acta lo otorga. Es el comportamiento del papel: la hoja firmada ES el
   * documento que concede el uso.
   */
  grant_entitlements?: boolean;
}

@Injectable()
export class VehicleAssignmentService {
  constructor(private readonly tk: TenantKnexService) {}

  /** Catálogo del formato, para que la pantalla lo pinte sin hardcodearlo. */
  getTemplate() {
    return {
      version: VEHICLE_ASSIGNMENT_TEMPLATE_VERSION,
      grades: CONDITION_GRADES,
      items: VEHICLE_ASSIGNMENT_TEMPLATE,
    };
  }

  // ── DERECHO de uso ───────────────────────────────────────────────────────

  /**
   * Agrupado por colaborador: "¿a qué vehículos tiene derecho fulano?".
   * Devuelve también a los que NO tienen ninguno — un padrón con huecos se ve,
   * no se esconde filtrándolo.
   */
  async entitlementsByDriver(opts: { only_with_rights?: boolean } = {}) {
    return this.tk.run(async (trx) => {
      const rows = await trx('logistics.drivers as d')
        .leftJoin('logistics.vehicle_entitlements as e', function (this: any) {
          this.on('e.driver_id', 'd.id')
            .andOnNull('e.deleted_at')
            .andOnNull('e.valid_to');
        })
        .leftJoin('logistics.vehicles as v', 'v.id', 'e.vehicle_id')
        .whereNull('d.deleted_at')
        .select(
          'd.id as driver_id', 'd.full_name', 'd.roles', 'd.status',
          'e.id as entitlement_id', 'e.capacity', 'e.valid_from',
          'v.id as vehicle_id', 'v.plate', 'v.brand', 'v.model', 'v.economic_number',
        )
        .orderBy('d.full_name', 'asc')
        .orderBy('v.plate', 'asc');

      const byDriver = new Map<string, any>();
      for (const r of rows) {
        if (!byDriver.has(r.driver_id)) {
          byDriver.set(r.driver_id, {
            driver_id: r.driver_id,
            full_name: r.full_name,
            roles: r.roles,
            status: r.status,
            vehicles: [] as any[],
          });
        }
        if (r.entitlement_id) {
          byDriver.get(r.driver_id).vehicles.push({
            entitlement_id: r.entitlement_id,
            vehicle_id: r.vehicle_id,
            plate: r.plate,
            brand: r.brand,
            model: r.model,
            economic_number: r.economic_number,
            capacity: r.capacity,
            valid_from: r.valid_from,
          });
        }
      }
      const out = Array.from(byDriver.values());
      return opts.only_with_rights ? out.filter((d) => d.vehicles.length > 0) : out;
    });
  }

  /** El espejo: "¿quién puede usar esta unidad?". */
  async entitlementsByVehicle(vehicleId: string) {
    if (!UUID_REGEX.test(vehicleId)) throw new BadRequestException('vehicle_id inválido');
    return this.tk.run(async (trx) =>
      trx('logistics.vehicle_entitlements as e')
        .join('logistics.drivers as d', 'd.id', 'e.driver_id')
        .where('e.vehicle_id', vehicleId)
        .whereNull('e.deleted_at')
        .whereNull('e.valid_to')
        .select('e.id', 'e.capacity', 'e.valid_from', 'd.id as driver_id', 'd.full_name')
        .orderBy('d.full_name'),
    );
  }

  async grant(dto: GrantEntitlementDto) {
    if (!UUID_REGEX.test(dto?.driver_id || '')) throw new BadRequestException('driver_id inválido');
    if (!UUID_REGEX.test(dto?.vehicle_id || '')) throw new BadRequestException('vehicle_id inválido');
    const capacity = dto.capacity || 'chofer';
    if (!CAPACITIES.includes(capacity)) {
      throw new BadRequestException(`capacity inválido. Permitidos: ${CAPACITIES.join(', ')}`);
    }
    return this.tk.run(async (trx) => {
      await this.assertDriverAndVehicle(trx, dto.driver_id, dto.vehicle_id);
      const dup = await trx('logistics.vehicle_entitlements')
        .where({ driver_id: dto.driver_id, vehicle_id: dto.vehicle_id, capacity })
        .whereNull('valid_to').whereNull('deleted_at').first();
      if (dup) throw new ConflictException('Ese colaborador ya tiene ese derecho vigente sobre la unidad.');

      const [row] = await trx('logistics.vehicle_entitlements')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          driver_id: dto.driver_id,
          vehicle_id: dto.vehicle_id,
          capacity,
          valid_from: dto.valid_from || trx.fn.now(),
          source: 'alta_manual',
          notes: dto.notes || null,
        })
        .returning('*');
      return row;
    });
  }

  /**
   * Revocar = vencer, no borrar. El derecho que existió tiene que seguir
   * siendo consultable: es lo que explica quién tenía la unidad cuando pasó algo.
   */
  async revoke(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const [row] = await trx('logistics.vehicle_entitlements')
        .where({ id })
        .whereNull('valid_to')
        .whereNull('deleted_at')
        .update({ valid_to: trx.fn.now(), updated_at: trx.fn.now() })
        .returning('*');
      if (!row) throw new NotFoundException('Derecho no encontrado o ya vencido');
      return row;
    });
  }

  // ── ACTA de asignación ───────────────────────────────────────────────────

  async listAssignments(opts: { vehicle_id?: string; driver_id?: string; status?: string } = {}) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.vehicle_assignments as a')
        .leftJoin('logistics.vehicles as v', 'v.id', 'a.vehicle_id')
        .leftJoin('logistics.drivers as ch', 'ch.id', 'a.driver_id')
        .leftJoin('logistics.drivers as rp', 'rp.id', 'a.responsible_driver_id')
        .whereNull('a.deleted_at');
      if (opts.vehicle_id) q = q.where('a.vehicle_id', opts.vehicle_id);
      if (opts.driver_id) q = q.where('a.driver_id', opts.driver_id);
      if (opts.status) q = q.where('a.status', opts.status);
      return q
        .select(
          'a.*',
          'v.plate', 'v.brand', 'v.model', 'v.economic_number',
          'ch.full_name as driver_name',
          'rp.full_name as responsible_name',
        )
        .orderBy('a.assigned_on', 'desc')
        .limit(300);
    });
  }

  async createAssignment(dto: CreateAssignmentDto) {
    if (!dto?.folio?.trim()) throw new BadRequestException('folio requerido');
    if (!UUID_REGEX.test(dto?.vehicle_id || '')) throw new BadRequestException('vehicle_id inválido');
    if (!dto?.assigned_on) throw new BadRequestException('assigned_on requerido');

    // La calificación se valida contra la plantilla: un concepto que no existe
    // o una nota fuera de M/R/B se rechaza en vez de guardarse como ruido.
    const problemas = validateCondition(dto.condition);
    if (problemas.length) throw new BadRequestException(problemas.join(' · '));

    return this.tk.run(async (trx) => {
      const vehiculo = await trx('logistics.vehicles')
        .where({ id: dto.vehicle_id }).whereNull('deleted_at').first();
      if (!vehiculo) throw new NotFoundException('Unidad no encontrada');

      const vigente = await trx('logistics.vehicle_assignments')
        .where({ vehicle_id: dto.vehicle_id, status: 'vigente' })
        .whereNull('deleted_at')
        .first('folio');
      if (vigente) {
        throw new ConflictException(
          `La unidad ${vehiculo.plate} ya está asignada en el acta ${vigente.folio}. Registrá la devolución antes de reasignarla.`,
        );
      }

      const [row] = await trx('logistics.vehicle_assignments')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          folio: dto.folio.trim(),
          vehicle_id: dto.vehicle_id,
          responsible_driver_id: dto.responsible_driver_id || null,
          driver_id: dto.driver_id || null,
          area: dto.area || null,
          warehouse_code: dto.warehouse_code || null,
          odometer: dto.odometer ?? null,
          assigned_on: dto.assigned_on,
          condition: dto.condition ? JSON.stringify(dto.condition) : null,
          condition_template: VEHICLE_ASSIGNMENT_TEMPLATE_VERSION,
          observations: dto.observations || null,
          scan_url: dto.scan_url || null,
          signature_url: dto.signature_url || null,
          status: 'vigente',
        })
        .returning('*');

      // El kilometraje del acta actualiza el odómetro de la unidad, pero NUNCA
      // hacia atrás: un número menor al que ya tiene es un error de captura y
      // se deja pasar sin pisar el bueno (la corrección va por su propio flujo).
      if (dto.odometer != null && Number(dto.odometer) >= 0) {
        await trx('logistics.vehicles')
          .where({ id: dto.vehicle_id })
          .andWhere((qb: any) =>
            qb.whereNull('current_odometer').orWhere('current_odometer', '<=', dto.odometer),
          )
          .update({ current_odometer: dto.odometer, updated_at: trx.fn.now() });
      }

      // El acta firmada concede el uso, igual que el papel.
      if (dto.grant_entitlements) {
        const pares: Array<[string | undefined, EntitlementCapacity]> = [
          [dto.driver_id, 'chofer'],
          [dto.responsible_driver_id, 'responsable_administrativo'],
        ];
        for (const [driverId, capacity] of pares) {
          if (!driverId) continue;
          const ya = await trx('logistics.vehicle_entitlements')
            .where({ driver_id: driverId, vehicle_id: dto.vehicle_id, capacity })
            .whereNull('valid_to').whereNull('deleted_at').first();
          if (ya) continue;
          await trx('logistics.vehicle_entitlements').insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            driver_id: driverId,
            vehicle_id: dto.vehicle_id,
            capacity,
            valid_from: dto.assigned_on,
            source: 'formato_asignacion',
            notes: `Otorgado por el acta ${dto.folio.trim()}`,
          });
        }
      }
      return row;
    });
  }

  /** Devolución de la unidad: cierra el acta y libera a la unidad para otra. */
  async returnAssignment(id: string, body: { released_on?: string; observations?: string } = {}) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const acta = await trx('logistics.vehicle_assignments')
        .where({ id }).whereNull('deleted_at').first();
      if (!acta) throw new NotFoundException('Acta no encontrada');
      if (acta.status !== 'vigente') {
        throw new ConflictException(`El acta ${acta.folio} ya está ${acta.status}.`);
      }
      const [row] = await trx('logistics.vehicle_assignments')
        .where({ id })
        .update({
          status: 'devuelto',
          released_on: body.released_on || trx.fn.now(),
          observations: body.observations
            ? `${acta.observations ? acta.observations + '\n' : ''}[DEVOLUCIÓN] ${body.observations}`
            : acta.observations,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      return row;
    });
  }

  private async assertDriverAndVehicle(trx: any, driverId: string, vehicleId: string) {
    const d = await trx('logistics.drivers').where({ id: driverId }).whereNull('deleted_at').first('id', 'full_name');
    if (!d) throw new NotFoundException('Colaborador no encontrado');
    const v = await trx('logistics.vehicles').where({ id: vehicleId }).whereNull('deleted_at').first('id', 'plate');
    if (!v) throw new NotFoundException('Unidad no encontrada');
  }
}
