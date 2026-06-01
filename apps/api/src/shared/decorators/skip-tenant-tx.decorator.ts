import { SetMetadata } from '@nestjs/common';

/**
 * Marca un handler para que `TenantContextInterceptor` NO abra una transaction
 * automática alrededor de toda la request. El handler sigue recibiendo el
 * contexto CLS (tenantId, userId, etc.) pero es responsable de abrir su
 * propia trx tight para las queries de DB.
 *
 * Caso de uso (audit #3): endpoints que hacen trabajo I/O largo (Cloudinary
 * upload de 30s+) ANTES de tocar la DB. Con el auto-trx, la transacción queda
 * idle durante el upload → Postgres `idle_in_transaction_timeout` la mata o
 * agota el pool de conexiones.
 */
export const SKIP_TENANT_TX_KEY = 'skipTenantTx';
export const SkipTenantTx = () => SetMetadata(SKIP_TENANT_TX_KEY, true);
