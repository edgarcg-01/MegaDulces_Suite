/**
 * Fase CXC — Cartera de clientes / Partidas vivas (Cuentas por Cobrar).
 *
 * Espejo read-only del estado de cuenta CxC de Kepler a nivel DOCUMENTO. Reproduce
 * el `Reporte de partidas vivas` (Crédito y cobranza → Estados de cuenta) que hoy
 * solo vive en el ERP. VERIFICADO: `saldo_cliente = Σ(importe·signo)` cuadra al peso
 * contra el PDF real (suc 01, grupo 1M001) en 8/8 clientes probados.
 *
 * `kdue` es AUTOSUFICIENTE: guarda facturas (c29='C') Y aplicaciones (c29='A') como
 * filas separadas. Universo CxC = crédito + cobros + notas/devoluciones; el contado
 * (UD10) se EXCLUYE por diseño (neto 0, no es cuenta por cobrar). El importer
 * `import-customer-receivables.js` puebla esta tabla desde los replicas md_01..06.
 *
 * analytics.* → sin RLS (filtro tenant explícito) + GRANT SELECT app_runtime.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('customer_receivables'))) {
    await knex.raw(`
      CREATE TABLE analytics.customer_receivables (
        tenant_id     uuid NOT NULL,
        sucursal      text NOT NULL,            -- kdue.c1
        doc_code      text NOT NULL,            -- c28+c29+lpad(c4,2)+lpad(c5,2), ej 'UD0801'
        doc_tipo      text NOT NULL,            -- factura | cobro | nota_credito | devolucion | otro
        doc_label     text,                     -- 'Factura Telemarketing' | 'Cobro CFDI' | ...
        folio         text NOT NULL,            -- kdue.c6
        folio_digital text,                     -- c1 || doc_code || '-' || c6  ('01UD0801-0000687')
        cliente_code  text,                     -- kdue.c2 (→ analytics.erp_customers / kdud)
        grupo         text,                     -- kdud.c13 (ej '1M001' TELEMARKETING LA PIEDAD)
        zona          text,                     -- kdud.c14 (ej '01')
        fecha         date,                     -- kdue.c7
        vencimiento   date,                     -- kdue.c10 (solo cargo; aging)
        importe       numeric NOT NULL DEFAULT 0,   -- kdue.c11
        cargo_abono   char(1) NOT NULL,         -- kdue.c29: C (cargo/deuda) | A (abono/pago)
        signed_amount numeric NOT NULL DEFAULT 0,   -- importe · (+1 si C, -1 si A) → SUM = saldo
        referencia    text,                     -- kdue.c16 (estado, ej 'EMBARCADO')
        vendedor      text,                     -- kdue.c18
        moneda        text,                     -- kdue.c8
        source_branch text,                     -- md_0X
        computed_at   timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, doc_code, folio)
      )`);
    // Cartera por cliente (agrupar + saldo) y aging (vencimiento).
    await knex.raw(`CREATE INDEX ix_cxc_cliente ON analytics.customer_receivables (tenant_id, sucursal, cliente_code)`);
    await knex.raw(`CREATE INDEX ix_cxc_venc ON analytics.customer_receivables (tenant_id, sucursal, vencimiento)`);
    await knex.raw(`CREATE INDEX ix_cxc_vendedor ON analytics.customer_receivables (tenant_id, sucursal, vendedor)`);
    await knex.raw(`CREATE INDEX ix_cxc_fecha ON analytics.customer_receivables (tenant_id, fecha DESC)`);
    await knex.raw(`GRANT SELECT ON analytics.customer_receivables TO app_runtime`);
  }

  // Idempotente: grupo/zona (kdud.c13/c14) por si la tabla ya existía sin ellas.
  for (const col of ['grupo', 'zona']) {
    if (!(await knex.schema.withSchema('analytics').hasColumn('customer_receivables', col))) {
      await knex.raw(`ALTER TABLE analytics.customer_receivables ADD COLUMN ${col} text`);
    }
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cxc_grupo_zona ON analytics.customer_receivables (tenant_id, sucursal, grupo, zona)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.customer_receivables`);
};
