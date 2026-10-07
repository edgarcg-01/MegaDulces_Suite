/**
 * RD.4 — `logistics.route_expenses`: el gasto de flota de la Ruta Directa.
 *
 * QUÉ REEMPLAZA
 * La hoja `CONTROL DE GASTOS RD` de `INDICADORES RD 2026.xlsx` — factura por factura, con
 * litros. Es **dato propio**: no existe en ningún ERP, sólo en ese archivo. Tabla real es
 * el caso legítimo de la regla #1 (HITL / captura), igual que `commercial.sales_targets`.
 *
 * Y NO ESTÁ DUPLICADO EN NINGÚN LADO: medido en prod, `logistics.fuel_transactions` tiene
 * **0 filas**, `logistics.vehicle_usage_logs` **0** y `commercial.route_tickets` **5**. Las
 * tres tablas diseñadas para alojar esto están vacías. Carga limpia.
 *
 * ── LO QUE EL PARSE MIDIÓ ANTES DE MODELAR (patrón CB.1) ────────────────────────────────
 * 782 filas con importe, $848,610.04, 34,718.24 litros, 13 rutas, 2026-01-02 → 2026-08-29.
 * La suma coincide **al peso** con la columna cruda `J3:J2057` de la hoja (782 celdas), así
 * que el parse no pierde nada.
 *
 * ⚠️ NO cuadra contra el "TOTAL POR TIPO DE GASTO" del propio Excel (`Z7 = 507,341.34` para
 * COMBUSTIBLES) — y el que está mal es el Excel: `Z7` es
 * `SUM(O7,O23,O38,O47,O60,R7,R23,R38,R47,V7,V23,)` (con coma colgando), una lista de celdas
 * que apunta a bloques de resumen rotulados con rutas **24, 25, 300 y 301**, que no existen
 * en los datos. El resumen suma casi puros ceros y subdeclara el combustible en ~$332,000.
 * Por eso el árbitro del importer es la columna cruda, no el total de la hoja.
 *
 * ── DOS DECISIONES QUE SALIERON DE MEDIR ────────────────────────────────────────────────
 *  1. LA LLAVE. `(ruta, fecha, folio, tipo)` NO es única: hay una colisión real
 *     (`501 · 2026-04-06 · folio 38438 · tipo 4` con $105 y $859.73 — dos cargos en el
 *     mismo vale). Agregando el importe quedan **0 duplicados**, así que la llave natural
 *     lo incluye. No se usa el número de renglón del Excel: si alguien inserta una fila,
 *     todos los renglones de abajo se corren y el re-import duplicaría en silencio.
 *  2. EL TIPO NO SE ADIVINA. 5 filas vienen sin tipo, y cuatro *parecen* gasolina por la
 *     descripción y una "CAMBIOS DE MUELLES" parece reparación. Parecer no alcanza: entran
 *     con el tipo `0 · SIN CLASIFICAR`, que es visible y se corrige desde la UI. Es lo que
 *     hizo CB con su 14.7% sin clasificar.
 *
 * ── EL CATÁLOGO ES TABLA, NO UN ENUM ────────────────────────────────────────────────────
 * Los 6 tipos salen de la hoja. Hoy la captura real es **99% combustible** (776 de 782
 * filas): los otros cinco tipos existen en el libro como rótulos de resumen pero casi no se
 * usan. Se siembran igual, porque son las categorías con las que la gente piensa el gasto y
 * la pantalla las va a ofrecer.
 *
 * `vehicle_id` es NULLABLE a propósito: el gasto se captura contra la RUTA, que es el grano
 * que el dato tiene, y sólo 13 de 50 `logistics.trackers` tienen `route_number`, así que
 * exigir vehículo dejaría fuera la mayoría. Se llena cuando el vínculo existe.
 *
 * @param { import("knex").Knex } knex
 */

const TIPOS = [
  [0, 'SIN CLASIFICAR', 'El Excel trae filas sin tipo. No se adivina: se marcan y se corrigen desde la UI.'],
  [1, 'PLACAS / ARRENDAMIENTOS / VERIFICACION', null],
  [2, 'ARRENDAMIENTOS / OTROS GASTOS', null],
  [3, 'NEUMATICOS / LUBRICANTES / BATERIAS', null],
  [4, 'COMBUSTIBLES', 'El unico con litros. 99% de la captura real del workbook.'],
  [5, 'SEGUROS / GPS', null],
  [6, 'REPARACIONES Y SERVICIOS', null],
];

