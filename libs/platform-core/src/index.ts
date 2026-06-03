// @megadulces/platform-core — barrel público.
// Infra compartida por todos los dominios: database (KNEX_CONNECTION,
// KNEX_NEW_DB, TenantKnexService), tenant context, ability, guards,
// interceptors, cloudinary, embeddings + auth/auth-mt/tenants-admin,
// websocket y cron. Es infra leaf: no depende de ningún dominio.

export {};
