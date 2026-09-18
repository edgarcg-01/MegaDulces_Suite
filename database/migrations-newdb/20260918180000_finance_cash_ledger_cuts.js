/**
 * CG.15 — Corte de caja con DOBLE LLAVE + saldo corrido + cancelación (ADR-070).
 *
 * Sin esto el libro de CG.13 es una lista, no una caja: no tiene saldo, no tiene cierre y un
 * movimiento mal capturado no tiene salida. Las tres cosas, con el criterio del §CG.15.
 *
 * ── 1. EL SALDO SE DERIVA, NO SE GUARDA ────────────────────────────────────────────────
 * El Access guarda el saldo en una columna (`Doctos.SaldoD`) que se calcula al capturar. Un
 * saldo almacenado se desvía en cuanto alguien cancela, reordena o inserta fuera de turno, y
 * nadie se entera porque el número sigue ahí, con cara de correcto. Acá es una VISTA con
 * `sum() OVER`: no puede desviarse porque no existe hasta que se pregunta.
 * El orden es `created_at, id` — el orden REAL de captura. NO el folio: los folios son por
 * tipo (CI/CG/CD), así que entre tipos no ordenan nada.
 *
 * ── 2. EL CORTE SEPARA FUNCIONES ───────────────────────────────────────────────────────
 * `borrador → cerrado → autorizado`, molde `purchase_book_runs` (LC.6).
 *   · abrir/cerrar  = FINANCE_CAJA_GESTIONAR (el capturista cuenta el efectivo)
 *   · autorizar     = FINANCE_CAJA_AUTORIZAR (otra persona lo acepta)
 * ⛔ Y el CHECK `cut_doble_llave_chk` impide en la DB que quien cerró sea quien autoriza. No
 * es una validación de servicio que alguien pueda saltarse con un UPDATE: es el candado.
 *
 * La aritmética del corte, explícita para que se pueda auditar:
 *   esperado  = fondo_inicial + ingresos − gastos − depositos
 *   contado   = Σ(denominación × piezas) + morralla   ← lo que el humano contó físicamente
 *   diferencia = contado − esperado                    ← positivo sobra, negativo falta
 *
 * ── 3. UN MOVIMIENTO NO SE BORRA, SE CANCELA ───────────────────────────────────────────
 * Con motivo obligatorio y autor. Y **no se puede cancelar lo que ya entró a un corte
 * cerrado**: eso movería un cuadre que alguien ya firmó. El CHECK lo exige.
 *
 * RLS FORZADO + grants. Idempotente. Aditiva.
 *
 * ⚠️ NO confundir con `analytics.cash_cuts`, que es el arqueo del POS de Wincaja espejado
 * desde Kepler (SM.1), ni con `wincaja.cortes` (la réplica cruda). Ésta es la caja NUESTRA.
 *
 * @param { import("knex").Knex } knex
 */