exports.up = async function up(knex) {
  if (await knex.schema.withSchema('logistics').hasTable('route_expenses')) return;

  // ── Catálogo ─────────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('logistics').hasTable('route_expense_types'))) {
    await knex.schema.withSchema('logistics').createTable('route_expense_types', (t) => {
      t.integer('code').notNullable();
      t.uuid('tenant_id').notNullable();
      t.string('nombre', 80).notNullable();
      t.boolean('lleva_litros').notNullable().defaultTo(false);
      t.boolean('activo').notNullable().defaultTo(true);
      t.text('notes').nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by').nullable();
      t.uuid('updated_by').nullable();
      t.primary(['tenant_id', 'code']);
    });
    await knex.raw(`
      ALTER TABLE logistics.route_expense_types
        ADD CONSTRAINT fk_route_expense_types_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
  }

  // ── El gasto ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('route_expenses', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('route_code', 24).notNullable();
    t.date('expense_date').notNullable();
    t.integer('expense_type').notNullable().defaultTo(0);
    t.string('folio', 64).notNullable().defaultTo('');   // FACTURA/VALE
    t.string('supplier', 200).nullable();
    t.string('description', 300).nullable();
    t.decimal('liters', 12, 3).nullable();               // sólo COMBUSTIBLES
    t.decimal('total', 14, 2).notNullable();
    t.boolean('is_remote').notNullable().defaultTo(false); // col REMOTO del Excel
    t.uuid('vehicle_id').nullable();
    t.integer('period_no').nullable();
    t.string('source', 24).notNullable().defaultTo('captura_web'); // excel_import | captura_web
    t.text('notes').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by').nullable();
    t.uuid('updated_by').nullable();
    t.timestamp('deleted_at').nullable();
    t.uuid('deleted_by').nullable();

    t.primary('id');
    t.check('total >= 0', [], 'route_expenses_total_nonneg');
    t.check('liters IS NULL OR liters >= 0', [], 'route_expenses_liters_nonneg');
    t.check(`?? in ('excel_import','captura_web')`, ['source'], 'route_expenses_source_valid');
    t.index(['tenant_id', 'route_code', 'expense_date'], 'idx_route_expenses_ruta_fecha');
    t.index(['tenant_id', 'expense_date'], 'idx_route_expenses_fecha');
  });

  await knex.raw(`
    ALTER TABLE logistics.route_expenses
      ADD CONSTRAINT fk_route_expenses_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
  await knex.raw(`
    ALTER TABLE logistics.route_expenses
      ADD CONSTRAINT fk_route_expenses_type
      FOREIGN KEY (tenant_id, expense_type)
      REFERENCES logistics.route_expense_types(tenant_id, code) ON DELETE RESTRICT`);

  // Idempotencia del re-import. Incluye el importe porque el folio se repite con montos
  // distintos (medido: una colisión real en 782 filas; con importe, cero).
  await knex.raw(`
    CREATE UNIQUE INDEX route_expenses_natural_unique
      ON logistics.route_expenses (tenant_id, route_code, expense_date, folio, expense_type, total)
      WHERE deleted_at IS NULL`);

  for (const tb of ['route_expense_types', 'route_expenses']) {
    const q = `logistics.${tb}`;
    await knex.raw(`ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${q} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${q}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${q}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO app_runtime`);
  }

  // Seed del catálogo para cada tenant que exista.
  const { rows: tenants } = await knex.raw(`SELECT id FROM identity.tenants`);
  for (const { id } of tenants) {
    await knex('logistics.route_expense_types')
      .insert(TIPOS.map(([code, nombre, notes]) => ({
        tenant_id: id, code, nombre, notes, lleva_litros: code === 4, activo: true,
      })))
      .onConflict(['tenant_id', 'code']).ignore();
  }

  await knex.raw(`COMMENT ON TABLE logistics.route_expenses IS 'RD.4 — gasto de flota de Ruta Directa, factura por factura, con litros. Dato PROPIO: no existe en ningun ERP, solo en la hoja CONTROL DE GASTOS RD del workbook INDICADORES RD. Se captura contra la RUTA, que es el grano que el dato tiene; vehicle_id es opcional porque solo 13 de 50 trackers tienen route_number. La llave natural incluye el IMPORTE porque el folio se repite con montos distintos (medido: una colision real en 782 filas).'`);
  await knex.raw(`COMMENT ON TABLE logistics.route_expense_types IS 'RD.4 — las 6 categorias de gasto de la hoja, mas 0 SIN CLASIFICAR para las filas que vienen sin tipo. El tipo NO se adivina por la descripcion: se marca y se corrige desde la UI (patron CB, que dejo su 14.7% sin clasificar a la vista).'`);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('route_expenses');
  await knex.schema.withSchema('logistics').dropTableIfExists('route_expense_types');
};
