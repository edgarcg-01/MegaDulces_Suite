-- ============================================================================
--  Fase 2 — Checkout: método de pago, datos fiscales y aviso de privacidad
--
--  El esquema 002 previó el pago y el envío, pero no tres cosas que el flujo
--  de compra necesita y que salieron al definirlo con Dirección:
--
--    1. QUÉ método de pago eligió el cliente. No es lo mismo que la pasarela:
--       Mercado Pago cobra con tarjeta, OXXO y SPEI, y el flujo del pedido
--       cambia por completo según cuál sea. Con tarjeta se autoriza al comprar
--       y se captura al confirmar; con efectivo no se puede reservar nada, así
--       que el pedido entra sin cobrar y la referencia se envía DESPUÉS de
--       confirmar existencia.
--
--    2. Los DATOS FISCALES. La tienda es de sólo mayoreo, así que los
--       compradores son negocios y casi todos van a querer factura. Como la
--       facturación es manual —se da de alta al cliente en Kepler— hay que
--       capturar los datos en el checkout; si no, quien factura tiene que
--       perseguir al cliente por teléfono.
--
--    3. La aceptación del AVISO DE PRIVACIDAD, con versión y fecha. La ley
--       mexicana exige poder demostrar que el titular consintió. Guardar sólo
--       un booleano no sirve: hay que saber QUÉ texto aceptó y CUÁNDO, porque
--       el aviso cambia con el tiempo.
--
--  CORRER COMO postgres:
--    psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f sql/004_checkout.sql
--  o con ADMINISTRAR.bat, opción 8.
-- ============================================================================

-- ── Método de pago ──────────────────────────────────────────────────────────
ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS metodo_pago TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pedidos_metodo_pago') THEN
    ALTER TABLE tienda.pedidos
      ADD CONSTRAINT ck_pedidos_metodo_pago
      CHECK (metodo_pago IS NULL OR metodo_pago IN ('TARJETA','OXXO','SPEI'));
  END IF;
END $$;

-- ── Facturación ─────────────────────────────────────────────────────────────
-- Los datos van en JSONB y no en columnas sueltas porque el catálogo del SAT
-- cambia (régimen fiscal, uso de CFDI) y no conviene una migración por cada
-- ajuste. Lo que sí es columna es el booleano, porque la pantalla de
-- confirmación filtra por él.
ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS requiere_factura BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS datos_fiscales JSONB;

-- Si el cliente ya existe en Kepler, aquí va su clave. Mientras esté en NULL y
-- requiera factura, es un alta pendiente: eso es lo que distingue al cliente
-- nuevo del recurrente en la pantalla de confirmación.
ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS cliente_kepler TEXT;

-- ── Aviso de privacidad ─────────────────────────────────────────────────────
ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS privacidad_version TEXT;

ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS privacidad_aceptada_en TIMESTAMPTZ;

-- La IP desde la que se aceptó. Es lo que convierte el registro en evidencia
-- si alguna vez hay que demostrar el consentimiento.
ALTER TABLE tienda.pedidos
  ADD COLUMN IF NOT EXISTS privacidad_ip TEXT;

-- ── Folio ───────────────────────────────────────────────────────────────────
-- Consecutivo propio, independiente de los ids internos. El cliente ve el
-- folio, no el id: un id revela cuántos pedidos van y salta si hay huecos.
CREATE SEQUENCE IF NOT EXISTS tienda.folio_seq START 1;
GRANT USAGE, SELECT ON SEQUENCE tienda.folio_seq TO app_runtime;

-- ── Índices del checkout ────────────────────────────────────────────────────
-- Consultar un pedido por su folio es la operación más frecuente del cliente.
CREATE INDEX IF NOT EXISTS ix_pedidos_folio ON tienda.pedidos (folio);

-- Para la vista de "referencia enviada, sin pagar": los pedidos en efectivo
-- que esperan que el cliente vaya a pagar.
CREATE INDEX IF NOT EXISTS ix_pedidos_efectivo_sin_pagar
  ON tienda.pedidos (creado_en)
  WHERE metodo_pago IN ('OXXO','SPEI') AND capturado_en IS NULL;

-- ── Vista: pedidos en efectivo que nadie ha pagado ──────────────────────────
-- La fuga conocida del flujo en efectivo. Un pedido con referencia enviada que
-- nunca se paga no genera ningún error: se queda ahí. Sin esta lista se pierde
-- en silencio, y es dinero que ya estaba decidido a entrar.
CREATE OR REPLACE VIEW tienda.v_efectivo_sin_pagar AS
SELECT p.id, p.folio, p.metodo_pago,
       p.cliente_nombre, p.cliente_email, p.cliente_tel,
       p.total, p.estado, p.creado_en,
       ROUND(EXTRACT(EPOCH FROM (NOW() - p.creado_en)) / 3600, 1) AS horas_sin_pagar
FROM tienda.pedidos p
WHERE p.metodo_pago IN ('OXXO','SPEI')
  AND p.capturado_en IS NULL
  AND p.estado NOT IN ('CANCELADO','CARRITO')
ORDER BY p.creado_en;

GRANT SELECT ON tienda.v_efectivo_sin_pagar TO app_runtime;

-- ── Comprobación ────────────────────────────────────────────────────────────
DO $$
DECLARE faltan TEXT := '';
BEGIN
  FOR faltan IN
    SELECT c FROM unnest(ARRAY['metodo_pago','requiere_factura','datos_fiscales',
                               'cliente_kepler','privacidad_version',
                               'privacidad_aceptada_en','privacidad_ip']) c
    WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='tienda' AND table_name='pedidos'
                        AND column_name = c)
  LOOP
    RAISE EXCEPTION 'Falto crear la columna %', faltan;
  END LOOP;
  RAISE NOTICE 'Migracion 004 aplicada correctamente.';
END $$;
