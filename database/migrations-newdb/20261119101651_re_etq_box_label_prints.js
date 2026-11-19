'use strict';
/**
 * `[RE.ETQ.2.3]` — **La bitácora de etiquetas de caja (D4)**: `commercial.box_label_prints`. Un registro por
 * renglón de orden de entrada cada vez que se envía a imprimir, con lo que se imprimió.
 *
 * ── Por qué es una tabla y no una vista ─────────────────────────────────────────────────────
 *  Es dato PROPIO de la Suite (quién envió qué, cuándo, por qué vía): Kepler no lo tiene. Lo que viene de Kepler
 *  (renglones, cajas, UXC) se lee de `analytics.v_box_label_lines`; aquí se COPIA sólo lo que se imprimió, porque
 *  eso es justo lo que la bitácora tiene que recordar aunque Kepler cambie después (snapshot legítimo, ADR-056).
 *
 * ── Lo medido antes (sólo lectura, pg-prod, 2026-11-19) ─────────────────────────────────────
 *  · Hoy no existe ningún registro de lo impreso: Kepler imprime y olvida. Reimprimir desde Consulta da UXC 1 y
 *    la fecha del documento (vista previa del 5-nov: «UXC 1 306-26» contra «UXC 18 308-26»).
 *  · Volumen: 4,820 renglones con etiqueta en 30 días (≈160 al día, toda la red) → ~5,000 filas al mes.
 *
 * ── Reglas que la tabla hace cumplir ────────────────────────────────────────────────────────
 *  · **Una sola `primera` por renglón** (índice único parcial): su `fecha_etiqueta` (D6, el día en que se envió
 *    por primera vez) queda congelada aunque dos personas aprieten a la vez. Toda reimpresión copia sus datos.
 *  · `consecutivos` nunca vacío; `motivo` y `via` cerrados.
 *  · Sólo SELECT e INSERT para la app: la bitácora no se edita ni se borra.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS commercial`);
  if (!(await knex.schema.withSchema('commercial').hasTable('box_label_prints'))) {
    await knex.raw(`
      CREATE TABLE commercial.box_label_prints (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        sucursal            text NOT NULL,
        serie               integer NOT NULL,
        folio               text NOT NULL,
        linea               integer NOT NULL,
        motivo              text NOT NULL CHECK (motivo IN ('primera', 'reimpresion')),
        via                 text NOT NULL CHECK (via IN ('navegador', 'tspl')),
        consecutivos        integer[] NOT NULL CHECK (cardinality(consecutivos) > 0),
        -- Lo que se imprimió (en la primera; la reimpresión lo copia tal cual).
        sku                 text NOT NULL,
        nombre              text,
        unidad              text NOT NULL,
        unidad_base         text,
        uxc                 numeric,
        cajas_completas     integer NOT NULL,
        piezas_sueltas      numeric NOT NULL DEFAULT 0,
        total_etiquetas     integer NOT NULL,
        codigo              text NOT NULL,
        sucursal_nombre     text,
        fecha_etiqueta      text NOT NULL,
        dia_impresion       date NOT NULL,
        -- Lo que NO se imprime (D6): mide el atraso llegada → etiqueta.
        orden_capturada_el  date,
        vale_folio          text,
        vale_capturado_el   date,
        enviada_por         text,
        created_by          text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_by          text,
        updated_at          timestamptz NOT NULL DEFAULT now()
      )`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_box_label_prints_primera
                    ON commercial.box_label_prints (tenant_id, sucursal, serie, folio, linea) WHERE motivo = 'primera'`);
  // La cola pregunta por las órdenes de una sucursal: este índice lo da sin barrer la bitácora.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_box_label_prints_orden
                    ON commercial.box_label_prints (tenant_id, sucursal, folio, serie)`);
  await knex.raw(`ALTER TABLE commercial.box_label_prints ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.box_label_prints FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='box_label_prints' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON commercial.box_label_prints
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT ON commercial.box_label_prints TO app_runtime;
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON TABLE commercial.box_label_prints IS
    '[RE.ETQ.2.3] Bitacora de etiquetas de caja enviadas a imprimir (D4). Una primera por renglon (indice unico parcial): su fecha_etiqueta (D6) queda congelada y toda reimpresion copia sus datos. "Enviada" no es "impresa": el navegador no distingue imprimir de cancelar.'`);
  console.log('  ✓ [RE.ETQ.2.3] commercial.box_label_prints lista (RLS forzada, SELECT/INSERT para app_runtime)');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: la tabla es nueva. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.box_label_prints`);
};
