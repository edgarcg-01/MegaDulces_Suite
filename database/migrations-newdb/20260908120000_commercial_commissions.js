/**
 * RD.6 — Motor de comisiones de Ruta Directa. El esquema.
 *
 * QUÉ REEMPLAZA
 * Las hojas `COMISIONES`, `FORMATO DE PAGO` y `FORMATO DE SUPERVISOR` de
 * `INDICADORES RD 2026.xlsx`, que es con lo que hoy se paga cada quincena a 13 choferes
 * y 3 supervisores. La base del cálculo es la venta que la plataforma ya deriva del ERP:
 * medido contra el workbook, el SUBTOTAL casa 98.0% exacto (1,934 de 1,974 celdas) y la
 * cadena de pago se reproduce al centavo — `COMISIONES` quincena 1 ruta PH 21:
 * `228,380.02 × 5% × 80% = 9,135.20` (L5) · `× 20% = 2,283.80` (K5) ·
 * `A PAGAR = 9,135.20 − 3,484.96 = 5,650.24` (N5).
 *
 * Por eso este sprint NO depende de los dos huecos declarados en FASE_RD §2.3 y §2.4:
 * la comisión se calcula sobre SUBTOTAL, no sobre el costo.
 *
 * LAS REGLAS VIVEN EN LA TABLA, NO EN EL CÓDIGO
 * Lección de CB.6: el `classify()` hardcodeado se volvió `finance.bank_classify_rules` y
 * la fuente de verdad pasó a ser la tabla. Acá igual: el tabulador, los bonos, el reparto
 * chofer/supervisor y la nómina de banco son filas, con ventana de vigencia. Un cambio de
 * tabulador es un INSERT con `valid_from`, no un deploy — y las corridas viejas siguen
 * explicándose con la escala que les tocaba.
 *
 * LO QUE SE CORRIGE DEL EXCEL AL MIGRAR (FASE_RD §4 — patrón CB: rediseñar, no migrar)
 *  - §4.4 UN SOLO UMBRAL. El Excel usa `>189,999.99` en 11 rutas y `>169,999.99` en las
 *    rutas 22 y 23 para la misma regla. Acá el umbral es el piso del primer escalón, uno.
 *  - §4.6 EL ESCALÓN DE ARRIBA NO TIENE TECHO. El Excel cierra con
 *    `IF(venta<400000,"5.000%")` sin rama `else`: una venta de $400,000 devuelve `FALSE` y
 *    `subtotal × FALSE = 0` → comisión CERO en la venta más alta. Acá el último escalón
 *    lleva `max_amount IS NULL` = sin techo, y hay un CHECK que impide dejar la escala
 *    abierta por arriba con un techo finito.
 *  - §4.5 EL FACTOR DEL SUPERVISOR ES DEL PERIODO. En el Excel está anclado a una fila
 *    fija (`I97`, `I98`, `I126`, `I154/155`), así que todos los periodos usan el factor de
 *    uno solo; hoy es inocuo porque todos valen 0.20, y rompe en silencio el día que
 *    cambie. Acá vive en la escala, con su ventana de vigencia.
 *  - §4.2 LA RUTA 322 NO SE QUEDA SIN SUPERVISOR. En el Excel sus celdas de factor
 *    (`T154/T155`) están vacías → el chofer cobra el 100% y el supervisor 0.
 *    `share_supervisor_pct` es NOT NULL con CHECK de rango.
 *  - §4.7 UNA SOLA NÓMINA DE BANCO. El Excel tiene SEIS valores para el mismo concepto
 *    (3,484.96 · 5,000 · 4,413.08 · 4,260 · 4,260.80 · 3,632/3,200.58) repartidos entre
 *    hojas, así que el neto dependía de cuál se imprimiera. Acá es una columna de
 *    `commission_route_config`, una por ruta.
 *  - §4.8 LA RUTA 28 CUENTA. `B31 = SUM(G13:G17)` la dejaba fuera del bono del supervisor
 *    de PH. Acá el alcance del supervisor sale de `commission_route_config`, no de un rango.
 *
 * MOTOR DECIDE / HUMANO APRUEBA (ADR-016)
 * Una corrida nace `borrador`, se revisa contra el Excel del periodo y sólo entonces pasa a
 * `aprobado` y `pagado`. No hay auto-pago. Las líneas guardan el detalle con el que se
 * calcularon (subtotal, venta, % aplicado, bonos, deducción) para que un recibo de hace
 * seis meses se pueda volver a explicar sin recalcular nada.
 *
 * @param { import("knex").Knex } knex
 */

const audit = (knex, t) => {
  t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  t.uuid('created_by').nullable();
  t.uuid('updated_by').nullable();
  t.timestamp('deleted_at').nullable();
  t.uuid('deleted_by').nullable();
};