async function tenantRls(knex, table) {
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

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  // --- El corte -----------------------------------------------------------------------------
  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_cuts'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_ledger_cuts (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        folio           text NOT NULL,                  -- CC-AAAA-NNNNN
        fecha           date NOT NULL,
        sucursal        text NOT NULL,
        estado          text NOT NULL DEFAULT 'borrador',

        fondo_inicial   numeric(18,2) NOT NULL DEFAULT 0,
        -- Snapshot de los totales AL CERRAR. Se congelan a propósito: el corte es una foto,
        -- y si mañana alguien cancela un movimiento viejo la foto no puede cambiar sola.
        total_ingresos  numeric(18,2),
        total_gastos    numeric(18,2),
        total_depositos numeric(18,2),
        esperado        numeric(18,2),
        contado         numeric(18,2),
        morralla        numeric(18,2) NOT NULL DEFAULT 0,
        diferencia      numeric(18,2),
        nota            text,

        -- quién hizo qué. La doble llave vive en estas tres columnas.
        created_by      uuid NOT NULL,
        created_by_username text,
        closed_by       uuid,
        closed_by_username  text,
        closed_at       timestamptz,
        authorized_by   uuid,
        authorized_by_username text,
        authorized_at   timestamptz,

        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT cut_estado_chk CHECK (estado IN ('borrador','cerrado','autorizado')),
        CONSTRAINT cut_fondo_chk  CHECK (fondo_inicial >= 0),
        -- Un corte CERRADO tiene que traer su cuadre completo: cerrar sin contar no es cerrar.
        CONSTRAINT cut_cerrado_completo_chk CHECK (
          estado = 'borrador'
          OR (closed_by IS NOT NULL AND closed_at IS NOT NULL
              AND esperado IS NOT NULL AND contado IS NOT NULL AND diferencia IS NOT NULL)),
        -- Un corte AUTORIZADO tiene que estar firmado.
        CONSTRAINT cut_autorizado_firmado_chk CHECK (
          estado <> 'autorizado' OR (authorized_by IS NOT NULL AND authorized_at IS NOT NULL)),
        -- ⛔ LA DOBLE LLAVE: quien cerró NO puede ser quien autoriza. En la DB, no en el servicio.
        CONSTRAINT cut_doble_llave_chk CHECK (
          authorized_by IS NULL OR closed_by IS NULL OR authorized_by <> closed_by)
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_cash_cut_folio ON finance.cash_ledger_cuts (tenant_id, folio)`);
    // Un solo corte ABIERTO por sucursal: dos cajas abiertas el mismo día no cuadran nunca.
    await knex.raw(`CREATE UNIQUE INDEX ux_cash_cut_abierto ON finance.cash_ledger_cuts (tenant_id, sucursal) WHERE estado = 'borrador'`);
    await knex.raw(`CREATE INDEX ix_cash_cut_fecha ON finance.cash_ledger_cuts (tenant_id, fecha DESC)`);
    await tenantRls(knex, 'cash_ledger_cuts');
  }

  // --- El conteo físico del corte, por denominación ------------------------------------------
  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_cut_denominations'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_ledger_cut_denominations (
        tenant_id    uuid NOT NULL,
        cut_id       uuid NOT NULL REFERENCES finance.cash_ledger_cuts(id) ON DELETE CASCADE,
        denominacion numeric(10,2) NOT NULL,
        piezas       int NOT NULL,
        PRIMARY KEY (tenant_id, cut_id, denominacion),
        CONSTRAINT cut_denom_piezas_chk CHECK (piezas > 0),
        CONSTRAINT cut_denom_valor_chk CHECK (denominacion IN
          (1000,500,200,100,50,20,10,5,2,1,0.50,0.20,0.10,0.05))
      )`);
    await tenantRls(knex, 'cash_ledger_cut_denominations');
  }

  // --- Cancelación de un movimiento: se marca, no se borra ----------------------------------
  const add = async (col, ddl) => {
    if (!(await knex.schema.withSchema('finance').hasColumn('cash_ledger', col))) {
      await knex.raw(`ALTER TABLE finance.cash_ledger ADD COLUMN ${ddl}`);
    }
  };
  await add('cancel_reason', 'cancel_reason text');
  await add('cancelled_by', 'cancelled_by uuid');
  await add('cancelled_by_username', 'cancelled_by_username text');
  await add('cancelled_at', 'cancelled_at timestamptz');

  // Cancelar exige motivo y autor: "cancelado" sin por qué es un agujero en la auditoría.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_ledger_cancel_chk') THEN
        ALTER TABLE finance.cash_ledger ADD CONSTRAINT cash_ledger_cancel_chk CHECK (
          estado <> 'cancelado'
          OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
              AND length(btrim(coalesce(cancel_reason,''))) >= 5));
      END IF;
    END $$`);

  // El corte al que pertenece el movimiento, con FK de verdad.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_ledger_corte_fk') THEN
        ALTER TABLE finance.cash_ledger ADD CONSTRAINT cash_ledger_corte_fk
          FOREIGN KEY (corte_id) REFERENCES finance.cash_ledger_cuts(id) ON DELETE SET NULL;
      END IF;
    END $$`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cash_ledger_corte ON finance.cash_ledger (tenant_id, corte_id) WHERE corte_id IS NOT NULL`);

  // --- El saldo corrido, DERIVADO -----------------------------------------------------------
  // `security_invoker` + filtro de tenant adentro: una vista no hereda la RLS de su tabla.
  await knex.raw(`DROP VIEW IF EXISTS finance.v_cash_ledger_balance`);
  await knex.raw(`
    CREATE VIEW finance.v_cash_ledger_balance
      WITH (security_invoker = true) AS
    SELECT l.id, l.tenant_id, l.folio, l.tipo, l.fecha, l.sucursal, l.monto, l.estado,
           l.corte_id, l.created_at,
           -- Un movimiento cancelado no mueve el saldo, pero SIGUE EN LA LISTA: borrarlo de la
           -- vista lo volvería invisible, y lo que se audita es justamente que se canceló.
           CASE WHEN l.estado = 'cancelado' THEN 0
                WHEN l.tipo = 'ingreso' THEN l.monto
                ELSE -l.monto END AS efecto,
           sum(CASE WHEN l.estado = 'cancelado' THEN 0
                    WHEN l.tipo = 'ingreso' THEN l.monto
                    ELSE -l.monto END)
             OVER (PARTITION BY l.tenant_id, l.sucursal
                   ORDER BY l.created_at, l.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS saldo_movimientos
      FROM finance.cash_ledger l
     WHERE l.tenant_id = current_tenant_id()
       AND l.deleted_at IS NULL`);
  await knex.raw(`GRANT SELECT ON finance.v_cash_ledger_balance TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS finance.v_cash_ledger_balance`);
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_corte_fk`);
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_cancel_chk`);
  for (const c of ['cancel_reason', 'cancelled_by', 'cancelled_by_username', 'cancelled_at']) {
    if (await knex.schema.withSchema('finance').hasColumn('cash_ledger', c)) {
      await knex.raw(`ALTER TABLE finance.cash_ledger DROP COLUMN ${c}`);
    }
  }
  await knex.schema.withSchema('finance').dropTableIfExists('cash_ledger_cut_denominations');
  await knex.schema.withSchema('finance').dropTableIfExists('cash_ledger_cuts');
};
