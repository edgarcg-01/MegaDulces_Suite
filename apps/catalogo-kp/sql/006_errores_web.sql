-- ============================================================================
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

-- Los errores son operación, no comercio, así que no van en `tienda`.
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
END $$;
