import type { PoolClient } from 'pg';

import { columnasRarasDePlantilla, type EscrituraSolicitudKepler } from './kepler-solicitud-gasto-sink.adapter';
import { COLUMNAS_QUE_VARIAN } from './solicitud-kepler.armador';

/**
 * `[PGP.122.11]` **Lo que el ensayo revisa en vez de escribir.** Corre dentro de la transacción del
 * adaptador real, en el lugar de `confirmar`: lee las temporales que el adaptador armó (`_h0` la
 * plantilla, `_h` la cabecera, `_l` los renglones) y el contador ya avanzado, y devuelve:
 *  · `fallas`  — lo que no cuadra: el verde exige cero;
 *  · `avisos`  — lo que no impide escribir pero una persona debe saber (p. ej. el contador venía atrasado).
 *    Una plantilla con algo en las 169 columnas que van vacías en las 5,224 solicitudes medidas es FALLA;
 *  · `permisos` — si `kepler_push` tiene cada permiso que pide escribir DE VERDAD (`has_*_privilege`).
 * NO escribe nada en `md`. La usan los dos ensayos (el spec y el de `md`) y la prueba de `database/tests`:
 * un solo criterio del «verde».
 */
export async function revisarEscrituraSolicitud(c: PoolClient, w: EscrituraSolicitudKepler): Promise<{ fallas: string[]; avisos: string[]; revisado: Record<string, unknown> }> {
  const no: string[] = [];
  const avisos: string[] = [];
  const cent = (v: unknown) => Math.round(Number(v) * 100);

  // ── La cabecera ──────────────────────────────────────────────────────────────────────────────
  const h = (await c.query(
    `SELECT btrim(c1) c1, c2, c3, c4::text c4, c5::text c5, btrim(c6) c6, to_char(c9, 'YYYY-MM-DD') c9, btrim(c10) c10, btrim(c11) c11,
            c14::text c14, c15::text c15, c16::text c16, btrim(c17) c17, to_char(c18, 'YYYY-MM-DD') c18, btrim(c22) c22, btrim(c24) c24,
            btrim(c25) c25, btrim(c26) c26, btrim(c30) c30, btrim(c32) c32, c42::text c42, btrim(c43) c43, btrim(c48) c48, btrim(c67) c67,
            to_char(c68, 'YYYY-MM-DD') c68, btrim(c69) c69, btrim(c90) c90 FROM _h`)).rows;
  if (h.length !== 1) no.push(`_h trae ${h.length} filas: se esperaba una`);
  const H = h[0] ?? {};
  const k = w.plan.kdm1;
  if (H.c1 !== w.sucursal || H.c6 !== w.folio) no.push(`llave ${H.c1}/${H.c6} ≠ ${w.sucursal}/${w.folio}`);
  if (H.c2 !== 'X' || H.c3 !== 'A' || H.c4 !== '15' || H.c5 !== '1') no.push(`tipo ${H.c2}-${H.c3}-${H.c4}-${H.c5} ≠ X-A-15-1`);
  for (const col of ['c9', 'c10', 'c11', 'c17', 'c18', 'c24', 'c25', 'c26', 'c30', 'c43', 'c48', 'c67', 'c68', 'c69', 'c90'] as const) {
    if (String(H[col] ?? '') !== String(k[col] ?? '')) no.push(`${col} = «${H[col]}», el plan dice «${k[col]}»`);
  }
  for (const col of ['c14', 'c15', 'c16', 'c42'] as const) if (cent(H[col]) !== cent(k[col])) no.push(`${col} = ${H[col]}, el plan dice ${k[col]}`);
  if (H.c26 !== w.marca) no.push(`marca ${H.c26} ≠ ${w.marca}`);

  // RFC y nombre: los del catálogo del servidor, recortados a su columna.
  const d = (await c.query(`SELECT left(coalesce(btrim(c10), ''), 40) rfc, left(coalesce(btrim(c3), ''), 60) nombre FROM md.kdxd WHERE btrim(c2) = $1 ORDER BY c1 LIMIT 1`, [k.c10])).rows[0];
  if (!d || H.c22 !== d.rfc || H.c32 !== d.nombre) no.push(`RFC/nombre ${H.c22}/${H.c32} ≠ catálogo ${d?.rfc}/${d?.nombre}`);

  // ── Los renglones: cuenta y texto del concepto en ESTE servidor; c16 = Σ renglones + IVA − retención ──
  const l = (await c.query(
    `SELECT btrim(l.c6) c6, l.c7::int c7, btrim(l.c8) c8, btrim(l.c9) c9, btrim(l.c12) c12, l.c11::text c11,
            (SELECT btrim(x.c3) FROM md.kdco x WHERE btrim(x.c1) = btrim(l.c12) ORDER BY x.c1 LIMIT 1) cuenta,
            (SELECT left(btrim(x.c2), 30) FROM md.kdco x WHERE btrim(x.c1) = btrim(l.c12) ORDER BY x.c1 LIMIT 1) nombre
       FROM _l l ORDER BY l.c7`)).rows;
  if (l.length !== w.plan.kdm6.length) no.push(`_l trae ${l.length} renglones, el plan ${w.plan.kdm6.length}`);
  l.forEach((r, i) => {
    if (r.c6 !== w.folio) no.push(`renglón ${i + 1}: folio ${r.c6}`);
    if (r.c7 !== i + 1) no.push(`renglón ${i + 1}: c7 = ${r.c7}`);
    if (!r.c8 || r.c8 !== r.cuenta) no.push(`renglón ${i + 1}: cuenta ${r.c8} ≠ la del concepto ${r.c12} (${r.cuenta})`);
    if (r.c9 !== r.nombre) no.push(`renglón ${i + 1}: texto ${r.c9} ≠ el del concepto (${r.nombre})`);
  });
  const suma = l.reduce((s, r) => s + cent(r.c11), 0);
  if (suma + cent(H.c14) - cent(H.c15) !== cent(H.c16)) no.push(`c16 ${H.c16} ≠ Σ renglones ${suma / 100} + IVA ${H.c14} − retención ${H.c15}`);

  // ── La copia: todo lo que NO se pisa es idéntico a la plantilla ──────────────────────────────
  const cols = (await c.query(
    `SELECT a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
      WHERE a.attrelid = '_h0'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows as { n: string; t: string }[];
  const varian = new Set<string>(COLUMNAS_QUE_VARIAN);
  const fijas = cols.filter((x) => !varian.has(x.n));
  if (fijas.length) {
    const igual = (await c.query(`SELECT ${fijas.map((x) => `(h.${x.n} IS NOT DISTINCT FROM p.${x.n}) AS ${x.n}`).join(', ')} FROM _h h, _h0 p`)).rows[0] as Record<string, boolean>;
    const distintas = fijas.filter((x) => igual[x.n] !== true).map((x) => x.n);
    if (distintas.length) no.push(`columnas que debían copiarse de la plantilla y cambiaron: ${distintas.join(', ')}`);
    // Lo que se copia y en las 5,224 solicitudes medidas va vacío: si la plantilla trae algo, es FALLA (el
    // escritor ya no escribe con ella: el mismo predicado, `columnasRarasDePlantilla`).
    for (const x of await columnasRarasDePlantilla(c, '_h0')) no.push(`plantilla ${x} (en las solicitudes medidas va vacía o en cero)`);
  }

  // ── El folio y el contador ───────────────────────────────────────────────────────────────────
  const ct = w.contador;
  const ahora = (await c.query(`SELECT btrim(c4) c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [ct.llave])).rows[0]?.c4;
  if (ahora !== ct.contadorNuevo) no.push(`el contador ${ct.llave} quedó en ${ahora}, se esperaba ${ct.contadorNuevo}`);
  if (Number(w.folio) !== Math.max(Number(ct.contadorAntes), ct.maximo + 1)) no.push(`folio ${w.folio} ≠ greatest(${ct.contadorAntes}, ${ct.maximo}+1)`);
  const ocupado = (await c.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND c6 = $2`, [w.sucursal, w.folio])).rows[0].n;
  if (ocupado) no.push(`el folio ${w.folio} ya existe en Kepler`);
  if (ct.contadorAtrasado) avisos.push(`el contador ${ct.llave} venía ATRASADO (${ct.contadorAntes} con el último folio en ${ct.maximo}): esta escritura lo repara`);

  // ── Los permisos que pide escribir de verdad (sin usarlos) ───────────────────────────────────
  const permisos: Record<string, boolean> = {};
  for (const [expr, que] of [
    [`has_table_privilege(current_user, 'md.kdm1', 'INSERT')`, 'INSERT md.kdm1'],
    [`has_table_privilege(current_user, 'md.kdm6', 'INSERT')`, 'INSERT md.kdm6'],
    [`has_table_privilege(current_user, 'md.kdm6', 'SELECT')`, 'SELECT md.kdm6'],
    [`has_column_privilege(current_user, 'md.sqliov', 'c4', 'UPDATE')`, 'UPDATE (c4) md.sqliov'],
    [`has_table_privilege(current_user, 'md.sqliov', 'SELECT')`, 'SELECT md.sqliov'],
    [`has_table_privilege(current_user, 'md.kdco', 'SELECT')`, 'SELECT md.kdco'],
    [`has_table_privilege(current_user, 'md.kdcp', 'SELECT')`, 'SELECT md.kdcp'],
    [`has_table_privilege(current_user, 'md.kdc3', 'SELECT')`, 'SELECT md.kdc3'],
    [`has_table_privilege(current_user, 'md.kdxd', 'SELECT')`, 'SELECT md.kdxd'],
  ] as const) {
    permisos[que] = (await c.query(`SELECT (${expr}) AS ok`)).rows[0].ok === true;
    if (!permisos[que]) no.push(`falta permiso: ${que}`);
  }

  return { fallas: no, avisos, revisado: { cabecera: H, renglones: l, contador: { ...ct, ahora }, permisos } };
}
