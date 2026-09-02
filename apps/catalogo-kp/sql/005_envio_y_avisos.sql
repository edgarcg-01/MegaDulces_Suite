-- ============================================================================
--  Fase 2 — Envío, avisos al cliente y vigilancia de autorizaciones
--
--  Tres entregables que comparten tabla, así que van en una sola migración
--  para no pedir tres ventanas de mantenimiento.
--
--  CORRER COMO postgres:  ADMINISTRAR.bat, opción 8
-- ============================================================================

-- ── 9. Envío ────────────────────────────────────────────────────────────────
-- La guía se captura A MANO en la pantalla de confirmación (decidido el
-- 01/09/2026). Integrarse con la API de Estafeta o DHL queda para después, y
-- por eso `paqueteria` es texto libre con CHECK y no una tabla: cuando llegue
-- la integración, lo que cambia es quién escribe estos campos, no su forma.
ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS paqueteria TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pedidos_paqueteria') THEN
    ALTER TABLE tienda.pedidos
      ADD CONSTRAINT ck_pedidos_paqueteria
      CHECK (paqueteria IS NULL OR paqueteria IN ('ESTAFETA','DHL'));
  END IF;
END $$;

ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS guia TEXT;

ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS enviado_en TIMESTAMPTZ;

ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS enviado_por TEXT;

-- Buscar un pedido por su guía es lo que se hace cuando el cliente llama a
-- preguntar, o cuando la paquetería reporta un problema.
CREATE INDEX IF NOT EXISTS ix_pedidos_guia ON tienda.pedidos (guia)
  WHERE guia IS NOT NULL;

-- ── 10. Avisos al cliente ───────────────────────────────────────────────────
-- Se registra qué avisos se enviaron, para no repetirlos y para poder
-- responder "sí se le avisó, el día tal" cuando alguien reclame.
--
-- Tabla aparte y no columnas en pedidos: son varios avisos por pedido y su
-- número va a crecer conforme se agreguen estados.
CREATE TABLE IF NOT EXISTS tienda.avisos (
  id          BIGSERIAL PRIMARY KEY,
  pedido_id   BIGINT NOT NULL REFERENCES tienda.pedidos(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL,          -- 'PEDIDO_CREADO' | 'CONFIRMADO' | ...
  destino     TEXT NOT NULL,          -- correo al que se envió
  asunto      TEXT,
  enviado_en  TIMESTAMPTZ,            -- NULL mientras no se logre enviar
  intentos    INT NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_avisos_pedido ON tienda.avisos (pedido_id, tipo);

-- Un mismo aviso no se manda dos veces por el mismo pedido. Si el worker
-- reintenta, o si alguien confirma dos veces, el cliente no recibe duplicados.
CREATE UNIQUE INDEX IF NOT EXISTS ux_avisos_pedido_tipo
  ON tienda.avisos (pedido_id, tipo);

-- ── 11. Vigilancia de autorizaciones ────────────────────────────────────────
-- Cuándo se avisó por última vez de que una autorización está por vencer, para
-- no repetir el aviso cada hora.
ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS aviso_vencimiento_en TIMESTAMPTZ;

-- Encuentra rápido lo que está por vencer sin recorrer la tabla.
CREATE INDEX IF NOT EXISTS ix_pedidos_autorizacion_vence
  ON tienda.pedidos (autorizacion_expira)
  WHERE autorizacion_expira IS NOT NULL AND capturado_en IS NULL;

-- Vista de lo que urge cobrar o liberar.
--
-- Es la que evita el peor caso del flujo con tarjeta: que la reserva venza sin
-- capturar. Ahí el cobro se pierde, pero el dinero estuvo retenido en la
-- tarjeta del cliente todo ese tiempo sin cobro ni entrega. Eso es una llamada
-- de reclamo, y encima con razón.
CREATE OR REPLACE VIEW tienda.v_autorizaciones_por_vencer AS
SELECT p.id, p.folio, p.estado, p.metodo_pago,
       p.cliente_nombre, p.cliente_email,
       p.total, p.autorizado_en, p.autorizacion_expira,
       ROUND(EXTRACT(EPOCH FROM (p.autorizacion_expira - NOW())) / 3600, 1) AS horas_para_vencer,
       (p.autorizacion_expira < NOW()) AS vencida,
       p.aviso_vencimiento_en
FROM tienda.pedidos p
WHERE p.autorizacion_expira IS NOT NULL
  AND p.capturado_en IS NULL
  AND p.estado NOT IN ('CANCELADO','ENTREGADO')
ORDER BY p.autorizacion_expira;

GRANT SELECT ON tienda.v_autorizaciones_por_vencer TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON tienda.avisos TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE tienda.avisos_id_seq TO app_runtime;

-- ── Comprobación ────────────────────────────────────────────────────────────
DO $$
DECLARE falta TEXT;
BEGIN
  FOR falta IN
    SELECT c FROM unnest(ARRAY['paqueteria','guia','enviado_en','enviado_por',
                               'aviso_vencimiento_en']) c
    WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='tienda' AND table_name='pedidos' AND column_name = c)
  LOOP
    RAISE EXCEPTION 'Falto crear la columna %', falta;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='tienda' AND table_name='avisos') THEN
    RAISE EXCEPTION 'Falto crear la tabla avisos';
  END IF;
  RAISE NOTICE 'Migracion 005 aplicada correctamente.';
END $$;
