'use strict';
/**
 * `[GX.82]` — Cierra los vales que quedaron en `aprobada` esperando una factura que ya no se pide.
 *
 * Decisión del usuario (2026-10-12): *«no quiero que sea una manera de que dependa el status»* —
 * la factura no decide el estado y **la cotización basta como evidencia**. El regreso automático
 * por sólo-cotización (`[GX.54]`) se retiró del código; esta migración cierra los que ya dejó
 * atorados. Sólo cambia el estado, como pidió el usuario.
 *
 * ── Lo medido antes (sólo lectura, prod) ────────────────────────────────────────────────────
 *  · 93 vales en `aprobada`, todos `no_comprobable`, con cotización y sin comprobante, ninguno
 *    marcado `provisional` (los marcados los decidió una persona: se quedan como están).
 *  · $759,955.11 en total. Medido en 45 días: 72 de ellos ya pagados en Kepler (`c43 = F`).
 *
 * ── Quién firma ─────────────────────────────────────────────────────────────────────────────
 * La Suite no guardó quién los aprobó (al aprobar sin cerrar, `validated_by` queda vacío). No se
 * inventa un nombre: `validated_by` DICE que fue este cierre. Es también la marca exacta que usa
 * el `down` para deshacer sólo estas filas.
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO. Aplicarla ANTES de
 *    mergear, una por una con `apply-one-migration-prod.js`.
 *
 * Idempotente: la segunda corrida no encuentra filas.
 *
 * @param { import("knex").Knex } knex
 */

const FIRMA = 'cierre GX.82 (aprobado con cotización)';

const SOLO_COTIZACION = `
  EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.files::jsonb) = 'array' THEN p.files::jsonb ELSE '[]'::jsonb END) x
           WHERE x->>'role' LIKE 'cotizacion%')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.files::jsonb) = 'array' THEN p.files::jsonb ELSE '[]'::jsonb END) x
           WHERE x->>'role' LIKE 'comprobante%')`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    UPDATE finance.expense_proofs p
       SET status = 'validada', validated_by = ?, validated_at = now(), updated_at = now()
     WHERE p.status = 'aprobada'
       AND p.provisional IS NOT TRUE
       AND p.clasificacion = 'no_comprobable'
       AND ${SOLO_COTIZACION}`, [FIRMA]);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: las que llevan su firma. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    UPDATE finance.expense_proofs
       SET status = 'aprobada', validated_by = NULL, validated_at = NULL, updated_at = now()
     WHERE status = 'validada' AND validated_by = ?`, [FIRMA]);
};
