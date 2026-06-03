import {
  BadRequestException,
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
import { getDataScope } from '@megadulces/platform-core';

interface RequesterContext {
  sub: string;
  rules?: unknown[];
}

const ELEVATED_ROLES = new Set(['superadmin', 'admin']);

@Injectable()
export class UsersService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  private async resolveZonaId(zonaName?: string): Promise<string | null> {
    if (!zonaName) return null;
    const zone = await this.knex('zones')
      .where({ name: zonaName })
      .select('id')
      .first();
    return zone ? zone.id : null;
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
      .where({ id: requester.sub })
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
      .where({ id: userId })
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
      .where({ role_name: 'superadmin', activo: true })
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

  async create(createUserDto: CreateUserDto, requester: RequesterContext) {
    const {
      password,
      zona,
      zona_id: dtoZonaId,
      role_name,
      username,
      ...rest
    } = createUserDto;

    await this.assertCanAssignRole(role_name, requester);

    const normalizedUsername = this.normalizeUsername(username);

    const existing = await this.knex('users')
      .where({ username: normalizedUsername })
      .select('id')
      .first();
    if (existing) {
      throw new ConflictException(
        `El nombre de usuario "${normalizedUsername}" ya está en uso.`,
      );
    }

    const password_hash = await bcrypt.hash(password, 10);
    const zona_id = dtoZonaId || (await this.resolveZonaId(zona));
    const normalizedRoleName = role_name.toLowerCase();

    const [user] = await this.knex('users')
      .insert({
        ...rest,
        zona_id,
        password_hash,
        role_name: normalizedRoleName,
        username: normalizedUsername,
        updated_by: requester.sub,
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

    return { ...user, zona };
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
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .leftJoin('daily_assignments as da', function () {
        this.on('da.user_id', '=', 'u.id');
        this.on('da.day_of_week', '=', knex.raw('?', [dow]));
      })
      .leftJoin('catalogs as cr', function () {
        this.on('cr.id', '=', 'da.route_id');
        this.on('cr.catalog_id', '=', knex.raw("'rutas'"));
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
      .where('u.id', id)
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
    const {
      password,
      zona,
      zona_id: dtoZonaId,
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
        .where({ username: normalized })
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

    if (dtoZonaId !== undefined) {
      updateData['zona_id'] = dtoZonaId;
    } else if (zona !== undefined) {
      updateData['zona_id'] = await this.resolveZonaId(zona);
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
      .where({ id })
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

    const zoneName =
      zona !== undefined
        ? zona
        : (
            await this.knex('zones')
              .where({ id: user.zona_id })
              .select('name')
              .first()
          )?.name;
    return { ...user, zona: zoneName };
  }

  async remove(id: string, requester: RequesterContext) {
    if (requester.sub === id) {
      throw new ForbiddenException(
        'No puedes desactivar tu propio usuario.',
      );
    }

    await this.assertNotLastSuperadmin(id, false, undefined);

    return this.knex.transaction(async (trx) => {
      const count = await trx('users').where({ id }).update({
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
        .where({ supervisor_id: id })
        .update({ supervisor_id: null });

      return {
        message: 'El usuario ha sido desactivado (soft delete)',
        orphans_cleared: orphans,
      };
    });
  }

  async getRoles() {
    return this.knex('role_permissions')
      .select('role_name')
      .orderBy('role_name', 'asc');
  }

  async findSupervisors(zona?: string) {
    const query = this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .where('u.role_name', 'like', '%supervisor%')
      .where({ 'u.activo': true })
      .select('u.id', 'u.nombre', 'u.username', 'z.name as zona');

    if (zona) query.where('z.name', zona);
    return query;
  }

  async findSellers(zona?: string, supervisorId?: string) {
    const query = this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .whereNotIn('u.role_name', ['supervisor_v', 'admin', 'superadmin'])
      .where({ 'u.activo': true })
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
      .where({ 'u.supervisor_id': supervisorId, 'u.activo': true })
      .select('u.id', 'u.nombre', 'u.username', 'z.name as zona', 'u.role_name');
  }

  async getZones() {
    return this.knex('zones')
      .orderBy('orden', 'asc')
      .select('id', 'name as value', 'orden');
  }
}
