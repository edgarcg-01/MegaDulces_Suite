import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { legacyTxStorage } from '@megadulces/platform-core';
import { ScoringV2Service } from '../scoring/scoring-v2.service';
import { Permission } from '@megadulces/platform-core';
import { PermissionsCacheService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto';

/**
 * Roles del sistema (semilla): no pueden renombrarse ni eliminarse desde la
 * UI. Set canónico snake_case + roles funcionales (tele_operator, vendedor,
 * customer_b2b, chofer). Los slugs crípticos `Jefe_M`/`supervisor_v` quedaron
 * deprecados (reemplazados por `jefe_marketing`/`supervisor_ventas`) y NO se
 * protegen aquí a propósito: si quedan instancias viejas en una DB, deben
 * poder borrarse desde la UI. Comparación case-insensitive vía `isSystemRole`.
 */
const SYSTEM_ROLES: readonly string[] = [
  'superadmin',
  'admin',
  'supervisor',
  'supervisor_ventas',
  'jefe_marketing',
  'colaborador',
  'ejecutivo',
  'tele_operator',
  'vendedor',
  'customer_b2b',
  'chofer',
];

const SCORING_TYPES: readonly string[] = ['ubicaciones', 'conceptos', 'niveles'];

/**
 * Set whitelist de claves válidas del enum Permission para descartar
 * basura/keys inventadas que mande el cliente al editar permisos.
 */
const VALID_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  Object.values(Permission),
);

/**
 * Permisos marcados como "críticos" para logging/UX. El anti-escalation real
 * aplica a TODAS las claves (ver `updateRolePermissions`): un editor solo
 * puede otorgar permisos que él mismo posee. Esta lista solo destaca los de
 * mayor impacto en logs.
 */
const ELEVATED_PERMISSIONS: readonly string[] = [
  Permission.REPORTES_VER_GLOBAL,
  Permission.ROLES_CONFIGURAR,
];

/**
 * Mapeo del `catalog_id` al nombre de campo que usan las capturas en su
 * JSONB `exhibiciones[]`. Se respeta el shape original del frontend para
 * el storage (los nombres `posicion_id`/`exhibicion_id`/`nivel_ejecucion_id`
 * solo aparecen en el path de scoring, no en disco).
 */
const CAPTURE_FIELD_BY_TYPE: Record<string, string> = {
  conceptos: 'conceptoId',
  ubicaciones: 'ubicacionId',
  niveles: 'nivelEjecucionId',
};

const isSystemRole = (name: string) =>
  SYSTEM_ROLES.includes((name ?? '').toLowerCase());

