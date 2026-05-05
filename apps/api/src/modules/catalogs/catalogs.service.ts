import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { ScoringV2Service } from '../scoring/scoring-v2.service';

@Injectable()
export class CatalogsService {
  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly scoringV2Service: ScoringV2Service
  ) {}

  async getByType(type: string, parentId?: string) {
    console.log('[CatalogsService] getByType called:', { type, parentId });
    
    if (type === 'zonas' || type === 'zones') {
      return this.knex('zones')
        .orderBy('orden', 'asc')
        .select('id', 'name as value', 'orden');
    }

    const query = this.knex('catalogs')
      .where({ catalog_id: type })
      .orderBy('orden', 'asc');
    
    if (parentId) {
      console.log('[CatalogsService] Filtering by parent_id:', parentId);
      query.where({ parent_id: parentId });
    }
    
    const result = await query;
    console.log('[CatalogsService] Query result for type:', type, 'parentId:', parentId, 'Count:', result.length);
    console.log('[CatalogsService] Result details:', result);
    
    return result;
  }

  async create(
    type: string,
    data: {
      value: string;
      orden?: number;
      puntuacion?: number | string;
      icono?: string;
      parent_id?: string;
    },
  ) {
    console.log('[CatalogsService] Creating item:', { type, data });
    
    // Handle zones separately - they have their own table
    if (type === 'zonas' || type === 'zones') {
      console.log('[CatalogsService] Creating zone:', data);
      const [item] = await this.knex('zones')
        .insert({
          name: data.value,
          orden: data.orden ?? 0,
        })
        .returning(['id', 'name as value', 'orden']);
      console.log('[CatalogsService] Zone created:', item);
      return item;
    }

    // Parse puntuacion as float to support decimals (0.7, 1.2, etc.)
    let puntuacion = data.puntuacion ?? 0;
    if (typeof puntuacion === 'string') {
      puntuacion = parseFloat(puntuacion);
    }
    
    const insertData = {
      catalog_id: type,
      value: data.value,
      orden: data.orden ?? 0,
      puntuacion: puntuacion,
      icono: data.icono,
      parent_id: data.parent_id, // Include parent_id for routes
    };
    
    console.log('[CatalogsService] Inserting into catalogs:', insertData);
    
    try {
      const [item] = await this.knex('catalogs')
        .insert(insertData)
        .returning('*');
      console.log('[CatalogsService] Item created successfully:', item);
      
      // Recalcular score_maximo si es un catálogo de scoring
      if (['ubicaciones', 'conceptos', 'niveles'].includes(type)) {
        await this.recalcularScoreMaximoActivo();
      }
      
      return item;
    } catch (error) {
      console.error('[CatalogsService] Error creating item:', error);
      
      // Handle duplicate key error specifically
      if (error.code === '23505') {
        throw new Error(`Ya existe un elemento con el valor "${data.value}" en este catálogo`);
      }
      
      throw error;
    }
  }

  async delete(type: string, id: string) {
    // Handle zones separately - they have their own table
    if (type === 'zonas' || type === 'zones') {
      const deleted = await this.knex('zones')
        .where({ id })
        .del();
      if (deleted === 0)
        throw new NotFoundException('Zona no encontrada');
      return { success: true };
    }

    const deleted = await this.knex('catalogs')
      .where({ catalog_id: type, id })
      .del();
    if (deleted === 0)
      throw new NotFoundException('Elemento paramétrico no encontrado');
    
    // Recalcular score_maximo si es un catálogo de scoring
    if (['ubicaciones', 'conceptos', 'niveles'].includes(type)) {
      await this.recalcularScoreMaximoActivo();
    }
    
    return { success: true };
  }

  /**
   * Recalcula el score_maximo de la versión activa
   */
  private async recalcularScoreMaximoActivo() {
    const activeVersion = await this.scoringV2Service.getActiveVersion();
    if (activeVersion) {
      await this.scoringV2Service.recalcularScoreMaximo(activeVersion.id);
    }
  }

  async update(
    type: string,
    id: string,
    data: Partial<{
      value: string;
      orden: number;
      puntuacion: number | string;
      icono: string;
    }>,
  ) {
    // Handle zones separately - they have their own table
    if (type === 'zonas' || type === 'zones') {
      const updateData: any = {};
      if (data.value !== undefined) updateData.name = data.value;
      if (data.orden !== undefined) updateData.orden = data.orden;

      const [item] = await this.knex('zones')
        .where({ id })
        .update(updateData)
        .returning(['id', 'name as value', 'orden']);

      if (!item)
        throw new NotFoundException('Zona no encontrada para actualizar');
      
      return item;
    }

    // Parse puntuacion as float to support decimals (0.7, 1.2, etc.)
    let puntuacion = data.puntuacion;
    if (puntuacion !== undefined && puntuacion !== null) {
      if (typeof puntuacion === 'string') {
        puntuacion = parseFloat(puntuacion);
      }
    }

    const updateData: any = {
      value: data.value,
      orden: data.orden,
      icono: data.icono,
    };
    
    // Only include puntuacion if it was provided
    if (puntuacion !== undefined && puntuacion !== null) {
      updateData.puntuacion = puntuacion;
    }

    const [item] = await this.knex('catalogs')
      .where({ catalog_id: type, id })
      .update(updateData)
      .returning('*');

    if (!item)
      throw new NotFoundException(
        'Elemento paramétrico no encontrado para actualizar',
      );
    
    // Recalcular score_maximo si es un catálogo de scoring y cambió la puntuación
    if (['ubicaciones', 'conceptos', 'niveles'].includes(type) && data.puntuacion !== undefined) {
      await this.recalcularScoreMaximoActivo();
    }
    
    return item;
  }

  // --- Funciones Dinámicas para Roles ---

  async getRolePermissions(roleName: string) {
    const role = await this.knex('role_permissions')
      .where({ role_name: roleName })
      .first();
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
        .insert({
          id: randomUUID(),
          role_name: roleName,
          permissions: permissions,
        })
        .returning('*');
      return newRole;
    }
    return role;
  }
}
