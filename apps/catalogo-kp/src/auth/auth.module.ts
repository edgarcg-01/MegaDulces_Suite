import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';

// El original traía un fallback inseguro hardcodeado
// ('megadulces-secret-cambiar-en-prod') si el env faltaba. Se retira: mejor
// fail-fast en boot (mismo criterio que PlatformDbModule en CV.0) que un
// secreto público conocido firmando sesiones reales.
const jwtSecret = process.env.CATALOGO_KP_JWT_SECRET;
if (!jwtSecret) {
  throw new Error(
    'CATALOGO_KP_JWT_SECRET no seteado — catalogo-kp no puede arrancar sin un secreto de sesión.',
  );
}

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: jwtSecret,
      signOptions: { expiresIn: '8h' },
    }),
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
