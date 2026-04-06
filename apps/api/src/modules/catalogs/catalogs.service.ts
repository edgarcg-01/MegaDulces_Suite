import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class CatalogsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  async getByType(type: string, parentId?: string) {
    const query = this.knex('catalogs').where({ catalog_id: type }).orderBy('orden', 'asc');
    if (parentId) {
      query.where({ parent_id: parentId });
    }
    return query;
  }

  async create(type: string, data: { value: string; orden?: number; puntuacion?: number; icono?: string }) {
    const [item] = await this.knex('catalogs')
      .insert({
        catalog_id: type,
        value: data.value,
        orden: data.orden ?? 0,
        puntuacion: data.puntuacion ?? 0,
        icono: data.icono,
      })
      .returning('*');
    return item;
  }

  async delete(type: string, id: string) {
    const deleted = await this.knex('catalogs').where({ catalog_id: type, id }).del();
    if (deleted === 0) throw new NotFoundException('Elemento paramétrico no encontrado');
    return { success: true };
  }

  async update(type: string, id: string, data: Partial<{ value: string; orden: number; puntuacion: number; icono: string }>) {
    const [item] = await this.knex('catalogs')
      .where({ catalog_id: type, id })
      .update({
        value: data.value,
        orden: data.orden,
        puntuacion: data.puntuacion,
        icono: data.icono,
      })
      .returning('*');
    
    if (!item) throw new NotFoundException('Elemento paramétrico no encontrado para actualizar');
    return item;
  }

  // --- Funciones Dinámicas para Roles ---

  async getRolePermissions(roleName: string) {
    const role = await this.knex('role_permissions').where({ role_name: roleName }).first();
    if (!role) {
      // Si no existe el registro en role_permissions, lo creamos con permisos vacíos
      const [newRole] = await this.knex('role_permissions')
        .insert({ id: randomUUID(), role_name: roleName, permissions: {} })
        .returning('*');
      return newRole;
    }
    return role;
  }

  async updateRolePermissions(roleName: string, permissions: any) {
    const [role] = await this.knex('role_permissions')
      .where({ role_name: roleName })
      .update({ permissions: permissions })
      .returning('*');
    
    if (!role) {
      // Si por alguna razón no existe, lo creamos
      const [newRole] = await this.knex('role_permissions')
        .insert({ id: randomUUID(), role_name: roleName, permissions: permissions })
        .returning('*');
      return newRole;
    }
    return role;
  }
}
