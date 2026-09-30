'use strict';
/**
 * `[BP.1]` — `commercial.pos_line_voids`: el renglón que el cajero quitó del ticket.
 *
 * ── Por qué una tabla y no una vista ────────────────────────────────────────────────────────
 * Misma excepción que nombra la regla dura del proyecto —dato propio capturado por una persona—
 * y por la misma razón estructural. Medido el 2026-09-28 contra las 9 ramas y en vivo en una caja:
 *
 *   > Kepler autentica el borrado con un supervisor y después NO LO ESCRIBE EN NINGÚN LADO.
 *   > `pv_aut_cambios.kpl` abre `kdpv_gerentes` y `kdpv_kdku` sólo para validar la contraseña —
 *   > cero escrituras. `elimina_prod()` marca la celda EN MEMORIA ("ELIMINADO" + la descripción)
 *   > y `pv_tk.kpl` línea 1335 impide grabar cualquier renglón en cantidad 0, así que la marca
 *   > nunca llega a la base. El renglón quitado no deja ticket, ni movimiento, ni bitácora.
 *
 * Cinco mediciones lo respaldan: 0 huecos de numeración en 5,237 tickets · 5,239/5,239 cuadran
 * al centavo · 0 folios faltantes en 21,213 tickets · **0 coincidencias de "ELIMINADO" en las 46
 * columnas de texto de `kdm2`** · y un barrido de 323 tablas antes/después de un borrado real en
 * el que sólo se movió lo de vender. Detalle en `FASE_BP_BITACORA_POS.md`.
 *
 * ⛔ Y no hay interruptor: `md.kdconfig` trae el catálogo COMPLETO de 48 parámetros (5 con valor
 * vacío pero presentes como fila), 19 de la sección `POS`, y ninguno es de bitácora. Existe
 * `POS.k_passRow` = "contraseña de supervisor para eliminar un registro del grid": Kepler
 * CONTROLA el evento pero no lo ANOTA.
 *
 * ── Grano: una fila por EVENTO, y acá se separa de su hermana `floor_stockouts` ──────────────
 * `floor_stockouts` agrega por semana porque ahí la señal es "cuántas veces pidieron esto".
 * Acá NO: cada retiro es un acto individual de una persona con nombre, autorizado por otra
 * persona con nombre, sobre dinero concreto. Agregarlo destruiría justo lo que lo hace auditable.
 * Sin `dedup_key`, sin UPSERT: una fila, un hecho.
 *
 * ── `occurred_at` y `reported_at` son dos cosas distintas, a propósito ──────────────────────
 * La captura ocurre segundos o minutos después del hecho, y **esa distancia es información**:
 * un registro capturado tres horas más tarde vale menos que uno capturado en el momento. Guardar
 * un solo timestamp borraría esa diferencia para siempre.
 *
 * ── `motivo = 'otro'` obliga a escribir por qué ─────────────────────────────────────────────
 * Un "otro" sin explicación es un agujero negro: se elige por comodidad y deja la fila muda.
 * El CHECK lo impide en el motor, no en el formulario — un formulario se puede saltar.
 *
 * ── Valoración ──────────────────────────────────────────────────────────────────────────────
 * `est_value` = precio del momento × (cantidad retirada). Es una ESTIMACIÓN para priorizar y
 * está etiquetada en `est_source`. Sin precio queda **NULL con `est_source='sin_dato'`, nunca 0**
 * (ADR-056): un cero dibujado se lee como "no vale nada", que es la conclusión contraria.
 *
 * Aditiva e idempotente. RLS forzado + grant `app_runtime`. FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  if (await knex.schema.withSchema('commercial').hasTable('pos_line_voids')) return;

  await knex.raw(`
    CREATE TABLE commercial.pos_line_voids (
      id                    uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id             uuid NOT NULL,

      -- Dónde. La caja es texto porque Kepler la identifica por el TIPO de documento
      -- (U-D-10-N = "Ticket Contado Caja N"), no por un catálogo con id propio.
      warehouse_id          uuid NOT NULL,
      caja                  varchar(20),

      -- Quién autorizó. Es el dato que justifica toda la tabla: el evento ya exige contraseña
      -- de supervisor (POS.k_passRow=1), lo que falta es el registro de quién la puso.
      supervisor_code       varchar(40) NOT NULL,
      supervisor_name       varchar(120),
      cashier_code          varchar(40),
      cashier_name          varchar(120),

      -- Qué. 'product_id' NULL cuando no se pudo resolver; 'sku' y 'product_name' son snapshots
      -- para que la fila siga siendo legible aunque el producto se borre del catálogo después.
      product_id            uuid,
      sku                   varchar(40),
      product_name          varchar(200),

      -- Cuánto. La versión nueva de Kepler (2026-09-28) dejó de borrar y ahora MODIFICA la
      -- cantidad, así que el hecho general es una reducción: qty_final=0 es el retiro completo.
      qty_original          numeric(14,3) NOT NULL,
      qty_final             numeric(14,3) NOT NULL DEFAULT 0,
      unidad                varchar(12),

      reason                varchar(24) NOT NULL,
      reason_note           text,

      -- Valoración (estimación etiquetada)
      unit_price            numeric(14,4),
      est_value             numeric(14,2),
      est_source            varchar(12) NOT NULL DEFAULT 'sin_dato',

      -- Cuándo pasó vs cuándo se registró. La distancia es información, no ruido.
      occurred_at           timestamptz NOT NULL,
      reported_at           timestamptz NOT NULL DEFAULT now(),

      source                varchar(16) NOT NULL DEFAULT 'captura',
      reported_by           uuid,
      reported_by_username  varchar(80),

      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),

      CONSTRAINT commercial_pos_line_voids_reason_chk
        CHECK (reason IN ('error_captura','cliente_desistio','precio_incorrecto',
                          'producto_danado','cantidad_incorrecta','otro')),
      CONSTRAINT commercial_pos_line_voids_source_chk
        CHECK (source IN ('captura','caja','supervision','otro')),
      -- 'otro' sin explicación deja la fila muda. Se impide en el motor, no en el formulario.
      CONSTRAINT commercial_pos_line_voids_otro_chk
        CHECK (reason <> 'otro' OR (reason_note IS NOT NULL AND btrim(reason_note) <> '')),
      -- Un retiro de cantidad 0 no es un retiro.
      CONSTRAINT commercial_pos_line_voids_qty_orig_chk
        CHECK (qty_original > 0),
      -- Es una REDUCCIÓN: si la cantidad no bajó, no hubo retiro que registrar.
      CONSTRAINT commercial_pos_line_voids_qty_final_chk
        CHECK (qty_final >= 0 AND qty_final < qty_original),
      -- Sin precio no hay valoración, y sin valoración la fuente TIENE que decir 'sin_dato'.
      -- Es lo que impide que un NULL se publique como si fuera una cifra medida.
      CONSTRAINT commercial_pos_line_voids_est_coherencia_chk
        CHECK ((est_source = 'precio_erp' AND est_value IS NOT NULL)
            OR (est_source = 'sin_dato'   AND est_value IS NULL)),
      -- No se puede registrar algo antes de que pasara. Las dos las pone el servidor.
      CONSTRAINT commercial_pos_line_voids_tiempo_chk
        CHECK (occurred_at <= reported_at),

      CONSTRAINT fk_commercial_pos_line_voids_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT fk_commercial_pos_line_voids_warehouse
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT,
      -- 'SET NULL (columna)' y no pelado: en una FK COMPUESTA el pelado intenta anular las DOS
      -- columnas y 'tenant_id' es NOT NULL -> borrar un producto reventaría. Vivido en
      -- 'receiving_claims' y 'floor_stockouts'. La fila sobrevive legible: sku y product_name
      -- son snapshots, no joins.
      CONSTRAINT fk_commercial_pos_line_voids_product
        FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products (tenant_id, id) ON DELETE SET NULL (product_id)
    )`);

  // Índices
  await knex.raw(`
    CREATE INDEX ix_pos_line_voids_bitacora
      ON commercial.pos_line_voids (tenant_id, occurred_at DESC)`);
  await knex.raw(`
    CREATE INDEX ix_pos_line_voids_sucursal
      ON commercial.pos_line_voids (tenant_id, warehouse_id, occurred_at DESC)`);
  // El ángulo de auditoría: qué supervisor autoriza cuánto. Es la razón de ser de la tabla.
  await knex.raw(`
    CREATE INDEX ix_pos_line_voids_supervisor
      ON commercial.pos_line_voids (tenant_id, supervisor_code, occurred_at DESC)`);
  await knex.raw(`
    CREATE INDEX ix_pos_line_voids_producto
      ON commercial.pos_line_voids (tenant_id, product_id, occurred_at DESC)
      WHERE product_id IS NOT NULL`);

  await knex.raw(`
    COMMENT ON TABLE commercial.pos_line_voids IS
      '[BP.1] El renglon que el cajero quito del ticket en el POS, con el supervisor que lo autorizo. '
      'Dato propio HITL: medido 2026-09-28, Kepler autentica el evento y NO lo escribe en ningun lado '
      '(0 coincidencias de ELIMINADO en las 46 columnas de texto de kdm2; kdconfig no tiene parametro de bitacora). '
      'Grano: una fila por EVENTO, sin agregar -- cada retiro es un acto individual auditable.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.pos_line_voids.supervisor_code IS
      'Quien autorizo. El evento YA exige su contrasena en Kepler (POS.k_passRow=1); lo que faltaba era el registro.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.pos_line_voids.qty_final IS
      '0 = retiro completo. Desde 2026-09-28 Kepler dejo de borrar y MODIFICA la cantidad, asi que el hecho general es una reduccion.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.pos_line_voids.occurred_at IS
      'Cuando paso en la caja. Distinto de reported_at a proposito: la distancia entre ambos mide cuan fresca es la captura.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.pos_line_voids.est_value IS
      'ESTIMACION para priorizar (precio del momento x cantidad retirada). NULL con est_source=sin_dato cuando no hay precio: nunca 0 (ADR-056).'`);

  await knex.raw(`ALTER TABLE commercial.pos_line_voids ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.pos_line_voids FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.pos_line_voids`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.pos_line_voids
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.pos_line_voids TO app_runtime`);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('pos_line_voids');
};
