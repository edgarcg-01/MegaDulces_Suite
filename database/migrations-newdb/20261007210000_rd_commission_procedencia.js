'use strict';
/**
 * `[RD.19]` — **El recibo declara con que se calculo, y el total deja de omitir una resta.**
 *
 * Tres cosas, las tres medidas o probadas por inspeccion sobre el motor que ya esta en prod.
 *
 * ── 1. ⛔ `total_a_pagar` NO es lo que se paga ───────────────────────────────────────────────
 * El motor arma la linea del supervisor con `nomina_banco = 0` y deja su deduccion -- que es
 * **por persona y agregada sobre sus rutas**, no por ruta -- fuera de toda suma. El comentario
 * del servicio lo dice y lo delega *"a quien consuma"*; el que consume es la pantalla, y la
 * pantalla **no lo hace**: el KPI grande y el pie de la tabla publican el bruto. Con la unica
 * deduccion que el libro documenta (`COMISIONES!K95 = 4,260`) y tres supervisores son
 * **~$12,780 por quincena** que el numero mas visible de la pantalla no resta.
 *
 * ⭐ **La deduccion NO se siembra.** No existe en ningun ERP que tengamos (`hr.*` solo trae
 * asistencia) y copiarla del Excel seria justo lo que esta fase retira. `commission_beneficiary_
 * config` **nace vacia**: mientras nadie la cargue, el motor publica el neto **declarado como
 * incompleto** (`deduccion_status = 'sin_configurar'`) en vez de publicar un bruto que se lee
 * como neto. Un hueco con nombre es mejor que un numero equivocado (ADR-056).
 *
 * ⚠️ Y lleva **ventana de vigencia**, que `commission_route_config.nomina_banco` no tiene: hoy
 * cambiar la deduccion reescribe la historia de todas las corridas viejas. Eso queda declarado
 * como deuda de esa tabla; no se toca aca para no mover el calculo del chofer en la misma
 * migracion que arregla el del supervisor.
 *
 * ── 2. ⭐ `margen_pct` guardaba un MARKUP ────────────────────────────────────────────────────
 * `(subtotal / costo - 1) * 100` es markup sobre costo, no margen sobre venta. El numero es el
 * correcto -- es lo que hace el Excel, y la propia doc de la fase lo llama markup (18.1-19.3%)
 * -- pero el nombre es una mina: "arreglarlo" a `(venta-costo)/venta` baja Canindo de ~18% a
 * ~15% y tumba rutas bajo sus umbrales de 14.5-16.5%, cambiando pagos sin que nadie lo pida.
 * Se renombra la columna y el valor de la metrica del bono. Verificado antes de renombrar: el
 * unico consumidor de `commission_run_lines.margen_pct` es el propio servicio --
 * `v_rd_period_summary` lee `pct_aplicado/comision/bonos/nomina_banco/a_pagar/motivo_no_pago` y
 * no esa columna, y el candado de RD.6 agrupa los bonos por `beneficiario/comparador`, no por
 * `metrica`.
 *
 * ── 3. Procedencia y compuertas ──────────────────────────────────────────────────────────────
 * Cada linea guarda **con que se calculo** (`venta_arbitro`, `costo_veredicto`, las dos
 * valuaciones del COGS, el traslape del periodo) y cada corrida guarda el resultado de sus
 * compuertas (`gates`) y la frescura del dato (`data_as_of`). Sin eso, un recibo de hace seis
 * meses se puede reproducir pero no se puede **defender**.
 *
 * ⭐ Estado nuevo **`bloqueada`**: una corrida automatica que no pasa una compuerta dura no nace
 * `borrador` -- nacer borrador la pone a un clic de aprobarse. Nace bloqueada, con el motivo.
 *
 * ⚠️ ORDEN DE DESPLIEGUE: esta migracion **renombra una columna que el API vivo escribe**. Va
 * junto con su redeploy. Hoy el riesgo es nulo (prod tiene **0 corridas y 0 lineas**: medido el
 * 2026-10-07), pero la regla no cambia por eso.
 *
 * @param { import("knex").Knex } knex
 */

const LINES = 'commercial.commission_run_lines';
const RUNS = 'commercial.commission_runs';
const BENE = 'commercial.commission_beneficiary_config';

