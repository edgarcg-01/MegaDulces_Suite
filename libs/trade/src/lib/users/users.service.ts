import {
  BadRequestException,
  Logger,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcryptjs';
import { getDataScope, TenantContextService, PermissionsCacheService } from '@megadulces/platform-core';

interface RequesterContext {
  sub: string;
  /** Se asienta en la bitácora: un uuid solo no dice quién fue. */
  username?: string;
  rules?: unknown[];
}

const ELEVATED_ROLES = new Set(['superadmin', 'admin']);

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    // `[ID.13]` Optional: el cache vive en platform-core y este service se
    // instancia en tests sin él. Sin cache el complemento tarda el TTL (30s)
    // en verse; con cache se ve al instante.
    @Optional() private readonly permsCache?: PermissionsCacheService,
  ) {}

  /**
   * Tenant del request. TODAS las queries de este service lo necesitan
   * EXPLÍCITO: `KNEX_CONNECTION` conecta como superusuario de Postgres, y un
   * superusuario bypassea RLS incluso con FORCE ROW LEVEL SECURITY. Sin el
   * filtro, este service veía y escribía el padrón de todos los tenants.
   */
  private get tenantId(): string {
    return this.tenantCtx.requireTenantId();
  }

  private async resolveZonaId(zonaName?: string): Promise<string | null> {
    if (!zonaName) return null;
    const zone = await this.knex('zones')
      .where({ name: zonaName, tenant_id: this.tenantId })
      .select('id')
      .first();
    return zone ? zone.id : null;
  }

  /**
   * `[ID.7]` — La zona llega por tres nombres y hay que quedarse con uno.
   *
   * `zone_id` es el canónico; `zona_id` y `zona` son alias deprecados que se
   * siguen aceptando para no romper al frontend actual. La precedencia es
   * explícita (uuid canónico → uuid viejo → nombre resuelto) en vez de quedar
   * al azar del orden de las propiedades del body.
   *
   * Devuelve `undefined` cuando NINGUNO vino, para poder distinguir en el
   * update "no lo mandes" de "ponelo en null" (desasignar zona).
   */
  private async resolveZoneRef(dto: {
    zone_id?: string;
    zona_id?: string;
    zona?: string;
  }): Promise<string | null | undefined> {
    if (dto.zone_id) return dto.zone_id;
    if (dto.zona_id) return dto.zona_id;
    if (dto.zona !== undefined) return this.resolveZonaId(dto.zona);
    return undefined;
  }

  /**
   * `[ID.8]` — Asienta un cambio en `identity.user_events`.
   *
   * Es append-only y **nunca hace fallar la operación**: si la bitácora se cae,
   * el alta o el cambio de rol ya se hizo, y perder el asiento es mucho menos
   * grave que dejar la operación a medias. El error se loguea, no se propaga.
   *
   * Se le pasa la trx cuando hay una abierta, para que el asiento viva o muera
   * con la operación que describe.
   */
  private async recordEvent(
    trx: Knex | Knex.Transaction,
    userId: string,
    event: string,
    detalle: Record<string, unknown>,
    requester: RequesterContext,
  ): Promise<void> {
    try {
      await trx('identity.user_events').insert({
        tenant_id: this.tenantId,
        user_id: userId,
        event,
        detalle: JSON.stringify(detalle),
        actor_user_id: requester.sub ?? null,
        actor_username: requester.username ?? null,
      });
    } catch (e) {
      this.logger.warn(
        `No se pudo asentar el evento "${event}" del usuario ${userId}: ${(e as Error).message}`,
      );
    }
  }

  /** Nombre de la zona a partir del uuid, para las respuestas de escritura. */
  private async zoneNameOf(zonaId?: string | null): Promise<string | null> {
    if (!zonaId) return null;
    const z = await this.knex('zones')
      .where({ id: zonaId, tenant_id: this.tenantId })
      .select('name')
      .first();
    return z?.name ?? null;
  }

  private normalizeUsername(username: string): string {
    return username.toLowerCase().trim();
  }

  /**
   * Anti-escalation: solo un superadmin puede otorgar roles elevados
   * (superadmin/admin). Cualquier intento de elevar a alguien desde un rol
   * no-superadmin es rechazado.
   */
  private async assertCanAssignRole(
    targetRole: string,
    requester: RequesterContext,
  ): Promise<void> {
    const normalized = targetRole.toLowerCase();
    if (!ELEVATED_ROLES.has(normalized)) return;

    const requesterRow = await this.knex('users')
      .where({ id: requester.sub, tenant_id: this.tenantId })
      .select('role_name')
      .first();
    const requesterRole = (requesterRow?.role_name ?? '').toLowerCase();
    if (requesterRole !== 'superadmin') {
      throw new ForbiddenException(
        `Solo un superadmin puede asignar el rol "${normalized}".`,
      );
    }
  }

  /**
   * Bloquea el caso de dejar al sistema sin ningún superadmin activo.
   * Se invoca antes de degradar de rol o desactivar.
   */
  private async assertNotLastSuperadmin(
    userId: string,
    nextActive: boolean,
    nextRole: string | undefined,
  ): Promise<void> {
    const current = await this.knex('users')
      .where({ id: userId, tenant_id: this.tenantId })
      .select('role_name', 'activo')
      .first();
    if (!current) return;

    const wasSuperadmin =
      (current.role_name ?? '').toLowerCase() === 'superadmin' &&
      current.activo === true;
    if (!wasSuperadmin) return;

    const willStaySuperadmin =
      nextActive !== false &&
      (nextRole === undefined ||
        nextRole.toLowerCase() === 'superadmin');
    if (willStaySuperadmin) return;

    // El cambio degradaría/desactivaría a un superadmin. Verificar que
    // queda al menos otro superadmin activo.
    const otherActive = await this.knex('users')
      .where({ role_name: 'superadmin', activo: true, tenant_id: this.tenantId })
      .andWhereNot({ id: userId })
      .count<{ count: string }>('id as count')
      .first();
    const otherCount = Number(otherActive?.count ?? 0);
    if (otherCount === 0) {
      throw new BadRequestException(
        'No puedes desactivar o degradar al último superadmin activo del sistema.',
      );
    }
  }

  /**
   * Valida los códigos de catálogo del usuario contra la DB ANTES de escribir.
   * Sin esto la FK compuesta tira 23503 y el handler lo convierte en un 500: el
   * admin veía "Error al actualizar usuario" sin motivo y quedaba un error de
   * servidor en el log por un dato de entrada inválido.
   *
   * `warehouse_code` se sumó acá y se le quitó el `@Matches(/^[0-9]{2}$/)` del
   * DTO: el regex validaba FORMA, no EXISTENCIA — aceptaba `'99'` feliz. Con el
   * default de alcance en `own` desde `[ID.3]`, una sucursal mal escrita ya no
   * es cosmética: deja al usuario sin ver nada y sin pista de por qué.
   */
  private async assertOrgCodes(
    departmentCode?: string | null,
    positionCode?: string | null,
    warehouseCode?: string | null,
  ): Promise<void> {
    if (warehouseCode) {
      const wh = await this.knex('commercial.warehouses')
        .where({ tenant_id: this.tenantId, code: warehouseCode })
        .whereNull('deleted_at')
        .select('code')
        .first();
      if (!wh) {
        throw new BadRequestException(
          `La sucursal "${warehouseCode}" no existe en el catálogo de almacenes.`,
        );
      }
    }
    if (departmentCode) {
      const dep = await this.knex('identity.departments')
        .where({ tenant_id: this.tenantId, code: departmentCode })
        .whereNull('deleted_at')
        .select('code')
        .first();
      if (!dep) {
        throw new BadRequestException(
          `El departamento "${departmentCode}" no existe.`,
        );
      }
    }
    if (positionCode) {
      const pos = await this.knex('identity.positions')
        .where({ tenant_id: this.tenantId, code: positionCode })
        .whereNull('deleted_at')
        .select('code')
        .first();
      if (!pos) {
        throw new BadRequestException(`El puesto "${positionCode}" no existe.`);
      }
    }
  }

  async create(createUserDto: CreateUserDto, requester: RequesterContext) {
    // `zone_id`/`zona_id`/`zona` salen del rest: los tres colapsan en una sola
    // columna y la precedencia la decide `resolveZoneRef`.
    const {
      password,
      zona: _zonaLegacy,
      zona_id: _zonaIdLegacy,
      zone_id: _zoneId,
      role_name,
      username,
      ...rest
    } = createUserDto;

    await this.assertCanAssignRole(role_name, requester);
    await this.assertOrgCodes(
      createUserDto.department_code,
      createUserDto.position_code,
      createUserDto.warehouse_code,
    );

    const normalizedUsername = this.normalizeUsername(username);

    const existing = await this.knex('users')
      .where({ username: normalizedUsername, tenant_id: this.tenantId })
      .select('id')
      .first();
    if (existing) {
      throw new ConflictException(
        `El nombre de usuario "${normalizedUsername}" ya está en uso.`,
      );
    }

    const password_hash = await bcrypt.hash(password, 10);
    const zona_id = (await this.resolveZoneRef(createUserDto)) ?? null;
    const normalizedRoleName = role_name.toLowerCase();

    const [user] = await this.knex('users')
      .insert({
        ...rest,
        tenant_id: this.tenantCtx.requireTenantId(),
        zona_id,
        password_hash,
        role_name: normalizedRoleName,
        username: normalizedUsername,
        updated_by: requester.sub,
        created_by: requester.sub,
        // `[ID.8]` La contraseña la eligió OTRO (el admin que da el alta), así
        // que el dueño tiene que cambiarla. `created_by` además deja de estar
        // vacío: en prod estaba en NULL para los 117 usuarios.
        password_changed_at: this.knex.fn.now(),
        must_change_password: true,
      })
      .returning([
        'id',
        'username',
        'nombre',
        'zona_id',
        'role_name',
        'activo',
        'supervisor_id',
        'created_at',
      ]);

    // El nombre de la zona se resuelve del uuid que quedó guardado: ya no hay
    // una variable `zona` en scope (los tres alias colapsaron en `[ID.7]`) y
    // devolver el que mandó el cliente sería devolverle su propio input.
    return { ...user, zona: await this.zoneNameOf(zona_id) };
  }

  async findAll(
    zona: string | undefined,
    activo: string | undefined,
    requester: RequesterContext,
  ) {
    const jsDay = new Date().getDay();
    const dow = jsDay === 0 ? 7 : jsDay;

    const knex = this.knex;
    const query = knex('users as u')
      .where('u.tenant_id', this.tenantId)
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .leftJoin('daily_assignments as da', function () {
        this.on('da.user_id', '=', 'u.id');
        this.on('da.day_of_week', '=', knex.raw('?', [dow]));
      })
      .leftJoin('catalogs as cr', function () {
        this.on('cr.id', '=', 'da.route_id');
        this.on('cr.catalog_id', '=', knex.raw("'rutas'"));
      })
      // Ejes organizacionales (Fase UN): el departamento y el puesto son dato
      // real de la fila, ya no se infieren del role_name en el frontend.
      .leftJoin('identity.departments as dp', function () {
        this.on('dp.tenant_id', '=', 'u.tenant_id');
        this.on('dp.code', '=', 'u.department_code');
      })
      .leftJoin('identity.positions as ps', function () {
        this.on('ps.tenant_id', '=', 'u.tenant_id');
        this.on('ps.code', '=', 'u.position_code');
      })
      .select(
        'u.id',
        'u.username',
        'u.nombre',
        'z.name as zona',
        'u.zona_id',
        'u.role_name',
        'u.activo',
        'u.supervisor_id',
        'u.warehouse_code',
        'u.department_code',
        'dp.name as department_name',
        'u.position_code',
        'ps.name as position_name',
        'u.finance_expense_area_ids',
        'u.created_at',
        'u.last_login_at',
        'u.last_login_ip',
        knex.raw(
          'CASE WHEN da.id IS NOT NULL THEN true ELSE false END as has_route_today',
        ),
        'cr.value as route_name_today',
      );

    // Scope enforcement: solo reports_global ve todo el padrón; team-scope ve
    // su equipo + sí mismo; own-scope solo a sí mismo.
    const scope = getDataScope({
      sub: requester.sub,
      rules: requester.rules as never,
    });
    if (scope.type === 'team') {
      query.where((qb) => {
        qb.where('u.supervisor_id', requester.sub).orWhere(
          'u.id',
          requester.sub,
        );
      });
    } else if (scope.type === 'own') {
      query.where('u.id', requester.sub);
    }

    if (zona) query.where('z.name', zona);
    if (activo) query.where('u.activo', activo === 'true');
    return query;
  }

  async findOne(id: string, requester: RequesterContext) {
    const user = await this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .leftJoin('identity.departments as dp', function () {
        this.on('dp.tenant_id', '=', 'u.tenant_id');
        this.on('dp.code', '=', 'u.department_code');
      })
      .leftJoin('identity.positions as ps', function () {
        this.on('ps.tenant_id', '=', 'u.tenant_id');
        this.on('ps.code', '=', 'u.position_code');
      })
      .where('u.id', id)
      .where('u.tenant_id', this.tenantId)
      .select(
        'u.id',
        'u.username',
        'u.nombre',
        'z.name as zona',
        'u.zona_id',
        'u.role_name',
        'u.activo',
        'u.supervisor_id',
        'u.supervisor_id as parent_supervisor',
        'u.warehouse_code',
        'u.department_code',
        'dp.name as department_name',
        'u.position_code',
        'ps.name as position_name',
        'u.finance_expense_area_ids',
        'u.created_at',
      )
      .first();

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }

    const scope = getDataScope({
      sub: requester.sub,
      rules: requester.rules as never,
    });
    if (scope.type === 'team') {
      const isSelf = user.id === requester.sub;
      const isDirectReport = user.parent_supervisor === requester.sub;
      if (!isSelf && !isDirectReport) {
        throw new ForbiddenException(
          'No puedes ver usuarios fuera de tu equipo.',
        );
      }
    } else if (scope.type === 'own' && user.id !== requester.sub) {
      throw new ForbiddenException('No puedes ver otros usuarios.');
    }

    return user;
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    requester: RequesterContext,
  ) {
    // Los tres nombres de zona salen del rest (colapsan en una sola columna).
    const {
      password,
      zona: _zonaLegacy,
      zona_id: _zonaIdLegacy,
      zone_id: _zoneId,
      role_name,
      username,
      activo,
      ...rest
    } = updateUserDto;

    const isSelf = id === requester.sub;

    // Anti-self-elevation / self-lockout: nadie puede cambiarse su propio
    // rol ni desactivarse a sí mismo. Estos cambios solo proceden vía un
    // tercero con permisos suficientes.
    if (isSelf && role_name !== undefined) {
      throw new ForbiddenException(
        'No puedes modificar tu propio rol.',
      );
    }
    if (isSelf && activo === false) {
      throw new ForbiddenException(
        'No puedes desactivar tu propio usuario.',
      );
    }

    if (role_name !== undefined) {
      await this.assertCanAssignRole(role_name, requester);
    }
    await this.assertOrgCodes(
      updateUserDto.department_code,
      updateUserDto.position_code,
      updateUserDto.warehouse_code,
    );

    // Defensa contra dejar al sistema sin superadmins activos.
    if (role_name !== undefined || activo !== undefined) {
      await this.assertNotLastSuperadmin(id, activo !== false, role_name);
    }

    const updateData: Record<string, unknown> = { ...rest };

    if (password) {
      updateData['password_hash'] = await bcrypt.hash(password, 10);
    }

    if (username) {
      const normalized = this.normalizeUsername(username);
      const conflict = await this.knex('users')
        .where({ username: normalized, tenant_id: this.tenantId })
        .andWhereNot({ id })
        .select('id')
        .first();
      if (conflict) {
        throw new ConflictException(
          `El nombre de usuario "${normalized}" ya está en uso.`,
        );
      }
      updateData['username'] = normalized;
    }

    // `undefined` = ninguno de los tres nombres vino → no se toca la columna.
    // `null` = vino `zona: ''` o un nombre que no existe → se desasigna. La
    // distinción importa: un PATCH que no menciona la zona no debe borrarla.
    const zoneRef = await this.resolveZoneRef(updateUserDto);
    if (zoneRef !== undefined) {
      updateData['zona_id'] = zoneRef;
    }

    if (role_name !== undefined) {
      updateData['role_name'] = role_name.toLowerCase();
    }

    if (activo !== undefined) {
      updateData['activo'] = activo;
    }

    updateData['updated_at'] = this.knex.fn.now();
    updateData['updated_by'] = requester.sub;

    const [user] = await this.knex('users')
      .where({ id, tenant_id: this.tenantId })
      .update(updateData)
      .returning([
        'id',
        'username',
        'nombre',
        'zona_id',
        'role_name',
        'activo',
        'supervisor_id',
        'created_at',
      ]);

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }

    return { ...user, zona: await this.zoneNameOf(user.zona_id) };
  }

  async remove(id: string, requester: RequesterContext) {
    if (requester.sub === id) {
      throw new ForbiddenException(
        'No puedes desactivar tu propio usuario.',
      );
    }

    await this.assertNotLastSuperadmin(id, false, undefined);

    return this.knex.transaction(async (trx) => {
      const count = await trx('users').where({ id, tenant_id: this.tenantId }).update({
        activo: false,
        deleted_at: trx.fn.now(),
        deleted_by: requester.sub,
        updated_at: trx.fn.now(),
        updated_by: requester.sub,
      });
      if (count === 0) {
        throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
      }

      const orphans = await trx('users')
        .where({ supervisor_id: id, tenant_id: this.tenantId })
        .update({ supervisor_id: null });

      return {
        message: 'El usuario ha sido desactivado (soft delete)',
        orphans_cleared: orphans,
      };
    });
  }

  async getRoles() {
    // Filtro de tenant EXPLÍCITO: `KNEX_CONNECTION` conecta como superusuario, y
    // un superusuario bypassea RLS incluso con FORCE ROW LEVEL SECURITY. Sin
    // este WHERE el endpoint devolvía los roles de TODOS los tenants (verificado:
    // 47 filas para 30 roles reales).
    return this.knex('role_permissions')
      .where({ tenant_id: this.tenantId })
      .whereNull('deleted_at')
      .select('role_name')
      .orderBy('role_name', 'asc');
  }

  async findSupervisors(zona?: string) {
    const query = this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .where('u.role_name', 'like', '%supervisor%')
      .where({ 'u.activo': true, 'u.tenant_id': this.tenantId })
      .select('u.id', 'u.nombre', 'u.username', 'z.name as zona');

    if (zona) query.where('z.name', zona);
    return query;
  }

  async findSellers(zona?: string, supervisorId?: string) {
    const query = this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .whereNotIn('u.role_name', ['supervisor_v', 'admin', 'superadmin'])
      .where({ 'u.activo': true, 'u.tenant_id': this.tenantId })
      .select(
        'u.id',
        'u.nombre',
        'u.username',
        'z.name as zona',
        'u.role_name',
        'u.supervisor_id',
      );

    if (zona) query.where('z.name', zona);
    if (supervisorId) query.where({ 'u.supervisor_id': supervisorId });

    return query;
  }

  async findBySupervisor(supervisorId: string) {
    return this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .where({ 'u.supervisor_id': supervisorId, 'u.activo': true, 'u.tenant_id': this.tenantId })
      .select('u.id', 'u.nombre', 'u.username', 'z.name as zona', 'u.role_name');
  }

  async getZones() {
    return this.knex('zones')
      .where({ tenant_id: this.tenantId })
      .orderBy('orden', 'asc')
      .select('id', 'name as value', 'orden');
  }

  /**
   * Catálogo de departamentos del organigrama (eje organizacional, Fase UN).
   * No confundir con los roles: el departamento describe dónde trabaja la
   * persona, el rol describe qué puede hacer en la app.
   */
  async getDepartments() {
    return this.knex('identity.departments')
      .where({ tenant_id: this.tenantId })
      .whereNull('deleted_at')
      .orderBy('orden', 'asc')
      .select('code', 'name', 'orden');
  }

  /**
   * Catálogo plano de puestos canonicalizados del ORGANIGRAMA 2026.
   * `org_labels` trae las etiquetas literales del PDF que se colapsaron en cada
   * puesto — útil para que el admin reconozca el puesto por como se llama en el
   * organigrama impreso.
   */
  async getPositions() {
    return this.knex('identity.positions')
      .where({ tenant_id: this.tenantId })
      .whereNull('deleted_at')
      .orderBy('orden', 'asc')
      // `[ID.15]` `department_code` y `default_role` viajan con el puesto: es lo
      // que permite que el alta PROPONGA en vez de pedirle al que da de alta que
      // adivine entre 28 roles. `default_role` puede venir NULL — hay 20 puestos
      // para los que todavía no existe un perfil que les quede.
      .select('code', 'name', 'org_labels', 'orden', 'department_code', 'default_role');
  }

  /**
   * `[ID.15]` — Lo que el sistema PROPONE para un puesto.
   *
   * El alta deja de ser "elegí un rol de esta lista larga" y pasa a ser
   * "persona + puesto + sucursal", con el departamento y el perfil ya sugeridos.
   * Ahí muere el crecimiento del catálogo: nadie inventa un rol para dar de alta
   * a alguien.
   */
  async proposeForPosition(positionCode: string) {
    const pos = await this.knex('identity.positions')
      .where({ tenant_id: this.tenantId, code: positionCode })
      .whereNull('deleted_at')
      .first('code', 'name', 'department_code', 'default_role');
    if (!pos) throw new NotFoundException(`El puesto "${positionCode}" no existe`);

    const dept = pos.department_code
      ? await this.knex('identity.departments')
          .where({ tenant_id: this.tenantId, code: pos.department_code })
          .first('code', 'name')
      : null;

    // El alcance por default NO sale del puesto: vive en `identity.role_scopes`
    // (por rol, desde `[ID.3]`). Se devuelve para que la pantalla lo muestre,
    // pero la fuente sigue siendo una sola.
    const alcance = pos.default_role
      ? await this.knex('identity.role_scopes')
          .where({ tenant_id: this.tenantId, role_name: pos.default_role })
          .orderBy('dimension')
          .select('dimension', 'mode', 'values', 'mode_write')
      : [];

    return {
      position_code: pos.code,
      position_name: pos.name,
      department_code: pos.department_code ?? null,
      department_name: dept?.name ?? null,
      role_name: pos.default_role ?? null,
      /** Sin perfil sugerido: la pantalla tiene que pedirlo explícitamente. */
      sin_perfil: !pos.default_role,
      alcance,
    };
  }

  // ═══════════════════════ [ID.9] administrable desde la UI ═══════════════════
  // Regla de Edgar: el dato operativo se administra en /admin/*, no por script.
  // Un script se justifica sólo para el backfill inicial de una fase.

  /**
   * Escribe el override de alcance de un usuario en UNA dimensión
   * (`identity.user_scopes`). Hasta acá esto sólo se podía tocar por migración.
   *
   * `mode = null` BORRA el override y el usuario vuelve al default de su rol.
   * Es distinto de `mode = 'none'`, que es "explícitamente no ve nada": uno
   * hereda, el otro decide. La UI tiene que ofrecer las dos cosas.
   */
  async setScope(
    id: string,
    dimension: string,
    dto: { mode?: string | null; values?: string[] | null; mode_write?: string | null; nota?: string | null },
    requester: RequesterContext,
  ) {
    const dim = await this.knex('identity.scope_dimensions').where({ code: dimension }).first('code', 'supports_own');
    if (!dim) throw new BadRequestException(`La dimensión de alcance "${dimension}" no existe.`);

    const user = await this.knex('users').where({ id, tenant_id: this.tenantId }).first('id', 'username');
    if (!user) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);

    const previo = await this.knex('identity.user_scopes')
      .where({ tenant_id: this.tenantId, user_id: id, dimension })
      .first('mode', 'values', 'mode_write');

    // Heredar del rol = borrar la fila propia.
    if (dto.mode == null) {
      await this.knex('identity.user_scopes')
        .where({ tenant_id: this.tenantId, user_id: id, dimension })
        .del();
      await this.recordEvent(this.knex, id, 'scope_changed', { dimension, de: previo ?? null, a: null, hereda_del_rol: true }, requester);
      return { dimension, hereda_del_rol: true };
    }

    if (dto.mode === 'own' && !dim.supports_own) {
      throw new BadRequestException(
        `La dimensión "${dimension}" no soporta "own": no hay columna propia en el usuario de la que sacar el valor.`,
      );
    }
    const values = dto.mode === 'listed' ? (dto.values ?? []).map(String).filter(Boolean) : null;
    if (dto.mode === 'listed' && !values?.length) {
      // El CHECK de la DB también lo rechaza, pero acá el mensaje es útil.
      throw new BadRequestException('Un alcance "listed" sin valores dejaría al usuario sin ver nada. Elegí valores o usá "none".');
    }

    const fila = {
      tenant_id: this.tenantId,
      user_id: id,
      dimension,
      mode: dto.mode,
      values,
      mode_write: dto.mode_write ?? null,
      nota: dto.nota ?? null,
      updated_by: requester.sub,
      updated_at: this.knex.fn.now(),
    };
    await this.knex('identity.user_scopes')
      .insert({ ...fila, created_by: requester.sub })
      .onConflict(['tenant_id', 'user_id', 'dimension'])
      .merge(fila);

    await this.recordEvent(this.knex, id, 'scope_changed', { dimension, de: previo ?? null, a: { mode: dto.mode, values, mode_write: dto.mode_write ?? null } }, requester);
    return { dimension, mode: dto.mode, values, mode_write: dto.mode_write ?? null };
  }

  /**
   * Asignación MASIVA de los ejes de control. Es lo que hacía falta para no
   * depender de un script: normalizar 116 usuarios de a uno por pantalla no es
   * viable, y por eso el dato se quedaba viejo.
   *
   * Sólo toca los campos que vengan. Valida los códigos contra su catálogo
   * (400, no 500) y asienta un evento por usuario.
   */
  async bulkAssign(
    dto: {
      user_ids: string[];
      department_code?: string | null;
      position_code?: string | null;
      warehouse_code?: string | null;
      status?: string | null;
    },
    requester: RequesterContext,
  ) {
    const ids = (dto.user_ids ?? []).filter(Boolean);
    if (!ids.length) throw new BadRequestException('Hay que seleccionar al menos un usuario.');

    await this.assertOrgCodes(dto.department_code, dto.position_code, dto.warehouse_code);

    const cambios: Record<string, unknown> = {};
    for (const k of ['department_code', 'position_code', 'warehouse_code', 'status'] as const) {
      if (dto[k] !== undefined) cambios[k] = dto[k];
    }
    if (!Object.keys(cambios).length) throw new BadRequestException('No hay ningún campo para cambiar.');

    // Nadie se cambia a sí mismo el estado en un lote: el guard de
    // auto-desactivación del update individual no aplicaría acá.
    if (cambios['status'] && ids.includes(requester.sub)) {
      throw new ForbiddenException('No puedes cambiar tu propio estado en una asignación masiva.');
    }

    return this.knex.transaction(async (trx) => {
      const afectados = await trx('users')
        .where({ tenant_id: this.tenantId })
        .whereIn('id', ids)
        .whereNull('deleted_at')
        .update({ ...cambios, updated_at: trx.fn.now(), updated_by: requester.sub })
        .returning(['id', 'username']);

      for (const u of afectados) {
        await this.recordEvent(trx, u.id, 'bulk_assigned', cambios, requester);
      }
      return { actualizados: afectados.length, campos: Object.keys(cambios), usuarios: afectados.map((u: any) => u.username) };
    });
  }

  /**
   * `[ID.13]` — Roles de un usuario: el perfil base + los complementos.
   *
   * Devuelve además el conteo de permisos de cada uno, que es lo que hace la
   * pantalla legible: "cajero (3 permisos) + captura_gastos (1)" dice mucho más
   * que dos nombres sueltos.
   */
  async roles(id: string) {
    const user = await this.knex('users')
      .where({ id, tenant_id: this.tenantId })
      .first('id', 'username', 'role_name');
    if (!user) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);

    const filas = await this.knex('identity.user_roles as ur')
      .leftJoin('identity.role_permissions as rp', function () {
        this.on('rp.tenant_id', '=', 'ur.tenant_id').andOn('rp.role_name', '=', 'ur.role_name');
      })
      .where({ 'ur.tenant_id': this.tenantId, 'ur.user_id': id })
      .orderBy([{ column: 'ur.is_primary', order: 'desc' }, { column: 'ur.role_name' }])
      .select(
        'ur.role_name',
        'ur.is_primary',
        'ur.nota',
        'ur.created_at',
        this.knex.raw(`(
          SELECT count(*) FROM jsonb_each(coalesce(rp.permissions, '{}'::jsonb)) e
           WHERE e.value = 'true'
        )::int AS permisos`),
      );

    return {
      user_id: id,
      username: user.username,
      perfil_base: user.role_name,
      roles: filas,
    };
  }

  /**
   * `[ID.13]` — Fija los COMPLEMENTOS de un usuario (el perfil base no se toca
   * acá: eso sigue siendo `role_name` en el formulario del usuario).
   *
   * Es la operación que resuelve dos cosas medidas en prod:
   *   - la encargada de sucursal que además cobra en caja no necesita una
   *     segunda cuenta con username de terminal;
   *   - `captura_gastos` (22 usuarios, 1 permiso) deja de ser un "rol" que
   *     además le pisaba el departamento a la persona.
   *
   * Recibe la lista COMPLETA de complementos deseados (semántica de PUT): lo
   * que no venga se quita. Devuelve qué se agregó y qué se quitó para que la
   * UI y la bitácora digan exactamente eso.
   */
  async setRoles(id: string, roleNames: string[], requester: RequesterContext) {
    const user = await this.knex('users')
      .where({ id, tenant_id: this.tenantId })
      .first('id', 'username', 'role_name');
    if (!user) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);

    const pedidos = Array.from(new Set((roleNames ?? []).map((r) => String(r).trim()).filter(Boolean)));

    // Los nombres se resuelven contra el catálogo (case-insensitive, igual que
    // el resto del sistema) y se guarda el CANÓNICO: la FK compuesta lo exige y
    // un rol con distinto case = 0 permisos silenciosos.
    const catalogo = await this.knex('identity.role_permissions')
      .where({ tenant_id: this.tenantId })
      .whereNull('deleted_at')
      .select('role_name');
    const porLower = new Map<string, string>(
      catalogo.map((r: { role_name: string }) => [r.role_name.toLowerCase(), r.role_name]),
    );

    const canonicos: string[] = [];
    for (const p of pedidos) {
      const c = porLower.get(p.toLowerCase());
      if (!c) throw new BadRequestException(`El rol "${p}" no existe en el catálogo.`);
      // El perfil base no se administra como complemento: si viene, se ignora
      // en silencio en vez de crear una fila que el trigger va a pelear.
      if (c.toLowerCase() !== String(user.role_name ?? '').toLowerCase()) canonicos.push(c);
    }

    const previos: string[] = await this.knex('identity.user_roles')
      .where({ tenant_id: this.tenantId, user_id: id, is_primary: false })
      .pluck('role_name');

    const agregados = canonicos.filter((c) => !previos.includes(c));
    const quitados = previos.filter((p) => !canonicos.includes(p));
    if (!agregados.length && !quitados.length) {
      return { user_id: id, complementos: canonicos, agregados: [], quitados: [] };
    }

    await this.knex.transaction(async (trx) => {
      if (quitados.length) {
        await trx('identity.user_roles')
          .where({ tenant_id: this.tenantId, user_id: id, is_primary: false })
          .whereIn('role_name', quitados)
          .del();
      }
      for (const rol of agregados) {
        const fila = {
          tenant_id: this.tenantId,
          user_id: id,
          role_name: rol,
          is_primary: false,
          updated_by: requester.sub,
          updated_at: trx.fn.now(),
        };
        await trx('identity.user_roles')
          .insert({ ...fila, created_by: requester.sub })
          .onConflict(['tenant_id', 'user_id', 'role_name'])
          .merge(fila);
      }
      await this.recordEvent(
        trx,
        id,
        'roles_changed',
        { agregados, quitados, complementos: canonicos, perfil_base: user.role_name },
        requester,
      );
    });

    // El guard cachea la LISTA de roles 30s; sin esto el complemento nuevo
    // tarda hasta medio minuto en verse y parece que no se guardó.
    this.permsCache?.invalidateUser?.(id, this.tenantId);

    return { user_id: id, complementos: canonicos, agregados, quitados };
  }

  /** Bitácora del usuario, para el panel de detalle. */
  async events(id: string, limit = 50) {
    return this.knex('identity.user_events')
      .where({ tenant_id: this.tenantId, user_id: id })
      .orderBy('created_at', 'desc')
      .limit(Math.min(200, Math.max(1, limit)))
      .select('event', 'detalle', 'actor_username', 'created_at');
  }
}
