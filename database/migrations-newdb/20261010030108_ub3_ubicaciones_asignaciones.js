'use strict';
/**
 * `[UB.3]` — Asignación por producto y PRESENTACIÓN (Fase UB, ADR-090 punto 7, decisión D10).
 *
 * El mismo Mazapán De la Rosa vive en cajas en `BA053`, en paquetes en `BA052`, en paquetes en
 * tienda `TA021` y en cajas en el rack superior de tienda `TA024`. Cada renglón de esta tabla dice:
 * este producto, en esta presentación, va en esta ubicación, con este papel y este mínimo/máximo.
 *
 * ── La presentación ─────────────────────────────────────────────────────────────────────────────
 *  `presentacion` = número de peldaño de la escalera de Kepler de ESA sucursal (1 base · 2 · 3),
 *  leída de `analytics.v_kepler_unit_ladder`. NO se guarda el factor: se lee vivo de Kepler cada vez,
 *  para que no exista una segunda copia que se desactualice (regla "nunca copias"). Se guarda una
 *  FOTO del rótulo (`CAJA`, `PAQ`…) sólo para que la etiqueta se lea aunque Kepler lo renombre.
 *  Mínimo y máximo van EN ESA PRESENTACIÓN (4 cajas, 30 paquetes), nunca convertidos.
 *
 * ── Los papeles ─────────────────────────────────────────────────────────────────────────────────
 *  · `surtido_fijo`       — su lugar de surtido en BODEGA. Uno por producto × presentación × almacén.
 *  · `exhibicion_tienda`  — dónde se exhibe en TIENDA (piso, cabecera, rack superior). Puede haber varios.
 *  · `reserva_preferida`  — a dónde va primero el excedente. Uno por producto × presentación × almacén.
 *  La zona que corresponde a cada papel (B/T) la valida el servicio, que conoce la ubicación.
 *
 * Quitar una asignación no la borra: `deleted_at` + quién (la bitácora completa llega en UB.4).
 * Tabla nueva con tenant_id + audit + RLS forzado + grant app_runtime (sin DELETE). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'commercial.bin_assignments';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('commercial').hasTable('bin_assignments')) return;

  await knex.schema.withSchema('commercial').createTable('bin_assignments', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('warehouse_id').notNullable();
    t.uuid('product_id').notNullable();
    t.uuid('bin_id').notNullable();
    t.smallint('presentacion').notNullable();
    t.string('presentacion_rotulo', 12);
    t.string('papel', 20).notNullable();
    t.decimal('min_qty', 12, 3);
    t.decimal('max_qty', 12, 3);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by');
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('updated_by');
    t.timestamp('deleted_at');
    t.uuid('deleted_by');

    t.primary('id');
    t.unique(['tenant_id', 'id'], { indexName: 'commercial_bin_assignments_tenant_id_composite' });
    t.index(['tenant_id', 'warehouse_id', 'product_id'], 'idx_commercial_bin_assignments_whp');
    t.index(['tenant_id', 'bin_id'], 'idx_commercial_bin_assignments_bin');
    t.check('?? BETWEEN 1 AND 3', ['presentacion'], 'ck_bin_assignments_presentacion');
    t.check(`?? IN ('surtido_fijo', 'exhibicion_tienda', 'reserva_preferida')`, ['papel'], 'ck_bin_assignments_papel');
    t.check('(?? IS NULL OR ?? >= 0) AND (?? IS NULL OR ?? >= 0)', ['min_qty', 'min_qty', 'max_qty', 'max_qty'], 'ck_bin_assignments_qty_nonneg');
    t.check('?? IS NULL OR ?? IS NULL OR ?? <= ??', ['min_qty', 'max_qty', 'min_qty', 'max_qty'], 'ck_bin_assignments_min_le_max');
    t.check('(?? IS NULL) = (?? IS NULL)', ['deleted_at', 'deleted_by'], 'ck_bin_assignments_deleted');
  });

  // Un solo lugar fijo de surtido y una sola reserva preferida por producto × presentación × almacén
  // (entre los vivos). La exhibición en tienda puede repetirse.
  await knex.raw(`
    CREATE UNIQUE INDEX commercial_bin_assignments_unico_por_papel
      ON ${T} (tenant_id, warehouse_id, product_id, presentacion, papel)
      WHERE deleted_at IS NULL AND papel IN ('surtido_fijo', 'reserva_preferida')`);
  // Y nunca el mismo renglón dos veces en la misma ubicación.
  await knex.raw(`
    CREATE UNIQUE INDEX commercial_bin_assignments_unico_en_ubicacion
      ON ${T} (tenant_id, bin_id, product_id, presentacion, papel)
      WHERE deleted_at IS NULL`);

  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT fk_bin_assignments_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT fk_bin_assignments_warehouse FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT fk_bin_assignments_product FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT`);
  // La ubicación tiene que ser DEL MISMO almacén que la asignación — garantizado en la base, no sólo en el
  // servicio (revisión del PR). Para eso la FK es compuesta (tenant, almacén, ubicación) y pide un único
  // sobre warehouse_bins (tabla chica: es el catálogo de ubicaciones).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS commercial_wh_bins_tenant_wh_id ON commercial.warehouse_bins (tenant_id, warehouse_id, id)`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT fk_bin_assignments_bin FOREIGN KEY (tenant_id, warehouse_id, bin_id) REFERENCES commercial.warehouse_bins(tenant_id, warehouse_id, id) ON DELETE RESTRICT`);

  await knex.raw(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${T}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON ${T}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${T} TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE ${T} IS
    'Fase UB.3 (ADR-090): producto x presentacion (peldaño 1-3 de la escalera Kepler de la sucursal) x ubicacion x papel (surtido_fijo/exhibicion_tienda/reserva_preferida) + min/max en esa presentacion. El factor NO se copia: se lee de v_kepler_unit_ladder. No se borra: deleted_at.'`);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('bin_assignments');
  await knex.raw(`DROP INDEX IF EXISTS commercial.commercial_wh_bins_tenant_wh_id`);
};
