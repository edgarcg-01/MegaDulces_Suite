import { SetMetadata } from '@nestjs/common';

/**
 * Marca un endpoint como público (no requiere JWT).
 *
 * Uso:
 *   @Public()
 *   @Post('login')
 *   login() { ... }
 *
 * Por defecto, el `JwtAuthGuard` global rechaza con 401 cualquier request que
 * no traiga `Authorization: Bearer <token>` válido. Decorar con `@Public()`
 * lo exime de esa validación (typical para login, register, health, public
 * webhooks).
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
