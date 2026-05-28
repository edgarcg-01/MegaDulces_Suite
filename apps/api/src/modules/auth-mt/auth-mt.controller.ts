import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthMtService, LoginDto } from './auth-mt.service';
import { Public } from '../../shared/auth/public.decorator';

@ApiTags('auth-mt')
@Controller('auth-mt')
export class AuthMtController {
  constructor(private readonly authService: AuthMtService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Login multi-tenant: requiere tenant_slug + username + password' })
  login(@Body() body: LoginDto) {
    return this.authService.login(body);
  }
}
