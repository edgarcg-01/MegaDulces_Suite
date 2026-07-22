/**
 * CB.6 — Reglas de clasificación bancaria en DB (ADR-033).
 *
 * Mueve la función hardcodeada classify() (duplicada idéntica en el CLI
 * import-bank-statement.js y en FinanceBankService) a una tabla editable desde
 * la vista Admin. Motivo: cada patrón nuevo "concepto → categoría" hoy exige
 * cambio de código + redeploy, y arriesga que las dos copias se desincronicen.
 *
 * Motor: reglas ordenadas por `priority` (menor = primero). Una regla aplica si
 * TODOS sus matchers no-nulos (regex sobre raw_type M / raw_code C / concept)
 * hacen match contra el valor normalizado (mayúsculas, espacios colapsados). La
 * primera regla que aplica gana; si ninguna aplica → 'sin_clasificar'.
 *
 * El seed reproduce EXACTAMENTE el classify() vigente (CB.1 + CB.5) para que el
 * cambio a DB sea neutral en comportamiento.
 *
 * @param { import("knex").Knex } knex
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';

async function createTenantRls(knex, table) {
  await knex.raw(`ALTER TABLE finance.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.${table}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.${table} TO app_runtime`);
}

// priority, match_type (M), match_code (C), match_concept, category_code, note
// null = comodín (siempre hace match). Patrones = regex case-insensitive.
const RULES = [
  [10,  '^(TE|TI)$', null,        null,                                                           'traspaso_entre_cuentas', 'Traspaso interno por tipo de movimiento'],
  [11,  null,        '^-$',       null,                                                           'traspaso_entre_cuentas', 'Código "-" = traspaso entre cuentas'],
  [20,  '^CF$',      null,        null,                                                           'compra_factoraje',       'Compra con factoraje'],
  [30,  '^PF$',      null,        null,                                                           'pago_factoraje',         'Pago a factoraje'],
  [40,  '^DS$',      null,        null,                                                           'devolucion_spei',        'Devolución SPEI'],
  [50,  '^ID$',      null,        null,                                                           'ingreso_devolucion',     'Ingreso por devolución'],
  [60,  '^I$',       null,        'DEV|DEVOLUC',                                                  'ingreso_devolucion',     'Ingreso marcado como devolución'],
  [61,  '^I$',       null,        null,                                                           'cobranza',               'Ingreso = cobranza (venta cobrada)'],
  [70,  null,        '^102$',     null,                                                           'cobranza',               'Código 102 = cobranza'],
  [80,  '^C$',       null,        null,                                                           'compra_mercancia',       'Movimiento tipo Compra'],
  [81,  null,        '^(510|501)$', null,                                                         'compra_mercancia',       'Código 510/501 = compra mercancía'],
  [90,  null,        '^610$',     null,                                                           'nomina',                 'Código 610 = nómina'],
  [100, null,        '^147$',     null,                                                           'iva_acreditable',        'Código 147 = IVA'],
  [110, null,        '^631$',     null,                                                           'pension_alimenticia',    'Código 631 = pensión'],
  [120, null,        '^621$',     null,                                                           'gasto_admin',            'Código 621 = gasto administrativo'],
  // 612/613 compartidas (reglas de concepto CB.5)
  [130, null,        '^(612|613)$', 'DISPOSICION POR POS|COMPRA - DISPOSICION',                   'compra_tarjeta',         'Disposición por POS = compra con tarjeta'],
  [131, null,        '^(612|613)$', 'DOMICILIACION|CFE|COMISION FEDERAL DE ELECTR|TELMEX|TELEFON|AGUA POTABLE', 'servicios', 'Domiciliación / servicios'],
  [132, null,        '^(612|613)$', '\\bSAT\\b|IMPUEST|\\bISR\\b|IVA POR PAGAR',                  'impuestos',              'Pago de impuestos'],
  [133, null,        '^(612|613)$', 'RENTA TERMINAL|RENTA TPV|RENTA DE TERMINAL',                 'comision_bancaria',      'Renta de terminal = comisión'],
  // 612 específicas
  [140, null,        '^612$',     'SUA|IMSS',                                                     'imss_sua',               'IMSS / SUA'],
  [141, null,        '^612$',     'COMISI|MEMBRES|COBRO',                                         'comision_bancaria',      'Comisión / membresía'],
  [142, null,        '^612$',     'CAPITAL|CREDITO|CRÉDITO|PRESTAMO|PRÉSTAMO',                    'pago_credito',           'Pago de capital de crédito'],
  [143, null,        '^612$',     'ARRENDA',                                                      'renta',                  'Arrendamiento'],
  [144, null,        '^612$',     'PAN AMERICANO|TRASLADO|VALORES',                               'traslado_valores',       'Traslado de valores'],
  // 613 específicas
  [150, null,        '^613$',     'CAJA DE AHORRO|CAJA AHORRO',                                   'caja_ahorro',            'Caja de ahorro'],
  [151, null,        '^613$',     'NOMINA|NÓMINA|\\bNOM\\b',                                      'nomina',                 'Nómina bajo 613'],
];

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  if (!(await knex.schema.withSchema('finance').hasTable('bank_classify_rules'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_classify_rules (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        priority      int  NOT NULL,                 -- menor = se evalúa primero
        match_type    text,                          -- regex sobre M (raw_type); null = comodín
        match_code    text,                          -- regex sobre C (raw_code); null = comodín
        match_concept text,                          -- regex sobre el concepto; null = comodín
        category_code text NOT NULL,                 -- categoría resultante (finance.movement_categories.code)
        note          text,
        active        boolean NOT NULL DEFAULT true,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_fin_classrule_prio ON finance.bank_classify_rules (tenant_id, priority) WHERE active`);
    await createTenantRls(knex, 'bank_classify_rules');
  }

  // Seed (SET LOCAL pasa el WITH CHECK de la policy). Idempotente por (tenant, priority).
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
  await knex.raw(
    `ALTER TABLE finance.bank_classify_rules
       ADD CONSTRAINT uq_fin_classrule UNIQUE (tenant_id, priority)`,
  ).catch(() => {}); // ya existe en re-run

  for (const [priority, mType, mCode, mConcept, category, note] of RULES) {
    await knex.raw(
      `INSERT INTO finance.bank_classify_rules
         (tenant_id, priority, match_type, match_code, match_concept, category_code, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, priority) DO NOTHING`,
      [MEGA, priority, mType, mCode, mConcept, category, note],
    );
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('bank_classify_rules');
};
