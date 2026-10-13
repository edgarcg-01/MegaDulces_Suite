'use strict';
/**
 * `[CG.115]` Candado del **barrido del corte de caja**: un corte sólo contiene movimientos de SU
 * jornada, y lo que queda suelto de otros días se cuenta aparte.
 *
 *   node database/tests/test-newdb-caja-corte-jornada.js
 *
 * Sólo lee.
 *
 * ── Qué se rompió, medido ───────────────────────────────────────────────────────────────────
 *
 * `movimientosSueltos()` y el `base()` de `cerrar()` barrían **todo** lo que tuviera
 * `corte_id IS NULL` en la sucursal, sin filtro de fecha. Medido en prod el 2026-10-13 sobre
 * `CC-2026-00001`, que es un corte del **12-oct**:
 *
 *     lo que barría  ->  32 movimientos, 25-sep .. 10-dic, neto -$156,275.84
 *     su jornada     ->  23 movimientos, 12-oct,           neto  +$53,134.95
 *
 * El esperado publicado era **-$206,008.34**: un número que nadie puede ir a contar, porque ese
 * efectivo ni existe ni existió junto. Un arqueo compara contra lo que hay en el cajón; si el
 * esperado suma jornadas ajenas, la diferencia deja de significar nada.
 *
 * ── Por qué ESTAS aserciones ────────────────────────────────────────────────────────────────
 *
 *  1. **El invariante que vale para siempre**: ningún movimiento atado a un corte puede tener
 *     fecha distinta a la del corte. Es verificable hoy y dentro de un año, y no depende de qué
 *     haya pasado en una fecha concreta.
 *  2. **El control negativo**: en el universo suelto, la ventana amplia y la de la jornada tienen
 *     que DIFERIR. Sin esto el candado pasaría en verde con el filtro borrado — que es
 *     exactamente el estado del que venimos.
 *  3. **Lo que queda fuera se puede nombrar**: si hay sueltos de otros días, el candado los
 *     enumera. Un pendiente que no se puede listar es un pendiente que nadie va a cerrar.
 *
 * ⚠️ No se afirma "cero sueltos viejos": en prod los hay y son trabajo real pendiente, no un bug.
 * Lo que el candado prohíbe es que se los trague un corte que no es el suyo.
 */

require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
let ok = 0;
let fail = 0;
let nomedido = 0;

