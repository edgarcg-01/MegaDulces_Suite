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
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { ScoringV2Service } from '../scoring/scoring-v2.service';
import { Permission } from '../../shared/constants/permissions';
import { PermissionsCacheService } from '../../shared/ability/permissions-cache.service';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto';

const SYSTEM_ROLES: readonly string[] = [
  'superadmin',
  'supervisor',
  'supervisor_ventas',
  'jefe_marketing',
  'colaborador',
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
 * Permisos que dan acceso elevado y que requieren que el editor ya los
 * tenga para poder otorgarlos (anti-escalation). Si la lista crece, vale la
 * pena moverla a configuración compartida con el frontend.
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

const isSystemRole = (name: string) => SYSTEM_ROLES.includes(name);

@Injectable()
export class CatalogsService {
  private readonly logger = new Logger(CatalogsService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly scoringV2Service: ScoringV2Service,
    private readonly permsCache: PermissionsCacheService,
  ) {}

  async getByType(type: string, parentId?: string, includeInactive = false) {
    if (type === 'zonas' || type === 'zones') {
      const query = this.knex('zones')
        .orderBy('orden', 'asc')
        .select(
          'id',
          'name as value',
          'orden',
          'activo',
          'is_system',
          'updated_at',
          'created_by',
          'updated_by',
        );
      if (!includeInactive) {
        query.where({ activo: true });
      }
      return query;
    }

    if (type === 'roles') {
      const roles = await this.knex('role_permissions')
        .orderBy('role_name', 'asc')
        .select('id', 'role_name as value');
      return roles.map((r) => ({ ...r, is_system: isSystemRole(r.value) }));
    }

    const query = this.knex('catalogs')
      .where({ catalog_id: type })
      .orderBy('orden', 'asc');

    if (!includeInactive) {
      query.where({ activo: true });
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
            name: data.value,
            orden: data.orden ?? 0,
            activo: true,
            created_by: requesterId,
            updated_by: requesterId,
          })
          .returning(['id', 'name as value', 'orden', 'activo', 'is_system']);
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
      const name = (data.value || '').trim();
      if (!name) {
        throw new BadRequestException('El nombre del rol no puede estar vacío');
      }
      try {
        const [item] = await this.knex('role_permissions')
          .insert({
            id: randomUUID(),
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
          activo: false,
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
      const existing = await this.knex('role_permissions').where({ id }).first();
      if (!existing) {
        throw new NotFoundException('Rol no encontrado');
      }

      if (isSystemRole(existing.role_name)) {
        throw new BadRequestException(
          `El rol "${existing.role_name}" es un rol del sistema y no puede eliminarse.`,
        );
      }

      const usersWithRole = await this.knex('users')
        .where({ role_name: existing.role_name })
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

      await this.knex('role_permissions').where({ id }).del();
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
            activo: false,
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
   * activa en `scoring_pesos` que referencia por `nombre`.
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

      // Rúbrica activa: scoring_pesos guarda niveles por `nombre` (string,
      // no UUID). Borrar el nivel rompería el peso de la rúbrica.
      const peso = await this.knex('scoring_pesos')
        .where({ tipo: 'ejecucion' })
        .andWhereRaw('LOWER(nombre) = LOWER(?)', [item.value])
        .select('id')
        .first();
      if (peso) return true;
    }

    // Versión activa de scoring (combinaciones_validas para conceptos/ubicaciones).
    if (type === 'conceptos' || type === 'ubicaciones') {
      const col = type === 'conceptos' ? 'exhibicion_id' : 'posicion_id';
      const combo = await this.knex('combinaciones_validas')
        .where({ [col]: item.id, activo: true })
        .select('id')
        .first();
      if (combo) return true;

      // Conceptos/ubicaciones también pueden estar en scoring_pesos por nombre.
      const tipoMap: Record<string, string> = {
        conceptos: 'exhibicion',
        ubicaciones: 'posicion',
      };
      const peso = await this.knex('scoring_pesos')
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
      if (data.activo !== undefined) updateData.activo = data.activo;

      if (Object.keys(updateData).length === 0) {
        return {
          id: existing.id,
          value: existing.name,
          orden: existing.orden,
          activo: existing.activo,
          is_system: existing.is_system,
        };
      }

      updateData.updated_by = requesterId;
      updateData.updated_at = this.knex.fn.now();

      try {
        const [item] = await this.knex('zones')
          .where({ id })
          .update(updateData)
          .returning(['id', 'name as value', 'orden', 'activo', 'is_system']);
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
      const newName = (data.value || '').trim();
      if (!newName) {
        throw new BadRequestException('El nombre del rol no puede estar vacío');
      }

      const existing = await this.knex('role_permissions').where({ id }).first();
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
        .where({ role_name: existing.role_name })
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
          .where({ id })
          .update({ role_name: newName })
          .returning(['id', 'role_name as value']);
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
    if (data.activo !== undefined) updateData.activo = data.activo;

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
      if (activeVersion) {
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
    const role = await this.knex('role_permissions')
      .where({ role_name: roleName })
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
    const existing = await this.knex('role_permissions')
      .where({ role_name: roleName })
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

    // Anti-escalation: chequear que el editor solo OTORGA permisos elevados
    // que él mismo posee. Quitarlos siempre es válido. Superadmin pasa libre.
    if (!isRequesterSuperadmin) {
      for (const elevated of ELEVATED_PERMISSIONS) {
        const willGrant =
          sanitized[elevated] === true && previousPerms[elevated] !== true;
        if (willGrant && !requesterPerms[elevated]) {
          throw new ForbiddenException(
            `No puedes otorgar el permiso "${elevated}" porque tu rol no lo tiene. Pide a un superadmin que lo habilite.`,
          );
        }
      }
    }

    const [role] = await this.knex('role_permissions')
      .where({ role_name: roleName })
      .update({
        permissions: sanitized,
        updated_by: requester?.sub,
        updated_at: this.knex.fn.now(),
      })
      .returning('*');

    // Invalida el cache para que el cambio se vea en el SIGUIENTE request
    // de cualquier usuario con este rol — sin requerir logout/login.
    this.permsCache.invalidate(roleName);

    this.logger.log(
      `Permissions updated for role "${roleName}" by ${requester?.sub ?? 'unknown'}`,
    );
    return role;
  }
}
