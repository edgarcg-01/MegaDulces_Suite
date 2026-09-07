import { Controller, Post, Body, Get, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RequireAuthGuard } from '@megadulces/platform-core';
import { ReqUser } from '@megadulces/platform-core';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '@megadulces/platform-core';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  // `[AUTHZ-HARD.5]` Rate-limit propio del login: 5 intentos/min/IP (ver auth-mt).
  @Throttle({ short: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({ summary: 'Inicia sesión con usuario y contraseña' })
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @UseGuards(RequireAuthGuard)
  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Obtiene el perfil del usuario autenticado a partir del JWT' })
  getProfile(@ReqUser() user: any) {
    return user;
  }
}
