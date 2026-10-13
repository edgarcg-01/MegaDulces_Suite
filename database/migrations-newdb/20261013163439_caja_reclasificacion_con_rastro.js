'use strict';
/**
 * ⭐⭐ `[CG.128]` — **Corregir la cuenta de un movimiento de caja, con rastro.**
 *
 * Edgar: *"necesitamos corregir esos ingresos y no dejar que vuelva a pasar"*.
 *
 * La segunda mitad la cierra `[CG.127]` (el autollenado del ingreso ya propone la cuenta del
 * árbitro). Esta es la primera: **hoy no existe ninguna forma de corregir un movimiento ya
 * guardado.** Se puede editar una REGLA (`PATCH /reglas/:id`) y se puede CANCELAR el movimiento,
 * pero cambiarle la cuenta no — por eso los 25 ingresos siguen mal.
 *
 * ── Lo medido en prod (2026-10-13) ──────────────────────────────────────────────────────────
 *
 * **25 ingresos ($404,725 + los del día) y el árbitro propone `115/071` para los 25**, con 16,700
 * renglones de respaldo en la póliza `UA0501` de la sucursal `00`:
 *
 *     102/011  CAJA GENERAL ............. 15 → 115/071   la caja contra si misma
 *     201/201  PASIVO A PROVEEDORES ......  5 → 115/071   deuda con proveedor
 *     607-002  HONORARIOS CONTADOR .......  3 → 115/071   lo que Edgar leyó en pantalla
 *     102/037  CAJA CHICA MORELIA ........  1 → 115/071
 *
 * Ninguno está sellado todavía, así que se pueden corregir sin tocar un corte firmado.
 *
 * ── Por qué una TABLA y no un `updated_at` ──────────────────────────────────────────────────
 *
 * ⛔ Cambiar la cuenta de un movimiento de dinero **sin guardar la anterior** convierte un error
 * en una historia que nadie puede reconstruir: al día siguiente, el libro se ve impecable y no hay
 * forma de saber que estuvo mal ni quién lo decidió. `updated_by`/`updated_at` dicen *que* cambió,
 * no *de qué a qué*.
 *
 * Es el primitivo que la Fase VP declaró faltante («historia de datos maestros», hoy **cero** para
 * precio, costo, reorden y etiqueta). Acá nace para la caja, que es donde hay dinero, y queda
 * disponible para los demás.
 *
 * ⚠️ **El movimiento sellado NO se toca** — eso lo exige el servicio y además lo protege esta
 * tabla, que guarda `corte_id` al momento del cambio: si alguna vez aparece una fila con corte,
 * se puede ir a ver qué corte quedó describiendo algo que después cambió.
 *
 * ⚠️ **`motivo` obligatorio, ≥12 caracteres**, mismo criterio que `[CG.124]`: una corrección sin
 * razón escrita es indistinguible de un ajuste para que cuadre.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'cash_ledger_reclasificaciones';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('finance').hasTable(TABLA))) {
    await knex.raw(`
      CREATE TABLE finance.${TABLA} (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        cash_ledger_id  uuid NOT NULL REFERENCES finance.cash_ledger(id) ON DELETE CASCADE,

        -- El ANTES. Sin esto la correccion borra la historia que viene a explicar.
        de_cuenta       text,
        de_concepto     text,
        -- El DESPUES.
        a_cuenta        text NOT NULL,
        a_concepto      text NOT NULL,

        /**
         * De donde salio la cuenta nueva. "arbitro" = la poliza del propio Kepler
         * (analytics.v_caja_contracuenta_cobro); "manual" = alguien la eligio.
         * Separarlas importa: una correccion derivada se puede volver a correr y verificar;
         * una manual NO, y por eso su motivo pesa mas.
         */
        origen          text NOT NULL,
        /** Cuantos renglones de poliza sostienen la propuesta, cuando viene del arbitro. */
        respaldo        integer,

        motivo          text NOT NULL,

        -- El corte al momento del cambio. Deberia ser NULL siempre: un movimiento sellado no se
        -- reclasifica. Si aparece lleno, hay un corte firmado describiendo algo que cambio.
        corte_id        uuid,

        hecho_por       uuid,
        hecho_por_username text,
        created_at      timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT cg_recl_origen_chk CHECK (origen IN ('arbitro','manual')),
        CONSTRAINT cg_recl_motivo_chk CHECK (length(btrim(motivo)) >= 12),
        -- Una reclasificacion que no cambia nada no es una reclasificacion.
        CONSTRAINT cg_recl_cambia_chk CHECK (
          de_cuenta IS DISTINCT FROM a_cuenta OR de_concepto IS DISTINCT FROM a_concepto)
      )`);
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS cg_recl_por_mov
      ON finance.${TABLA} (tenant_id, cash_ledger_id, created_at DESC)`);

  await knex.raw(`ALTER TABLE finance.${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='${TABLA}'
           AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.${TABLA}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  /**
   * ⛔ Sin DELETE, y a proposito: una bitacora que se puede borrar no es una bitacora. Un cambio
   * equivocado se corrige con OTRA reclasificacion, que tambien queda escrita.
   */
  await knex.raw(`GRANT SELECT, INSERT ON finance.${TABLA} TO app_runtime`);

  await knex.raw(`
    COMMENT ON TABLE finance.${TABLA} IS
      '[CG.128] Historia de los cambios de cuenta/concepto de un movimiento de caja. Guarda el ANTES, que "+
      "updated_by/updated_at no dicen. Sin DELETE: un cambio equivocado se corrige con otra fila.'`);

  // --- La cola de trabajo: a quien el árbitro contradice ------------------------------------
  /**
   * ⭐ La vista NO corrige nada: lista. Quien decide es una persona, y el servicio exige motivo.
   *
   * ⚠️ Sólo movimientos **sin sellar** (`corte_id IS NULL`): un corte firmado describe un hecho
   * y no se reescribe por detrás.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_caja_por_reclasificar AS
    SELECT l.tenant_id, l.id AS cash_ledger_id, l.folio, l.fecha, l.tipo, l.monto, l.sucursal,
           l.beneficiario, l.glosa,
           l.kepler_cuenta   AS de_cuenta,
           l.kepler_concepto AS de_concepto,
           a.cuenta          AS a_cuenta,
           a.concepto        AS a_concepto,
           a.cuenta_nombre, a.concepto_nombre,
           a.renglones       AS respaldo
      FROM finance.cash_ledger l
      JOIN analytics.v_caja_contracuenta_cobro a
        ON a.tenant_id = l.tenant_id AND a.sucursal = l.sucursal
     WHERE l.tipo = 'ingreso'
       AND l.deleted_at IS NULL
       AND l.estado <> 'cancelado'
       AND l.corte_id IS NULL
       AND a.cuenta IS NOT NULL AND a.concepto IS NOT NULL
       AND (l.kepler_cuenta IS DISTINCT FROM a.cuenta
         OR l.kepler_concepto IS DISTINCT FROM a.concepto)`);

  await knex.raw(`ALTER VIEW analytics.v_caja_por_reclasificar SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_caja_por_reclasificar TO app_runtime`);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_caja_por_reclasificar IS
      '[CG.128] Ingresos SIN SELLAR cuya cuenta contradice a la poliza del propio Kepler. Medido el 2026-10-13: 25 ingresos, los 25 deberian ir a 115/071 ABONO A CLIENTES (16,700 renglones de respaldo). No corrige: lista.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_por_reclasificar`);
  await knex.raw(`DROP TABLE IF EXISTS finance.${TABLA}`);
};
