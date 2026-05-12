import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UsersService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  private async resolveZonaId(zonaName?: string): Promise<string | null> {
    if (!zonaName) return null;
    const zone = await this.knex('zones').where({ name: zonaName }).select('id').first();
    return zone ? zone.id : null;
  }

  async create(createUserDto: CreateUserDto) {
    const { password, zona, zona_id: dtoZonaId, role_name, ...rest } = createUserDto;
    const password_hash = await bcrypt.hash(password, 10);
    
    // Use zona_id from DTO if provided, otherwise resolve by name
    const zona_id = dtoZonaId || await this.resolveZonaId(zona);
    
    console.log('[UsersService] Creating user with zona_id:', zona_id, 'zona:', zona);

    // Normalize role_name to lowercase to match role_permissions
    const normalizedRoleName = role_name ? role_name.toLowerCase() : role_name;

    const [user] = await this.knex('users')
      .insert({ ...rest, zona_id, password_hash, role_name: normalizedRoleName })
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

    // Return with zona name for compatibility
    return { ...user, zona: zona };
  }

  async findAll(zona?: string, activo?: string) {
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
        'u.role_name',
        'u.activo',
        'u.supervisor_id',
        'u.created_at',
        this.knex.raw('CASE WHEN da.id IS NOT NULL THEN true ELSE false END as has_route_today'),
        'cr.value as route_name_today'
      );

    if (zona) query.where('z.name', zona);
    if (activo) query.where('u.activo', activo === 'true');
    return query;
  }

  async findOne(id: string) {
    const user = await this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .where('u.id', id)
      .select(
        'u.id',
        'u.username',
        'u.nombre',
        'z.name as zona',
        'u.role_name',
        'u.activo',
        'u.supervisor_id',
        'u.created_at'
      )
      .first();

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }
    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    const { password, zona, zona_id: dtoZonaId, role_name, ...rest } = updateUserDto;
    const updateData: Record<string, any> = { ...rest };

    if (password) {
      updateData.password_hash = await bcrypt.hash(password, 10);
    }

    // Use zona_id from DTO if provided, otherwise resolve by name
    if (dtoZonaId !== undefined) {
      updateData.zona_id = dtoZonaId;
      console.log('[UsersService] Updating user with zona_id from DTO:', dtoZonaId);
    } else if (zona !== undefined) {
      updateData.zona_id = await this.resolveZonaId(zona);
      console.log('[UsersService] Updating user with resolved zona_id:', updateData.zona_id);
    }

    // Normalize role_name to lowercase to match role_permissions
    if (role_name) {
      updateData.role_name = role_name.toLowerCase();
    }

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

    // Map back for compatibility
    const zoneName = zona !== undefined ? zona : (await this.knex('zones').where({ id: user.zona_id }).select('name').first())?.name;
    return { ...user, zona: zoneName };
  }

  async remove(id: string) {
     const count = await this.knex('users')
      .where({ id })
      .update({ activo: false });

     if (count === 0) {
        throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
     }
     return { message: 'El usuario ha sido desactivado (soft delete)' };
  }

  async getRoles() {
    return await this.knex('role_permissions').select('role_name');
  }

  async findSupervisors(zona?: string) {
    console.log('[findSupervisors] Buscando supervisores, zona:', zona);

    const query = this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .where('u.role_name', 'like', '%supervisor%')
      .where({ 'u.activo': true })
      .select('u.id', 'u.nombre', 'u.username', 'z.name as zona');

    if (zona) {
      query.where('z.name', zona);
    }

    const result = await query;
    console.log('[findSupervisors] Encontrados:', result.length);
    return result;
  }

  async findSellers(zona?: string, supervisorId?: string) {
    console.log('[findSellers] Buscando vendedodores, zona:', zona, 'supervisorId:', supervisorId);

    const query = this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .whereNotIn('u.role_name', ['supervisor_v', 'admin', 'superadmin'])
      .where({ 'u.activo': true })
      .select('u.id', 'u.nombre', 'u.username', 'z.name as zona', 'u.role_name', 'u.supervisor_id');

    if (zona) {
      query.where('z.name', zona);
    }

    if (supervisorId) {
      query.where({ 'u.supervisor_id': supervisorId });
    }

    const result = await query;
    console.log('[findSellers] Encontrados:', result.length);
    return result;
  }

  async findBySupervisor(supervisorId: string) {
    return this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .where({ 'u.supervisor_id': supervisorId, 'u.activo': true })
      .select('u.id', 'u.nombre', 'u.username', 'z.name as zona', 'u.role_name');
  }

  async getZones() {
    try {
      console.log('[getZones] Obteniendo zonas de la tabla zones...');

      const rows = await this.knex('zones')
        .orderBy('orden', 'asc')
        .select('id', 'name as value', 'orden');

      console.log('[getZones] Zonas encontradas:', rows);
      return rows;
    } catch (error) {
      console.error('[getZones] Error:', error);
      return [];
    }
  }

}
