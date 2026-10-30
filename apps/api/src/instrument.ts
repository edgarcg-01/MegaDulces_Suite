/**
 * Inicialización de Sentry (error tracking del backend).
 *
 * DEBE importarse ANTES que cualquier otro módulo en main.ts (Sentry instrumenta
 * al cargar). Es INERTE sin `SENTRY_DSN` → seguro en dev/local y en cualquier
 * entorno sin la env seteada. Cargá el DSN en Railway (Sentry SaaS free) o, cuando
 * prod sea on-prem, apuntá al DSN de GlitchTip (mismo SDK).
 */
import * as dotenv from 'dotenv';
dotenv.config();
// `[VL.11.C]` Archivo local SIN importaciones a propósito: acá no se puede tocar
// `@megadulces/platform-core` sin ejecutar media plataforma antes de que Sentry instrumente.
import { commitDelBuildOpcional } from './build-info';
import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Trazas de performance: bajo por default (barato). Subir si se quiere APM.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // No mandar PII (headers/cookies/body) salvo que se active explícito.
    // ⛔ `[DEPS.4]` Sentry 11 retiró `sendDefaultPii` y, si `dataCollection` queda SIN
    // declarar, junta por default cuerpos HTTP (el login lleva la contraseña), cookies,
    // usuario y el SQL de cada consulta. Esto es la línea base de la v10, explícita
    // (MIGRATION.md de sentry-javascript, «If you want to keep the v10 default behavior»).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
        response: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
      },
      httpBodies: [],
      urlQueryParams: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    },
    // ⛔ Antes leía SÓLO `RAILWAY_GIT_COMMIT_SHA`, que on-prem no existe: todo error de
    // producción llegaba a Sentry SIN release, o sea imposible de atribuir a un build.
    release: commitDelBuildOpcional(),
  });
}
