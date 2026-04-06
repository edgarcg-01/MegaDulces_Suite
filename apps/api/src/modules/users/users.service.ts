import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UsersService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  async create(createUserDto: CreateUserDto) {
    const { password, ...rest } = createUserDto;
    const password_hash = await bcrypt.hash(password, 10);

    const [user] = await this.knex('users')
      .insert({ ...rest, password_hash })
      .returning([
        'id',
        'username',
        'nombre',
        'zona',
        'role_name',
        'activo',
        'supervisor_id',
        'created_at',
      ]);

    return user;
  }

  async findAll(zona?: string, activo?: string) {
    const query = this.knex('users').select('id', 'username', 'nombre', 'zona', 'role_name', 'activo', 'supervisor_id', 'created_at');
    if (zona) query.where({ zona });
    if (activo) query.where({ activo: activo === 'true' });
    return query;
  }

  async findOne(id: string) {
    const user = await this.knex('users')
      .where({ id })
      .select('id', 'username', 'nombre', 'zona', 'role_name', 'activo', 'supervisor_id', 'created_at')
      .first();

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }
    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    const { password, ...rest } = updateUserDto;
    const updateData: Record<string, any> = { ...rest };

    if (password) {
      updateData.password_hash = await bcrypt.hash(password, 10);
    }

    const [user] = await this.knex('users')
      .where({ id })
      .update(updateData)
      .returning([
        'id',
        'username',
        'nombre',
        'zona',
        'role_name',
        'activo',
        'supervisor_id',
        'created_at',
      ]);

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }
    return user;
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
    const query = this.knex('users')
      .where({ role_name: 'supervisor_v', activo: true })
      .select('id', 'nombre', 'username', 'zona');
    
    if (zona) {
      query.where({ zona });
    }
    
    return query;
  }

  async findBySupervisor(supervisorId: string) {
    return this.knex('users')
      .where({ supervisor_id: supervisorId, activo: true })
      .select('id', 'nombre', 'username', 'zona', 'role_name');
  }
}
