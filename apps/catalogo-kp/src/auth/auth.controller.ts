import { Body, Controller, Get, Post, Put, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body.email, body.password);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('perfil')
  perfil(@Request() req: any) {
    return this.authService.perfil(req.user.sub);
  }

  @UseGuards(AuthGuard('jwt'))
  @Put('password')
  cambiarPassword(
    @Request() req: any,
    @Body() body: { actual: string; nueva: string },
  ) {
    return this.authService.cambiarPassword(req.user.sub, body.actual, body.nueva);
  }
}
