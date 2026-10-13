'use strict';
/**
 * `[AB.18]` «Mi pedido» v2 — el pedido de la sucursal se ajusta y se guarda EN LA SUITE, y cada
 * decisión deja huella. Etapa 1 de 4 (decisión de Francisco, 2026-10-12): sin Excel ni papel; el
 * sistema arma el pedido, el almacenista sólo corrige excepciones con − / + y motivo, y la huella
 * alimenta el aprendizaje (etapa 4). El envío a la matriz / Compras es la etapa 2.
 *
 * ── Por qué tablas y no una vista ───────────────────────────────────────────────────────────
 * Es dato PROPIO HITL (lo que decide una persona), que la regla principal del proyecto permite
 * materializar: ningún feed puede derivar «el almacenista bajó el agua a 100 cajas porque no tiene
 * espacio». El SUGERIDO no se guarda como verdad: se recalcula del motor y sólo se fotografía al
 * lado de la decisión, para medir después cuánto se desvió la persona y si acertó.
 *
 * ── Tres tablas ─────────────────────────────────────────────────────────────────────────────
 *  · `autoabasto_pedidos` — el pedido de un almacén. Un solo BORRADOR vivo por almacén (índice
 *    único parcial): dos borradores del mismo almacén serían dos verdades del mismo pedido.
 *  · `autoabasto_pedido_lineas` — SOLO los renglones que la persona tocó. Lo no tocado es el
 *    sugerido del motor; guardar todo duplicaría el cálculo y envejecería con el día.
 *  · `autoabasto_huella` — cada acción (abrir, ajustar, restablecer, aceptar grupo…), con el
 *    sugerido que vio, lo que dejó, el motivo y cuánto tardó. Sólo se inserta: es la materia prima
 *    del aprendizaje y no se reescribe.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-12) ───────────────────────────────────────
 *  · `almacenista` (7 personas) tiene AUTOABASTO_VER pero AUTOABASTO_SOLICITAR está VACÍO en su
 *    rol: hoy no podría guardar ningún ajuste, y el módulo es principalmente para él (pedido de
 *    Francisco). Esta migración se lo da. `encargado_tienda` ya lo tiene.
 *
 * ⚠️ Crea tablas: la compuerta del despliegue la mide. Aun así va ANTES del código (el código
 *    escribe en estas tablas).
 *
 * Idempotente. RLS forzado + grant `app_runtime`. FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

const MOTIVOS = ['espacio_bodega', 'promocion_proxima', 'cliente_aparto', 'producto_lento',
  'caducidad', 'exhibicion', 'otro'];
const NOTA_PERMISO = '[AB.18] almacenista prepara su pedido en Autoabasto';

const rls = async (knex, tabla) => {
  await knex.raw(`ALTER TABLE commercial.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.${tabla}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const lista = MOTIVOS.map((m) => `'${m}'`).join(',');

  if (!(await knex.schema.withSchema('commercial').hasTable('autoabasto_pedidos'))) {
    await knex.raw(`
      CREATE TABLE commercial.autoabasto_pedidos (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        warehouse_id          uuid NOT NULL,
        estado                varchar(16) NOT NULL DEFAULT 'borrador',
        -- Con qué se calculó el sugerido (base del objetivo, cobertura, ventanas): para comparar
        -- después contra lo que el motor dice con otra versión, no contra un recuerdo.
        motor                 jsonb NOT NULL DEFAULT '{}'::jsonb,
        -- [AB.19] Hasta dónde pide el almacenista: sólo agotado, + bajo mínimo, + bajo reorden…
        -- Es parte de la decisión (y del aprendizaje), no un filtro de pantalla.
        posiciones            text[] NOT NULL DEFAULT ARRAY['agotado','bajo_minimo','bajo_reorden']::text[],
        abierto_por           uuid,
        abierto_por_username  varchar(80),
        enviado_at            timestamptz,
        enviado_por           uuid,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT commercial_autoabasto_pedidos_estado_chk CHECK (estado IN ('borrador','enviado','cancelado')),
        CONSTRAINT commercial_autoabasto_pedidos_posiciones_chk
          CHECK (posiciones <@ ARRAY['agotado','bajo_minimo','bajo_reorden','otros']::text[]),
        -- Un pedido enviado dice cuándo; uno sin enviar no puede traer fecha de envío colgada.
        CONSTRAINT commercial_autoabasto_pedidos_envio_chk
          CHECK ((estado = 'enviado') = (enviado_at IS NOT NULL)),
        CONSTRAINT fk_commercial_autoabasto_pedidos_tenant
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
        CONSTRAINT fk_commercial_autoabasto_pedidos_warehouse
          FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`
      CREATE UNIQUE INDEX ux_autoabasto_pedidos_borrador
        ON commercial.autoabasto_pedidos (tenant_id, warehouse_id) WHERE estado = 'borrador'`);
    await knex.raw(`
      COMMENT ON TABLE commercial.autoabasto_pedidos IS
        '[AB.18] Pedido de una sucursal en Autoabasto. Un solo borrador vivo por almacen. Dato propio HITL.'`);
    await rls(knex, 'autoabasto_pedidos');
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.autoabasto_pedidos TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('commercial').hasTable('autoabasto_pedido_lineas'))) {
    await knex.raw(`
      CREATE TABLE commercial.autoabasto_pedido_lineas (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        pedido_id             uuid NOT NULL,
        product_id            uuid NOT NULL,
        sku                   varchar(40),
        origen_tipo           varchar(12) NOT NULL,
        origen_clave          varchar(64),
        -- Lo que el motor propuso CUANDO la persona decidió (foto, no verdad).
        sugerido              numeric(14,3) NOT NULL,
        sugerido_unidad       varchar(12),
        sugerido_base         numeric(14,3) NOT NULL,
        -- Lo que la persona dejó.
        cantidad              numeric(14,3) NOT NULL,
        unidad                varchar(12),
        cantidad_base         numeric(14,3) NOT NULL,
        motivo                varchar(24),
        -- Lo que la persona tenía enfrente: venta 30 d, existencia, ya pedido, negado, regla…
        contexto              jsonb NOT NULL DEFAULT '{}'::jsonb,
        ajustado_por          uuid,
        ajustado_por_username varchar(80),
        ajustado_at           timestamptz NOT NULL DEFAULT now(),
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, pedido_id, product_id),
        CONSTRAINT commercial_autoabasto_lineas_origen_chk CHECK (origen_tipo IN ('matriz','proveedor','sin_ruta')),
        CONSTRAINT commercial_autoabasto_lineas_cantidad_chk CHECK (cantidad >= 0 AND cantidad_base >= 0),
        CONSTRAINT commercial_autoabasto_lineas_motivo_chk CHECK (motivo IS NULL OR motivo IN (${lista})),
        CONSTRAINT fk_commercial_autoabasto_lineas_pedido
          FOREIGN KEY (tenant_id, pedido_id) REFERENCES commercial.autoabasto_pedidos (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT fk_commercial_autoabasto_lineas_product
          FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`
      COMMENT ON TABLE commercial.autoabasto_pedido_lineas IS
        '[AB.18] Solo los renglones que la persona ajusto. Lo no tocado es el sugerido del motor.'`);
    await rls(knex, 'autoabasto_pedido_lineas');
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.autoabasto_pedido_lineas TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('commercial').hasTable('autoabasto_huella'))) {
    await knex.raw(`
      CREATE TABLE commercial.autoabasto_huella (
        id               bigint GENERATED ALWAYS AS IDENTITY,
        tenant_id        uuid NOT NULL,
        warehouse_id     uuid NOT NULL,
        pedido_id        uuid,
        product_id       uuid,
        evento           varchar(20) NOT NULL,
        sugerido         numeric(14,3),
        antes            numeric(14,3),
        despues          numeric(14,3),
        unidad           varchar(12),
        motivo           varchar(24),
        -- Cuánto tardó la persona en el renglón antes de decidir. NULL = no se pudo medir.
        ms_en_renglon    integer,
        user_id          uuid,
        username         varchar(80),
        datos            jsonb NOT NULL DEFAULT '{}'::jsonb,
        at               timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT commercial_autoabasto_huella_evento_chk
          CHECK (evento IN ('abrir','ajustar','restablecer','aceptar_grupo','posiciones','enviar','recalcular')),
        CONSTRAINT commercial_autoabasto_huella_motivo_chk CHECK (motivo IS NULL OR motivo IN (${lista})),
        CONSTRAINT commercial_autoabasto_huella_ms_chk CHECK (ms_en_renglon IS NULL OR ms_en_renglon >= 0),
        CONSTRAINT fk_commercial_autoabasto_huella_tenant
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
        CONSTRAINT fk_commercial_autoabasto_huella_warehouse
          FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT
      )`);
    // Los dos accesos del aprendizaje: la historia de un almacén y la de un producto.
    await knex.raw(`CREATE INDEX ix_autoabasto_huella_almacen ON commercial.autoabasto_huella (tenant_id, warehouse_id, at DESC)`);
    await knex.raw(`CREATE INDEX ix_autoabasto_huella_producto ON commercial.autoabasto_huella (tenant_id, product_id, at DESC) WHERE product_id IS NOT NULL`);
    await knex.raw(`
      COMMENT ON TABLE commercial.autoabasto_huella IS
        '[AB.18] Huella de cada decision en Mi pedido (sugerido visto, lo que quedo, motivo, tiempo). Solo se inserta: es la materia prima del aprendizaje.'`);
    await rls(knex, 'autoabasto_huella');
    await knex.raw(`GRANT SELECT, INSERT ON commercial.autoabasto_huella TO app_runtime`);
  }
  // Fuera del `if`: el privilegio por omisión del esquema `commercial` le da a `app_runtime`
  // UPDATE y DELETE en toda tabla nueva (medido en Docker: `{app_runtime=arwd/postgres}`), así que
  // el GRANT de arriba no alcanza. Sin este REVOKE la huella se podía reescribir.
  await knex.raw(`REVOKE UPDATE, DELETE, TRUNCATE ON commercial.autoabasto_huella FROM app_runtime`);

  // El almacenista prepara su pedido. Sólo donde la clave está VACÍA: un `false` explícito es una
  // decisión guardada desde /admin/roles y no se pisa.
  const r = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"AUTOABASTO_SOLICITAR": true}'::jsonb
      WHERE role_name = 'almacenista'
        AND permissions -> 'AUTOABASTO_SOLICITAR' IS NULL`);
  // eslint-disable-next-line no-console
  console.log(`${NOTA_PERMISO}: ${r.rowCount} rol(es)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.autoabasto_huella`);
  await knex.raw(`DROP TABLE IF EXISTS commercial.autoabasto_pedido_lineas`);
  await knex.raw(`DROP TABLE IF EXISTS commercial.autoabasto_pedidos`);
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - 'AUTOABASTO_SOLICITAR'
      WHERE role_name = 'almacenista' AND (permissions ->> 'AUTOABASTO_SOLICITAR')::boolean IS TRUE`);
};