@Injectable()
export class CatalogsService {
  private readonly logger = new Logger(CatalogsService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly scoringV2Service: ScoringV2Service,
    private readonly permsCache: PermissionsCacheService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async getByType(type: string, parentId?: string, includeInactive = false) {
    if (type === 'zonas' || type === 'zones') {
      const query = this.knex('zones')
        .orderBy('orden', 'asc')
        .select(
          'id',
          'name as value',
          'orden',
          this.knex.raw('(deleted_at IS NULL) as activo'),
          'is_system',
          'updated_at',
          'created_by',
          'updated_by',
        );
      if (!includeInactive) {
        query.whereNull('deleted_at');
      }
      return query;
    }

    if (type === 'roles') {
      // Enriquecido para la vista de roles: incluye el JSONB de permisos
      // (para la barra de cobertura + desglose por módulo), el conteo de
      // usuarios asignados y la fecha de última modificación.
      // tenant_id EXPLÍCITO: KNEX_CONNECTION no es RLS-scoped, y el mismo
      // role_name existe en cada tenant (UNIQUE tenant_id, role_name). Sin el
      // filtro devolvería roles de TODOS los tenants (cross-tenant leak).
      const tenantId = this.tenantCtx.requireTenantId();
      const userCounts = this.knex('users')
        .where('tenant_id', tenantId)
        .select('role_name')
        .count('* as user_count')
        .groupBy('role_name')
        .as('uc');

      const roles = await this.knex('role_permissions as rp')
        .where('rp.tenant_id', tenantId)
        .leftJoin(userCounts, 'uc.role_name', 'rp.role_name')
        .orderBy('rp.role_name', 'asc')
        .select(
          'rp.id',
          'rp.role_name as value',
          'rp.permissions',
          'rp.updated_at',
          this.knex.raw('COALESCE(uc.user_count, 0)::int as user_count'),
        );
      return roles.map((r) => ({ ...r, is_system: isSystemRole(r.value) }));
    }

    const query = this.knex('catalogs')
      .where({ catalog_id: type })
      .orderBy('orden', 'asc');

    if (!includeInactive) {
      query.whereNull('deleted_at');
    }
    if (parentId) {
      query.where({ parent_id: parentId });
    }

    return query;
  }

  async create(type: string, data: CreateCatalogItemDto, requesterId?: string) {
    if (type === 'zonas' || type === 'zones') {
      // Case-insensitive uniqueness check antes del INSERT — la constraint
      // de DB es case-sensitive, pero los filtros downstream son case-
      // insensitive (reports/seguimiento usan LOWER(TRIM(...))).
      const conflict = await this.knex('zones')
        .whereRaw('LOWER(name) = LOWER(?)', [data.value])
        .first();
      if (conflict) {
        throw new ConflictException(
          `Ya existe una zona con el nombre "${conflict.name}".`,
        );
      }

      try {
        const [item] = await this.knex('zones')
          .insert({
            tenant_id: this.tenantCtx.requireTenantId(),
            name: data.value,
            orden: data.orden ?? 0,
            created_by: requesterId,
            updated_by: requesterId,
          })
          .returning([
            'id',
            'name as value',
            'orden',
            this.knex.raw('(deleted_at IS NULL) as activo'),
            'is_system',
          ]);
        return item;
      } catch (error: any) {
        if (error.code === '23505') {
          throw new ConflictException(
            `Ya existe una zona con el nombre "${data.value}".`,
          );
        }
        throw error;
      }
    }

    if (type === 'roles') {
      // Normalizamos a minúscula: el lookup rol→permisos es case-insensitive,
      // pero mantener role_name canónico (snake_case minúscula) evita que
      // convivan variantes de case ('Auxiliar_x' vs 'auxiliar_x') que rompían
      // la resolución de permisos (usuarios en minúscula vs fila capitalizada).
      const name = (data.value || '').trim().toLowerCase();
      if (!name) {
        throw new BadRequestException('El nombre del rol no puede estar vacío');
      }
      try {
        const [item] = await this.knex('role_permissions')
          .insert({
            id: randomUUID(),
            tenant_id: this.tenantCtx.requireTenantId(),
            role_name: name,
            permissions: {},
            updated_by: requesterId,
          })
          .returning(['id', 'role_name as value']);
        return { ...item, is_system: isSystemRole(item.value) };
      } catch (error: any) {
        if (error.code === '23505') {
          throw new ConflictException(
            `Ya existe un rol con el nombre "${name}"`,
          );
        }
        throw error;
      }
    }

    // Para tipos de scoring: chequeo case-insensitive para no romper el
    // backfill por nombre (especialmente niveles).
    if (SCORING_TYPES.includes(type)) {
      await this.checkCaseInsensitiveDuplicate(type, data.value);
    }

    const insertData: Record<string, any> = {
      tenant_id: this.tenantCtx.requireTenantId(),
      catalog_id: type,
      value: data.value,
      orden: data.orden ?? 0,
      puntuacion: data.puntuacion ?? 0,
      icono: data.icono,
      parent_id: data.parent_id,
      created_by: requesterId,
      updated_by: requesterId,
    };

    try {
      const [item] = await this.knex('catalogs').insert(insertData).returning('*');

      if (SCORING_TYPES.includes(type)) {
        await this.safeRecalcularScoreMaximo(type);
      }
      return item;
    } catch (error: any) {
      if (error.code === '23505') {
        throw new ConflictException(
          `Ya existe un elemento con el valor "${data.value}" en este catálogo`,
        );
      }
      throw error;
    }
  }

  /**
   * Eliminar un ítem de catálogo. Para tipos de scoring (conceptos/ubicaciones/
   * niveles), si el ítem está referenciado por capturas históricas o por la
   * versión activa de scoring, se hace **soft-delete** (`activo=false`) para
   * preservar el historial. Si no hay referencias, hard-delete.
   *
   * Para `zonas` y `roles` se mantiene el comportamiento previo (hard-delete
   * con sus propios chequeos de integridad).
   */
  async delete(type: string, id: string, requesterId?: string) {
    if (type === 'zonas' || type === 'zones') {
      const existing = await this.knex('zones').where({ id }).first();
      if (!existing) throw new NotFoundException('Zona no encontrada');

      if (existing.is_system) {
        throw new BadRequestException(
          `La zona "${existing.name}" es del sistema (semilla) y no puede eliminarse. Está referenciada por código y seeds.`,
        );
      }

      const refs = await this.getZoneReferences(id);

      if (refs.users > 0 || refs.stores > 0 || refs.routes > 0) {
        // Soft-delete: marcar inactiva y preservar las FKs. La zona queda
        // oculta del listado por defecto pero las referencias siguen viables.
        await this.knex('zones').where({ id }).update({
          deleted_at: this.knex.fn.now(),
          updated_by: requesterId,
          updated_at: this.knex.fn.now(),
        });
        const parts: string[] = [];
        if (refs.users > 0) parts.push(`${refs.users} usuario(s)`);
        if (refs.stores > 0) parts.push(`${refs.stores} tienda(s)`);
        if (refs.routes > 0) parts.push(`${refs.routes} ruta(s)`);
        return {
          success: true,
          soft_deleted: true,
          message: `La zona "${existing.name}" está referenciada por ${parts.join(
            ', ',
          )}; se marcó como inactiva para preservar el historial.`,
        };
      }

      // Sin referencias: limpiamos primero las rutas huérfanas (catalogs
      // con parent_id apuntando a esta zona — no hay FK estricta, así que
      // tenemos que hacerlo manualmente para evitar dejar huérfanos en DB).
      await this.knex.transaction(async (trx) => {
        await trx('catalogs')
          .where({ catalog_id: 'rutas', parent_id: id })
          .del();
        await trx('zones').where({ id }).del();
      });

      return { success: true, soft_deleted: false };
    }

    if (type === 'roles') {
      // tenant_id EXPLÍCITO: KNEX_CONNECTION no es RLS-scoped. El lookup por PK
      // UUID no colisiona entre tenants, pero el conteo de usuarios por
      // role_name SÍ cuenta usuarios de otros tenants → bloqueo/permiso erróneo.
      const tenantId = this.tenantCtx.requireTenantId();
      const existing = await this.knex('role_permissions')
        .where({ id, tenant_id: tenantId })
        .first();
      if (!existing) {
        throw new NotFoundException('Rol no encontrado');
      }

      if (isSystemRole(existing.role_name)) {
        throw new BadRequestException(
          `El rol "${existing.role_name}" es un rol del sistema y no puede eliminarse.`,
        );
      }

      const usersWithRole = await this.knex('users')
        .where({ role_name: existing.role_name, tenant_id: tenantId })
        .select('username');

      if (usersWithRole.length > 0) {
        const sample = usersWithRole
          .slice(0, 5)
          .map((u) => u.username)
          .join(', ');
        const extra =
          usersWithRole.length > 5 ? ` y ${usersWithRole.length - 5} más` : '';
        throw new ConflictException(
          `No se puede eliminar el rol "${existing.role_name}": hay ${usersWithRole.length} usuario(s) asignado(s) (${sample}${extra}). Reasígnalos a otro rol antes de eliminar.`,
        );
      }

      await this.knex('role_permissions').where({ id, tenant_id: tenantId }).del();
      return { success: true };
    }

    // Catálogo genérico: chequear referencias antes de hard-delete.
    const existing = await this.knex('catalogs')
      .where({ catalog_id: type, id })
      .first();
    if (!existing) {
      throw new NotFoundException('Elemento paramétrico no encontrado');
    }

    if (SCORING_TYPES.includes(type)) {
      const referenced = await this.isReferenced(type, {
        id: existing.id,
        value: existing.value,
      });
      if (referenced) {
        // Soft-delete: marcar inactivo y preservar el historial.
        await this.knex('catalogs')
          .where({ catalog_id: type, id })
          .update({
            deleted_at: this.knex.fn.now(),
            updated_by: requesterId,
            updated_at: this.knex.fn.now(),
          });
        await this.safeRecalcularScoreMaximo(type);
        return {
          success: true,
          soft_deleted: true,
          message:
            'El ítem está referenciado en capturas o en la versión activa de scoring; se marcó como inactivo para preservar el historial.',
        };
      }
    }

    await this.knex('catalogs').where({ catalog_id: type, id }).del();

    if (SCORING_TYPES.includes(type)) {
      await this.safeRecalcularScoreMaximo(type);
    }

    return { success: true, soft_deleted: false };
  }

  /**
   * Cuenta cuántos `users`, `stores` y `rutas` referencian la zona dada.
   * Lo usamos para decidir entre hard-delete y soft-delete, y para armar un
   * mensaje informativo al cliente cuando hay refs.
   */
  private async getZoneReferences(zoneId: string): Promise<{
    users: number;
    stores: number;
    routes: number;
  }> {
    const [usersRow, storesRow, routesRow] = await Promise.all([
      this.knex('users').where({ zona_id: zoneId }).count('* as c').first(),
      this.knex('stores').where({ zona_id: zoneId }).count('* as c').first(),
      this.knex('catalogs')
        .where({ catalog_id: 'rutas', parent_id: zoneId })
        .count('* as c')
        .first(),
    ]);
    return {
      users: Number(usersRow?.c) || 0,
      stores: Number(storesRow?.c) || 0,
      routes: Number(routesRow?.c) || 0,
    };
  }

  /**
   * ¿El ítem está referenciado por capturas históricas o por la versión
   * activa de scoring? Se usa para decidir entre hard-delete y soft-delete.
   *
   * Para `niveles` también busca el legacy: capturas viejas que llegaban
   * solo con `nivelEjecucion` (string) en lugar del UUID, y la rúbrica
   * activa en `scoring_weights` que referencia por `nombre`.
   */
  private async isReferenced(
    type: string,
    item: { id: string; value: string },
  ): Promise<boolean> {
    const field = CAPTURE_FIELD_BY_TYPE[type];
    if (!field) return false;

    // Capturas históricas por UUID
    const containmentId = JSON.stringify([{ [field]: item.id }]);
    const captureById = await this.knex('daily_captures')
      .whereRaw('exhibiciones @> ?::jsonb', [containmentId])
      .select('id')
      .first();
    if (captureById) return true;

    if (type === 'niveles') {
      // Capturas legacy: solo `nivelEjecucion` string sin UUID. El backfill
      // de daily-captures las resuelve por nombre; borrar el catálogo aquí
      // dejaría a esas capturas sin referencia viable.
      const containmentName = JSON.stringify([{ nivelEjecucion: item.value }]);
      const captureByName = await this.knex('daily_captures')
        .whereRaw('exhibiciones @> ?::jsonb', [containmentName])
        .select('id')
        .first();
      if (captureByName) return true;

      // Rúbrica activa: scoring_weights guarda niveles por `nombre` (string,
      // no UUID). Borrar el nivel rompería el peso de la rúbrica.
      const peso = await this.knex('scoring_weights')
        .where({ tipo: 'ejecucion' })
        .andWhereRaw('LOWER(nombre) = LOWER(?)', [item.value])
        .select('id')
        .first();
      if (peso) return true;
    }

    // Versión activa de scoring (combinaciones_validas para conceptos/ubicaciones).
    // La tabla no existe en el schema multi-tenant — guard defensivo evita 500
    // mientras se decide si restaurarla o reemplazarla por otro modelo.
    if (type === 'conceptos' || type === 'ubicaciones') {
      const col = type === 'conceptos' ? 'exhibicion_id' : 'posicion_id';
      try {
        const combo = await this.knex('combinaciones_validas')
          .where({ [col]: item.id, activo: true })
          .select('id')
          .first();
        if (combo) return true;
      } catch (err: any) {
        if (err?.code !== '42P01') throw err;
      }

      // Conceptos/ubicaciones también pueden estar en scoring_weights por nombre.
      const tipoMap: Record<string, string> = {
        conceptos: 'exhibicion',
        ubicaciones: 'posicion',
      };
      const peso = await this.knex('scoring_weights')
        .where({ tipo: tipoMap[type] })
        .andWhereRaw('LOWER(nombre) = LOWER(?)', [item.value])
        .select('id')
        .first();
      if (peso) return true;
    }

    return false;
  }

  /**
   * Detecta colisiones case-insensitive en el catálogo. Necesario porque la
   * unique constraint actual `(catalog_id, value)` es case-sensitive, pero
   * el backfill de niveles (y la UX en general) son case-insensitive.
   */
  private async checkCaseInsensitiveDuplicate(
    type: string,
    value: string,
    excludeId?: string,
  ): Promise<void> {
    const query = this.knex('catalogs')
      .where({ catalog_id: type })
      .andWhereRaw('LOWER(value) = LOWER(?)', [value])
      .select('id', 'value');
    if (excludeId) query.andWhereNot({ id: excludeId });

    const conflict = await query.first();
    if (conflict) {
      throw new ConflictException(
        `Ya existe un elemento con el valor "${conflict.value}" (coincide ignorando mayúsculas/minúsculas).`,
      );
    }
  }

  async update(
    type: string,
    id: string,
    data: UpdateCatalogItemDto,
    requesterId?: string,
  ) {
    if (type === 'zonas' || type === 'zones') {
      const existing = await this.knex('zones').where({ id }).first();
      if (!existing) throw new NotFoundException('Zona no encontrada');

      const isRename =
        data.value !== undefined && data.value !== existing.name;

      if (isRename && existing.is_system) {
        throw new BadRequestException(
          `La zona "${existing.name}" es del sistema (semilla) y no puede renombrarse. Está referenciada por código y seeds.`,
        );
      }

      // Case-insensitive uniqueness check al renombrar.
      if (isRename) {
        const conflict = await this.knex('zones')
          .whereRaw('LOWER(name) = LOWER(?)', [data.value!])
          .andWhereNot({ id })
          .first();
        if (conflict) {
          throw new ConflictException(
            `Ya existe una zona con el nombre "${conflict.name}".`,
          );
        }
      }

      const updateData: Record<string, any> = {};
      if (data.value !== undefined) updateData.name = data.value;
      if (data.orden !== undefined) updateData.orden = data.orden;
      if (data.activo !== undefined) {
        updateData.deleted_at = data.activo ? null : this.knex.fn.now();
      }

      if (Object.keys(updateData).length === 0) {
        return {
          id: existing.id,
          value: existing.name,
          orden: existing.orden,
          activo: existing.deleted_at === null,
          is_system: existing.is_system,
        };
      }

      updateData.updated_by = requesterId;
      updateData.updated_at = this.knex.fn.now();

      try {
        const [item] = await this.knex('zones')
          .where({ id })
          .update(updateData)
          .returning([
            'id',
            'name as value',
            'orden',
            this.knex.raw('(deleted_at IS NULL) as activo'),
            'is_system',
          ]);
        if (!item)
          throw new NotFoundException('Zona no encontrada para actualizar');

        // Propagar rename a daily_captures.zona_captura (string denormalizado).
        // Sin esto, filtros por zona en /reports y /seguimiento ignoran las
        // capturas históricas tras un rename.
        if (isRename) {
          const updated = await this.knex('daily_captures')
            .whereRaw('LOWER(TRIM(zona_captura)) = LOWER(TRIM(?))', [
              existing.name,
            ])
            .update({ zona_captura: data.value });
          if (updated > 0) {
            this.logger.log(
              `Zone rename "${existing.name}" → "${data.value}" propagated to ${updated} captures.`,
            );
          }
        }

        return item;
      } catch (error: any) {
        if (error.code === '23505') {
          throw new ConflictException(
            `Ya existe una zona con el nombre "${data.value}".`,
          );
        }
        throw error;
      }
    }

    if (type === 'roles') {
      if (data.value === undefined) {
        throw new BadRequestException('Falta el nuevo nombre del rol');
      }
      // Canónico en minúscula (ver create): evita variantes de case que rompen
      // la resolución de permisos.
      const newName = (data.value || '').trim().toLowerCase();
      if (!newName) {
        throw new BadRequestException('El nombre del rol no puede estar vacío');
      }

      // tenant_id EXPLÍCITO: KNEX_CONNECTION no es RLS-scoped (ver delete/update).
      const tenantId = this.tenantCtx.requireTenantId();
      const existing = await this.knex('role_permissions')
        .where({ id, tenant_id: tenantId })
        .first();
      if (!existing) {
        throw new NotFoundException('Rol no encontrado para actualizar');
      }

      if (isSystemRole(existing.role_name)) {
        throw new BadRequestException(
          `El rol "${existing.role_name}" es un rol del sistema y no puede renombrarse.`,
        );
      }

      if (existing.role_name === newName) {
        return {
          id: existing.id,
          value: existing.role_name,
          is_system: isSystemRole(existing.role_name),
        };
      }

      const usersWithRole = await this.knex('users')
        .where({ role_name: existing.role_name, tenant_id: tenantId })
        .select('username');

      if (usersWithRole.length > 0) {
        const sample = usersWithRole
          .slice(0, 5)
          .map((u) => u.username)
          .join(', ');
        const extra =
          usersWithRole.length > 5 ? ` y ${usersWithRole.length - 5} más` : '';
        throw new ConflictException(
          `No se puede renombrar el rol "${existing.role_name}": hay ${usersWithRole.length} usuario(s) asignado(s) (${sample}${extra}). Reasígnalos a otro rol antes de renombrar.`,
        );
      }

      try {
        const [item] = await this.knex('role_permissions')
          .where({ id, tenant_id: tenantId })
          .update({ role_name: newName })
          .returning(['id', 'role_name as value']);
        // Renombrar el rol deja usuarios con el role_name viejo huérfanos de
        // permisos; hoy sólo se permite con 0 usuarios asignados, así que no hay
        // cache que invalidar por usuarios activos. Se invalida por prolijidad.
        this.permsCache.invalidate(existing.role_name, tenantId);
        return { ...item, is_system: isSystemRole(item.value) };
      } catch (error: any) {
        if (error.code === '23505') {
          throw new ConflictException(
            `Ya existe un rol con el nombre "${newName}"`,
          );
        }
        throw error;
      }
    }

    // Catálogo genérico: construir updateData solo con keys efectivamente
    // presentes — evita sobreescribir `value`/`orden` con `undefined`.
    const updateData: Record<string, any> = {};
    if (data.value !== undefined) updateData.value = data.value;
    if (data.orden !== undefined) updateData.orden = data.orden;
    if (data.icono !== undefined) updateData.icono = data.icono;
    if (data.puntuacion !== undefined) updateData.puntuacion = data.puntuacion;
    if (data.parent_id !== undefined) updateData.parent_id = data.parent_id;
    if (data.activo !== undefined) {
      updateData.deleted_at = data.activo ? null : this.knex.fn.now();
    }

    // Para tipos de scoring: si el rename colisiona case-insensitive con
    // otro item, abortar (importante para que el backfill por nombre no
    // ambiguo deje de resolver).
    if (SCORING_TYPES.includes(type) && data.value !== undefined) {
      await this.checkCaseInsensitiveDuplicate(type, data.value, id);
    }

    if (Object.keys(updateData).length === 0) {
      const existing = await this.knex('catalogs')
        .where({ catalog_id: type, id })
        .first();
      if (!existing)
        throw new NotFoundException(
          'Elemento paramétrico no encontrado para actualizar',
        );
      return existing;
    }

    updateData.updated_by = requesterId;
    updateData.updated_at = this.knex.fn.now();

    try {
      const [item] = await this.knex('catalogs')
        .where({ catalog_id: type, id })
        .update(updateData)
        .returning('*');

      if (!item)
        throw new NotFoundException(
          'Elemento paramétrico no encontrado para actualizar',
        );

      if (
        SCORING_TYPES.includes(type) &&
        (data.puntuacion !== undefined || data.activo !== undefined)
      ) {
        await this.safeRecalcularScoreMaximo(type);
      }

      return item;
    } catch (error: any) {
      if (error.code === '23505') {
        throw new ConflictException(
          `Ya existe un elemento con el valor "${data.value}" en este catálogo`,
        );
      }
      throw error;
    }
  }

  /**
   * Recalcula score_maximo y loggea (no propaga) los errores: el cliente
   * recibe success del CRUD aunque el recalc falle, y el log permite
   * auditarlo en backend.
   */
  private async safeRecalcularScoreMaximo(triggerType: string) {
    try {
      const activeVersion = await this.scoringV2Service.getActiveVersion();
      if (!activeVersion) return;

      // El recálculo es best-effort: si falla, NO debe abortar la trx de la
      // request (que ya tiene el create/update/delete del catálogo pendiente de
      // commit) y provocar un rollback silencioso. Lo corremos en un savepoint
      // sobre la misma trx. recalcularScoreMaximo usa su propio `this.knex`
      // (proxy → CLS), así que re-scopeamos el CLS al savepoint para que sus
      // queries caigan ahí y vean el cambio de catálogo aún sin commitear.
      const store = legacyTxStorage.getStore();
      if (store?.tx) {
        await store.tx.transaction((sp) =>
          legacyTxStorage.run({ tx: sp, tenantId: store.tenantId }, () =>
            this.scoringV2Service.recalcularScoreMaximo(activeVersion.id),
          ),
        );
      } else {
        await this.scoringV2Service.recalcularScoreMaximo(activeVersion.id);
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to recompute score_maximo after ${triggerType} change: ${err.message}`,
        err.stack,
      );
    }
  }

  // --- Funciones Dinámicas para Roles ---

  /**
   * Devuelve los permisos del rol. **NO** crea el registro si no existe
   * (eliminado side-effect en GET): si el rol no está en la tabla,
   * lanza 404. Los roles se crean explícitamente vía `create('roles', ...)`.
   */
  async getRolePermissions(roleName: string) {
    // tenant_id EXPLÍCITO: sin él, `.first()` sobre el mismo role_name en
    // varios tenants es no-determinista (UNIQUE tenant_id, role_name) → un
    // tenant podía leer/editar los permisos de otro. KNEX_CONNECTION no aplica
    // RLS. Mismo blindaje que PermissionsCacheService (incidente 2026-06-16).
    const tenantId = this.tenantCtx.requireTenantId();
    const role = await this.knex('role_permissions as rp')
      .leftJoin('users as u', 'u.id', 'rp.updated_by')
      .where('rp.role_name', roleName)
      .where('rp.tenant_id', tenantId)
      .select('rp.*', 'u.username as updated_by_username')
      .first();
    if (!role) {
      throw new NotFoundException(`Rol "${roleName}" no encontrado.`);
    }
    return role;
  }

  /**
   * Actualiza los permisos JSONB de un rol existente.
   *
   * Validaciones:
   *   - Whitelist contra el enum `Permission`: claves desconocidas o valores
   *     no-boolean se descartan silenciosamente.
   *   - Anti-escalation: el editor solo puede otorgar permisos elevados
   *     (`REPORTES_VER_GLOBAL`, `ROLES_CONFIGURAR`) si él mismo los tiene
   *     habilitados. Sin esto, alguien con `ROLES_CONFIGURAR` podría darse
   *     `manage:all` editando su propio rol.
   *   - El rol debe existir (sin auto-create).
   *   - Audit: setea `updated_by` y `updated_at`.
   */
  async updateRolePermissions(
    roleName: string,
    incoming: Record<string, boolean | undefined>,
    requester?: {
      sub?: string;
      role_name?: string;
      permissions?: Record<string, boolean>;
    },
  ) {
    // tenant_id EXPLÍCITO en TODAS las queries: KNEX_CONNECTION no es RLS-scoped
    // y el mismo role_name existe por tenant. Sin esto un editor podía leer y
    // sobrescribir el rol homónimo de otro tenant.
    const tenantId = this.tenantCtx.requireTenantId();
    const existing = await this.knex('role_permissions')
      .where({ role_name: roleName, tenant_id: tenantId })
      .first();
    if (!existing) {
      throw new NotFoundException(`Rol "${roleName}" no encontrado.`);
    }

    // Guardrail: el rol `superadmin` nunca debe poder editarse vía este
    // endpoint. Si alguien (incluido otro superadmin por error) postea un set
    // parcial al rol `superadmin`, queda con permisos de un rol menor y se
    // pierde el acceso al panel. La única forma legítima de modificar al
    // superadmin es vía migración o directamente en DB.
    if (roleName.toLowerCase() === 'superadmin') {
      throw new ForbiddenException(
        'El rol "superadmin" no puede modificarse desde la UI. Si necesitas ajustar permisos del superadmin, hazlo vía migración.',
      );
    }

    const previousPerms: Record<string, boolean> = existing.permissions || {};
    const requesterPerms: Record<string, boolean> = requester?.permissions || {};
    const isRequesterSuperadmin =
      requester?.role_name?.toLowerCase() === 'superadmin';

    // Whitelist: solo aceptar keys del enum Permission con value boolean.
    const sanitized: Record<string, boolean> = {};
    const droppedKeys: string[] = [];
    for (const [key, value] of Object.entries(incoming || {})) {
      if (!VALID_PERMISSION_KEYS.has(key) || typeof value !== 'boolean') {
        droppedKeys.push(key);
        continue;
      }
      sanitized[key] = value;
    }
    if (droppedKeys.length > 0) {
      this.logger.warn(
        `Dropped ${droppedKeys.length} unknown permission keys from update of "${roleName}": ${droppedKeys.join(', ')}`,
      );
    }

    // Anti-escalation (least-privilege): el editor solo puede OTORGAR permisos
    // que él mismo posee. Quitar permisos siempre es válido. Superadmin pasa
    // libre. Sin esto, alguien con ROLES_CONFIGURAR podía concederse cualquier
    // permiso (USUARIOS_GESTIONAR, *_GESTIONAR comercial/logística, etc.).
    if (!isRequesterSuperadmin) {
      const illegalGrants = Object.keys(sanitized).filter(
        (key) =>
          sanitized[key] === true &&
          previousPerms[key] !== true &&
          requesterPerms[key] !== true,
      );
      if (illegalGrants.length > 0) {
        throw new ForbiddenException(
          `No puedes otorgar permisos que tu rol no tiene: ${illegalGrants.join(
            ', ',
          )}. Pide a un superadmin que los habilite.`,
        );
      }
    }

    const [role] = await this.knex('role_permissions')
      .where({ role_name: roleName, tenant_id: tenantId })
      .update({
        permissions: sanitized,
        updated_by: requester?.sub,
        updated_at: this.knex.fn.now(),
      })
      .returning('*');

    // Invalida el cache para que el cambio se vea en el SIGUIENTE request
    // de cualquier usuario con este rol — sin requerir logout/login.
    this.permsCache.invalidate(roleName, tenantId);

    this.logger.log(
      `Permissions updated for role "${roleName}" by ${requester?.sub ?? 'unknown'}`,
    );
    return role;
  }
}
