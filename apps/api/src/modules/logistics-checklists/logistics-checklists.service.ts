import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';
import { TenantContextService } from '../../shared/tenant/tenant-context.service';

export type ChecklistType = 'salida' | 'llegada';
export type ChecklistStatus = 'pendiente' | 'completado';

export interface ChecklistItem {
  id: string;
  label: string;
  required?: boolean;
  group?: string;
}

export interface ChecklistResponse {
  ok: boolean;
  comment?: string;
  photo_url?: string;
}

export interface CreateChecklistDto {
  shipment_id: string;
  type: ChecklistType;
  items: ChecklistItem[];
  driver_id?: string;
}

export interface CompleteChecklistDto {
  responses: Record<string, ChecklistResponse>;
  notes?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Templates default para checklists. El operador puede pasar items custom si
 * los necesita. Origen: convención típica de operación PdV/logística MX.
 */
export const DEFAULT_CHECKLIST_TEMPLATES: Record<ChecklistType, ChecklistItem[]> = {
  salida: [
    { id: 'documentos', label: 'Documentos completos (factura, guía, etc.)', required: true, group: 'documentos' },
    { id: 'mercancia_revisada', label: 'Mercancía revisada y cargada correctamente', required: true, group: 'carga' },
    { id: 'sellos', label: 'Sellos colocados', required: true, group: 'carga' },
    { id: 'vehiculo_limpio', label: 'Vehículo limpio y sin daños visibles', required: true, group: 'vehiculo' },
    { id: 'combustible', label: 'Combustible suficiente para la ruta', required: true, group: 'vehiculo' },
    { id: 'luces_frenos', label: 'Luces y frenos funcionando', required: true, group: 'vehiculo' },
    { id: 'llantas', label: 'Llantas en buen estado (presión + dibujo)', required: true, group: 'vehiculo' },
    { id: 'gato_llave_cruz', label: 'Gato, llave de cruz y refacción presentes', required: false, group: 'vehiculo' },
    { id: 'extintor_botiquin', label: 'Extintor + botiquín de primeros auxilios', required: false, group: 'seguridad' },
    { id: 'epp_chofer', label: 'EPP del chofer (chaleco, guantes)', required: false, group: 'seguridad' },
  ],
  llegada: [
    { id: 'entrega_completa', label: 'Entrega completa a destinatario(s)', required: true, group: 'entrega' },
    { id: 'firmas_recibido', label: 'Firmas y/o sellos de recibido', required: true, group: 'entrega' },
    { id: 'devoluciones_registradas', label: 'Devoluciones/incidencias registradas (si aplica)', required: false, group: 'entrega' },
    { id: 'mercancia_remanente', label: 'Mercancía remanente reintegrada a almacén', required: false, group: 'retorno' },
    { id: 'vehiculo_sin_dano', label: 'Vehículo sin daño post-viaje', required: true, group: 'vehiculo' },
    { id: 'km_final', label: 'Kilometraje final registrado', required: true, group: 'vehiculo' },
    { id: 'combustible_final', label: 'Combustible final registrado', required: false, group: 'vehiculo' },
    { id: 'tickets_casetas', label: 'Tickets de casetas/combustible entregados', required: true, group: 'costos' },
  ],
};

@Injectable()
export class LogisticsChecklistsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async create(dto: CreateChecklistDto) {
    if (!UUID_REGEX.test(dto.shipment_id)) {
      throw new BadRequestException('shipment_id inválido');
    }
    if (!['salida', 'llegada'].includes(dto.type)) {
      throw new BadRequestException(`type inválido: ${dto.type}`);
    }
    if (dto.driver_id && !UUID_REGEX.test(dto.driver_id)) {
      throw new BadRequestException('driver_id inválido');
    }
    const items = dto.items?.length ? dto.items : DEFAULT_CHECKLIST_TEMPLATES[dto.type];
    if (!items?.length) throw new BadRequestException('items requerido o template default vacío');

    return this.tk.run(async (trx) => {
      // Verificar shipment existe
      const shipment = await trx('logistics.shipments')
        .where({ id: dto.shipment_id })
        .whereNull('deleted_at')
        .first();
      if (!shipment) throw new NotFoundException(`Shipment ${dto.shipment_id} no encontrado`);

      // Validar driver si viene
      if (dto.driver_id) {
        const d = await trx('logistics.drivers').where({ id: dto.driver_id }).first();
        if (!d) throw new NotFoundException(`Driver ${dto.driver_id} no encontrado`);
      }

      try {
        const [row] = await trx('logistics.shipment_checklists')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            shipment_id: dto.shipment_id,
            type: dto.type,
            status: 'pendiente',
            items: JSON.stringify(items),
            driver_id: dto.driver_id || null,
          })
          .returning('*');
        return row;
      } catch (e: any) {
        if (e.code === '23505') {
          throw new ConflictException(
            `Ya existe checklist tipo '${dto.type}' para shipment ${shipment.folio}`,
          );
        }
        throw e;
      }
    });
  }

  async findByShipment(shipmentId: string) {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipment_id inválido');
    return this.tk.run(async (trx) =>
      trx('logistics.shipment_checklists')
        .where({ shipment_id: shipmentId })
        .orderBy('created_at', 'asc'),
    );
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.shipment_checklists').where({ id }).first();
      if (!row) throw new NotFoundException(`Checklist ${id} no encontrado`);
      return row;
    });
  }

  async complete(id: string, dto: CompleteChecklistDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    if (!dto.responses || typeof dto.responses !== 'object') {
      throw new BadRequestException('responses requerido (object)');
    }

    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.shipment_checklists').where({ id }).first();
      if (!existing) throw new NotFoundException(`Checklist ${id} no encontrado`);
      if (existing.status === 'completado') {
        throw new ConflictException('Checklist ya está completado');
      }

      // Validar que todos los items required tengan respuesta
      const items: ChecklistItem[] =
        typeof existing.items === 'string' ? JSON.parse(existing.items) : existing.items;
      const missing = items
        .filter((it) => it.required)
        .filter((it) => !dto.responses[it.id] || dto.responses[it.id].ok === undefined)
        .map((it) => it.id);
      if (missing.length) {
        throw new BadRequestException(
          `Faltan respuestas a items requeridos: ${missing.join(', ')}`,
        );
      }

      const userId = this.tenantCtx.get()?.userId;

      const [row] = await trx('logistics.shipment_checklists')
        .where({ id })
        .update({
          status: 'completado',
          responses: JSON.stringify(dto.responses),
          notes: dto.notes || existing.notes,
          completed_at: trx.fn.now(),
          signed_by_user_id: userId || existing.signed_by_user_id,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      return row;
    });
  }

  async getTemplate(type: ChecklistType) {
    if (!['salida', 'llegada'].includes(type)) {
      throw new BadRequestException(`type inválido: ${type}`);
    }
    return { type, items: DEFAULT_CHECKLIST_TEMPLATES[type] };
  }
}