const TABLES = [
  'commission_run_lines',
  'commission_runs',
  'commission_periods',
  'commission_route_config',
  'commission_bonuses',
  'commission_scale_tiers',
  'commission_scales',
];

/** RLS forzado + grant, igual en las 7. */
async function hardenAll(knex) {
  for (const tb of TABLES) {
    const q = `commercial.${tb}`;
    await knex.raw(`ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${q} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${q}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${q}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO app_runtime`);
    await knex.raw(`
      ALTER TABLE ${q}
        ADD CONSTRAINT fk_${tb}_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
  }
}

exports.up = async function up(knex) {
  if (await knex.schema.withSchema('commercial').hasTable('commission_scales')) return;
  const S = () => knex.schema.withSchema('commercial');

  // ── 1) La escala: el encabezado del tabulador, con ventana de vigencia ────────────────
  await S().createTable('commission_scales', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('code', 40).notNullable();               // 'RD-2026'
    t.string('nombre', 160).notNullable();
    t.date('valid_from').notNullable();
    t.date('valid_to').nullable();                    // NULL = vigente
    // Sobre qué monto se calcula y con qué monto se abre la compuerta. En el Excel de 2026
    // la comisión va sobre SUBTOTAL y la compuerta la abre TOTAL VENTA: no es lo mismo.
    t.string('base_field', 16).notNullable().defaultTo('subtotal');   // subtotal | venta
    t.string('gate_field', 16).notNullable().defaultTo('venta');      // subtotal | venta
    // §4.5 / §4.2 — el reparto es de la escala y del periodo, no de una celda fija.
    t.decimal('share_supervisor_pct', 6, 4).notNullable().defaultTo(20);
    t.text('notes').nullable();
    audit(knex, t);

    t.primary('id');
    t.unique(['tenant_id', 'code', 'valid_from'], { indexName: 'commission_scales_natural_unique' });
    t.check(`?? in ('subtotal','venta')`, ['base_field'], 'commission_scales_base_valid');
    t.check(`?? in ('subtotal','venta')`, ['gate_field'], 'commission_scales_gate_valid');
    t.check('share_supervisor_pct >= 0 AND share_supervisor_pct <= 100', [], 'commission_scales_share_range');
    t.check('valid_to IS NULL OR valid_to > valid_from', [], 'commission_scales_window_valid');
  });

  // ── 2) Los escalones ─────────────────────────────────────────────────────────────────
  await S().createTable('commission_scale_tiers', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('scale_id').notNullable();
    t.decimal('min_amount', 16, 2).notNullable();     // inclusivo
    t.decimal('max_amount', 16, 2).nullable();        // exclusivo · NULL = sin techo (§4.6)
    t.decimal('pct', 8, 4).notNullable();             // 3.7500 = 3.75%
    audit(knex, t);

    t.primary('id');
    t.foreign('scale_id').references('id').inTable('commercial.commission_scales').onDelete('CASCADE');
    t.unique(['tenant_id', 'scale_id', 'min_amount'], { indexName: 'commission_tiers_natural_unique' });
    t.check('max_amount IS NULL OR max_amount > min_amount', [], 'commission_tiers_range_valid');
    t.check('pct >= 0 AND pct <= 100', [], 'commission_tiers_pct_range');
    t.index(['tenant_id', 'scale_id'], 'idx_commission_tiers_scale');
  });

  // ── 3) Los bonos ─────────────────────────────────────────────────────────────────────
  // Chofer: por VENTA del periodo (Lavadas 200 / Lonche 800 / Chalán 1000).
  // Supervisor: por MARGEN alcanzado, con umbral por ruta y compuerta de venta mínima.
  // ⚠️ El bono del supervisor depende del MARGEN, y el margen depende del costo, que hoy
  // no es estable (FASE_RD §2.3). El servicio lo calcula con las dos bases y marca la
  // divergencia; no cambia el pago por su cuenta.
  await S().createTable('commission_bonuses', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('scale_id').notNullable();
    t.string('beneficiario', 16).notNullable();       // chofer | supervisor
    t.string('nombre', 80).notNullable();             // 'Lavadas', 'Alcance de margen'
    t.string('metrica', 16).notNullable();            // venta | margen_pct
    t.decimal('umbral', 16, 4).notNullable();         // se paga si metrica > umbral
    t.decimal('monto', 14, 2).notNullable();
    t.string('route_code', 24).nullable();            // NULL = aplica a todas las rutas
    t.decimal('gate_venta_min', 16, 2).nullable();    // compuerta extra del Excel
    audit(knex, t);

    t.primary('id');
    t.foreign('scale_id').references('id').inTable('commercial.commission_scales').onDelete('CASCADE');
    t.unique(['tenant_id', 'scale_id', 'beneficiario', 'nombre', 'route_code'], { indexName: 'commission_bonuses_natural_unique' });
    t.check(`?? in ('chofer','supervisor')`, ['beneficiario'], 'commission_bonuses_benef_valid');
    t.check(`?? in ('venta','margen_pct')`, ['metrica'], 'commission_bonuses_metrica_valid');
    t.index(['tenant_id', 'scale_id'], 'idx_commission_bonuses_scale');
  });

  // ── 4) La configuración por ruta ─────────────────────────────────────────────────────
  // §4.7 la nómina de banco vive UNA vez. §4.8 el alcance del supervisor sale de acá,
  // no de un rango de filas, así que la ruta 28 no se puede volver a caer de la suma.
  await S().createTable('commission_route_config', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('route_code', 24).notNullable();         // '21' … '505'
    t.uuid('scale_id').notNullable();
    t.decimal('nomina_banco', 14, 2).notNullable().defaultTo(0);
    t.string('zona', 80).nullable();
    t.uuid('chofer_user_id').nullable();
    t.string('chofer_nombre', 160).nullable();
    t.uuid('supervisor_user_id').nullable();
    t.string('supervisor_nombre', 160).nullable();
    t.boolean('activo').notNullable().defaultTo(true);
    audit(knex, t);

    t.primary('id');
    t.unique(['tenant_id', 'route_code'], { indexName: 'commission_route_config_natural_unique' });
    t.foreign('scale_id').references('id').inTable('commercial.commission_scales').onDelete('RESTRICT');
    t.check('nomina_banco >= 0', [], 'commission_route_config_nomina_nonneg');
    t.index(['tenant_id', 'supervisor_nombre'], 'idx_commission_route_config_super');
  });

  // ── 5) Los periodos ──────────────────────────────────────────────────────────────────
  // Quincena de 14 días. En el Excel `B95 = 2026-01-14` y `B96 = B95+14`, 27 periodos;
  // el inicio es `fin − 13` y la fecha de pago `fin + 3`.
  await S().createTable('commission_periods', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.integer('anio').notNullable();
    t.integer('period_no').notNullable();             // 1..27
    t.date('date_from').notNullable();
    t.date('date_to').notNullable();
    t.date('pay_date').nullable();
    audit(knex, t);

    t.primary('id');
    t.unique(['tenant_id', 'anio', 'period_no'], { indexName: 'commission_periods_natural_unique' });
    t.check('date_to >= date_from', [], 'commission_periods_range_valid');
    t.check('period_no >= 1', [], 'commission_periods_no_positive');
    t.index(['tenant_id', 'date_from', 'date_to'], 'idx_commission_periods_range');
  });

  // ── 6) La corrida ────────────────────────────────────────────────────────────────────
  await S().createTable('commission_runs', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('period_id').notNullable();
    t.uuid('scale_id').notNullable();
    t.string('status', 16).notNullable().defaultTo('borrador'); // borrador|aprobado|pagado|anulado
    t.decimal('total_subtotal', 16, 2).notNullable().defaultTo(0);
    t.decimal('total_venta', 16, 2).notNullable().defaultTo(0);
    t.decimal('total_comision', 16, 2).notNullable().defaultTo(0);
    t.decimal('total_a_pagar', 16, 2).notNullable().defaultTo(0);
    // Cobertura del dato con el que se calculó. Si una ruta del periodo no tuvo fuente,
    // se dice acá y no se publica el total como si estuviera completo (FASE_RD §2.4).
    t.integer('rutas_con_dato').notNullable().defaultTo(0);
    t.integer('rutas_sin_dato').notNullable().defaultTo(0);
    t.timestamp('approved_at').nullable();
    t.uuid('approved_by').nullable();
    t.timestamp('paid_at').nullable();
    t.uuid('paid_by').nullable();
    t.text('notes').nullable();
    audit(knex, t);

    t.primary('id');
    t.foreign('period_id').references('id').inTable('commercial.commission_periods').onDelete('RESTRICT');
    t.foreign('scale_id').references('id').inTable('commercial.commission_scales').onDelete('RESTRICT');
    t.check(`?? in ('borrador','aprobado','pagado','anulado')`, ['status'], 'commission_runs_status_valid');
    t.index(['tenant_id', 'period_id'], 'idx_commission_runs_period');
  });
  // Una sola corrida VIVA por periodo; las anuladas no estorban. UNIQUE parcial.
  await knex.raw(`
    CREATE UNIQUE INDEX commission_runs_una_viva_por_periodo
      ON commercial.commission_runs (tenant_id, period_id)
      WHERE deleted_at IS NULL AND status <> 'anulado'`);

  // ── 7) El renglón: el recibo congelado ───────────────────────────────────────────────
  await S().createTable('commission_run_lines', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('run_id').notNullable();
    t.string('route_code', 24).notNullable();
    t.string('beneficiario', 16).notNullable();       // chofer | supervisor

    // La base con la que se calculó, guardada. Un recibo de hace seis meses se explica
    // sin recalcular: si la venta del ERP cambia después, la corrida no se mueve.
    t.decimal('subtotal', 16, 2).nullable();
    t.decimal('venta', 16, 2).nullable();
    t.decimal('costo', 16, 2).nullable();
    t.decimal('margen_pct', 8, 4).nullable();
    t.string('subtotal_origen', 32).nullable();       // erp | derivado_tasa_wincaja
    t.string('costo_status', 40).nullable();          // erp_reexpresado_cada_corrida | sin_dato_en_la_fuente

    t.decimal('pct_aplicado', 8, 4).nullable();       // NULL = no alcanzó el primer escalón
    t.decimal('comision', 14, 2).notNullable().defaultTo(0);
    t.decimal('bonos', 14, 2).notNullable().defaultTo(0);
    t.jsonb('bonos_detalle').notNullable().defaultTo('[]');
    t.decimal('nomina_banco', 14, 2).notNullable().defaultTo(0);
    t.decimal('a_pagar', 14, 2).notNullable().defaultTo(0);
    t.string('motivo_no_pago', 64).nullable();        // 'bajo_umbral' | 'sin_dato_en_la_fuente'
    audit(knex, t);

    t.primary('id');
    t.foreign('run_id').references('id').inTable('commercial.commission_runs').onDelete('CASCADE');
    t.unique(['tenant_id', 'run_id', 'route_code', 'beneficiario'], { indexName: 'commission_run_lines_natural_unique' });
    t.check(`?? in ('chofer','supervisor')`, ['beneficiario'], 'commission_run_lines_benef_valid');
    t.index(['tenant_id', 'run_id'], 'idx_commission_run_lines_run');
  });

  await hardenAll(knex);

  await knex.raw(`COMMENT ON TABLE commercial.commission_scales IS 'RD.6 — tabulador de comision de Ruta Directa, con ventana de vigencia. Las reglas son FILAS, no ifs (leccion CB.6): cambiar el tabulador es un INSERT con valid_from, y las corridas viejas siguen explicandose con la escala que les tocaba. base_field=sobre que monto se calcula, gate_field=cual abre la compuerta: en el Excel de 2026 la comision va sobre SUBTOTAL y la compuerta la abre TOTAL VENTA.'`);
  await knex.raw(`COMMENT ON TABLE commercial.commission_scale_tiers IS 'RD.6 — escalones. min_amount inclusivo, max_amount exclusivo y NULL = SIN TECHO: el Excel cerraba con IF(venta<400000,"5%") sin rama else, asi que una venta de 400,000 devolvia FALSE y pagaba comision CERO en la venta mas alta.'`);
  await knex.raw(`COMMENT ON TABLE commercial.commission_bonuses IS 'RD.6 — bonos. Chofer por VENTA del periodo; supervisor por MARGEN, con umbral por ruta. OJO: el bono del supervisor depende del margen y el margen del costo, que hoy no es estable (FASE_RD 2.3) — el servicio lo calcula con las dos bases y marca la divergencia, no cambia el pago por su cuenta.'`);
  await knex.raw(`COMMENT ON TABLE commercial.commission_route_config IS 'RD.6 — config por ruta: escala, nomina de banco, chofer y supervisor. La nomina de banco vive UNA vez: el Excel tenia SEIS valores para el mismo concepto repartidos entre hojas, asi que el neto dependia de cual se imprimiera. El alcance del supervisor sale de aca y no de un rango de filas, para que la ruta 28 no se vuelva a caer de la suma.'`);
  await knex.raw(`COMMENT ON TABLE commercial.commission_periods IS 'RD.6 — quincenas de 14 dias. El Excel arranca en 2026-01-14 (fin del periodo 1) y suma 14; inicio = fin-13, pago = fin+3.'`);
  await knex.raw(`COMMENT ON TABLE commercial.commission_runs IS 'RD.6 — corrida por periodo. Motor decide / humano aprueba (ADR-016): nace borrador, se cuadra contra el Excel del periodo y solo entonces pasa a aprobado y pagado. Sin auto-pago. rutas_sin_dato declara la cobertura: si una ruta no tuvo fuente no se publica el total como si estuviera completo.'`);
  await knex.raw(`COMMENT ON TABLE commercial.commission_run_lines IS 'RD.6 — el renglon del recibo, CONGELADO con la base que lo produjo (subtotal, venta, % aplicado, bonos, deduccion) mas la procedencia (subtotal_origen, costo_status). Un recibo de hace seis meses se vuelve a explicar sin recalcular, y si la venta del ERP cambia despues la corrida no se mueve.'`);
};

exports.down = async function down(knex) {
  for (const tb of TABLES) {
    await knex.schema.withSchema('commercial').dropTableIfExists(tb);
  }
};
