'use strict';
/**
 * ⭐⭐ `[CGA-A.18]` — **La glosa decía de qué depósito era; ahora lo dice el ENLACE.**
 *
 * ── Qué pasaba, medido en prod el 2026-10-19 ───────────────────────────────────────────────
 *
 * **18 movimientos del libro citan `CAOS Deposito #NNNN` dentro de `glosa`** y no tienen ni una
 * fila en `finance.caos_cash_links`:
 *
 *     CI-2026-00046   $40,949.00   "CAOS Deposito #1595 - RV24416/RV321-16531 - arqueo..."
 *     CI-2026-00045    $6,244.50   "CAOS Deposito #1594 - RV MOR 7-10-2026 - ruta 2V005..."
 *     ... 16 más
 *
 * ⛔ **Es `GOTCHAS` §86 en su forma pura: la identidad del depósito vive en un campo de texto.**
 * Para una persona que lee, están conciliados. Para cualquier cosa que calcule, no existen — por
 * eso el reparto cajón/bóveda los cuenta entre los **758 depósitos de CAOS sin enlazar**, y por
 * eso el arqueo publica un movimiento que no ocurrió en caja general.
 *
 * ── Qué IDENTIFICA al depósito, y qué no ───────────────────────────────────────────────────
 *
 * ⭐ El enlace se arma por el **NÚMERO** (`external_id`), que es la llave y está escrito
 * explícitamente en la glosa. **NO por el importe** — ésa es justamente la lección de §86, donde
 * aparear por un campo de prosa escondió $1,325,687.43. Acá el número es inequívoco; el importe
 * sólo se usa como **comprobación**, no como identidad.
 *
 * ── La única exclusión, y por qué ──────────────────────────────────────────────────────────
 *
 * De los 18 se enlazan **17**. Queda fuera `CI-2026-00049`:
 *
 *     libro $20,345.00   ·   CAOS #1619 $20,420.00   ->   residuo −$75.00
 *
 * ⛔ Un residuo negativo es **imposible por construcción**: diría que la máquina se tragó más de
 * lo que el movimiento vale. Enlazarlo metería `en_el_cajon` en negativo por una vía falsa — el
 * mismo defecto que `CG-2026-00129` ya tiene y que esta fase está persiguiendo. Se **declara**
 * en el log y lo resuelve quien capturó, no una migración.
 *
 * ⚠️ **Los 7 con residuo > $1,000 SÍ se enlazan**, y se listan en el log para que alguien los
 * mire:
 *
 *     CI-2026-00046  #1595   residuo $4,509.00        CI-2026-00033  #1599   residuo $1,577.00
 *     CI-2026-00032  #1598   residuo $2,629.00        CI-2026-00036  #1602   residuo $1,197.00
 *     CI-2026-00041  #1614   residuo $1,234.00        CI-2026-00014  #1577   residuo $1,073.00
 *     CI-2026-00039  #1612   residuo $1,046.00
 *
 * No se excluyen porque **el residuo no contradice la identidad**: la máquina sólo acepta
 * billetes, así que un cobro puede dejar miles en el cajón de forma legítima. Excluirlos sería
 * volver a decidir por el importe lo que la llave ya decidió. Lo que sí corresponde es que se
 * vean, porque $4,509 de morralla no es morralla.
 *
 * ── Convención del importe enlazado ────────────────────────────────────────────────────────
 *
 * `monto_enlazado = el total que contó la MÁQUINA`. Medido: de los 26 enlaces que ya existían,
 * los 26 coinciden al centavo con `caos_cash_movements.total` — cero excepciones. Se respeta.
 *
 * Idempotente: `ux_caos_link_vivo` ya impide dos enlaces vivos sobre el mismo depósito, y el
 * `INSERT` filtra por `NOT EXISTS`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/**
 * Los candidatos: citan un depósito en la glosa, no tienen enlace, y ese depósito existe,
 * es un Deposito (`type_id = 0`), está libre, y no deja residuo negativo.
 */
