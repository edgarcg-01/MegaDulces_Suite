/**
 * Fase CG.2 — Caja General VIVA (Doctos) → analytics.caja_general_*.
 *
 * El sistema "Base Movimientos SI/NO" (caja_ventas_diarias/caja_depositos) se ABANDONÓ
 * en Q1-2026 (era una copia manual de Finanzas). La caja general OPERATIVA viva vive en
 * `Z:\Datos\20 Comisionistas\Dulceria\BDatos.mdb` → tabla `Doctos` (114k movs, al día):
 * un hub de efectivo por sucursal — ingresos (ventas de ruta que ENTRAN) + gastos
 * (remisiones a proveedor / comisiones que SALEN), por cuenta + denominación. El plan de
 * cuentas jerárquico está en `Cuenta` (sucursal × concepto). Ver [reference_movimientos_finanzas_access].
 *
 * Scope: enero-2026 → hoy (decisión Edgar 2026-08-14). analytics.* SIN RLS (filtro tenant
 * explícito) + GRANT SELECT app_runtime. Lo puebla import-caja-general.js --only doctos
 * (UPSERT churn-free por (tenant_id, source_caja, tipo_dto, mov_id)). Idempotente (hasTable).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // --- Plan de cuentas (Cuenta): sucursal × concepto, jerárquico ---
  if (!(await knex.schema.withSchema('analytics').hasTable('caja_general_cuentas'))) {
    await knex.raw(`
      CREATE TABLE analytics.caja_general_cuentas (
        tenant_id     uuid NOT NULL,
        source_caja   text NOT NULL,               -- backend de origen (ej. '20' = Comisionistas Dulceria)
        id_cuenta     text NOT NULL,               -- Cuenta.IdCuenta (numérico en Access, texto aquí)
        nombre        text,                         -- NombreCuenta (ej. "Matriz Compras Mercancia", "VENTAS RD LA PIEDAD")
        nombre_largo  text,                         -- NombreLargoCta
        nivel         int,                          -- NivelCta
        grupo         text,                         -- GrupoCta
        acumula_a     text,                         -- AcumulaACta (cuenta padre → rollup)
        afectable     boolean DEFAULT false,        -- AfectableCta (S = se le cargan movimientos)
        computed_at   timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, source_caja, id_cuenta)
      )`);
    await knex.raw(`GRANT SELECT ON analytics.caja_general_cuentas TO app_runtime`);
  }

  // --- Libro de movimientos (Doctos): ingreso/gasto por cuenta + denominación ---
  if (!(await knex.schema.withSchema('analytics').hasTable('caja_general_movimientos'))) {
    await knex.raw(`
      CREATE TABLE analytics.caja_general_movimientos (
        tenant_id      uuid NOT NULL,
        source_caja    text NOT NULL,              -- '20' (Comisionistas Dulceria)
        tipo_dto       int NOT NULL,               -- Doctos.TipoDto: 1=Ingreso 2=Gasto 3=Deposito(muerto) 6=misc
        mov_id         text NOT NULL,              -- Doctos.IdDocto (secuencia por TipoDto → PK compuesta)
        tipo           text,                       -- etiqueta legible (Ingreso/Gasto/Deposito)
        fecha          date,
        hora           text,                       -- HoraD (hora del día, sin fecha)
        usuario        text,                       -- UsuarioD (quién capturó)
        cuenta         text,                       -- Doctos.Cuenta → caja_general_cuentas.id_cuenta
        cuenta_nombre  text,                       -- denormalizado del catálogo al importar
        nombre_cliente text,                       -- NombreCliente (cliente/proveedor/concepto de la fila)
        concepto       text,                       -- ObservDocto
        ingreso        numeric DEFAULT 0,
        gasto          numeric DEFAULT 0,
        deposito       numeric DEFAULT 0,          -- a banco (cuentas 1990/40000000; esporádico)
        efectivo       numeric DEFAULT 0,          -- neto de efectivo del movimiento
        denom          jsonb,                      -- {B1000,B500,…,M01,Mor} conteos de denominación
        saldo          numeric DEFAULT 0,          -- SaldoD (saldo de caja tras el movimiento)
        corte          boolean DEFAULT false,      -- Corte (si ya entró a un corte)
        dolar          numeric DEFAULT 0,          -- DolarD
        tipo_cambio    numeric DEFAULT 0,          -- TipoCambD
        computed_at    timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, source_caja, tipo_dto, mov_id)
      )`);
    await knex.raw(`CREATE INDEX ix_cajagm_fecha ON analytics.caja_general_movimientos (tenant_id, fecha)`);
    await knex.raw(`CREATE INDEX ix_cajagm_cuenta ON analytics.caja_general_movimientos (tenant_id, cuenta)`);
    await knex.raw(`CREATE INDEX ix_cajagm_tipo ON analytics.caja_general_movimientos (tenant_id, tipo_dto)`);
    await knex.raw(`GRANT SELECT ON analytics.caja_general_movimientos TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('caja_general_movimientos');
  await knex.schema.withSchema('analytics').dropTableIfExists('caja_general_cuentas');
};
