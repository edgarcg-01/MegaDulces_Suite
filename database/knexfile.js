"use strict";
/**
 * `[AUD-DAT.7]` — Knexfile **LEGACY** (`database/migrations/`, 89 migraciones de la DB vieja).
 *
 * ⛔⛔ TENÍA UN CAMINO DE UN SOLO COMANDO HASTA RE-APLICAR 89 MIGRACIONES SOBRE PRODUCCIÓN.
 *
 * Medido el 2026-09-28. Tres hechos que por separado son inofensivos y juntos son una mina:
 *
 *   1. `package.json` llama a este archivo desde **`npm run migrate:latest`** — el nombre que
 *      cualquiera teclearía primero, y el que `npm run dev:bootstrap` corre como primer paso.
 *   2. `DATABASE_URL` apunta hoy a **producción** (`192.168.0.222:5434/railway`), la MISMA base
 *      que `DATABASE_URL_NEW`. No a la DB legacy: esa es `LEGACY_DATABASE_URL`.
 *   3. Este era el único de los cuatro knexfiles **sin bloque `migrations`**, o sea sin
 *      `schemaName`. Los otros tres (`-newdb`, `-hr`, `-products`) lo tienen fijado en `public`.
 *
 * Sin `schemaName`, knex resuelve `knex_migrations` por `search_path`, y el del rol de prod
 * empieza con `identity` → escribe su ledger en **`identity.knex_migrations`, que está VACÍA**.
 * Ledger vacío = "ninguna migración aplicada" = re-aplicar las 89 contra la base viva.
 *
 * ⚠️ Y NO ES HIPOTÉTICO: la migración `20260907160000_retirar_knex_migrations_fantasma.js`
 * ([VP.5.4]) dropeó `identity.knex_migrations` y figura como APLICADA en `public.knex_migrations`
 * — y al 2026-09-28 las dos tablas fantasma **existen de nuevo, con 0 filas**. Algo las recreó
 * después de borrarlas, y esto es lo único que las crea.
 *
 * ── El freno ────────────────────────────────────────────────────────────────
 * Falla CERRADA: si el destino es la base de la plataforma, no arranca. Se comprueba por **nombre
 * de base** (`railway`) y no por host, que es el mismo criterio que ya usa
 * `libs/platform-core/src/lib/provenance/target-guard.js` — y por buena razón: la prod se mudó de
 * Railway a una IP de LAN en la Fase VL y el guardián por host habría dejado de reconocerla, el
 * guardián por nombre no.
 *
 * Más `schemaName: 'public'` como defensa en profundidad: aunque alguien apunte este knexfile a
 * una base legítima, su ledger va donde el resto, nunca a un fantasma nuevo.
 *
 * ⚠️ El `throw` vive en el MÓDULO, no dentro de una función: el CLI de knex carga este archivo
 * antes de conectarse, así que revienta antes de abrir la sesión. Un freno que corre después de
 * conectar ya no es un freno.
 */

const URL = process.env.DATABASE_URL || '';
// `railway` es el nombre de la base de la plataforma, en Railway y on-prem. Ver target-guard.js.
const ES_PLATAFORMA = /\/railway(\?|$)/i.test(URL) || (URL && URL === process.env.DATABASE_URL_NEW);

if (ES_PLATAFORMA) {
  throw new Error(
    'ABORT (knexfile.js LEGACY): DATABASE_URL apunta a la base de la PLATAFORMA. Este knexfile ' +
    'corre database/migrations/ (89 migraciones de la DB vieja) y su ledger caeria en ' +
    'identity.knex_migrations, que esta VACIA -> re-aplicaria las 89 sobre produccion. ' +
    'Para la plataforma usa `npm run migrate:new` (knexfile-newdb.js). Para la DB legacy, ' +
    'exporta DATABASE_URL=$LEGACY_DATABASE_URL en el comando.',
  );
}

const migrations = {
  directory: './migrations',
  tableName: 'knex_migrations',
  // Fijado a proposito: sin esto el search_path decide, y en prod decide mal.
  schemaName: 'public',
};

const config = {
    development: {
        client: 'pg',
        connection: process.env.DATABASE_URL
            ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
            : {
                host: process.env.DB_HOST || 'localhost',
                port: Number(process.env.DB_PORT) || 5432,
                database: process.env.DB_NAME || 'megadulces_logistica',
                user: process.env.DB_USER || 'postgres',
                password: process.env.DB_PASSWORD || 'postgres',
            },
        pool: { min: 2, max: 10 },
        migrations,
    },
    production: {
        client: 'pg',
        connection: process.env.DATABASE_URL
            ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
            : {
                host: process.env.DB_HOST,
                port: Number(process.env.DB_PORT),
                database: process.env.DB_NAME || 'megadulces_logistica',
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                ssl: { rejectUnauthorized: false },
            },
        pool: { min: 2, max: 10 },
        migrations,
    },
};

module.exports = config;
module.exports.connectionConfig = config;
