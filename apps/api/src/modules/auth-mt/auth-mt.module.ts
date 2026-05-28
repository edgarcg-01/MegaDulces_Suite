import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthMtService } from './auth-mt.service';
import { AuthMtController } from './auth-mt.controller';

/**
 * Módulo auth multi-tenant. No reemplaza al AuthModule legacy todavía —
 * convive con él hasta el cutover (Sprint A.0mt.5).
 *
 * NO está registrado en AppModule. Se importa cuando esté listo el cutover.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
    }),
  ],
  controllers: [AuthMtController],
  providers: [AuthMtService],
  exports: [AuthMtService],
})
export class AuthMtModule {}
