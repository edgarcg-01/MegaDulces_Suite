import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    // `CATALOGO_KP_JWT_SECRET`, no `JWT_SECRET`: ese nombre ya lo usa el
    // sistema de auth multi-tenant de esta Suite (33 archivos) — compartirlo
    // firmaría/validaría tokens de dos sistemas de auth distintos con el
    // mismo secreto si algún día conviven en el mismo .env de dev. Mismo
    // criterio que separar `catalogo_kp_runtime` de `app_runtime` en CV.0.
    const secret = process.env.CATALOGO_KP_JWT_SECRET;
    if (!secret) {
      throw new Error(
        'CATALOGO_KP_JWT_SECRET no seteado — catalogo-kp no puede arrancar sin un secreto de sesión.',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
    });
  }

  validate(payload: { sub: number; email: string; rol: string; nombre: string }) {
    return payload; // queda en req.user
  }
}
