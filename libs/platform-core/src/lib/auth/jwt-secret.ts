import { Logger } from '@nestjs/common';
import type { Algorithm } from 'jsonwebtoken';

/**
 * `[AUTHZ-HARD.0]` Secreto de firma del JWT — fail-closed.
 *
 * Antes cada `JwtModule`/guard/gateway hacía `process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod'`.
 * Ese default está **commiteado en el repo** (docs incluidas): cualquiera que vio el código forja un token
 * `{ role_name: 'superadmin' }`, lo firma HS256 y obtiene god-mode cross-tenant (el guard confía en la claim).
 * El fallback convertía "olvidé setear el secreto" en "sin autenticación real" — silencioso.
 *
 * Ahora hay UN solo lugar que resuelve el secreto y **aborta el arranque** si no es un secreto de verdad:
 *   - falta            → siempre lanza (no hay app sin secreto de firma).
 *   - es el default     → lanza en producción; en dev avisa fuerte pero deja correr (para no romper el
 *                         entorno local de los devs, que comparten `.245`). Rotar el valor real en Railway.
 *
 * Pinneamos además `algorithms: ['HS256']` en la verificación (ver `jwtVerifyOptions`): defensa en
 * profundidad barata contra confusión de algoritmo si algún día se migra a llave asimétrica.
 */
const PUBLIC_DEFAULT = 'super_secret_dev_key_change_in_prod';
const logger = new Logger('JwtSecret');

export function requireJwtSecret(): string {
  const secret = process.env['JWT_SECRET'];
  const isProd = process.env['NODE_ENV'] === 'production';

  if (!secret) {
    throw new Error(
      '[AUTHZ-HARD] JWT_SECRET no está definido. La app NO arranca sin un secreto de firma. ' +
        'Setealo (≥32 bytes aleatorios) en el entorno.',
    );
  }
  if (secret === PUBLIC_DEFAULT) {
    if (isProd) {
      throw new Error(
        '[AUTHZ-HARD] JWT_SECRET es el default público del repo. Es un agujero de seguridad crítico ' +
          '(forja de superadmin). Rotá a un secreto real antes de arrancar en producción.',
      );
    }
    logger.warn(
      'JWT_SECRET es el default público del repo. TOLERADO sólo fuera de producción. Nadie lo use en prod.',
    );
  }
  return secret;
}

/** Opciones de verificación con el algoritmo pinneado. Se pasa a `verifyOptions` de cada `JwtModule`. */
export const jwtVerifyOptions: { algorithms: Algorithm[] } = { algorithms: ['HS256'] };
