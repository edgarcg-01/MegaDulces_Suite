/**
 * catalogo-kp — tienda pedidos
 *
 * **Portada desde `apps/catalogo-kp/sql/002_tienda_pedidos.sql` (CV.22, review del PR #62).**
 * tienda.* — ledger de pedidos de la tienda mayorista + cola de trabajos.
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
--  Fase 2 — Modelo de pedidos de la tienda en línea
--
--  Esquema propio (tienda), separado de kp. Razón de fondo: kp es una COPIA
--  de Kepler que el pipeline reescribe cada hora. Los pedidos son el único
--  dato del que este sistema es dueño, así que no pueden vivir ahí.
--
--  Decisiones que este modelo materializa (ver PLAN_TIENDA_EN_LINEA en Drive):
--    · Pedido por confirmar: la sucursal valida existencia antes de cobrar.
--    · Autorizar al comprar, capturar al confirmar.
--
--  Es agnóstico de la pasarela: los campos de pago guardan referencias, no
--  estructuras de un proveedor. Elegir Mercado Pago, Conekta o Stripe después
--  no obliga a cambiar el esquema.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS tienda;

-- ── Estados ─────────────────────────────────────────────────────────────────
-- Se usa un dominio con CHECK y no un ENUM: agregar un estado a un ENUM en
-- PostgreSQL no se puede revertir dentro de una transacción, y este flujo va
-- a cambiar en los primeros meses.
CREATE TABLE IF NOT EXISTS tienda.estados (
  estado      TEXT PRIMARY KEY,
  descripcion TEXT NOT NULL,
  orden       INT  NOT NULL,
  es_final    BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO tienda.estados (estado, descripcion, orden, es_final) VALUES
  ('CARRITO',                'El cliente aún está armando el pedido',                 0, FALSE),
  ('PENDIENTE_CONFIRMACION', 'Pago autorizado. La sucursal debe validar existencia',  1, FALSE),
  ('CONFIRMADO',             'Existencia validada y pago capturado',                  2, FALSE),
  ('EN_PREPARACION',         'Se está surtiendo',                                     3, FALSE),
  ('LISTO_PARA_RECOGER',     'Esperando al cliente en la sucursal',                   4, FALSE),
  ('ENVIADO',                'Entregado a la paquetería',                             4, FALSE),
  ('ENTREGADO',              'En manos del cliente',                                  5, TRUE),
  ('CANCELADO',              'Cancelado: sin existencia, expiró, o lo pidió el cliente', 9, TRUE)
ON CONFLICT (estado) DO NOTHING;

-- ── Pedidos ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tienda.pedidos (
  id              BIGSERIAL PRIMARY KEY,
  folio           TEXT UNIQUE,               -- visible al cliente; se asigna al autorizar
  estado          TEXT NOT NULL DEFAULT 'CARRITO' REFERENCES tienda.estados(estado),

  -- Quién compra. Sin cuenta obligatoria: el correo identifica.
  cliente_nombre  TEXT,
  cliente_email   TEXT,
  cliente_tel     TEXT,

  -- Qué sucursal surte. Es el precio y la existencia que aplican, porque 725
  -- códigos cuestan distinto según la plaza.
  sucursal        TEXT NOT NULL,

  entrega         TEXT NOT NULL DEFAULT 'RECOGER'
                    CHECK (entrega IN ('RECOGER','ENVIO')),
  direccion       JSONB,                     -- sólo si entrega = ENVIO

  -- Importes. NUMERIC, nunca float: con dinero, 0.1+0.2 no puede dar 0.30000000000000004.
  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
  envio           NUMERIC(12,2) NOT NULL DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- ── Pago: agnóstico de proveedor ─────────────────────────────────────────
  pago_proveedor  TEXT,                      -- 'mercadopago' | 'conekta' | ...
  pago_referencia TEXT,                      -- id de la autorización en la pasarela
  autorizado_en   TIMESTAMPTZ,
  -- Fecha en que la retención de la tarjeta deja de ser válida. Si se pasa,
  -- se pierde el cobro y hay que pedirle al cliente que pague otra vez: por eso
  -- el pedido debe confirmarse ANTES de esta fecha.
  autorizacion_expira TIMESTAMPTZ,
  capturado_en    TIMESTAMPTZ,
  monto_capturado NUMERIC(12,2),             -- puede ser menor: captura parcial si se surte incompleto

  -- ── Reloj de confirmación ────────────────────────────────────────────────
  -- Sin esto los pedidos sin atender se acumulan en silencio, que es el modo
  -- de falla que ya costó caro en este sistema.
  confirmar_antes_de TIMESTAMPTZ,
  confirmado_por   TEXT,                     -- correo de quien confirmó
  confirmado_en    TIMESTAMPTZ,

  cancelado_motivo TEXT,
  notas_internas   TEXT,

  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_pedidos_estado    ON tienda.pedidos (estado);
CREATE INDEX IF NOT EXISTS ix_pedidos_sucursal  ON tienda.pedidos (sucursal, estado);
CREATE INDEX IF NOT EXISTS ix_pedidos_email     ON tienda.pedidos (LOWER(cliente_email));
-- Para la pantalla de confirmación: lo que urge, primero lo que expira antes.
CREATE INDEX IF NOT EXISTS ix_pedidos_por_confirmar
  ON tienda.pedidos (confirmar_antes_de)
  WHERE estado = 'PENDIENTE_CONFIRMACION';

-- ── Partidas ────────────────────────────────────────────────────────────────
-- El precio se congela al momento de la compra. No se puede recalcular después
-- desde kp: los precios cambian y el cliente pagó los de su momento.
CREATE TABLE IF NOT EXISTS tienda.pedido_items (
  id            BIGSERIAL PRIMARY KEY,
  pedido_id     BIGINT NOT NULL REFERENCES tienda.pedidos(id) ON DELETE CASCADE,

  codigo        TEXT NOT NULL,               -- kp.kdii.c1
  nombre        TEXT NOT NULL,               -- copiado, no referenciado
  unidad        TEXT NOT NULL,               -- PZA | PAQ | CJA ...
  piezas_por_unidad NUMERIC(12,3) NOT NULL DEFAULT 1,

  cantidad      NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),
  precio_unitario NUMERIC(12,2) NOT NULL,    -- congelado al comprar
  importe       NUMERIC(12,2) NOT NULL,

  -- Existencia que el cliente vio. Sirve para saber si el oversell venía de
  -- datos viejos o de una venta simultánea en mostrador.
  existencia_al_comprar NUMERIC(12,3),

  -- Lo que la sucursal pudo surtir. NULL mientras no se confirma.
  cantidad_surtida NUMERIC(12,3),

  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_items_pedido ON tienda.pedido_items (pedido_id);
CREATE INDEX IF NOT EXISTS ix_items_codigo ON tienda.pedido_items (codigo);

-- ── Bitácora ────────────────────────────────────────────────────────────────
-- Hay dinero de por medio: cada cambio de estado queda registrado con quién y
-- por qué. Nunca se borra ni se actualiza.
CREATE TABLE IF NOT EXISTS tienda.pedido_eventos (
  id          BIGSERIAL PRIMARY KEY,
  pedido_id   BIGINT NOT NULL REFERENCES tienda.pedidos(id) ON DELETE CASCADE,
  estado_de   TEXT,
  estado_a    TEXT NOT NULL,
  actor       TEXT NOT NULL,                 -- correo, 'sistema', o el nombre de la pasarela
  detalle     TEXT,
  datos       JSONB,                         -- respuesta cruda de la pasarela, para auditar
  ocurrio_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_eventos_pedido ON tienda.pedido_eventos (pedido_id, ocurrio_en);

-- ── Cola de trabajos ────────────────────────────────────────────────────────
-- Aquí sí hace falta una cola: un webhook de pago no se puede perder porque la
-- API se estaba reiniciando. Es una tabla y un worker, no Redis ni RabbitMQ:
-- 600 pedidos al mes no justifican otro servicio que mantener con 2 personas.
CREATE TABLE IF NOT EXISTS tienda.trabajos (
  id            BIGSERIAL PRIMARY KEY,
  tipo          TEXT NOT NULL,               -- 'webhook_pago' | 'correo' | 'factura' ...
  carga         JSONB NOT NULL,
  estado        TEXT NOT NULL DEFAULT 'PENDIENTE'
                  CHECK (estado IN ('PENDIENTE','PROCESANDO','HECHO','FALLIDO')),
  intentos      INT NOT NULL DEFAULT 0,
  max_intentos  INT NOT NULL DEFAULT 5,
  ultimo_error  TEXT,
  -- Reintento con espera creciente: se procesa cuando llega esta hora.
  correr_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  terminado_en  TIMESTAMPTZ
);

-- El worker toma trabajos con FOR UPDATE SKIP LOCKED sobre este índice.
CREATE INDEX IF NOT EXISTS ix_trabajos_pendientes
  ON tienda.trabajos (correr_en)
  WHERE estado = 'PENDIENTE';

-- Evita procesar dos veces el mismo aviso de la pasarela si lo reenvía.
CREATE UNIQUE INDEX IF NOT EXISTS ux_trabajos_idempotencia
  ON tienda.trabajos (tipo, (carga->>'idempotencia'))
  WHERE carga ? 'idempotencia';

-- ── actualizado_en automático ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tienda.tocar_actualizado()
RETURNS TRIGGER AS $$
BEGIN
  NEW.actualizado_en := NOW();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_pedidos_actualizado ON tienda.pedidos;
CREATE TRIGGER tr_pedidos_actualizado
  BEFORE UPDATE ON tienda.pedidos
  FOR EACH ROW EXECUTE FUNCTION tienda.tocar_actualizado();

-- ── Permisos ────────────────────────────────────────────────────────────────
-- app_runtime escribe en tienda porque es el dueño de estos datos, pero SIGUE
-- siendo de sólo lectura sobre kp. Esa frontera es la protección principal:
-- una API comprometida no puede alterar Kepler.
GRANT USAGE ON SCHEMA tienda TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA tienda TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA tienda TO app_runtime;
-- Sin DELETE a propósito: los pedidos se cancelan, no se borran.
ALTER DEFAULT PRIVILEGES IN SCHEMA tienda
  GRANT SELECT, INSERT, UPDATE ON TABLES TO app_runtime;

-- ── Vista para la pantalla de confirmación ──────────────────────────────────
CREATE OR REPLACE VIEW tienda.v_por_confirmar AS
SELECT p.id, p.folio, p.sucursal, p.cliente_nombre, p.cliente_email,
       p.total, p.creado_en, p.confirmar_antes_de,
       p.autorizacion_expira,
       ROUND(EXTRACT(EPOCH FROM (p.confirmar_antes_de - NOW()))/3600, 1) AS horas_para_confirmar,
       (p.confirmar_antes_de < NOW())                                    AS vencido,
       (SELECT COUNT(*) FROM tienda.pedido_items i WHERE i.pedido_id = p.id) AS partidas
FROM tienda.pedidos p
WHERE p.estado = 'PENDIENTE_CONFIRMACION'
ORDER BY p.confirmar_antes_de;

GRANT SELECT ON tienda.v_por_confirmar TO app_runtime;`);
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
