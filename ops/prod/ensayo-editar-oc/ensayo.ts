/* eslint-disable no-console */
/**
 * `[PQ.160]` **Ensayo de «editar cantidades de una OC» contra el Kepler vivo, desde `md`, sin escribir nada.**
 *
 * Corre el `KeplerOcCancelAdapter` REAL —lecturas con `FOR UPDATE NOWAIT`, la regla, el plan— y cambia el único
 * paso que escribe (`confirmarEdicion`) por esto:
 *  1. copia a tablas TEMPORALES el encabezado y los renglones de la OC, con los tipos reales de `md.kdm1`/`md.kdm2`;
 *  2. PRUEBA NEGATIVA del candado de concurrencia: dentro de un savepoint cambia `c9` de un renglón de la copia y
 *     corre su sentencia: tiene que afectar 0 filas;
 *  3. corre sobre las copias las MISMAS sentencias (`sentenciasEdicion`) y revisa el resultado contra la fórmula de
 *     Kepler (renglón: `c9`, `c13`, `c24`, `c56`; encabezado: impuestos, total y saldo recalculados de las copias);
 *  4. pregunta a Kepler si `kepler_push` tiene cada permiso (`permisosEdicion`), sin usarlo;
 *  5. `ROLLBACK`.
 * Ninguna fila real cambia. Lo único que toca el Kepler real es el candado de lectura, milisegundos.
 *
 * Entrada por stdin (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { "sucursal": "00", "casos": [{ "folio": "0007492", "renglones": [{ "renglon": 1, "cantidad": 140 }] }] }
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { KeplerOcCancelAdapter } from '../../../libs/commercial/src/lib/commercial-replenishment/kepler-oc-cancel.adapter';
import {
  permisosEdicion, sentenciasEdicion, totalesKepler, type PlanEdicion,
} from '../../../libs/commercial/src/lib/commercial-replenishment/kepler-oc-edicion';

type Env = Readonly<Record<string, string | undefined>>;
const llave = `btrim(c1) = $1 AND c2 = 'X' AND c3 = 'A' AND btrim(c4::text) = '35' AND btrim(c5::text) = $2 AND btrim(c6) = $3`;
const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;

class AdaptadorEnsayo extends KeplerOcCancelAdapter {
  public revisado: Record<string, unknown> | null = null;
  public fallas: string[] = [];
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }

  protected override async confirmarEdicion(c: PoolClient, plan: PlanEdicion): Promise<string | null> {
    const no: string[] = [];
    const k = [plan.sucursal, plan.serie, plan.folio];
    await c.query('CREATE TEMP TABLE _k1 ON COMMIT DROP AS SELECT * FROM md.kdm1 WITH NO DATA');
    await c.query('CREATE TEMP TABLE _k2 ON COMMIT DROP AS SELECT * FROM md.kdm2 WITH NO DATA');
    await c.query(`INSERT INTO _k1 SELECT * FROM md.kdm1 WHERE ${llave}`, k);
    await c.query(`INSERT INTO _k2 SELECT * FROM md.kdm2 WHERE ${llave}`, k);
    const sentencias = sentenciasEdicion(plan, { kdm1: '_k1', kdm2: '_k2' });

    // 2. Negativa: si alguien cambió el renglón entretanto, su UPDATE afecta 0 filas.
    await c.query('SAVEPOINT negativa');
    await c.query(`UPDATE _k2 SET c9 = c9 + 1 WHERE ${llave} AND c7::int = $4`, [...k, plan.renglones[0].renglon]);
    const neg = await c.query(sentencias[0].sql, sentencias[0].params);
    await c.query('ROLLBACK TO SAVEPOINT negativa');
    const candado = neg.rowCount === 0 ? 'renglón cambiado entretanto: 0 filas (bien)' : `renglón cambiado entretanto: afectó ${neg.rowCount}`;
    if (neg.rowCount !== 0) no.push(candado);

    // 3. Las sentencias de verdad, sobre las copias.
    const afectadas: Record<string, number> = {};
    for (const s of sentencias) {
      const r = await c.query(s.sql, s.params);
      afectadas[s.que] = r.rowCount ?? 0;
      if (r.rowCount !== s.esperadas) no.push(`${s.que}: ${r.rowCount} filas, se esperaban ${s.esperadas}`);
    }
    const ren = (await c.query(
      `SELECT c7::int renglon, c9::float8 c9, c12::float8 c12, c13::float8 c13, c24::float8 c24, c31::float8 c31,
              btrim(c56::text) c56, btrim(coalesce(c51::text, '')) c51, coalesce(nullif(btrim(c58::text), ''), '1')::float8 factor,
              coalesce(nullif(btrim(c17::text), ''), '0')::float8 iva, coalesce(c18, 0)::float8 ieps
         FROM _k2 WHERE ${llave} ORDER BY c7`, k)).rows;
    for (const e of plan.renglones) {
      const r = ren.find((x) => x.renglon === e.renglon);
      if (!r) { no.push(`renglón ${e.renglon} no está en la copia`); continue; }
      if (r.c9 !== e.base_despues) no.push(`renglón ${e.renglon}: c9 = ${r.c9}, se esperaba ${e.base_despues}`);
      if (r2(r.c9 * r.c12) !== r2(r.c13)) no.push(`renglón ${e.renglon}: c13 ${r.c13} ≠ c9 × c12`);
      if (r.c24 !== r.c9) no.push(`renglón ${e.renglon}: c24 ${r.c24} ≠ c9`);
      if (Number(r.c56) * r.factor !== r.c9) no.push(`renglón ${e.renglon}: c56 ${r.c56} × c58 ≠ c9`);
      if (e.con_c31 && r.c31 !== r.c9) no.push(`renglón ${e.renglon}: c31 ${r.c31} ≠ c9`);
      if (e.con_c51 && r.c51 !== r.c56) no.push(`renglón ${e.renglon}: c51 ${r.c51} ≠ c56`);
    }
    const hdr = (await c.query(`SELECT btrim(c43) c43, c14::float8 c14, c15::float8 c15, c16::float8 c16, c42::float8 c42 FROM _k1 WHERE ${llave}`, k)).rows[0] ?? {};
    const t = totalesKepler(ren.map((r) => ({ importe: r.c13, iva: r.iva, ieps: r.ieps })));
    if (hdr.c43 !== 'N') no.push(`encabezado c43 = ${hdr.c43}`);
    if (r2(hdr.c16) !== t.total) no.push(`encabezado c16 ${hdr.c16} ≠ Σ renglones con impuestos ${t.total}`);
    if (r2(hdr.c14) !== t.iva || r2(hdr.c15) !== t.ieps) no.push(`encabezado IVA/IEPS ${hdr.c14}/${hdr.c15} ≠ ${t.iva}/${t.ieps}`);
    if (r2(hdr.c42) !== r2(hdr.c16)) no.push(`encabezado c42 ${hdr.c42} ≠ c16 ${hdr.c16}`);

    // 4. Permisos, preguntados uno por uno.
    const permisos: Record<string, boolean> = {};
    for (const expr of permisosEdicion(plan)) {
      const ok = (await c.query(`SELECT (${expr}) ok`)).rows[0].ok === true;
      permisos[expr.replace(/^has_\w+\(current_user, /, '').replace(/\)$/, '')] = ok;
      if (!ok) no.push(`falta permiso: ${expr}`);
    }
    this.fallas = no;
    this.revisado = { plan, candado, afectadas, encabezado_despues: hdr, renglones_despues: ren, permisos };
    await c.query('ROLLBACK');
    return null;
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const p = JSON.parse(json) as { sucursal: string; casos: Array<{ folio: string; renglones: Array<{ renglon: number; cantidad: number }> }> };
  const env: Env = { [`KEPLER_PUSH_URL_${p.sucursal}`]: url };

  const { Client } = await import('pg');
  const k = new Client({ connectionString: url });
  await k.connect();
  // El control: la OC real (encabezado y renglones) queda exactamente como estaba.
  const foto = async (f: string) => ({
    h: (await k.query(`SELECT btrim(c43) e, c14::text, c15::text, c16::text, c42::text FROM md.kdm1 WHERE btrim(c1)=$1 AND c2='X' AND c3='A' AND btrim(c4::text)='35' AND btrim(c6)=$2`, [p.sucursal, f])).rows,
    r: (await k.query(`SELECT c7::text, c9::text, c13::text, c24::text, c31::text, c56::text, c51::text FROM md.kdm2 WHERE btrim(c1)=$1 AND c2='X' AND c3='A' AND btrim(c4::text)='35' AND btrim(c6)=$2 ORDER BY c7`, [p.sucursal, f])).rows,
  });

  let malo = false;
  for (const caso of p.casos) {
    const antes = await foto(caso.folio);
    const ad = new AdaptadorEnsayo(env);
    const r = await ad.editar({ sucursal: p.sucursal, folio: caso.folio, cambios: caso.renglones });
    await ad.onModuleDestroy();
    const despues = await foto(caso.folio);
    const intacta = JSON.stringify(antes) === JSON.stringify(despues);
    if (!intacta || ad.fallas.length) malo = true;
    console.log(JSON.stringify({ folio: caso.folio, resultado: { estado: r.estado, motivo: r.motivo }, revisado: ad.revisado, fallas: ad.fallas, control: { intacta } }, null, 1));
  }
  await k.end();
  if (malo) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR', (e as Error).message); process.exit(1); });
