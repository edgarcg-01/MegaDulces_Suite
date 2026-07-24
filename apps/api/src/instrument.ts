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
import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Trazas de performance: bajo por default (barato). Subir si se quiere APM.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // No mandar PII (headers/cookies/body) salvo que se active explícito.
    sendDefaultPii: false,
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
  });
}
