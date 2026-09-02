-- ============================================================================
--  Fase 2 — Ajustes para el carrito
--
--  El carrito NO necesita tablas nuevas: el esquema 002 ya contempla el estado
--  'CARRITO' en tienda.pedidos, así que un carrito es un pedido que todavía no
--  se autoriza. Esto sólo agrega lo que faltaba para poder operarlo.
--
--  CORRER COMO postgres, no como app_runtime: app_runtime tiene INSERT y
--  UPDATE sobre tienda pero no es dueño de las tablas, así que no puede hacer
--  DDL. Eso es intencional (Fase 0) y no debe cambiarse.
--
--    psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f sql/003_carrito.sql
-- ============================================================================

-- ── Quitar un renglón del carrito ───────────────────────────────────────────
-- app_runtime no tiene DELETE, y a propósito: los pedidos se cancelan, no se
-- borran. Pero un carrito sí necesita quitar renglones.
--
-- Se resuelve con borrado lógico en vez de aflojar los permisos. Dos ventajas
-- sobre conceder DELETE: la frontera de seguridad no se toca, y queda registro
-- de lo que el cliente sacó del carrito, que es justo lo que el departamento
-- de e-commerce necesita para entender por qué un pedido no se cerró.
--
-- No se puede usar cantidad = 0 como marca: la tabla tiene CHECK (cantidad > 0).
ALTER TABLE tienda.pedido_items
  ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE;

-- Las consultas del carrito siempre filtran por activo.
CREATE INDEX IF NOT EXISTS ix_items_pedido_activo
  ON tienda.pedido_items (pedido_id) WHERE activo;

-- ── Limpieza de carritos abandonados ────────────────────────────────────────
-- Un carrito que nadie retomó no es un pedido y no debe acumularse para
-- siempre. El índice permite encontrarlos rápido sin recorrer la tabla.
CREATE INDEX IF NOT EXISTS ix_pedidos_carritos
  ON tienda.pedidos (actualizado_en) WHERE estado = 'CARRITO';

-- ── Vista de carritos abandonados ───────────────────────────────────────────
-- Para el departamento de e-commerce: un carrito con productos que lleva días
-- parado es una venta que estuvo a punto de ocurrir. Con perfil de
-- telemarketing en el equipo, esto es material de trabajo, no estadística.
CREATE OR REPLACE VIEW tienda.v_carritos_abandonados AS
SELECT p.id,
       p.cliente_nombre,
       p.cliente_email,
       p.cliente_tel,
       p.subtotal,
       p.creado_en,
       p.actualizado_en,
       ROUND(EXTRACT(EPOCH FROM (NOW() - p.actualizado_en)) / 3600, 1) AS horas_parado,
       (SELECT COUNT(*)      FROM tienda.pedido_items i
         WHERE i.pedido_id = p.id AND i.activo)                        AS partidas,
       (SELECT SUM(i.importe) FROM tienda.pedido_items i
         WHERE i.pedido_id = p.id AND i.activo)                        AS importe
FROM tienda.pedidos p
WHERE p.estado = 'CARRITO'
  AND EXISTS (SELECT 1 FROM tienda.pedido_items i
               WHERE i.pedido_id = p.id AND i.activo)
ORDER BY p.actualizado_en DESC;

GRANT SELECT ON tienda.v_carritos_abandonados TO app_runtime;

-- Confirmación de que corrió completo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='tienda' AND table_name='pedido_items'
                   AND column_name='activo') THEN
    RAISE EXCEPTION 'La columna activo no se creo';
  END IF;
  RAISE NOTICE 'Migracion 003 aplicada correctamente.';
END $$;