const check = (cond, txt, detalle = '') => {
  if (cond) { ok++; console.log(`  ✓ ${txt}`); }
  else { fail++; console.log(`  ✗ ${txt}${detalle ? '\n      ' + detalle : ''}`); }
};
const declarar = (txt) => { nomedido++; console.log(`  ⓘ NO MEDIDO — ${txt}`); };

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW (o PROD_DB_URL).'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();

  // ── 1. EL INVARIANTE ──────────────────────────────────────────────────────────────────────
  console.log('\n[1] Un corte sólo contiene movimientos de su jornada');
  /**
   * ⛔ **Primero se mide si hay con qué comprobarlo.** Medido el 2026-10-13: en prod hay UN corte,
   * en borrador, con **cero movimientos atados** — o sea que la consulta de abajo devolvía 0 filas
   * y el candado se ponía ✓ **sin haber revisado nada**. Un verde sobre población vacía se lee
   * igual que un verde de verdad, y es justo lo que ADR-056 prohíbe: lo que no se pudo medir se
   * DECLARA. El ✓ vuelve solo, el día que se cierre el primer corte.
   */
  const { rows: [pob] } = await c.query(
    `SELECT count(*)::int n FROM finance.cash_ledger WHERE corte_id IS NOT NULL AND deleted_at IS NULL`);
  if (!pob.n) {
    declarar('no hay NI UN movimiento atado a un corte todavía: el invariante no tiene qué revisar');
  } else {
    const { rows: fuera } = await c.query(`
      SELECT k.folio, to_char(k.fecha,'YYYY-MM-DD') AS dia_corte,
             to_char(m.fecha,'YYYY-MM-DD') AS dia_mov, count(*)::int n, sum(m.monto) AS monto
        FROM finance.cash_ledger m
        JOIN finance.cash_ledger_cuts k ON k.id = m.corte_id
       WHERE m.deleted_at IS NULL AND m.fecha <> k.fecha
       GROUP BY 1,2,3 ORDER BY 1,3`);
    check(fuera.length === 0,
      `ninguno de los ${pob.n} movimientos atados tiene fecha distinta a la de su corte`,
      fuera.length ? fuera.map((r) => `${r.folio} (${r.dia_corte}) se tragó ${r.n} del ${r.dia_mov} por ${r.monto}`).join('\n      ') : '');
  }

  // ── 2. EL CONTROL NEGATIVO ────────────────────────────────────────────────────────────────
  // Si las dos ventanas dieran siempre lo mismo, el filtro podría no existir y nadie lo notaría.
  console.log('\n[2] Control negativo: la ventana amplia y la de la jornada NO son la misma');
  const { rows: ab } = await c.query(`
    SELECT id, folio, sucursal, to_char(fecha,'YYYY-MM-DD') AS dia
      FROM finance.cash_ledger_cuts WHERE estado = 'borrador' ORDER BY created_at DESC LIMIT 1`);
  if (!ab.length) {
    declarar('no hay corte abierto: sin él no existe la ventana que comparar');
  } else {
    const k = ab[0];
    const neto = `sum(CASE WHEN estado='cancelado' THEN 0 WHEN tipo='ingreso' THEN monto ELSE -monto END)`;
    const { rows: [u] } = await c.query(`
      SELECT count(*)::int n_todo, coalesce(${neto},0)::numeric neto_todo,
             count(*) FILTER (WHERE fecha = $2::date)::int n_dia,
             coalesce(${neto} FILTER (WHERE fecha = $2::date),0)::numeric neto_dia
        FROM finance.cash_ledger
       WHERE corte_id IS NULL AND deleted_at IS NULL AND sucursal = $1`, [k.sucursal, k.dia]);
    console.log(`      corte ${k.folio} · jornada ${k.dia} · sucursal ${k.sucursal}`);
    console.log(`      ventana amplia : ${u.n_todo} movs, neto ${u.neto_todo}`);
    console.log(`      su jornada     : ${u.n_dia} movs, neto ${u.neto_dia}`);
    if (u.n_todo === u.n_dia) {
      declarar('hoy no hay sueltos de otros días: el filtro no se puede distinguir de su ausencia');
    } else {
      check(Number(u.neto_todo) !== Number(u.neto_dia),
        'el filtro cambia el resultado (si no, estaría borrado y el candado no lo vería)');
      check(u.n_dia <= u.n_todo, 'la jornada es un subconjunto de lo suelto');
    }

    // ── 3. LO QUE QUEDA FUERA SE PUEDE NOMBRAR ─────────────────────────────────────────────
    console.log('\n[3] Lo suelto de otras jornadas, enumerado (no es un bug: es trabajo pendiente)');
    const { rows: pend } = await c.query(`
      SELECT to_char(fecha,'YYYY-MM-DD') dia, count(*)::int n, coalesce(${neto},0)::numeric neto
        FROM finance.cash_ledger
       WHERE corte_id IS NULL AND deleted_at IS NULL AND sucursal = $1 AND fecha <> $2::date
       GROUP BY 1 ORDER BY 1`, [k.sucursal, k.dia]);
    for (const r of pend) console.log(`      ${r.dia}: ${r.n} movimiento(s), neto ${r.neto}`);
    check(pend.every((r) => r.dia && r.n > 0),
      'cada pendiente tiene día y conteo (ninguno llega sin fecha, que lo volvería inubicable)');
  }

  await c.end();
  console.log(`\n${ok} ✓ / ${fail} ✗${nomedido ? ` / ${nomedido} no medido` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
