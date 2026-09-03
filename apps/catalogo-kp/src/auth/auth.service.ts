import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Knex } from 'knex';
import * as bcrypt from 'bcryptjs';
import { KNEX_KP_CONCENTRADA } from '../kp-concentrada/kp-concentrada.constants';
import { pgRaw } from '../kp-concentrada/pg-raw.util';

export interface Usuario {
  id: number;
  email: string;
  nombre: string;
  rol: string;
  sucursales: string[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(KNEX_KP_CONCENTRADA) private readonly db: Knex,
    private jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const rows = await this.query<any>(
      `SELECT id, email, nombre, rol, sucursales, password
       FROM admin.usuarios WHERE email = $1 AND activo = true`,
      [email.toLowerCase()],
    );
    if (!rows.length) throw new UnauthorizedException('Credenciales inválidas');

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('Credenciales inválidas');

    // Actualizar último login. NO fatal: es una comodidad de auditoría, no
    // una condición del login — un permiso mal configurado en el rol de la
    // base (ya pasó una vez, 2026-09-03: catalogo_kp_runtime sólo tenía
    // SELECT en admin.usuarios) no debe tumbar el inicio de sesión de nadie,
    // ni menos el proceso entero.
    try {
      await this.query('UPDATE admin.usuarios SET ultimo_login = NOW() WHERE id = $1', [user.id]);
    } catch (e: any) {
      this.logger.warn(`No se pudo registrar ultimo_login del usuario ${user.id}: ${e.message}`);
    }

    const payload = { sub: user.id, email: user.email, rol: user.rol, nombre: user.nombre };
    return {
      token: this.jwt.sign(payload),
      usuario: { id: user.id, email: user.email, nombre: user.nombre, rol: user.rol, sucursales: user.sucursales },
    };
  }

  async cambiarPassword(userId: number, actual: string, nueva: string) {
    const rows = await this.query<any>('SELECT password FROM admin.usuarios WHERE id = $1', [userId]);
    if (!rows.length) throw new UnauthorizedException();

    const ok = await bcrypt.compare(actual, rows[0].password);
    if (!ok) throw new UnauthorizedException('Contraseña actual incorrecta');

    const hash = await bcrypt.hash(nueva, 10);
    await this.query('UPDATE admin.usuarios SET password = $1 WHERE id = $2', [hash, userId]);
    return { ok: true };
  }

  async perfil(userId: number): Promise<Usuario> {
    const rows = await this.query<Usuario>(
      'SELECT id, email, nombre, rol, sucursales FROM admin.usuarios WHERE id = $1',
      [userId],
    );
    if (!rows.length) throw new UnauthorizedException();
    return rows[0];
  }

  private async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return pgRaw<T>(this.db, sql, params);
  }
}
