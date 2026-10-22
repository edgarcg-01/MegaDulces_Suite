'use strict';
/**
 * `[CGA-A.33]` — La FOTO del contenido de la caja fuerte CAOS: lo que la máquina dice tener,
 * casete por casete, amarrado al último movimiento que ya teníamos cuando se tomó.
 *
 * Hasta hoy la pantalla publicaba «depósitos − dispensado» y advertía que NO era el saldo,
 * porque nadie había leído el inventario del equipo. Existe: la consola lo sirve en
 * `GET /Reports/report-Countings/getCounting` (reporte «Contenidos»). Lo escribe el demonio
 * `caos-live`, que ya tiene la sesión con el aparato — CAOS es un sistema EXTERNO, así que
 * aplica la excepción de tabla propia, igual que `analytics.caos_cash_movements`.
 *
 * ── Lo medido antes (sólo lectura, 2026-10-20) ──────────────────────────────────────────────
 *  · `getCounting` a las 10:04:38 MX: 8 casetes (stocks), sin bolsas, sin `miscount`,
 *    500×507 · 200×383 · 100×252 · 50×46 · 20×121 = **$360,020.00**.
 *  · El replay de los 44 movimientos desde el último vaciado (#1609) da **el mismo vector**,
 *    billete por billete. Y el replay por denominación cierra a 0 contra los vaciados del
 *    7-jul y 18-ago y contra el `Fin de Dia` del 15-oct (`FASE_CGA_PLAN_IMPLEMENTACION §11.2.1`).
 *
 * ── Por qué `after_external_id` ─────────────────────────────────────────────────────────────
 * Una foto sólo se puede cuadrar si se sabe QUÉ movimientos ya contiene. El demonio la toma
 * justo después de sincronizar movimientos y la descarta si entró uno nuevo mientras la leía.
 * Así, entre dos fotos consecutivas: `foto_nueva − foto_vieja = Σ movimientos (vieja, nueva]`,
 * por denominación. Eso es el cuadre continuo; si no cierra, es un hallazgo con monto.
 *
 * ── Por qué en `analytics.*` y SIN RLS ──────────────────────────────────────────────────────
 * Mismo patrón que `caos_cash_movements`: la alimenta un proceso fuera de `TenantContextService`;
 * `tenant_id` explícito y la lectura filtra por tenant a mano.
 *
 * Aditiva e idempotente (hasTable). No toca ninguna tabla existente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('caos_cash_counts'))) {
    await knex.raw(`
      CREATE TABLE analytics.caos_cash_counts (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        device             text NOT NULL,              -- 'AST700-19758' (el mismo devName de los movimientos)

        -- qué movimientos YA contiene esta foto
        after_external_id  bigint NOT NULL,            -- max(external_id) sincronizado al tomarla

        captured_at        timestamptz NOT NULL,       -- primera vez que se leyó esta foto
        confirmed_at       timestamptz NOT NULL,       -- última vez que se volvió a leer IGUAL

        online             boolean,                    -- lo que reporta el equipo
        any_miscount       boolean NOT NULL,           -- algún contenedor con conteo dudoso
        total              numeric(18,2) NOT NULL,     -- Σ denom × quantity de todos los contenedores

        content_hash       text NOT NULL,              -- md5 del contenido normalizado
        raw                jsonb NOT NULL,             -- respuesta cruda de getCounting (procedencia)

        created_by         text NOT NULL DEFAULT 'caos-live',
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_caos_counts_foto
                      ON analytics.caos_cash_counts (tenant_id, device, after_external_id, content_hash)`);
    await knex.raw(`CREATE INDEX ix_caos_counts_reciente
                      ON analytics.caos_cash_counts (tenant_id, device, captured_at DESC)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.caos_cash_counts TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('analytics').hasTable('caos_cash_count_lines'))) {
    await knex.raw(`
      CREATE TABLE analytics.caos_cash_count_lines (
        tenant_id        uuid NOT NULL,
        count_id         uuid NOT NULL REFERENCES analytics.caos_cash_counts(id) ON DELETE CASCADE,
        container_kind   text NOT NULL,                -- 'stock' (casete reciclador) | 'bag' (bolsa)
        container_index  int  NOT NULL,                -- el número de casete/bolsa del equipo
        currency         text NOT NULL DEFAULT 'MXN',
        denom            numeric(10,2) NOT NULL,
        pieza_tipo       text NOT NULL DEFAULT 'B',
        quantity         int  NOT NULL,
        miscount         boolean NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, count_id, container_kind, container_index, currency, denom, pieza_tipo),
        CONSTRAINT caos_count_kind_chk CHECK (container_kind IN ('stock', 'bag')),
        CONSTRAINT caos_count_qty_chk  CHECK (quantity >= 0),
        CONSTRAINT caos_count_denom_chk CHECK (denom > 0)
      )`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.caos_cash_count_lines TO app_runtime`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('caos_cash_count_lines');
  await knex.schema.withSchema('analytics').dropTableIfExists('caos_cash_counts');
};
