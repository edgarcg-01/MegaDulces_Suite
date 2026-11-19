'use strict';
/**
 * `[PGP.153]` — Dos índices parciales en `fiscal.cfdis` (CFDI recibidos) para que la evidencia de una tanda de facturas
 * (`analytics.payable_evidence(p_llaves)`, `[PGP.152]`) BUSQUE los CFDI que pueden casar en vez de recorrer los 172 mil,
 * y la función deja de materializar su CTE `cfd` para poder usarlos.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-18) ────────────────────────────────────────
 *  · `fiscal.cfdis`: ~455 mil filas, 526 MB de heap + 919 MB de TOAST; 2.8 M actualizaciones desde el último reinicio de
 *    estadísticas. Ningún índice sirve hoy: el de `emisor_rfc` exige `tipo_comprobante = 'I'`, y el cruce por folio es
 *    una expresión (`regexp_replace` del folio a número).
 *  · Con `[PGP.152]`, la evidencia de 200 facturas tarda ~1.6–2.0 s; ~0.85 s es recorrer y materializar los CFDI.
 *  · **Simulación del índice** (sólo lectura: `cfd` restringido por llave primaria a los CFDI que casarían por RFC o
 *    por folio — 15,882 de ~172 mil para 41 RFC y 127 referencias): **~1.6 s → ~0.95 s, filas idénticas** (huella).
 *    Es una simulación: el tiempo real se mide DESPUÉS de crearlos (ver «Después de aplicar»).
 *
 * ── Para aplicar (fuera de horario; una persona) ────────────────────────────────────────────
 * `fiscal.cfdis` recibe actualizaciones todo el día y el aplicador fija `lock_timeout` de 15 s: un `CREATE INDEX
 * CONCURRENTLY` ahí puede fallar y dejar un índice INVALID. Receta de la skill `entrega` §5: crear los dos índices
 * ANTES, a mano, con margen de `lock_timeout`, y después aplicar esta migración (los encuentra hechos y sólo cambia la
 * función). Si encuentra un índice INVALID, se NIEGA y dice cuál borrar.
 *
 * ── Después de aplicar ──────────────────────────────────────────────────────────────────────
 * Medir `GET payment-calendar/evidencia` en `analytics.ui_usage` por día. Si no baja, `down()` regresa la función a
 * materializar `cfd` y borra los índices: nada de esto cambia filas.
 *
 * Requiere `20261118144337_pgp152_evidencia_por_llaves` aplicada. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false };

/** El número del folio del CFDI, la MISMA expresión que el CTE `cfd` de la evidencia (si difiere, el índice no se usa). */
const FOLIO_N = `(NULLIF(regexp_replace(COALESCE(folio, ''::text), '[^0-9]'::text, ''::text, 'g'::text), ''::text)::numeric)`;
const INDICES = [
  { nombre: 'ix_fiscal_cfdis_recibidas_folio_n', sql: `ON fiscal.cfdis (tenant_id, ${FOLIO_N}) WHERE rol = 'recibidas'` },
  { nombre: 'ix_fiscal_cfdis_recibidas_rfc', sql: `ON fiscal.cfdis (tenant_id, emisor_rfc) WHERE rol = 'recibidas'` },
];
const MATERIALIZADO = '), cfd AS (';
const SIN_MATERIALIZAR = '), cfd AS NOT MATERIALIZED (';

async function cuerpoDeLaFuncion(knex) {
  const r = (await knex.raw(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('analytics.payable_evidence(text[])')`)).rows[0];
  return r ? String(r.prosrc) : null;
}
async function columnas(knex) {
  return (await knex.raw(`
    SELECT a.attname AS nombre, format_type(a.atttypid, a.atttypmod) AS tipo
      FROM pg_attribute a
     WHERE a.attrelid = 'analytics.v_payable_evidence'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`)).rows;
}
async function reemplazarCuerpo(knex, cuerpo) {
  const cols = await columnas(knex);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.payable_evidence(p_llaves text[])
    RETURNS TABLE (${cols.map((c) => `${c.nombre} ${c.tipo}`).join(', ')})
    LANGUAGE sql STABLE
    AS $fn$ ${cuerpo.trim()} $fn$`);
}

exports.up = async function up(knex) {
  const cuerpo = await cuerpoDeLaFuncion(knex);
  if (!cuerpo) throw new Error('[PGP.153] falta analytics.payable_evidence: aplica antes 20261118144337_pgp152_evidencia_por_llaves.js');
  for (const ix of INDICES) {
    const inval = (await knex.raw(`
      SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'fiscal' AND c.relname = ? AND NOT i.indisvalid`, [ix.nombre])).rows.length;
    if (inval) throw new Error(`[PGP.153] el índice fiscal.${ix.nombre} quedó INVALID (un CONCURRENTLY anterior falló): bórralo con DROP INDEX CONCURRENTLY fiscal.${ix.nombre} y vuelve a crearlo con margen de lock_timeout (skill entrega §5)`);
    await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ix.nombre} ${ix.sql}`);
  }
  if (cuerpo.includes(SIN_MATERIALIZAR)) { console.log('  · [PGP.153] la función ya no materializa cfd'); return; }
  if (cuerpo.split(MATERIALIZADO).length !== 2) throw new Error('[PGP.153] el CTE cfd no aparece como se esperaba en la función: no se adivina');
  await reemplazarCuerpo(knex, cuerpo.replace(MATERIALIZADO, SIN_MATERIALIZAR));
  console.log('  ✓ [PGP.153] índices de CFDI listos; la evidencia busca los CFDI por índice (cfd sin materializar)');
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la función vuelve a materializar `cfd` y se borran los dos índices. */
exports.down = async function down(knex) {
  const cuerpo = await cuerpoDeLaFuncion(knex);
  if (cuerpo && cuerpo.includes(SIN_MATERIALIZAR)) await reemplazarCuerpo(knex, cuerpo.replace(SIN_MATERIALIZAR, MATERIALIZADO));
  for (const ix of INDICES) await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS fiscal.${ix.nombre}`);
};

exports.INDICES = INDICES;
exports.FOLIO_N = FOLIO_N;
