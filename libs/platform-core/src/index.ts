// @megadulces/platform-core — barrel público.
// Infra compartida por todos los dominios. Es infra leaf: no depende de
// ningún dominio. Los dominios importan SIEMPRE desde aquí (nunca deep import).

// ── database ──
export * from './lib/database/database.module';
export * from './lib/database/new-database.module';
export * from './lib/database/tenant-knex.service';
export * from './lib/database/vector-database.module';

// ── tenant ──
export * from './lib/tenant/tenant.module';
export * from './lib/tenant/tenant-context.service';
export * from './lib/tenant/tenant-context.interceptor';
export * from './lib/tenant/legacy-tx.als';

// ── ability / permisos ──
export * from './lib/ability/ability.module';
export * from './lib/ability/ability.factory';
export * from './lib/ability/ability.types';
export * from './lib/ability/data-scope';
export * from './lib/ability/permissions-cache.service';

// ── auth ──
export * from './lib/auth/jwt-auth.guard';
export * from './lib/auth/public.decorator';

// ── guards ──
export * from './lib/guards/require-auth.guard';
export * from './lib/guards/roles.guard';

// ── decorators ──
export * from './lib/decorators/permissions.decorator';
export * from './lib/decorators/req-user.decorator';
export * from './lib/decorators/skip-tenant-tx.decorator';
// roles.decorator.ts deprecado (sin exports) — no se re-exporta.

// ── ai ──
export * from './lib/ai/embeddings.service';
export * from './lib/ai/llm-extractor.service';
export * from './lib/ai-product-matcher/ai-product-matcher.module';
export * from './lib/ai-product-matcher/ai-product-matcher.service';

// ── cloudinary ──
export * from './lib/cloudinary/cloudinary.module';
export * from './lib/cloudinary/cloudinary.service';

// ── constants / schemas / date ──
export * from './lib/constants/permissions';
export * from './lib/schemas/jsonb-schemas';
export * from './lib/date/mx-date';
