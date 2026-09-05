/**
 * catalogo-kp — monitor errores
 *
 * **Portada desde `apps/catalogo-kp/sql/006_errores_web.sql` (CV.22, review del PR #62).**
 * monitor.* — errores del frontend web agrupados + detalle.
 *
 * Antes estos schemas vivían en `KP_CONCENTRADA` y se aplicaban a mano con
 * `psql` como superusuario. Con el repunte de catalogo-kp a `postgres_platform`
 * pasan a ser migraciones versionadas de la Suite, corridas por el mismo
 * `knexfile-newdb.js` que el resto — que es lo que pidió el review: que no
 * queden sueltas contra una base ajena.
 *
 * **Idempotente**: el SQL original ya venía escrito así (`CREATE ... IF NOT
 * EXISTS`, `ADD COLUMN IF NOT EXISTS`, bloques `DO $$ IF NOT EXISTS ... $$`
 * para los constraints), así que se ejecuta tal cual, sin reescribirlo. Se
 * preserva a propósito el texto y los comentarios originales: son la
 * documentación de por qué cada columna existe, y reescribirlos los perdería.
 *
 * Los GRANT del archivo van a `app_runtime`, que es el rol de runtime de esta
 * base — el mismo que ya tiene SELECT sobre `kepler_ods` (mig 20260811120000).
 * El rol dedicado `catalogo_kp_runtime` de `sql/007_rol_dedicado.sql` queda
 * **obsoleto**: existía para no compartir credencial entre dos bases del mismo
 * cluster (GOTCHAS §24), y ahora hay una sola base.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`-- ============================================================================
--  Fase 3 — Captura de errores del navegador
--
--  QUE PROBLEMA RESUELVE
--  Si a un cliente le truena el checkout, hoy no nos enteramos. El error ocurre
--  en SU navegador: no deja rastro en la bitácora del servidor, y el cliente
--  casi nunca llama a contarlo. Simplemente no compra.
--
--  Se decidió captura propia en vez de Sentry (01/09/2026): los datos del
--  cliente no salen de la empresa, no hay un servicio más que mantener, y
--  reutiliza el correo y la cola que ya existen.
--
--  CORRER COMO postgres:  ADMINISTRAR.bat, opción 8
-- ============================================================================

-- Los errores son operación, no comercio, así que no van en \`tienda\`.
CREATE SCHEMA IF NOT EXISTS monitor;
GRANT USAGE ON SCHEMA monitor TO app_runtime;

-- ── Grupos de error ─────────────────────────────────────────────────────────
--
-- Un solo error suele repetirse cientos de veces: si cada ocurrencia fuera una
-- fila y un correo, la bandeja se vuelve inútil el primer día y nadie la mira.
-- Por eso se AGRUPA: la primera vez avisa, las siguientes sólo suman.
CREATE TABLE IF NOT EXISTS monitor.errores (
  id            BIGSERIAL PRIMARY KEY,

  -- Huella del error: mensaje + primera línea del rastro. Lo que decide si dos
  -- ocurrencias son "el mismo error".
  huella        TEXT NOT NULL UNIQUE,

  mensaje       TEXT NOT NULL,
  origen        TEXT,                  -- archivo:linea donde ocurrió
  rastro        TEXT,                  -- stack, recortado
  pagina        TEXT,                  -- en qué página del sitio
  navegador     TEXT,

  -- Dónde duele más. Un error en el checkout cuesta una venta; uno en el
  -- catálogo, una visita.
  critico       BOOLEAN NOT NULL DEFAULT FALSE,

  veces         INT NOT NULL DEFAULT 1,
  primera_vez   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_vez    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  avisado_en    TIMESTAMPTZ,           -- cuándo se mandó el correo
  resuelto_en   TIMESTAMPTZ,           -- lo marca una persona
  resuelto_por  TEXT,
  nota          TEXT
);

CREATE INDEX IF NOT EXISTS ix_errores_ultima  ON monitor.errores (ultima_vez DESC);
CREATE INDEX IF NOT EXISTS ix_errores_activos ON monitor.errores (ultima_vez DESC)
  WHERE resuelto_en IS NULL;

-- ── Ocurrencias recientes ───────────────────────────────────────────────────
--
-- Se guardan las últimas de cada grupo, no todas: sirven para ver el contexto
-- (qué página, qué navegador, qué pedido) sin que la tabla crezca sin control.
CREATE TABLE IF NOT EXISTS monitor.errores_detalle (
  id          BIGSERIAL PRIMARY KEY,
  error_id    BIGINT NOT NULL REFERENCES monitor.errores(id) ON DELETE CASCADE,
  pagina      TEXT,
  navegador   TEXT,
  -- Folio del pedido si el error ocurrió con uno en curso. Es lo que permite
  -- llamarle al cliente que no pudo pagar.
  folio       TEXT,
  ip          TEXT,
  ocurrio_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_errores_detalle ON monitor.errores_detalle (error_id, ocurrio_en DESC);

-- ── Vista para el tablero ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW monitor.v_errores_activos AS
SELECT e.id, e.mensaje, e.origen, e.pagina, e.critico,
       e.veces, e.primera_vez, e.ultima_vez, e.avisado_en,
       ROUND(EXTRACT(EPOCH FROM (NOW() - e.ultima_vez)) / 3600, 1) AS horas_desde_ultima,
       (SELECT COUNT(DISTINCT d.folio) FROM monitor.errores_detalle d
         WHERE d.error_id = e.id AND d.folio IS NOT NULL)          AS pedidos_afectados
FROM monitor.errores e
WHERE e.resuelto_en IS NULL
ORDER BY e.critico DESC, e.ultima_vez DESC;

GRANT SELECT, INSERT, UPDATE ON monitor.errores          TO app_runtime;
GRANT SELECT, INSERT         ON monitor.errores_detalle  TO app_runtime;
GRANT SELECT                 ON monitor.v_errores_activos TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE monitor.errores_id_seq          TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE monitor.errores_detalle_id_seq  TO app_runtime;

-- Sin DELETE, igual que en tienda: un error se marca resuelto, no se borra.
-- Si vuelve a ocurrir conviene ver que ya había pasado antes.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='monitor' AND table_name='errores') THEN
    RAISE EXCEPTION 'Falto crear monitor.errores';
  END IF;
  RAISE NOTICE 'Migracion 006 aplicada correctamente.';
END $$;`);
};

/**
 * Sin `down`. Estos schemas guardan **pedidos de clientes con dinero real**
 * (`tienda.pedidos`), los usuarios del tablero y el historial de errores: un
 * rollback de esquema no puede llevárselos por delante. Mismo criterio que el
 * resto de las migraciones de datos vivos del repo. Para desarmarlo, se hace a
 * mano y a conciencia.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // no-op deliberado (ver arriba)
};