const CANDIDATOS = `
  SELECT l.id AS cash_ledger_id, l.folio, l.monto, m.device, m.external_id, m.total,
         (l.monto - m.total) AS residuo
    FROM finance.cash_ledger l
    JOIN analytics.caos_cash_movements m
      ON m.tenant_id = l.tenant_id
     AND m.external_id = substring(l.glosa from 'Deposito #([0-9]+)')::bigint
   WHERE l.tenant_id = ?::uuid
     AND l.deleted_at IS NULL
     AND l.estado <> 'cancelado'
     AND l.glosa ~ 'Deposito #[0-9]+'
     AND m.type_id = 0
     AND l.monto >= m.total
     AND NOT EXISTS (SELECT 1 FROM finance.caos_cash_links k
                      WHERE k.cash_ledger_id = l.id AND k.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM finance.caos_cash_links k2
                      WHERE k2.tenant_id = l.tenant_id AND k2.deleted_at IS NULL
                        AND k2.caos_device = m.device AND k2.caos_external_id = m.external_id)`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: previos } = await knex.raw(CANDIDATOS, [TENANT]);
  if (previos.length === 0) {
    console.log('[A.18] no hay glosas de CAOS sin enlazar. Nada que hacer.');
    return;
  }

  const { rowCount } = await knex.raw(`
    INSERT INTO finance.caos_cash_links
      (tenant_id, cash_ledger_id, caos_device, caos_external_id, monto_enlazado, senales)
    SELECT ?::uuid, c.cash_ledger_id, c.device, c.external_id, c.total,
           jsonb_build_object(
             'origen', 'CGA-A.18',
             'por', 'numero_en_glosa',
             'residuo', c.residuo,
             'nota', 'La glosa citaba "CAOS Deposito #N". El enlace sale del NUMERO, no del importe.')
      FROM (${CANDIDATOS}) c`, [TENANT, TENANT]);

  // ⛔ Si se insertó algo distinto de lo que se midió, algo cambió entre la medición y el
  // INSERT: se aborta en vez de dejar un enlace que nadie contó.
  if (rowCount !== previos.length) {
    throw new Error(`[A.18] se midieron ${previos.length} candidatos y se insertaron ${rowCount}. ABORTA.`);
  }

  const grandes = previos.filter((r) => Number(r.residuo) > 1000);
  console.log(`[A.18] ${rowCount} glosa(s) convertidas en enlace real.`);
  if (grandes.length) {
    console.log(`[A.18] ⚠️ ${grandes.length} con residuo > $1,000 — enlazados, pero hay que mirarlos:`);
    for (const g of grandes) {
      console.log(`         ${g.folio}  #${g.external_id}  residuo $${Number(g.residuo).toFixed(2)}`);
    }
  }

  // Lo que NO se pudo enlazar se DECLARA; si se omitiera, el 100% sería mentira.
  const { rows: fuera } = await knex.raw(`
    SELECT l.folio, l.monto, m.external_id, m.total, (l.monto - m.total) AS residuo
      FROM finance.cash_ledger l
      JOIN analytics.caos_cash_movements m
        ON m.tenant_id = l.tenant_id
       AND m.external_id = substring(l.glosa from 'Deposito #([0-9]+)')::bigint
     WHERE l.tenant_id = ?::uuid AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
       AND l.glosa ~ 'Deposito #[0-9]+' AND m.type_id = 0 AND l.monto < m.total
       AND NOT EXISTS (SELECT 1 FROM finance.caos_cash_links k
                        WHERE k.cash_ledger_id = l.id AND k.deleted_at IS NULL)`, [TENANT]);
  for (const f of fuera) {
    console.log(`[A.18] ⛔ NO enlazado ${f.folio}: libro $${f.monto} < CAOS #${f.external_id} $${f.total}`
      + ` (residuo $${Number(f.residuo).toFixed(2)}). Un residuo negativo es imposible: lo revisa quien capturó.`);
  }
};

/** Quita SÓLO los enlaces que puso esta migración, reconocibles por su señal. */
exports.down = async function down(knex) {
  await knex.raw(
    `DELETE FROM finance.caos_cash_links
      WHERE tenant_id = ?::uuid AND senales ->> 'origen' = 'CGA-A.18'`, [TENANT]);
};
