import type { PoolClient } from 'pg';

import { COLUMNAS_DEL_GASTO, polizaCuadra } from '../../shared/gasto-kepler.armador';
import type { EscrituraGastoKepler } from './kepler-gasto-sink.adapter';

/**
 * `[PGP.123]` G.7 — **Lo que el ensayo revisa en vez de escribir el gasto.** Corre dentro de la transacción del
 * escritor real, en el lugar de `confirmar`: lee las temporales que armó (`_s0` la solicitud, `_r0` sus renglones,
 * `_h` el gasto, `_l` sus renglones, `_e` la cuenta por pagar, `_p` la póliza), el contador ya avanzado y lo que
 * los acumulados van a tocar, y devuelve:
 *  · `fallas`   — lo que no cuadra: el verde exige cero;
 *  · `avisos`   — lo que no impide escribir pero una persona debe saber (el contador venía atrasado, celdas nuevas);
 *  · `revisado` — lo que vio, con los permisos que pide escribir DE VERDAD (`has_*_privilege`).
 * NO escribe nada en `md`. La usan el ensayo contra el Kepler vivo y la prueba contra Postgres real.
 */
export async function revisarEscrituraGasto(c: PoolClient, w: EscrituraGastoKepler): Promise<{ fallas: string[]; avisos: string[]; revisado: Record<string, unknown> }> {
  const no: string[] = [];
  const avisos: string[] = [];
  const cent = (v: unknown) => Math.round(Number(v) * 100);
  const plan = w.plan;

  // ── El gasto: la solicitud clonada; sólo cambia lo que el armador decide ─────────────────────────────────────────
  const h = (await c.query(
    `SELECT btrim(c1) c1, c2, c3, c4::text c4, c5::text c5, btrim(c6) c6, to_char(c9, 'YYYY-MM-DD') c9, btrim(c31) c31, btrim(c36) c36,
            c37::text c37, c38::text c38, btrim(c39) c39, to_char(c41, 'YYYY-MM-DD') c41, c42::text c42, btrim(c43) c43, btrim(c63) c63,
            btrim(c67) c67, to_char(c68, 'YYYY-MM-DD') c68, btrim(c69) c69, btrim(c90) c90, c16::text c16, c14::text c14 FROM _h`)).rows;
  if (h.length !== 1) no.push(`_h trae ${h.length} filas: se esperaba una`);
  const H = h[0] ?? {};
  if (H.c1 !== w.sucursal || H.c6 !== w.folio) no.push(`llave ${H.c1}/${H.c6} ≠ ${w.sucursal}/${w.folio}`);
  if (H.c2 !== 'X' || H.c3 !== 'A' || H.c4 !== '10' || H.c5 !== '1') no.push(`tipo ${H.c2}-${H.c3}-${H.c4}-${H.c5} ≠ X-A-10-1`);
  for (const col of ['c9', 'c31', 'c36', 'c37', 'c38', 'c39', 'c41', 'c43', 'c63', 'c67', 'c68', 'c69', 'c90'] as const) {
    if (String(H[col] ?? '') !== String(plan.kdm1[col] ?? '')) no.push(`gasto ${col} = «${H[col]}», el plan dice «${plan.kdm1[col]}»`);
  }
  if (H.c39 !== w.solicitud) no.push(`el gasto apunta a la solicitud ${H.c39}, no a ${w.solicitud}`);
  if (cent(H.c42) !== cent(plan.total) || cent(H.c16) !== cent(plan.total)) no.push(`gasto c42 ${H.c42} / c16 ${H.c16} ≠ total ${plan.total}`);
  const cols = async (t: string) => (await c.query(
    `SELECT a.attname AS n FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [t])).rows.map((x) => x.n as string);
  const propias = new Set<string>([...COLUMNAS_DEL_GASTO, 'c6']);
  const copiadas = (await cols('_h')).filter((x) => !propias.has(x));
  const igual = (await c.query(`SELECT ${copiadas.map((x) => `(h.${x} IS NOT DISTINCT FROM s.${x}) AS ${x}`).join(', ')} FROM _h h, _s0 s`)).rows[0] as Record<string, boolean> | undefined;
  const distintas = copiadas.filter((x) => igual?.[x] !== true);
  if (distintas.length) no.push(`columnas del gasto que debían copiarse de la solicitud y cambiaron: ${distintas.join(', ')}`);

  // ── Los renglones: los de la solicitud, con el tipo y el folio del gasto ─────────────────────────────────────────
  const l = (await c.query(`SELECT c4::text c4, btrim(c6) c6, c7::int c7 FROM _l ORDER BY c7`)).rows;
  const r0 = Number((await c.query('SELECT count(*)::int n FROM _r0')).rows[0].n);
  if (l.length !== r0 || l.length !== plan.kdm6.length) no.push(`_l trae ${l.length} renglones; la solicitud ${r0}; el plan ${plan.kdm6.length}`);
  l.forEach((r) => { if (r.c4 !== '10' || r.c6 !== w.folio) no.push(`renglón ${r.c7}: tipo ${r.c4}, folio ${r.c6}`); });
  const cols6 = (await cols('_l')).filter((x) => !['c4', 'c6'].includes(x));
  const dif6 = Number((await c.query(
    `SELECT count(*)::int n FROM _l l LEFT JOIN _r0 r ON r.c7 = l.c7 WHERE r.c7 IS NULL OR NOT (${cols6.map((x) => `l.${x} IS NOT DISTINCT FROM r.${x}`).join(' AND ')})`)).rows[0].n);
  if (dif6) no.push(`${dif6} renglones del gasto no son copia de los de la solicitud`);

  // ── La cuenta por pagar: completa, con lo vacío en lo que el armador no pone ─────────────────────────────────────
  const e = (await c.query(
    `SELECT btrim(c1) c1, btrim(c2) c2, c3, c4::text c4, c5::text c5, btrim(c6) c6, c11::text c11, c13::text c13, c17::text c17, c20::text c20,
            c12::text c12, c15::text c15, c19::text c19, c21::text c21, c25::text c25, btrim(c18) c18, btrim(c22) c22, btrim(c23) c23 FROM _e`)).rows;
  if (e.length !== 1) no.push(`_e trae ${e.length} filas: se esperaba una`);
  const E = e[0] ?? {};
  if (E.c1 !== w.sucursal || E.c3 !== 'A' || E.c4 !== '10' || E.c5 !== '1' || E.c6 !== w.folio) no.push(`kdxe llave ${E.c1}/${E.c3}/${E.c4}/${E.c5}/${E.c6}`);
  for (const col of ['c11', 'c17', 'c20'] as const) if (cent(E[col]) !== cent(plan.total)) no.push(`kdxe ${col} = ${E[col]} ≠ total ${plan.total}`);
  if (cent(E.c13) !== cent(plan.iva)) no.push(`kdxe c13 = ${E.c13} ≠ IVA ${plan.iva}`);
  for (const col of ['c12', 'c15', 'c19', 'c21', 'c25'] as const) if (cent(E[col]) !== 0) no.push(`kdxe ${col} = ${E[col]} (en los 1,922 medidos va en cero)`);
  for (const col of ['c18', 'c22', 'c23'] as const) if (E[col]) no.push(`kdxe ${col} = «${E[col]}» (en los 1,922 medidos va vacía)`);

  // ── La póliza: su número, su documento y que cuadre ──────────────────────────────────────────────────────────────
  const p = (await c.query(
    `SELECT c1::int c1, to_char(c2, 'YYYY-MM-DD') c2, btrim(c3) c3, c4, c5::text c5, c9::text c9, c8, btrim(c15) c15, btrim(c16) c16, c17::text c17,
            c18::text c18, btrim(c19) c19, btrim(c14) c14, c10::int c10 FROM _p ORDER BY c10`)).rows;
  if (p.length !== plan.poliza.renglones.length) no.push(`_p trae ${p.length} renglones; el plan ${plan.poliza.renglones.length}`);
  for (const r of p) {
    if (r.c1 !== w.poliza || r.c8 !== 'D' || r.c2 !== plan.poliza.fecha || r.c15 !== 'X' || r.c16 !== 'A' || r.c17 !== '10' || r.c18 !== '1' || r.c19 !== w.folio || r.c14 !== w.sucursal) {
      no.push(`renglón ${r.c10} de la póliza: ${r.c1}/${r.c8}/${r.c2}/${r.c15}-${r.c16}-${r.c17}-${r.c18}/${r.c19}/${r.c14}`);
    }
    if (cent(r.c5) !== cent(r.c9)) no.push(`renglón ${r.c10} de la póliza: c5 ${r.c5} ≠ c9 ${r.c9}`);
  }
  if (!polizaCuadra({ tipo: 'D', fecha: plan.poliza.fecha, renglones: p.map((r) => ({ c4: r.c4, c5: r.c5 })) }, plan.total)) no.push('la póliza no cuadra o su abono no es el total');
  const max = Number((await c.query(`SELECT coalesce(max(c1), 0)::int m FROM md.${w.tablaPoliza} WHERE c8 = 'D'`)).rows[0].m);
  if (w.poliza !== max + 1) no.push(`número de póliza ${w.poliza} ≠ MAX+1 (${max + 1})`);

  // ── La solicitud que se va a aplicar, y los acumulados que se van a tocar ────────────────────────────────────────
  const s = Number((await c.query(
    `SELECT count(*)::int n FROM md.kdm1 WHERE c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND c6 = $2 AND btrim(c43) = 'A' AND c42 = $3`,
    [w.sucursal, w.solicitud, plan.total])).rows[0].n);
  if (s !== 1) no.push(`la solicitud ${w.solicitud} ya no está en A con todo su saldo (${s} filas)`);
  for (const m of plan.acumulados.kdc126) {
    const n = Number((await c.query(`SELECT count(*)::int n FROM md.kdc126 WHERE btrim(c1) = $1`, [m.cuenta])).rows[0].n);
    if (n !== 1) no.push(`kdc126: la cuenta ${m.cuenta} trae ${n} filas`);
  }
  const nuevas: string[] = [];
  for (const m of plan.acumulados.kdcn26) {
    const n = Number((await c.query(`SELECT count(*)::int n FROM md.kdcn26 WHERE btrim(c1) = $1 AND btrim(c2) = $2 AND btrim(c3) = $3 AND btrim(c4) = $4`,
      [m.concepto, m.departamento, m.proyecto, m.periodo])).rows[0].n);
    if (n > 1) no.push(`kdcn26: la celda ${m.concepto}/${m.departamento}/${m.proyecto}/${m.periodo} trae ${n} filas`);
    if (n === 0) nuevas.push(`${m.concepto}/${m.departamento}/${m.proyecto}`);
  }
  if (nuevas.length) avisos.push(`kdcn26: ${nuevas.length} celdas nuevas en ${plan.acumulados.periodo} (${nuevas.slice(0, 4).join(', ')}${nuevas.length > 4 ? '…' : ''})`);
  // `[PGP.172]` Mismo trato que `kdcn26`, doce líneas más arriba: SOBRAR filas bloquea (no se adivina cuál),
  // pero que FALTE la fila no es un problema — el acumulado del acreedor nace con el movimiento, igual que lo
  // crearía Kepler. Antes esto bloqueaba el 80.7 % de los pares (sucursal, acreedor) del catálogo.
  const xg = Number((await c.query(`SELECT count(*)::int n FROM md.kdxg WHERE btrim(c1) = 'PESOS' AND btrim(c2) = $1 AND btrim(c3) = $2`,
    [w.sucursal, plan.acumulados.kdxg.acreedor])).rows[0].n);
  if (xg > 1) no.push(`kdxg: el acreedor ${plan.acumulados.kdxg.acreedor} trae ${xg} filas propias en ${w.sucursal}`);
  if (xg === 0) avisos.push(`kdxg: el acreedor ${plan.acumulados.kdxg.acreedor} no tenía movimientos en ${w.sucursal}; su acumulado NACE con este gasto`);

  // ── El folio y el contador ───────────────────────────────────────────────────────────────────────────────────────
  const ct = w.contador;
  const ahora = (await c.query(`SELECT btrim(c4) c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [ct.llave])).rows[0]?.c4;
  if (ahora !== ct.contadorNuevo) no.push(`el contador ${ct.llave} quedó en ${ahora}, se esperaba ${ct.contadorNuevo}`);
  if (Number(w.folio) !== Math.max(Number(ct.contadorAntes), ct.maximo + 1)) no.push(`folio ${w.folio} ≠ greatest(${ct.contadorAntes}, ${ct.maximo}+1)`);
  const ocupado = Number((await c.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 10 AND c5 = 1 AND c6 = $2`, [w.sucursal, w.folio])).rows[0].n);
  if (ocupado) no.push(`el folio ${w.folio} ya existe en Kepler`);
  if (ct.contadorAtrasado) avisos.push(`el contador ${ct.llave} venía ATRASADO (${ct.contadorAntes} con el último folio en ${ct.maximo}): esta escritura lo repara`);

  // ── Los permisos que pide escribir de verdad (sin usarlos) ───────────────────────────────────────────────────────
  const permisos: Record<string, boolean> = {};
  const t = `md.${w.tablaPoliza}`;
  for (const [expr, que] of [
    [`has_table_privilege(current_user, 'md.kdm1', 'INSERT')`, 'INSERT md.kdm1'],
    [`has_column_privilege(current_user, 'md.kdm1', 'c42', 'UPDATE') AND has_column_privilege(current_user, 'md.kdm1', 'c43', 'UPDATE')`, 'UPDATE (c42, c43) md.kdm1'],
    [`has_table_privilege(current_user, 'md.kdm6', 'INSERT') AND has_table_privilege(current_user, 'md.kdm6', 'SELECT')`, 'SELECT, INSERT md.kdm6'],
    [`has_table_privilege(current_user, 'md.kdxe', 'INSERT')`, 'INSERT md.kdxe'],
    [`has_table_privilege(current_user, '${t}', 'INSERT') AND has_table_privilege(current_user, '${t}', 'SELECT')`, `SELECT, INSERT ${t}`],
    [`has_table_privilege(current_user, 'md.kdc126', 'UPDATE') AND has_table_privilege(current_user, 'md.kdc126', 'SELECT')`, 'SELECT, UPDATE md.kdc126'],
    [`has_table_privilege(current_user, 'md.kdcn26', 'UPDATE') AND has_table_privilege(current_user, 'md.kdcn26', 'INSERT') AND has_table_privilege(current_user, 'md.kdcn26', 'SELECT')`, 'SELECT, INSERT, UPDATE md.kdcn26'],
    // `[PGP.172]` INSERT además de UPDATE: la fila del acreedor nace aquí cuando es su primer movimiento.
    [`has_table_privilege(current_user, 'md.kdxg', 'UPDATE') AND has_table_privilege(current_user, 'md.kdxg', 'INSERT') AND has_table_privilege(current_user, 'md.kdxg', 'SELECT')`, 'SELECT, INSERT, UPDATE md.kdxg'],
    [`has_column_privilege(current_user, 'md.sqliov', 'c4', 'UPDATE')`, 'UPDATE (c4) md.sqliov'],
    [`has_table_privilege(current_user, 'md.kdmm', 'SELECT') AND has_table_privilege(current_user, 'md.kdc3', 'SELECT')`, 'SELECT md.kdmm, md.kdc3'],
  ] as const) {
    permisos[que] = (await c.query(`SELECT (${expr}) AS ok`)).rows[0].ok === true;
    if (!permisos[que]) no.push(`falta permiso: ${que}`);
  }

  return { fallas: no, avisos, revisado: { gasto: H, renglones: l.length, cuentaPorPagar: E, poliza: { tabla: w.tablaPoliza, numero: w.poliza, renglones: p.length }, contador: { ...ct, ahora }, permisos } };
}
