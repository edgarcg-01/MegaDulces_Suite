'use strict';
/**
 * `[RE.20.3]` — **Descartar una entrada, con motivo.** La salida que le faltaba al proceso.
 *
 * Hoy el único camino de salida de una orden de entrada es *Devuelta*, y devolver **rebota a la
 * sucursal**: le pide que suba otra vez algo que sí existe. Pero hay entradas que **nunca van a
 * tener factura de proveedor**, y para ésas el proceso no tiene final:
 *
 *   - **Traspasos entre sucursales** (`proveedor_code` con prefijo `TI` — `TI001` Padre Hidalgo,
 *     `TI002` 8 Esquinas…). No hay proveedor externo, así que no hay factura que subir.
 *     Verificado 2026-08-29: **1,176 en el histórico**, la última el **15/06/2026** — o sea que
 *     hoy caen todas en el carril de *rezago*, no en el vivo. Si el ERP vuelve a emitirlas,
 *     vuelven a caer en el carril vivo y el motivo ya está listo.
 *   - **Entradas en $0.00** — 13 sólo en agosto: muestras, bonificaciones o correcciones del ERP.
 *     Es la categoría que hoy SÍ está en el carril vivo.
 *   - **Canceladas o capturadas por error** en el ERP.
 *
 * Sin esto se quedan *Sin factura* para siempre, **inflan el atraso de su sucursal** y ensucian
 * el semáforo del Control. Y no se puede arreglar en el ERP: `analytics.erp_goods_receipts` es
 * una **vista viva** sobre `kepler_ods` (derive-no-copy), de sólo lectura. La decisión humana va
 * al lado, igual que el dictamen de gemelas en `analytics.erp_goods_receipt_dedup`.
 *
 * **El descarte NO esconde el problema:** sale del denominador de cobertura, pero el tablero
 * cuenta y muestra cuántas se descartaron y por qué. Un motivo que empieza a crecer es una
 * señal, no una fila menos.
 *
 * Aditiva e idempotente. No toca datos existentes.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  // ── 1. La decisión de descartar ───────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable('goods_receipt_discards'))) {
    await knex.raw(`
      CREATE TABLE finance.goods_receipt_discards (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        -- Clave natural de la entrada, igual que en goods_receipt_proofs: la vista de Kepler
        -- no tiene id propio estable y (sucursal, folio) es lo que identifica una recepción.
        sucursal       text NOT NULL,
        folio          text NOT NULL,
        motivo_codigo  text NOT NULL,
        -- Nota libre. El service la EXIGE cuando el motivo es 'otro': un descarte sin razón
        -- legible es indistinguible de esconder una factura que sí faltaba.
        motivo         text,
        descartado_por text,
        descartado_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id)
      )`);
    // Una entrada se descarta UNA vez. Reactivar borra la fila (y deja su rastro en el
    // historial), así que no hace falta versionar acá.
    await knex.raw(`CREATE UNIQUE INDEX ux_fin_grd_entrada
      ON finance.goods_receipt_discards (tenant_id, sucursal, folio)`);
    await knex.raw(`CREATE INDEX ix_fin_grd_motivo
      ON finance.goods_receipt_discards (tenant_id, motivo_codigo)`);

    await knex.raw(`ALTER TABLE finance.goods_receipt_discards ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.goods_receipt_discards FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON finance.goods_receipt_discards
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auto_populate_tenant_id') THEN
          DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON finance.goods_receipt_discards;
          CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON finance.goods_receipt_discards
            FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id();
        END IF;
      END $$;`);
    // DELETE sí (reactivar es un caso real: alguien descarta de más y la factura aparece).
    // UPDATE no: cambiar el motivo de un descarte viejo sin dejar rastro es reescribir la
    // historia — se reactiva y se vuelve a descartar, y las dos cosas quedan en el historial.
    await knex.raw(`GRANT SELECT, INSERT, DELETE ON finance.goods_receipt_discards TO app_runtime`);

    // Sin CHECK a propósito, igual que en `goods_receipt_proofs.motivo_codigo` (RE.13.2): el
    // catálogo va a crecer y una migración por motivo nuevo es fricción sin beneficio.
    await knex.raw(`COMMENT ON TABLE finance.goods_receipt_discards IS
      'RE.20.3 — entradas de Kepler que NUNCA van a tener factura de proveedor (traspaso|cancelada_erp|duplicada|sin_costo|otro). Salen del denominador de cobertura pero se siguen contando aparte. La vista analytics.erp_goods_receipts es read-only, por eso la decisión vive acá.'`);
    await knex.raw(`COMMENT ON COLUMN finance.goods_receipt_discards.motivo_codigo IS
      'traspaso = movimiento entre sucursales (proveedor_code TI*), no hay proveedor externo · cancelada_erp = el documento se canceló o se capturó por error · duplicada = la misma recepción ya está en otra orden · sin_costo = entrada en $0 (muestra/bonificación/corrección) · otro = exige nota.'`);
  }

  // ── 2. El historial acepta decisiones SIN evidencia ───────────────────────
  // `goods_receipt_proof_history` nació atado a un `proof_id` porque las únicas decisiones eran
  // sobre una evidencia subida. Un descarte es una decisión sobre la ENTRADA y no hay evidencia
  // que apuntar. La tabla ya denormaliza (sucursal, folio) y se LEE por ahí, así que abrirla es
  // dejar UNA sola línea de tiempo por entrada en vez de dos tablas que el detalle tenga que
  // intercalar.
  if (await knex.schema.withSchema('finance').hasTable('goods_receipt_proof_history')) {
    const [{ nullable }] = (await knex.raw(`
      SELECT is_nullable = 'YES' AS nullable FROM information_schema.columns
       WHERE table_schema = 'finance' AND table_name = 'goods_receipt_proof_history'
         AND column_name = 'proof_id'`)).rows;
    if (!nullable) {
      await knex.raw(`ALTER TABLE finance.goods_receipt_proof_history ALTER COLUMN proof_id DROP NOT NULL`);
      await knex.raw(`COMMENT ON COLUMN finance.goods_receipt_proof_history.proof_id IS
        'NULL cuando la decisión es sobre la ENTRADA y no sobre una evidencia (RE.20.3: descartada/reactivada).'`);
    }
  }
};

exports.down = async function down(knex) {
  // No se borra al bajar la fase: un descarte es una decisión humana con nombre y fecha, y
  // volverla a pedir es re-trabajo para la sucursal. Misma regla que el historial (RE.13.2).
  await knex.raw(`SELECT 1`);
};
