import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { Knex } from 'knex';
import * as bcrypt from 'bcryptjs';
import { LoginDto } from './dto/login.dto';

interface JwtPayload {
  sub: string;
  username: string;
  zona: string;
  rol: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto) {
    const { username, password } = loginDto;

    const user = await this.knex('users')
      .where({ username, activo: true })
      .first();

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      zona: user.zona,
      rol: user.role_name,
    };

    return {
      access_token: await this.jwtService.signAsync(payload),
      user: {
        id: user.id,
        username: user.username,
        nombre: user.nombre,
        zona: user.zona,
        role: user.role_name,
      },
    };
  }
}
