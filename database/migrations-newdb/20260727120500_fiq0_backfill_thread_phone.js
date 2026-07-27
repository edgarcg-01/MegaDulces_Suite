/**
 * Fase FIQ.0 (ADR-036) — Backfill de `whatsapp.conversation_threads.phone` a
 * MSISDN canónico (52XXXXXXXXXX).
 *
 * A partir de FIQ.0 el ingest guarda el teléfono canónico; los hilos ABIERTOS
 * creados antes tienen `521XXXXXXXXXX` (crudo de Meta) y no matchearían el nuevo
 * `getOrCreate({ phone })` (match exacto) → se crearía un hilo duplicado y el
 * cliente perdería su carrito/domicilio en curso al momento del deploy.
 *
 * Collision-safe: solo normaliza un hilo si su forma canónica NO está ya tomada
 * por OTRO hilo abierto del mismo tenant (respeta el índice parcial
 * uq_wa_thread_open (tenant_id, phone) WHERE state <> 'done'). Idempotente.
 */

exports.up = async function up(knex) {
  const res = await knex.raw(`
    UPDATE whatsapp.conversation_threads t
       SET phone = public.mx_normalize_phone(t.phone)
     WHERE t.phone IS NOT NULL
       AND public.mx_normalize_phone(t.phone) IS NOT NULL
       AND public.mx_normalize_phone(t.phone) <> t.phone
       AND NOT EXISTS (
         SELECT 1 FROM whatsapp.conversation_threads o
          WHERE o.tenant_id = t.tenant_id
            AND o.id <> t.id
            AND o.state <> 'done'
            AND o.phone = public.mx_normalize_phone(t.phone)
       )
  `);
  // eslint-disable-next-line no-console
  console.log(`[fiq0_backfill_thread_phone] hilos normalizados: ${res.rowCount ?? 0}`);
};

exports.down = async function down() {
  // No reversible (no guardamos el formato previo); no-op seguro.
};
