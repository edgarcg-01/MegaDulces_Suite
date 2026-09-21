'use strict';
/**
 * `[FLT.0]` — `commercial.floor_stockouts`: la venta que NO ocurrió, reportada desde el piso.
 *
 * ── Por qué existe una tabla y no una vista ─────────────────────────────────────────────────
 * La regla dura del proyecto es que todo dato sale del ODS y se DERIVA (vista), nunca se copia.
 * Esta tabla es la excepción que la propia regla nombra: **dato propio capturado por una persona
 * (HITL)**. Y es la excepción por una razón estructural, no por comodidad:
 *
 *   > Una venta que no ocurrió no deja rastro en NINGUNA fuente. No hay ticket, no hay movimiento,
 *   > no hay renglón en `kepler_ods`. El cliente preguntó, no lo había, y se fue. El único
 *   > instrumento capaz de registrar ese hecho es la persona que estaba en el mostrador.
 *
 * Por eso no se puede derivar y por eso hay tabla. Lo que SÍ se deriva (existencia teórica al
 * momento, precio para valorar) se lee del ODS en el momento de la captura y se guarda como
 * **snapshot**, para que la bandeja se lea sin joins y para poder contrastar después lo que el
 * sistema creía contra lo que la persona vio.
 *
 * ── Los cuatro motivos, que NO son el mismo hecho ───────────────────────────────────────────
 *   · `agotado`         — lo vendemos, se acabó en esta sucursal. El sistema PUEDE verlo
 *                         (barrido nocturno de reabasto). Valor agregado: si el ODS dice que hay
 *                         existencia y la persona vio cero, eso es un **descuadre de inventario**,
 *                         no un aviso de compra. Son dos destinos distintos y por eso se guarda
 *                         `on_hand_at_report`.
 *   · `no_en_sucursal`  — existe en el catálogo, esta plaza no lo maneja. Señal de surtido.
 *   · `no_en_catalogo`  — **nadie lo compra nunca**. Es el motivo que ninguna fuente puede ver.
 *                         `product_id` va NULL y lo que queda es lo que la persona escribió.
 *   · `codigo_no_pasa`  — el código EXISTE en el catálogo y el escaneo falló igual (etiqueta
 *                         borrada, granel reempacado, código impreso distinto al de Kepler).
 *                         Medido 2026-09-19: los SKU **sin** código son 139 (1.5% del catálogo) y
 *                         valen **0.01% de la venta** de 90 días ($3,130 de $45.7M) — y la mayoría
 *                         ni son mercancía (códigos de promo, etiquetas de anaquel). O sea: la
 *                         lista útil para la caja NO es "los que no tienen código", es **ésta**,
 *                         la de los que de verdad fallan al escanear. Hoy ese intento se evapora.
 *
 * ── Grano: una fila por (sucursal, motivo, cosa, SEMANA) ────────────────────────────────────
 * No una fila por reporte. Si el mismo producto lo piden nueve veces, **la señal es el nueve**,
 * no nueve renglones que nadie lee. `times_reported` se incrementa por UPSERT idempotente sobre
 * `(tenant_id, dedup_key)`, igual que `commercial.receiving_claims` (WMS-REC.8) y
 * `commercial.replenishment_findings` (RA.8), que son las dos bandejas hermanas.
 *
 * ⚠️ **Un re-reporte NO reabre una fila ya resuelta, a propósito.** La semana siguiente genera una
 * fila nueva —y por lo tanto una decisión nueva—, así que el ciclo ya tiene su reloj. Dentro de la
 * misma semana, que el contador siga subiendo sobre una fila resuelta es información valiosa
 * ("se decidió y sigue pasando"), no un estado que haya que revertir.
 *
 * ── Valorar lo no vendido ───────────────────────────────────────────────────────────────────
 * `est_lost_revenue` = precio de venta del momento × `times_reported`. Es una **estimación para
 * priorizar**, y está etiquetada como tal en `est_source`. Cuando no hay precio con el que
 * valorar (típicamente `no_en_catalogo`, que por definición no tiene precio nuestro) queda
 * **NULL con `est_source='sin_dato'`** — nunca $0. Un cero dibujado se lee igual que "no vale
 * nada", que es justo la conclusión contraria a la verdadera (ADR-056).
 *
 * ── Sin sesión ──────────────────────────────────────────────────────────────────────────────
 * El kiosco de mostrador corre sin cuenta (mismo caso que el verificador, `[CV.24]`). Por eso
 * `reported_by` es NULLABLE y la sucursal llega por `warehouse_id`, no deducida del usuario.
 * Pedir login mataría los 5 segundos que este flujo tiene para existir, y un faltante sin nombre
 * sigue siendo un faltante.
 *
 * Aditiva e idempotente. RLS forzado + grant `app_runtime`. FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  if (await knex.schema.withSchema('commercial').hasTable('floor_stockouts')) return;

  await knex.raw(`
    CREATE TABLE commercial.floor_stockouts (
      id                    uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id             uuid NOT NULL,

      -- Dónde. Nunca deducida del usuario: el kiosco no tiene sesión.
      warehouse_id          uuid NOT NULL,

      -- Qué. 'product_id' NULL = no está en el catálogo (el caso que ninguna fuente ve).
      product_id            uuid,
      sku                   varchar(40),
      scanned_code          varchar(60),      -- lo que leyó el lector, aunque no haya resuelto
      product_name          varchar(200),     -- snapshot del catálogo, o lo que escribió la persona

      kind                  varchar(20) NOT NULL,

      -- Grano semanal (lunes de la semana del reporte, TZ MX resuelta en el service).
      week_start            date NOT NULL,
      times_reported        integer NOT NULL DEFAULT 1,
      first_reported_at     timestamptz NOT NULL DEFAULT now(),
      last_reported_at      timestamptz NOT NULL DEFAULT now(),

      -- De qué pantalla salió. Sirve para saber cuál superficie realmente se usa.
      source                varchar(16) NOT NULL DEFAULT 'verificador',
      reported_by           uuid,
      reported_by_username  varchar(80),

      -- Lo que el sistema CREÍA en ese momento. Es el insumo del cruce contra inventario:
      -- persona ve 0 + ODS dice 12 => descuadre, no compra. NULL = no se pudo leer (se declara).
      on_hand_at_report     numeric(14,3),

      -- Valoración (estimación para priorizar, etiquetada)
      unit_price            numeric(14,4),
      est_lost_revenue      numeric(14,2),
      est_source            varchar(12) NOT NULL DEFAULT 'sin_dato',

      -- Decisión de Compras
      status                varchar(16) NOT NULL DEFAULT 'open',
      decision              varchar(24),
      decision_note         text,
      decided_at            timestamptz,
      decided_by            uuid,
      decided_by_username   varchar(80),

      dedup_key             text NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, dedup_key),

      CONSTRAINT commercial_floor_stockouts_kind_chk
        CHECK (kind IN ('agotado','no_en_sucursal','no_en_catalogo','codigo_no_pasa')),
      CONSTRAINT commercial_floor_stockouts_source_chk
        CHECK (source IN ('verificador','almacen','caja','otro')),
      CONSTRAINT commercial_floor_stockouts_status_chk
        CHECK (status IN ('open','in_progress','resolved','dismissed')),
      CONSTRAINT commercial_floor_stockouts_decision_chk
        CHECK (decision IS NULL OR decision IN
          ('alta_catalogo','ya_en_camino','no_se_trabaja','codigo_corregido','era_error')),
      CONSTRAINT commercial_floor_stockouts_est_src_chk
        CHECK (est_source IN ('precio_erp','sin_dato')),
      -- Un reporte de 0 veces no es un reporte.
      CONSTRAINT commercial_floor_stockouts_times_chk
        CHECK (times_reported > 0),
      -- Sin precio no hay valoración, y sin valoración la fuente TIENE que decir 'sin_dato'.
      -- Esto es lo que impide que un NULL se cuele publicado como si fuera una cifra medida.
      CONSTRAINT commercial_floor_stockouts_est_coherencia_chk
        CHECK ((est_source = 'precio_erp' AND est_lost_revenue IS NOT NULL)
            OR (est_source = 'sin_dato'   AND est_lost_revenue IS NULL)),
      -- 'no_en_catalogo' es, por definición, lo que NO tiene producto nuestro. Si alguien manda
      -- un product_id con ese motivo, el motivo está mal elegido y la bandeja mentiría.
      CONSTRAINT commercial_floor_stockouts_sin_catalogo_chk
        CHECK (kind <> 'no_en_catalogo' OR product_id IS NULL),
      -- Una fila decidida tiene que decir QUÉ se decidió, y una sin decidir no puede traer
      -- decisión colgada. El estado y la decisión son la misma afirmación vista dos veces.
      CONSTRAINT commercial_floor_stockouts_decision_coherencia_chk
        CHECK ((status IN ('resolved','dismissed') AND decision IS NOT NULL)
            OR (status IN ('open','in_progress')   AND decision IS NULL)),

      CONSTRAINT fk_commercial_floor_stockouts_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT fk_commercial_floor_stockouts_warehouse
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT,
      -- 'SET NULL (columna)' y no 'SET NULL' pelado: en una FK COMPUESTA el pelado intenta anular
      -- las DOS columnas y 'tenant_id' es NOT NULL -> borrar un producto reventaría con
      -- "null value in column tenant_id". Vivido en 'receiving_claims'. El reporte sobrevive
      -- legible igual: 'sku' y 'product_name' son snapshots, no joins.
      CONSTRAINT fk_commercial_floor_stockouts_product
        FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products (tenant_id, id) ON DELETE SET NULL (product_id)
    )`);

  // Bandeja de Compras: lo abierto primero, y dentro de eso lo que más dinero vale.
  // 'est_lost_revenue' NULLS LAST porque lo no valorado no debe encabezar la cola.
  await knex.raw(`
    CREATE INDEX ix_floor_stockouts_bandeja
      ON commercial.floor_stockouts (tenant_id, status, est_lost_revenue DESC NULLS LAST)`);
  // Pantalla de la sucursal: "lo que reporté esta semana".
  await knex.raw(`
    CREATE INDEX ix_floor_stockouts_sucursal
      ON commercial.floor_stockouts (tenant_id, warehouse_id, week_start DESC)`);
  // La herramienta de caja: los códigos que más fallan en esta plaza.
  await knex.raw(`
    CREATE INDEX ix_floor_stockouts_codigo_no_pasa
      ON commercial.floor_stockouts (tenant_id, warehouse_id, times_reported DESC)
      WHERE kind = 'codigo_no_pasa'`);
  // Cruce con reabasto / inventario por producto.
  await knex.raw(`
    CREATE INDEX ix_floor_stockouts_producto
      ON commercial.floor_stockouts (tenant_id, product_id, status)
      WHERE product_id IS NOT NULL`);

  await knex.raw(`
    COMMENT ON TABLE commercial.floor_stockouts IS
      '[FLT.0] La venta que NO ocurrio, reportada desde el piso (kiosco de mostrador, entrada de almacen, caja). '
      'Dato propio HITL: ningun feed puede verlo porque una venta que no paso no deja rastro. '
      'Grano (sucursal, motivo, cosa, SEMANA) con contador; UPSERT por (tenant, dedup_key).'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.floor_stockouts.on_hand_at_report IS
      'Existencia teorica del ODS al momento del reporte. Persona ve 0 + sistema dice 12 = descuadre de inventario, NO aviso de compra. NULL = no se pudo leer.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.floor_stockouts.est_lost_revenue IS
      'ESTIMACION para priorizar (precio del momento x veces). NULL con est_source=sin_dato cuando no hay precio: nunca 0 (ADR-056).'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.floor_stockouts.kind IS
      'agotado=lo vendemos y se acabo · no_en_sucursal=existe pero esta plaza no lo maneja · no_en_catalogo=nadie lo compra nunca (product_id NULL) · codigo_no_pasa=el codigo existe y el escaneo fallo igual'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.floor_stockouts.reported_by IS
      'NULLABLE a proposito: el kiosco de mostrador corre sin sesion (mismo caso que el verificador, CV.24). Un faltante sin nombre sigue siendo un faltante.'`);

  await knex.raw(`ALTER TABLE commercial.floor_stockouts ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.floor_stockouts FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.floor_stockouts`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.floor_stockouts
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.floor_stockouts TO app_runtime`);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('floor_stockouts');
};
