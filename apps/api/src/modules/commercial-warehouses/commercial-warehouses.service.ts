import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

export interface CreateWarehouseDto {
  code: string;
  name: string;
  address?: string;
  is_default?: boolean;
  active?: boolean;
}

export type UpdateWarehouseDto = Partial<CreateWarehouseDto>;

export interface ListWarehousesQuery {
  active?: boolean;
}

const CODE_REGEX = /^[A-Z0-9_-]{2,50}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CommercialWarehousesService {
  constructor(private readonly tk: TenantKnexService) {}

  async create(dto: CreateWarehouseDto) {
    this.validateCreate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.warehouses')
        .where({ code: dto.code })
        .first();
      if (existing) {
        throw new ConflictException(`Ya existe warehouse con code "${dto.code}"`);
      }

      if (dto.is_default) await this.clearDefaultFlag(trx);

      const [row] = await trx('commercial.warehouses')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          code: dto.code,
          name: dto.name.trim(),
          address: dto.address || null,
          is_default: dto.is_default ?? false,
          active: dto.active ?? true,
        })
        .returning('*');
      return row;
    });
  }

  async list(query: ListWarehousesQuery) {
    return this.tk.run(async (trx) => {
      let q = trx('commercial.warehouses').whereNull('deleted_at');
      if (typeof query.active === 'boolean') q = q.where({ active: query.active });
      return q.orderBy('is_default', 'desc').orderBy('name', 'asc');
    });
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('commercial.warehouses')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!row) throw new NotFoundException(`Warehouse ${id} no encontrado`);
      return row;
    });
  }

  async update(id: string, dto: UpdateWarehouseDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    this.validateUpdate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.warehouses')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Warehouse ${id} no encontrado`);

      if (dto.code && dto.code !== existing.code) {
        const dup = await trx('commercial.warehouses')
          .where({ code: dto.code })
          .whereNot({ id })
          .first();
        if (dup)
          throw new ConflictException(`Ya existe warehouse con code "${dto.code}"`);
      }

      if (dto.is_default === true && !existing.is_default) {
        await this.clearDefaultFlag(trx);
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.code !== undefined) patch.code = dto.code;
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.address !== undefined) patch.address = dto.address || null;
      if (dto.is_default !== undefined) patch.is_default = dto.is_default;
      if (dto.active !== undefined) patch.active = dto.active;

      const [row] = await trx('commercial.warehouses')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  async softDelete(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      const wh = await trx('commercial.warehouses')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!wh) throw new NotFoundException(`Warehouse ${id} no encontrado`);

      // Defensa: no permitir borrar el único default activo.
      if (wh.is_default) {
        const otherDefault = await trx('commercial.warehouses')
          .where({ is_default: true, active: true })
          .whereNot({ id })
          .whereNull('deleted_at')
          .first();
        if (!otherDefault) {
          throw new ConflictException(
            'No se puede borrar el único warehouse default. Marcar otro como default primero.',
          );
        }
      }

      await trx('commercial.warehouses')
        .where({ id })
        .update({ deleted_at: trx.fn.now(), active: false });
      return { deleted: true, id };
    });
  }

  /** Quita el flag is_default de cualquier otro warehouse del tenant. */
  private async clearDefaultFlag(trx: any): Promise<void> {
    await trx('commercial.warehouses')
      .where({ is_default: true })
      .update({ is_default: false, updated_at: trx.fn.now() });
  }

  private validateCreate(dto: CreateWarehouseDto): void {
    if (!dto.code || !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException(
        'code requerido: 2-50 chars [A-Z0-9_-]. Ej: "MD-CENTRAL".',
      );
    }
    if (!dto.name?.trim()) throw new BadRequestException('name requerido');
  }

  private validateUpdate(dto: UpdateWarehouseDto): void {
    if (dto.code !== undefined && !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException('code inválido');
    }
    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException('name no puede ser vacío');
    }
  }
}
