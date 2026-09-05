import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import * as bcrypt from 'bcryptjs';
import { KNEX_PLATFORM } from '../platform-db/platform-db.constants';
import { pgRaw } from '../platform-db/pg-raw.util';

@Injectable()
export class AdminService {
  constructor(@Inject(KNEX_PLATFORM) private readonly db: Knex) {}

  async listarUsuarios() {
    return this.query(
      'SELECT id, email, nombre, rol, activo, sucursales, creado_en, ultimo_login FROM admin.usuarios ORDER BY id',
    );
  }

  async crearUsuario(data: { email: string; nombre: string; password: string; rol?: string; sucursales?: string[] }) {
    const hash = await bcrypt.hash(data.password, 10);
    const rows = await this.query<any>(
      `INSERT INTO admin.usuarios (email, nombre, password, rol, sucursales)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, nombre, rol, activo, sucursales`,
      [data.email, data.nombre, hash, data.rol || 'viewer', data.sucursales || []],
    );
    return rows[0];
  }

  async actualizarUsuario(id: number, data: { nombre?: string; rol?: string; sucursales?: string[]; activo?: boolean }) {
    const campos: string[] = [];
    const params: any[] = [];
    if (data.nombre     !== undefined) { params.push(data.nombre);     campos.push(`nombre = $${params.length}`); }
    if (data.rol        !== undefined) { params.push(data.rol);        campos.push(`rol = $${params.length}`); }
    if (data.sucursales !== undefined) { params.push(data.sucursales); campos.push(`sucursales = $${params.length}`); }
    if (data.activo     !== undefined) { params.push(data.activo);     campos.push(`activo = $${params.length}`); }
    if (!campos.length) return { ok: false, msg: 'Sin cambios' };
    params.push(id);
    await this.query(`UPDATE admin.usuarios SET ${campos.join(', ')} WHERE id = $${params.length}`, params);
    return { ok: true };
  }

  async desactivarUsuario(id: number) {
    await this.query('UPDATE admin.usuarios SET activo = false WHERE id = $1', [id]);
    return { ok: true };
  }

  async resetPassword(id: number, nueva: string) {
    const hash = await bcrypt.hash(nueva, 10);
    await this.query('UPDATE admin.usuarios SET password = $1 WHERE id = $2', [hash, id]);
    return { ok: true };
  }

  private async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return pgRaw<T>(this.db, sql, params);
  }
}
