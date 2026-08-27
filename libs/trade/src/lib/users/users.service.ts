import {
  BadRequestException,
  Logger,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcryptjs';
import { getDataScope, TenantContextService } from '@megadulces/platform-core';

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
      .select('code', 'name', 'org_labels', 'orden');
  }
}