exports.up = async function up(knex) {
  const hasCol = (t, c) => knex.schema.withSchema('commercial').hasColumn(t.split('.')[1], c);

  // ── 1. La linea: el nombre honesto y la procedencia ────────────────────────────────────────
  if (await hasCol(LINES, 'margen_pct')) {
    await knex.raw(`ALTER TABLE ${LINES} RENAME COLUMN margen_pct TO markup_sobre_costo_pct`);
  }
  const COLS_LINEA = [
    ['markup_sobre_costo_pct', 'numeric(10,4)'],  // por si la tabla nacio sin margen_pct
    ['margen_sobre_venta_pct', 'numeric(10,4)'],
    ['venta_arbitro', 'varchar(24)'],
    ['costo_veredicto', 'varchar(32)'],
    ['cogs_ruta', 'numeric(16,2)'],
    ['cogs_erp', 'numeric(16,2)'],
    ['traslape_subtotal', 'numeric(16,2)'],
    ['bono_veredicto', 'varchar(32)'],
    ['deduccion_status', 'varchar(24)'],
  ];
  for (const [c, t] of COLS_LINEA) {
    if (!(await hasCol(LINES, c))) await knex.raw(`ALTER TABLE ${LINES} ADD COLUMN ${c} ${t}`);
  }

  await knex.raw(`COMMENT ON COLUMN ${LINES}.markup_sobre_costo_pct IS
    'RD.19 - (subtotal/costo - 1)*100. Es MARKUP SOBRE COSTO, no margen sobre venta, y asi se llama: los umbrales del bono del supervisor (25% PH, 14.5-16.5% Canindo) estan calibrados contra esta razon porque es la que usa el Excel. Se llamaba margen_pct y ese nombre invitaba a un "arreglo" que habria tumbado a Canindo bajo su umbral.'`);
  await knex.raw(`COMMENT ON COLUMN ${LINES}.margen_sobre_venta_pct IS
    'RD.19 - (subtotal-costo)/subtotal*100. El margen de verdad. Se publica al lado del markup para que nadie los confunda; NINGUN bono se decide con esta.'`);
  await knex.raw(`COMMENT ON COLUMN ${LINES}.venta_arbitro IS
    'RD.19 - cual de las dos capturas de la venta se uso: push | erp | ambas_gana_push. El motor anterior las SUMABA (agrupaba solo por route_code sobre un UNION ALL de las dos).'`);
  await knex.raw(`COMMENT ON COLUMN ${LINES}.costo_veredicto IS
    'RD.19 - cuantas fuentes de costo respaldan el markup: dos_fuentes | una_fuente_embarque | una_fuente_erp | solo_wincaja_reexpresado | sin_costo. solo_wincaja_reexpresado es el INESTABLE (se re-expresa cada noche, FASE_RD 2.3).'`);
  await knex.raw(`COMMENT ON COLUMN ${LINES}.traslape_subtotal IS
    'RD.19 - cuanto subtotal del periodo aparece en las DOS capturas. 0 = no se pisan. Es lo que el motor anterior sumaba de mas en la base Y en la compuerta del escalon.'`);
  await knex.raw(`COMMENT ON COLUMN ${LINES}.bono_veredicto IS
    'RD.19 - sobre que descansa el bono pagado: arbitrado | fuente_unica | fuente_inestable | sin_metrica_no_paga. No suprime el pago; lo DECLARA para que quien aprueba sepa.'`);
  await knex.raw(`COMMENT ON COLUMN ${LINES}.deduccion_status IS
    'RD.19 - aplicada | sin_configurar | no_aplica. sin_configurar = hay beneficiario con deduccion esperada y nadie la cargo: el neto sale declarado incompleto, nunca igual al bruto en silencio.'`);

  // ── 2. La corrida: compuertas, frescura y el neto ──────────────────────────────────────────
  const COLS_RUN = [
    ['gates', 'jsonb'],
    ['data_as_of', 'timestamptz'],
    ['total_deduccion', 'numeric(16,2)'],
    ['total_neto', 'numeric(16,2)'],
    ['traslape_subtotal', 'numeric(16,2)'],
    ['rutas_fuera', 'integer'],
    ['origen', 'varchar(16)'],   // manual | cron
  ];
  for (const [c, t] of COLS_RUN) {
    if (!(await hasCol(RUNS, c))) await knex.raw(`ALTER TABLE ${RUNS} ADD COLUMN ${c} ${t}`);
  }
  // ⭐ Estado nuevo: una corrida automatica que no pasa una compuerta dura NO nace borrador.
  await knex.raw(`ALTER TABLE ${RUNS} DROP CONSTRAINT IF EXISTS commission_runs_status_valid`);
  await knex.raw(`
    ALTER TABLE ${RUNS} ADD CONSTRAINT commission_runs_status_valid
      CHECK (status IN ('borrador','bloqueada','aprobado','pagado','anulado'))`);
  await knex.raw(`COMMENT ON COLUMN ${RUNS}.gates IS
    'RD.19 - resultado de cada compuerta de la corrida: [{gate, estado, detalle}]. estado = pasa | bloquea | advierte | no_medido. Una corrida con alguna en bloquea nace status=bloqueada.'`);
  await knex.raw(`COMMENT ON COLUMN ${RUNS}.data_as_of IS
    'RD.19 - hasta cuando llegaba el dato cuando se calculo (frescura del carril que alimenta route_push_lines). Sin esto una corrida se puede reproducir pero no defender.'`);
  await knex.raw(`COMMENT ON COLUMN ${RUNS}.total_neto IS
    'RD.19 - lo que de verdad se paga: bruto menos las deducciones, INCLUIDA la del supervisor, que es por persona y que total_a_pagar nunca restaba (~12,780 por quincena con 3 supervisores).'`);
  await knex.raw(`COMMENT ON COLUMN ${RUNS}.rutas_fuera IS
    'RD.19 - cuantos route_code del universo NO comisionan en esta quincena, con su motivo en las lineas. Antes se caian sin contarse y la cobertura salia completa por construccion.'`);

  // ── 3. La deduccion por PERSONA. Nace vacia: no se copia del Excel ─────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('commission_beneficiary_config'))) {
    await knex.schema.withSchema('commercial').createTable('commission_beneficiary_config', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('scale_id').notNullable();
      t.string('beneficiario', 16).notNullable();        // chofer | supervisor
      t.string('nombre', 160).notNullable();             // como lo nombra commission_route_config
      t.uuid('user_id').nullable();                      // el puente a identity, cuando exista
      t.decimal('nomina_banco', 14, 2).notNullable().defaultTo(0);
      t.date('valid_from').notNullable();
      t.date('valid_to').nullable();
      t.text('notes').nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by').nullable();
      t.uuid('updated_by').nullable();
      t.timestamp('deleted_at').nullable();
      t.uuid('deleted_by').nullable();

      t.primary('id');
      t.foreign('scale_id').references('id').inTable('commercial.commission_scales').onDelete('RESTRICT');
      t.unique(['tenant_id', 'scale_id', 'beneficiario', 'nombre', 'valid_from'],
        { indexName: 'commission_beneficiary_natural_unique' });
      t.check(`?? in ('chofer','supervisor')`, ['beneficiario'], 'commission_beneficiary_tipo_valid');
      t.check('nomina_banco >= 0', [], 'commission_beneficiary_nomina_nonneg');
      t.check('valid_to IS NULL OR valid_to > valid_from', [], 'commission_beneficiary_window_valid');
      t.index(['tenant_id', 'scale_id', 'beneficiario'], 'idx_commission_beneficiary_scale');
    });

    await knex.raw(`ALTER TABLE ${BENE} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${BENE} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${BENE}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${BENE}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${BENE} TO app_runtime`);
    await knex.raw(`
      ALTER TABLE ${BENE}
        ADD CONSTRAINT fk_commission_beneficiary_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);

    await knex.raw(`COMMENT ON TABLE ${BENE} IS $$[RD.19] Deduccion de nomina de banco POR
PERSONA, con ventana de vigencia. Existe porque la del supervisor es por persona y agregada sobre
sus rutas -- no por ruta -- y el motor la dejaba fuera de toda suma, asi que total_a_pagar
publicaba el bruto como si fuera el neto. NACE VACIA A PROPOSITO: esta cifra no existe en ningun
ERP que tengamos (hr.* solo trae asistencia) y copiarla del Excel es justo lo que esta fase
retira. Mientras este vacia el motor publica deduccion_status='sin_configurar' y declara el neto
incompleto, que es distinto de publicar un bruto que se lee como neto.$$`);
  }

  // ── 4. La metrica del bono, con su nombre ──────────────────────────────────────────────────
  // ⚠️ EL ORDEN IMPORTA Y LA PRIMERA VERSION LO TENIA AL REVES: agregar el CHECK antes de mover
  // los valores lo hace fallar contra las filas que ya existen ("is violated by some row"), y la
  // migracion entera se revierte. Primero se suelta el candado viejo, luego se mueve el dato, y
  // recien entonces se pone el nuevo.
  await knex.raw(`ALTER TABLE commercial.commission_bonuses
                    DROP CONSTRAINT IF EXISTS commission_bonuses_metrica_valid`);
  const mov = await knex.raw(
    `UPDATE commercial.commission_bonuses SET metrica = 'markup_pct', updated_at = now()
      WHERE metrica = 'margen_pct'`);
  await knex.raw(`
    ALTER TABLE commercial.commission_bonuses ADD CONSTRAINT commission_bonuses_metrica_valid
      CHECK (metrica IN ('venta','markup_pct'))`);
  console.log(`[rd_commission_procedencia] metrica margen_pct -> markup_pct: ${mov.rowCount ?? 0} bonos`);
  await knex.raw(`COMMENT ON COLUMN commercial.commission_bonuses.metrica IS
    'RD.19 - venta | markup_pct. Se llamaba margen_pct y NO era margen: es (subtotal/costo-1)*100, markup sobre costo, que es lo que compara el Excel. Los umbrales (25% PH, 14.5-16.5% Canindo) estan calibrados contra esa razon.'`);
};

exports.down = async function down(knex) {
  const hasCol = (t, c) => knex.schema.withSchema('commercial').hasColumn(t.split('.')[1], c);
  await knex.raw(`UPDATE commercial.commission_bonuses SET metrica = 'margen_pct' WHERE metrica = 'markup_pct'`);
  await knex.raw(`ALTER TABLE commercial.commission_bonuses DROP CONSTRAINT IF EXISTS commission_bonuses_metrica_valid`);
  await knex.raw(`
    ALTER TABLE commercial.commission_bonuses ADD CONSTRAINT commission_bonuses_metrica_valid
      CHECK (metrica IN ('venta','margen_pct'))`);
  await knex.schema.withSchema('commercial').dropTableIfExists('commission_beneficiary_config');
  // El estado `bloqueada` se retira sólo si nadie lo usa: una corrida bloqueada no se puede
  // reclasificar sola sin inventarle un estado.
  const { rows: [b] } = await knex.raw(`SELECT count(*)::int n FROM ${RUNS} WHERE status = 'bloqueada'`);
  if (b.n > 0) throw new Error(`hay ${b.n} corrida(s) en estado bloqueada: resolverlas antes del down`);
  await knex.raw(`ALTER TABLE ${RUNS} DROP CONSTRAINT IF EXISTS commission_runs_status_valid`);
  await knex.raw(`
    ALTER TABLE ${RUNS} ADD CONSTRAINT commission_runs_status_valid
      CHECK (status IN ('borrador','aprobado','pagado','anulado'))`);
  for (const c of ['gates', 'data_as_of', 'total_deduccion', 'total_neto', 'traslape_subtotal', 'rutas_fuera', 'origen']) {
    if (await hasCol(RUNS, c)) await knex.raw(`ALTER TABLE ${RUNS} DROP COLUMN ${c}`);
  }
  for (const c of ['margen_sobre_venta_pct', 'venta_arbitro', 'costo_veredicto', 'cogs_ruta',
    'cogs_erp', 'traslape_subtotal', 'bono_veredicto', 'deduccion_status']) {
    if (await hasCol(LINES, c)) await knex.raw(`ALTER TABLE ${LINES} DROP COLUMN ${c}`);
  }
  if (await hasCol(LINES, 'markup_sobre_costo_pct')) {
    await knex.raw(`ALTER TABLE ${LINES} RENAME COLUMN markup_sobre_costo_pct TO margen_pct`);
  }
};
