/**
 * W.0 - Landing schema `wincaja.*` para el POS Access 97 (Wincaja). ADR-031.
 *
 * Espejo 1:1 (bronze) de las tablas relevantes del .mdb por sucursal. Cada fila
 * lleva tenant_id + source_branch (10/30/32/50) + imported_at. El importer hace
 * RECARGA FULL por sucursal (DELETE WHERE source_branch=X; INSERT) dentro de una
 * trx => idempotente sin depender de PKs naturales perfectas. Por eso NO hay FKs
 * entre tablas landing (evita orden de recarga); solo PKs + indices de join.
 *
 * Numericos = `numeric` sin precision (unbounded): un landing/bronze acepta la
 * fuente TAL CUAL, incluida data corrupta del POS (ej. CostoPromedio 2.29e16 en
 * suc 30). La limpieza/validacion es aguas abajo, no aqui.
 *
 * Convencion A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime.
 * Los reads de la app van por TenantKnexService.run(); el importer setea
 * SET LOCAL app.tenant_id antes de escribir (pasa FORCE RLS).
 *
 * `wincaja.branches` = crosswalk source_branch <-> kepler_code <-> warehouse_code.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

async function createTenantRls(knex, table) {
  await knex.raw(`ALTER TABLE wincaja.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE wincaja.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='wincaja' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON wincaja.${table}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON wincaja.${table} TO app_runtime`);
}

// helpers de columnas
let knexRef;
const ts = (t, name) => t.specificType(name, 'timestamptz');
const num = (t, name) => t.specificType(name, 'numeric');
function stamp(t) {
  t.uuid('tenant_id').notNullable();
  t.text('source_branch').notNullable();
  t.text('source_dataset').notNullable().defaultTo('actual'); // actual | concentrada
  t.specificType('imported_at', 'timestamptz').notNullable().defaultTo(knexRef.fn.now());
}

exports.up = async function (knex) {
  knexRef = knex;
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS wincaja`);
  await knex.raw(`GRANT USAGE ON SCHEMA wincaja TO app_runtime`);

  const has = (t) => knex.schema.withSchema('wincaja').hasTable(t);

  // -- crosswalk de sucursal --------------------------------------------------
  if (!(await has('branches'))) {
    await knex.schema.withSchema('wincaja').createTable('branches', (t) => {
      t.uuid('tenant_id').notNullable();
      t.text('source_branch').notNullable();        // 10/30/32/50
      t.text('branch_name');
      t.text('kepler_code');                         // md_01 -> '01' (null si no esta en Kepler)
      t.text('warehouse_code');                      // MD-10...
      t.text('status').notNullable().defaultTo('legacy'); // live_on_wincaja | legacy_on_kepler | transition
      t.date('last_movement_date');
      t.text('mdb_file');
      t.text('notes');
      t.specificType('imported_at', 'timestamptz').notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'source_branch']);
    });
    await createTenantRls(knex, 'branches');
    await knex('wincaja.branches').insert([
      { tenant_id: TENANT, source_branch: '00', branch_name: 'BPIRAPUATO', kepler_code: '00', warehouse_code: 'MD-00', status: 'live_on_wincaja', mdb_file: '0 BPIRAPUATO MOV.MDB', notes: 'CEDIS/bodegon Irapuato; datos completos en el archivo MOV' },
      { tenant_id: TENANT, source_branch: '10', branch_name: 'PADRE HIDALGO', kepler_code: '01', warehouse_code: 'MD-10', status: 'transition', mdb_file: '10 PHIDALGO.MDB', notes: 'Kepler md_01; Wincaja concentrada 31/05, actual 26/06' },
      { tenant_id: TENANT, source_branch: '30', branch_name: 'MORELIA ABASTOS', kepler_code: null, warehouse_code: 'MD-30', status: 'live_on_wincaja', mdb_file: '30 MORELIA ABASTOS.MDB', notes: 'Viva en Wincaja (mov. a 12/07/2026); no en Kepler' },
      { tenant_id: TENANT, source_branch: '32', branch_name: 'MORELIA MADERO', kepler_code: null, warehouse_code: 'MD-32', status: 'live_on_wincaja', mdb_file: '32 MORELIA MADERO.MDB', notes: 'Viva en Wincaja (mov. a 12/07/2026); no en Kepler' },
      { tenant_id: TENANT, source_branch: '40', branch_name: '8 ESQUINAS', kepler_code: '03', warehouse_code: 'MD-40', status: 'legacy_on_kepler', mdb_file: '40 8ESQUINAS.MDB', notes: 'Kepler md_03; Wincaja ultimo mov 08/01/2026' },
      { tenant_id: TENANT, source_branch: '44', branch_name: 'YURECUARO', kepler_code: '04', warehouse_code: 'MD-44', status: 'legacy_on_kepler', mdb_file: '44 YURECUARO.MDB', notes: 'Kepler md_04; Wincaja ultimo mov 17/02/2026' },
      { tenant_id: TENANT, source_branch: '50', branch_name: 'CANINDO', kepler_code: null, warehouse_code: 'MD-50', status: 'live_on_wincaja', mdb_file: '50 CANINDO.MDB', notes: 'Viva en Wincaja (mov. a 12/07/2026); no en Kepler' },
      { tenant_id: TENANT, source_branch: '54', branch_name: 'ZAMORA CENTRO', kepler_code: '05', warehouse_code: 'MD-54', status: 'legacy_on_kepler', mdb_file: '54 ZAMORA CENTRO.MDB', notes: 'Kepler md_05; Wincaja ultimo mov 15/03/2026' },
    ]);
  }

  // -- Catalogo ---------------------------------------------------------------
  if (!(await has('familias'))) {
    await knex.schema.withSchema('wincaja').createTable('familias', (t) => {
      stamp(t);
      t.text('familia').notNullable();
      t.text('descripcion');
      ts(t, 'fecha_alta'); ts(t, 'fecha_ult_mod');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'familia']);
    });
    await createTenantRls(knex, 'familias');
  }

  if (!(await has('subfamilias'))) {
    await knex.schema.withSchema('wincaja').createTable('subfamilias', (t) => {
      stamp(t);
      t.text('subfamilia').notNullable();
      t.text('descripcion');
      t.text('familia');
      ts(t, 'fecha_alta'); ts(t, 'fecha_ult_mod');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'subfamilia']);
    });
    await createTenantRls(knex, 'subfamilias');
  }

  if (!(await has('articulos'))) {
    await knex.schema.withSchema('wincaja').createTable('articulos', (t) => {
      stamp(t);
      t.text('articulo').notNullable();
      t.text('codigo_barras');
      t.text('subfamilia');
      t.text('nombre');
      t.text('descripcion');
      t.text('categoria');
      t.boolean('es_compuesto');
      t.text('unidad_compra');
      t.text('unidad_venta');
      num(t, 'factor_compra'); num(t, 'factor_venta');
      num(t, 'iva_venta'); num(t, 'ieps_venta');
      num(t, 'venta_valor_anual'); num(t, 'venta_unidad_anual');
      t.text('tipo');
      ts(t, 'fecha_alta'); ts(t, 'fecha_ult_mod');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'articulo']);
    });
    await knex.raw(`CREATE INDEX ix_wcj_art_barras ON wincaja.articulos (tenant_id, codigo_barras)`);
    await knex.raw(`CREATE INDEX ix_wcj_art_subfam ON wincaja.articulos (tenant_id, source_branch, subfamilia)`);
    await createTenantRls(knex, 'articulos');
  }

  if (!(await has('precios'))) {
    await knex.schema.withSchema('wincaja').createTable('precios', (t) => {
      stamp(t);
      t.text('articulo').notNullable();
      t.integer('no_precio').notNullable();
      num(t, 'precio'); num(t, 'cantidad_automatico');
      num(t, 'margen_utilidad'); num(t, 'margen_costo_promedio'); num(t, 'comision_vendedor');
      ts(t, 'fecha_ult_mod');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'articulo', 'no_precio']);
    });
    await createTenantRls(knex, 'precios');
  }

  if (!(await has('existencias'))) {
    await knex.schema.withSchema('wincaja').createTable('existencias', (t) => {
      stamp(t);
      t.text('almacen').notNullable();
      t.text('articulo').notNullable();
      t.text('ubicacion');
      num(t, 'existencia_inicial'); num(t, 'entrada'); num(t, 'salida');
      num(t, 'existencia'); // inicial + entrada - salida (calculado en load)
      num(t, 'stock_maximo'); num(t, 'stock_minimo');
      num(t, 'costo_existencia'); num(t, 'costo_promedio'); num(t, 'ultimo_costo');
      num(t, 'apartado');
      ts(t, 'fecha_ult_compra'); ts(t, 'fecha_ult_venta');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'almacen', 'articulo']);
    });
    await createTenantRls(knex, 'existencias');
  }

  if (!(await has('articulo_proveedor'))) {
    await knex.schema.withSchema('wincaja').createTable('articulo_proveedor', (t) => {
      stamp(t);
      t.text('articulo').notNullable();
      t.text('proveedor').notNullable();
      t.text('codigo_proveedor');
      num(t, 'costo');
      t.integer('prioridad');
      ts(t, 'fecha_ult_compra');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'articulo', 'proveedor']);
    });
    await createTenantRls(knex, 'articulo_proveedor');
  }

  // -- Cartera / cobranza -----------------------------------------------------
  if (!(await has('clientes'))) {
    await knex.schema.withSchema('wincaja').createTable('clientes', (t) => {
      stamp(t);
      t.text('cliente').notNullable();
      t.text('tipo'); t.text('nombre'); t.text('razon'); t.text('rfc'); t.text('vendedor');
      num(t, 'descuento');
      t.text('direccion'); t.text('colonia'); t.text('cd'); t.text('cp'); t.text('telefono'); t.text('email');
      num(t, 'saldo_mn'); num(t, 'maximo_mn');
      t.integer('plazo'); t.boolean('credito');
      num(t, 'puntos_acumulados');
      t.text('territorio'); t.boolean('bloqueado');
      ts(t, 'fecha_alta'); ts(t, 'fecha_ult_mod');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'cliente']);
    });
    await knex.raw(`CREATE INDEX ix_wcj_cli_rfc ON wincaja.clientes (tenant_id, rfc)`);
    await createTenantRls(knex, 'clientes');
  }

  if (!(await has('movimiento_clientes'))) {
    await knex.schema.withSchema('wincaja').createTable('movimiento_clientes', (t) => {
      stamp(t);
      t.text('documento').notNullable();
      t.text('tipo').notNullable();
      t.text('tercero'); t.text('referencia');
      ts(t, 'fecha'); t.text('hora'); ts(t, 'fecha_vencimiento'); ts(t, 'fecha_ultimo_pago');
      t.text('caja'); t.text('cajero'); t.text('vendedor');
      num(t, 'valor'); num(t, 'descuento'); num(t, 'costo'); num(t, 'iva'); num(t, 'ieps'); num(t, 'saldo');
      t.text('moneda'); num(t, 'paridad');
      num(t, 'comision_generada'); num(t, 'comision_pendiente');
      t.text('almacen'); t.text('observaciones'); ts(t, 'fecha_captura');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'documento', 'tipo']);
    });
    await knex.raw(`CREATE INDEX ix_wcj_movcli_tercero ON wincaja.movimiento_clientes (tenant_id, source_branch, tercero)`);
    await knex.raw(`CREATE INDEX ix_wcj_movcli_fecha ON wincaja.movimiento_clientes (tenant_id, source_branch, fecha)`);
    await createTenantRls(knex, 'movimiento_clientes');
  }

  // -- Proveedores / compras --------------------------------------------------
  if (!(await has('proveedores'))) {
    await knex.schema.withSchema('wincaja').createTable('proveedores', (t) => {
      stamp(t);
      t.text('proveedor').notNullable();
      t.text('nombre'); t.text('rfc'); t.text('direccion'); t.text('colonia'); t.text('cd'); t.text('telefonos'); t.text('email');
      num(t, 'saldo_mn'); num(t, 'limite_credito_mn');
      t.text('tipo');
      ts(t, 'fecha_alta'); ts(t, 'fecha_ult_mod');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'proveedor']);
    });
    await createTenantRls(knex, 'proveedores');
  }

  if (!(await has('movimiento_proveedores'))) {
    await knex.schema.withSchema('wincaja').createTable('movimiento_proveedores', (t) => {
      stamp(t);
      t.text('documento').notNullable();
      t.text('tipo').notNullable();
      t.text('tercero'); t.text('referencia');
      ts(t, 'fecha'); ts(t, 'fecha_vencimiento');
      num(t, 'valor'); num(t, 'descuento'); num(t, 'iva'); num(t, 'ieps'); num(t, 'saldo');
      t.text('moneda'); t.text('almacen'); t.text('observaciones'); ts(t, 'fecha_captura');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'documento', 'tipo']);
    });
    await createTenantRls(knex, 'movimiento_proveedores');
  }

  if (!(await has('ordenes_compra'))) {
    await knex.schema.withSchema('wincaja').createTable('ordenes_compra', (t) => {
      stamp(t);
      t.text('consecutivo').notNullable();
      t.text('articulo').notNullable();
      ts(t, 'fecha');
      t.text('codigo_proveedor');
      num(t, 'cantidad_pedida'); num(t, 'cantidad_surtida'); num(t, 'costo_pedido'); num(t, 'ultimo_costo_surtido');
      t.text('almacen'); t.text('emitio'); t.text('autorizo'); t.text('moneda');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'consecutivo', 'articulo']);
    });
    await createTenantRls(knex, 'ordenes_compra');
  }

  // -- Caja / tesoreria -------------------------------------------------------
  if (!(await has('formas_pago'))) {
    await knex.schema.withSchema('wincaja').createTable('formas_pago', (t) => {
      stamp(t);
      t.text('forma_pago').notNullable();
      t.text('descripcion');
      t.boolean('credito'); t.boolean('tarjeta_credito'); t.boolean('vale_interno');
      num(t, 'paridad');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'forma_pago']);
    });
    await createTenantRls(knex, 'formas_pago');
  }

  if (!(await has('pagos_dia'))) {
    await knex.schema.withSchema('wincaja').createTable('pagos_dia', (t) => {
      stamp(t);
      t.text('consecutivo').notNullable();
      t.text('folio'); t.text('forma_pago'); t.text('referencia');
      num(t, 'pagado');
      t.text('hora'); t.text('vendedor'); t.text('moneda');
      num(t, 'paridad');
      t.text('caja'); t.boolean('cobranza');
      num(t, 'propina');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'consecutivo']);
    });
    await knex.raw(`CREATE INDEX ix_wcj_pagos_folio ON wincaja.pagos_dia (tenant_id, source_branch, folio)`);
    await createTenantRls(knex, 'pagos_dia');
  }

  if (!(await has('cortes'))) {
    await knex.schema.withSchema('wincaja').createTable('cortes', (t) => {
      stamp(t);
      t.text('folio').notNullable();
      t.text('caja').notNullable();
      ts(t, 'fecha_corte');
      t.text('cajero');
      t.text('folio_inicial_retiro'); t.text('folio_final_retiro');
      t.text('folio_inicial_pago'); t.text('folio_final_pago');
      t.text('folio_inicial_movto'); t.text('folio_final_movto');
      t.integer('canceladas'); num(t, 'monto_canceladas');
      t.integer('eliminadas'); num(t, 'monto_eliminadas');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'folio', 'caja']);
    });
    await knex.raw(`CREATE INDEX ix_wcj_cortes_fecha ON wincaja.cortes (tenant_id, source_branch, fecha_corte)`);
    await createTenantRls(knex, 'cortes');
  }

  if (!(await has('arqueos'))) {
    await knex.schema.withSchema('wincaja').createTable('arqueos', (t) => {
      stamp(t);
      t.text('consecutivo').notNullable();
      t.text('folio'); t.text('caja');
      num(t, 'denominacion').notNullable();
      num(t, 'cantidad');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'consecutivo', 'denominacion']);
    });
    await knex.raw(`CREATE INDEX ix_wcj_arq_folio ON wincaja.arqueos (tenant_id, source_branch, folio)`);
    await createTenantRls(knex, 'arqueos');
  }

  if (!(await has('retiros'))) {
    await knex.schema.withSchema('wincaja').createTable('retiros', (t) => {
      stamp(t);
      t.text('folio').notNullable();
      t.text('caja').notNullable();
      num(t, 'monto');
      ts(t, 'fecha');
      t.text('forma_de_pago'); t.text('moneda'); t.text('cajero');
      t.boolean('incremento'); t.boolean('dotacion_inicial'); t.boolean('por_diferencia_corte');
      t.text('observacion');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'folio', 'caja']);
    });
    await createTenantRls(knex, 'retiros');
  }

  // -- Ventas / almacen -------------------------------------------------------
  if (!(await has('maestro_mov_almacen'))) {
    await knex.schema.withSchema('wincaja').createTable('maestro_mov_almacen', (t) => {
      stamp(t);
      t.text('consecutivo').notNullable();
      t.text('tipo'); t.text('documento'); t.text('tercero'); t.text('referencia');
      ts(t, 'fecha'); t.text('hora');
      t.text('almacen'); t.text('moneda'); num(t, 'paridad');
      t.text('caja'); t.text('cajero'); t.text('vendedor');
      t.boolean('cancelado'); t.text('observaciones'); ts(t, 'fecha_captura');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'consecutivo']);
    });
    await knex.raw(`CREATE INDEX ix_wcj_maestro_fecha ON wincaja.maestro_mov_almacen (tenant_id, source_branch, fecha)`);
    await knex.raw(`CREATE INDEX ix_wcj_maestro_tipo ON wincaja.maestro_mov_almacen (tenant_id, source_branch, tipo)`);
    await createTenantRls(knex, 'maestro_mov_almacen');
  }

  if (!(await has('detalles_mov_almacen'))) {
    await knex.schema.withSchema('wincaja').createTable('detalles_mov_almacen', (t) => {
      t.bigIncrements('id');
      t.uuid('tenant_id').notNullable();
      t.text('source_branch').notNullable();
      t.text('source_dataset').notNullable().defaultTo('actual');
      t.specificType('imported_at', 'timestamptz').notNullable().defaultTo(knex.fn.now());
      t.text('consecutivo').notNullable();
      t.text('articulo').notNullable();
      t.text('tipo'); t.text('documento');
      num(t, 'cantidad_regular'); num(t, 'cantidad_auxiliar');
      num(t, 'valor_costo'); num(t, 'valor_venta'); num(t, 'iva'); num(t, 'ieps');
      num(t, 'descuento1'); num(t, 'descuento2');
      t.text('tipo_precio'); t.text('unidad_venta');
    });
    await knex.raw(`CREATE INDEX ix_wcj_det_join ON wincaja.detalles_mov_almacen (tenant_id, source_branch, source_dataset, consecutivo)`);
    await knex.raw(`CREATE INDEX ix_wcj_det_art ON wincaja.detalles_mov_almacen (tenant_id, source_branch, articulo)`);
    await createTenantRls(knex, 'detalles_mov_almacen');
  }

  // -- Referencia -------------------------------------------------------------
  if (!(await has('vendedores'))) {
    await knex.schema.withSchema('wincaja').createTable('vendedores', (t) => {
      stamp(t);
      t.text('vendedor').notNullable();
      t.text('nombre');
      num(t, 'comision');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'vendedor']);
    });
    await createTenantRls(knex, 'vendedores');
  }

  if (!(await has('ofertas'))) {
    await knex.schema.withSchema('wincaja').createTable('ofertas', (t) => {
      stamp(t);
      t.text('consecutivo').notNullable();
      t.text('articulo');
      num(t, 'descuento'); num(t, 'porcentaje');
      t.integer('nivel_precio');
      ts(t, 'fecha_inicial'); ts(t, 'fecha_final');
      num(t, 'limite'); num(t, 'remanente');
      t.text('id_oferta'); t.boolean('no_caduca');
      t.primary(['tenant_id', 'source_branch', 'source_dataset', 'consecutivo']);
    });
    await knex.raw(`CREATE INDEX ix_wcj_ofertas_art ON wincaja.ofertas (tenant_id, source_branch, articulo)`);
    await createTenantRls(knex, 'ofertas');
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP SCHEMA IF EXISTS wincaja CASCADE');
};
