import type { PoolClient } from 'pg';

import type { EscrituraPagoKepler } from './kepler-pago-sink.adapter';
import { columnaAbonoKdxg, columnasKdc126 } from '../../shared/kepler-contable';

/**
 * `[PGP.71]` + `[PGP.106]` **Lo que el ensayo revisa en vez de escribir.** Corre dentro de la transacción del
 * adaptador real, en el lugar de `confirmar`: lee las temporales que el adaptador armó y las filas reales que los
 * UPDATE tocarían, y devuelve lo que no cuadra. NO escribe nada en `md`. La usan los dos ensayos —el spec
 * (`kepler-pago-sink.ensayo.spec.ts`) y el de `md` (`ops/prod/ensayo-pago-kepler/ensayo.ts`)— para no tener dos
 * criterios del «verde».
 */
export async function revisarEscrituraPago(c: PoolClient, w: EscrituraPagoKepler): Promise<{ fallas: string[]; revisado: Record<string, unknown> }> {
  const no: string[] = [];
  const n = w.documentos.length;
  const folios = w.documentos.map((d) => d.folio);

  const h = (await c.query(`SELECT c6, btrim(c10) c10, c16::text c16, c42::text c42, btrim(c45) c45, btrim(c12) c12, btrim(c67) c67 FROM _h ORDER BY c6`)).rows;
  const e = (await c.query(`SELECT c6, c11::text c11, c17::text c17, c20::text c20, btrim(c22) c22 FROM _e ORDER BY c6`)).rows;
  const f = (await c.query(`SELECT c6 FROM _f`)).rows;
  const m5 = (await c.query(`SELECT c6, c7::int c7, c12::text c12, c13::text c13, btrim(c14) c14 FROM _m5 ORDER BY c6, c7`)).rows;
  const p = (await c.query(`SELECT c1::int c1, btrim(c3) c3, btrim(c4) c4, c5::numeric c5, btrim(c19) c19, to_char(c2, 'YYYY-MM-DD') c2 FROM _p ORDER BY c1, c10`)).rows;

  // ── kdm1 / kdxe: un documento por plan, folios MAX+1… seguidos ─────────────────────────────────
  const max = Number((await c.query(`SELECT coalesce(max(c6::int), 0) m FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='D' AND btrim(c4::text)='26' AND btrim(c5::text)='1'`, [w.sucursal])).rows[0].m);
  if (h.length !== n || e.length !== n) no.push(`_h ${h.length} / _e ${e.length} filas para ${n} documentos`);
  folios.forEach((fo, i) => { if (Number(fo) !== max + 1 + i) no.push(`folio ${fo} ≠ MAX+${1 + i} (${max + 1 + i})`); });
  w.documentos.forEach((d, i) => {
    const H = h[i] ?? {}, E = e[i] ?? {};
    if (H.c6 !== d.folio || E.c6 !== d.folio) no.push(`documento ${i + 1}: kdm1.c6 ${H.c6} · kdxe.c6 ${E.c6} ≠ ${d.folio}`);
    if (Number(H.c16) !== Number(d.plan.kdm1['c16']) || Number(H.c42) !== Number(H.c16)) no.push(`${d.folio}: importe ${H.c16}/${H.c42}`);
    if (E.c22 !== H.c45) no.push(`${d.folio}: c45 ${H.c45} / kdxe.c22 ${E.c22}`);
    if (Number(E.c20) !== 0 || Number(E.c11) !== Number(H.c16) || Number(E.c17) !== Number(H.c16)) no.push(`${d.folio}: kdxe c11 ${E.c11} c17 ${E.c17} c20 ${E.c20}`);
    if (H.c67 !== 'SUITE') no.push(`${d.folio}: c67 ${H.c67}`);
  });

  // ── kdxf / kdm5: un renglón por factura, con el folio de su documento ───────────────────────────
  const facturas = w.documentos.reduce((s, d) => s + d.plan.kdxf.length, 0);
  if (f.length !== facturas || f.some((x) => !folios.includes(x.c6))) no.push(`kdxf ${f.length} filas para ${facturas} facturas`);
  if (m5.length !== facturas || m5.some((x) => !folios.includes(x.c6) || x.c12 !== x.c13)) no.push(`kdm5 ${m5.length} filas para ${facturas} facturas`);

  // ── La póliza: números MAX+1… del mes, cuadrada, cada renglón con el folio de su documento ──────
  const maxPol = Number((await c.query(`SELECT coalesce(max(c1), 0)::int m FROM md.${w.tablaPoliza} WHERE c8='E'`)).rows[0].m);
  w.documentos.forEach((d, i) => {
    const mios = p.filter((x) => x.c19 === d.folio);
    if (d.poliza !== maxPol + 1 + i || mios.some((x) => x.c1 !== d.poliza)) no.push(`${d.folio}: póliza ${d.poliza} ≠ MAX+${1 + i} (${maxPol + 1 + i})`);
    if (mios.length !== d.plan.poliza.renglones.length) no.push(`${d.folio}: la póliza trae ${mios.length} renglones, el plan ${d.plan.poliza.renglones.length}`);
    const cargo = mios.filter((x) => x.c4 === 'C').reduce((s, x) => s + Math.round(Number(x.c5) * 100), 0);
    const abono = mios.filter((x) => x.c4 === 'A').reduce((s, x) => s + Math.round(Number(x.c5) * 100), 0);
    if (cargo !== abono || abono !== Math.round(Number(d.plan.kdm1['c16']) * 100)) no.push(`${d.folio}: póliza descuadrada (cargo ${cargo / 100}, abono ${abono / 100})`);
    if (mios.some((x) => x.c2 !== d.plan.poliza.fecha)) no.push(`${d.folio}: la póliza no trae la fecha del pago`);
  });

  // ── Lo que los UPDATE tocarían: exactamente una fila cada uno, y el saldo alcanza ───────────────
  for (const d of w.documentos) for (const s of d.plan.saldos) {
    const r = await c.query(`SELECT c20::float8 c20 FROM md.kdxe WHERE btrim(c1)=$1 AND btrim(c2)=$2 AND c3='A' AND btrim(c4::text)=$3 AND btrim(c5::text)=$4 AND c6=$5`,
      [s.almacen, s.acreedor, String(s.tipo), String(s.subtipo), s.folio]);
    if (r.rowCount !== 1 || r.rows[0].c20 < s.menos - 0.005) no.push(`saldo de ${s.folio}: ${r.rows[0]?.c20}`);
  }
  const a0 = w.documentos[0].plan.acumulados;
  const colG = columnaAbonoKdxg(a0.mes);
  const g = await c.query(`SELECT ${colG}::text abono FROM md.kdxg WHERE btrim(c3)=$1 AND btrim(c1)='PESOS'`, [a0.acreedor]);
  if (g.rowCount !== 1) no.push(`kdxg del acreedor ${a0.acreedor}: ${g.rowCount} filas`);
  const k = columnasKdc126(a0.mes);
  const cuentas = [...new Set(w.documentos.flatMap((d) => d.plan.acumulados.cuentas.map((m) => m.cuenta)))];
  const acum: Record<string, unknown> = { kdxg: g.rows[0] ?? null };
  for (const cuenta of cuentas) {
    const r = await c.query(`SELECT ${k.cargo[0]}::text cargo, ${k.abono[0]}::text abono FROM md.kdc126 WHERE btrim(c1)=$1`, [cuenta]);
    if (r.rowCount !== 1) no.push(`kdc126 de la cuenta ${cuenta}: ${r.rowCount} filas`);
    acum[`kdc126_${cuenta}`] = r.rows[0] ?? null;
  }

  // ── Los permisos que la escritura de verdad pide: el ensayo no los ejerce (termina en ROLLBACK), así que se
  // preguntan a Postgres. Sólo lectura (`has_*_privilege`).
  const pide: [string, string, string | null][] = [
    ['md.kdm1', 'INSERT', null], ['md.kdm5', 'INSERT', null], ['md.kdxe', 'INSERT', null], ['md.kdxf', 'INSERT', null],
    [`md.${w.tablaPoliza}`, 'INSERT', null], ['md.kdxe', 'UPDATE', 'c20'],
    ['md.kdxg', 'UPDATE', colG], ['md.kdxg', 'UPDATE', 'c4'], ['md.kdxg', 'UPDATE', 'c7'],
    ...[...k.cargo, ...k.abono].map((col): [string, string, string] => ['md.kdc126', 'UPDATE', col]),
  ];
  const permisos: Record<string, boolean> = {};
  for (const [tabla, priv, col] of pide) {
    const ok = col
      ? (await c.query(`SELECT has_column_privilege($1, $2, $3) ok`, [tabla, col, priv])).rows[0].ok
      : (await c.query(`SELECT has_table_privilege($1, $2) ok`, [tabla, priv])).rows[0].ok;
    permisos[`${priv} ${tabla}${col ? `(${col})` : ''}`] = ok;
    if (!ok) no.push(`sin permiso: ${priv} ${tabla}${col ? `(${col})` : ''}`);
  }
  acum['permisos'] = permisos;

  return { fallas: no, revisado: { tablaPoliza: w.tablaPoliza, kdm1: h, kdxe: e, kdxf: f.length, kdm5: m5, poliza: p, acumulados_hoy: acum } };
}
