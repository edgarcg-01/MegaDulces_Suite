import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: requireJwtSecret(),
      signOptions: { expiresIn: '12h', algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
