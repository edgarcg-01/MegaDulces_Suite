import { Inject, Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '../../shared/database/new-database.module';

/**
 * Service de administración de tenants. Operaciones GLOBALES (sin tenant context)
 * — solo accesibles desde un super-admin de la plataforma (no de un tenant
 * específico).
 *
 * Usa la conexión postgres (admin) o app_runtime con queries globales (la
 * tabla `tenants` NO tiene RLS porque es la raíz).
 */

export interface CreateTenantDto {
  slug: string;
  nombre: string;
  plan?: 'standard' | 'enterprise' | 'trial';
  metadata?: Record<string, any>;
}

const SLUG_REGEX = /^[a-z][a-z0-9_]{2,49}$/;

@Injectable()
export class TenantsAdminService {
  constructor(@Inject(KNEX_NEW_DB) private readonly knex: Knex) {}

  async create(dto: CreateTenantDto) {
    if (!SLUG_REGEX.test(dto.slug)) {
      throw new BadRequestException(
        'slug inválido: solo lowercase, números y underscore, 3-50 chars, debe empezar con letra',
      );
    }
    if (!dto.nombre?.trim()) {
      throw new BadRequestException('nombre requerido');
    }

    const existing = await this.knex('tenants').where({ slug: dto.slug }).first();
    if (existing) {
      throw new ConflictException(`Ya existe tenant con slug "${dto.slug}"`);
    }

    const [tenant] = await this.knex('tenants')
      .insert({
        slug: dto.slug,
        nombre: dto.nombre.trim(),
        plan: dto.plan || 'standard',
        metadata: JSON.stringify(dto.metadata || {}),
      })
      .returning('*');

    return tenant;
  }

  async findAll() {
    return this.knex('tenants').orderBy('created_at', 'desc');
  }

  async findBySlug(slug: string) {
    const t = await this.knex('tenants').where({ slug }).first();
    if (!t) throw new NotFoundException(`Tenant "${slug}" no encontrado`);
    return t;
  }

  async deactivate(slug: string) {
    const updated = await this.knex('tenants')
      .where({ slug })
      .update({ activo: false, updated_at: this.knex.fn.now() })
      .returning('*');
    if (updated.length === 0) throw new NotFoundException(`Tenant "${slug}" no encontrado`);
    return updated[0];
  }
}
