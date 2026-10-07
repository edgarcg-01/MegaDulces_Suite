/**
 * W (cont.) - Landing extra Wincaja: tablas ⬜ que faltaban ingerir.
 *   - cotizaciones + cotizacion_lineas + faltantes_cotizacion  => U6 (demanda perdida)
 *   - autorizaciones                                           => U12 (auditoria overrides)
 *   - cajeros / categorias / almacenes                         => enriquecimiento
 *
 * Misma convencion que el landing base: tenant_id + source_branch + source_dataset
 * + imported_at, RLS forzado, grants app_runtime, numericos unbounded (bronze).
 * NOTA seguridad: de Cajeros NO se ingiere la columna Password.
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';
let K;
const ts = (t, n) => t.specificType(n, 'timestamptz');
const num = (t, n) => t.specificType(n, 'numeric');
function stamp(t) {
  t.uuid('tenant_id').notNullable();
  t.text('source_branch').notNullable();
  t.text('source_dataset').notNullable().defaultTo('actual');
  t.specificType('imported_at', 'timestamptz').notNullable().defaultTo(K.fn.now());
}
async function rls(knex, table) {
  await knex.raw(`ALTER TABLE wincaja.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE wincaja.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='wincaja' AND tablename='${table}' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON wincaja.${table} USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON wincaja.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  K = knex;
  const has = (t) => knex.schema.withSchema('wincaja').hasTable(t);

  if (!(await has('categorias'))) {
    await knex.schema.withSchema('wincaja').createTable('categorias', (t) => {
      stamp(t);
      t.text('categoria').notNullable();
      t.text('descripcion');
      t.boolean('ocultar_wm');
      ts(t, 'fecha_alta'); ts(t, 'fecha_ult_mod');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'categoria']);
    });
    await rls(knex, 'categorias');
  }

  if (!(await has('almacenes'))) {
    await knex.schema.withSchema('wincaja').createTable('almacenes', (t) => {
      stamp(t);
      t.text('almacen').notNullable();
      t.text('descripcion');
      ts(t, 'fecha_existencia_inicial');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'almacen']);
    });
    await rls(knex, 'almacenes');
  }

  if (!(await has('cajeros'))) {
    await knex.schema.withSchema('wincaja').createTable('cajeros', (t) => {
      stamp(t);
      t.text('cajero').notNullable();
      t.text('nombre');
      t.integer('nivel_seguridad');
      t.text('caja_actual');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'cajero']);
    });
    await rls(knex, 'cajeros');
  }

  if (!(await has('autorizaciones'))) {
    await knex.schema.withSchema('wincaja').createTable('autorizaciones', (t) => {
      t.bigIncrements('id');
      t.uuid('tenant_id').notNullable();
      t.text('source_branch').notNullable();
      t.text('source_dataset').notNullable().defaultTo('actual');
      t.specificType('imported_at', 'timestamptz').notNullable().defaultTo(knex.fn.now());
      t.text('autorizo');
      t.text('cajero');
      ts(t, 'fecha'); t.text('hora');
      t.text('referencia');
      t.text('caja');
    });
    await knex.raw(`CREATE INDEX ix_wcj_autoriz ON wincaja.autorizaciones (tenant_id, source_branch, source_dataset, fecha)`);
    await rls(knex, 'autorizaciones');
  }

  if (!(await has('cotizaciones'))) {
    await knex.schema.withSchema('wincaja').createTable('cotizaciones', (t) => {
      stamp(t);
      t.text('consecutivo').notNullable();
      t.text('tipo'); t.text('tercero'); t.text('referencia');
      ts(t, 'fecha'); t.text('hora');
      t.text('almacen'); t.text('caja'); t.text('cajero'); t.text('vendedor'); t.text('moneda');
      t.text('factura_sugerida');
      t.boolean('apartado'); t.boolean('vendida'); t.boolean('venta_suspendida');
      t.text('observaciones');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'consecutivo']);
    });
    await knex.raw(`CREATE INDEX ix_wcj_cotiz_fecha ON wincaja.cotizaciones (tenant_id, source_branch, source_dataset, fecha)`);
    await rls(knex, 'cotizaciones');
  }

  if (!(await has('cotizacion_lineas'))) {
    await knex.schema.withSchema('wincaja').createTable('cotizacion_lineas', (t) => {
      t.bigIncrements('id');
      t.uuid('tenant_id').notNullable();
      t.text('source_branch').notNullable();
      t.text('source_dataset').notNullable().defaultTo('actual');
      t.specificType('imported_at', 'timestamptz').notNullable().defaultTo(knex.fn.now());
      t.text('consecutivo').notNullable();
      t.text('articulo').notNullable();
      num(t, 'cantidad_regular'); num(t, 'iva'); num(t, 'ieps'); num(t, 'valor_venta');
      num(t, 'descuento1');
      t.text('tipo_precio'); t.text('unidad_venta');
    });
    await knex.raw(`CREATE INDEX ix_wcj_cotlin ON wincaja.cotizacion_lineas (tenant_id, source_branch, source_dataset, consecutivo)`);
    await rls(knex, 'cotizacion_lineas');
  }

  if (!(await has('faltantes_cotizacion'))) {
    await knex.schema.withSchema('wincaja').createTable('faltantes_cotizacion', (t) => {
      t.bigIncrements('id');
      t.uuid('tenant_id').notNullable();
      t.text('source_branch').notNullable();
      t.text('source_dataset').notNullable().defaultTo('actual');
      t.specificType('imported_at', 'timestamptz').notNullable().defaultTo(knex.fn.now());
      t.text('articulo').notNullable();
      num(t, 'cantidad_regular');
      t.text('cliente'); t.text('consecutivo');
      ts(t, 'fecha'); t.text('hora');
      t.text('almacen'); t.text('caja'); t.text('cajero'); t.text('vendedor');
      num(t, 'iva'); num(t, 'valor_venta');
    });
    await knex.raw(`CREATE INDEX ix_wcj_falt_art ON wincaja.faltantes_cotizacion (tenant_id, source_branch, source_dataset, articulo)`);
    await rls(knex, 'faltantes_cotizacion');
  }
};

exports.down = async function (knex) {
  for (const t of ['faltantes_cotizacion', 'cotizacion_lineas', 'cotizaciones', 'autorizaciones', 'cajeros', 'almacenes', 'categorias']) {
    await knex.schema.withSchema('wincaja').dropTableIfExists(t);
  }
};
