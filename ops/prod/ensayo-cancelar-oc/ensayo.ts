/* eslint-disable no-console */
/**
 * `[PQ.110]` **Ensayo de «cancelar OC» contra el Kepler vivo, desde `md`, sin escribir nada.**
 *
 * Corre el `KeplerOcCancelAdapter` REAL —lecturas con `FOR UPDATE NOWAIT`, la regla, el plan— y
 * cambia el único paso que escribe (`confirmar`) por esto:
 *  1. copia a tablas TEMPORALES las filas que la cancelación tocaría (cabecera y renglones de la OC
 *     y, si aplica, de su requisición), con los tipos reales de `md.kdm1` / `md.kdm2`;
 *  2. corre sobre ellas las MISMAS sentencias (`sentenciasCancelacion`) y revisa el resultado contra
 *     lo que Kepler escribe al cancelar (anexo PQ §3c);
 *  3. pregunta a Kepler si `kepler_push` tiene cada permiso (`permisosNecesarios`), sin usarlo;
 *  4. `ROLLBACK`.
 * Ninguna fila real cambia. Lo único que toca el Kepler real es el candado de lectura, milisegundos.
 *
 * Entrada por stdin (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { "sucursal": "08", "folios": ["0000393", "0000236", "0000338"] }
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { KeplerOcCancelAdapter } from '../../../libs/commercial/src/lib/commercial-replenishment/kepler-oc-cancel.adapter';
import {
  permisosNecesarios, sentenciasCancelacion, type PlanCancelacion,
} from '../../../libs/commercial/src/lib/commercial-replenishment/kepler-oc-cancelacion';

type Env = Readonly<Record<string, string | undefined>>;

const llave = (tipo: string) =>
  `btrim(c1) = $1 AND c2 = 'X' AND c3 = 'A' AND btrim(c4::text) = '${tipo}' AND btrim(c5::text) = $2 AND btrim(c6) = $3`;

class AdaptadorEnsayo extends KeplerOcCancelAdapter {
  public revisado: Record<string, unknown> | null = null;
  public fallas: string[] = [];
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }

  protected override async confirmar(c: PoolClient, plan: PlanCancelacion): Promise<string | null> {
    const no: string[] = [];
    const docs: Array<[string, { serie: string; folio: string }]> = [['35', plan.oc]];
    if (plan.requisicion) docs.push(['30', plan.requisicion]);
    await c.query('CREATE TEMP TABLE _k1 ON COMMIT DROP AS SELECT * FROM md.kdm1 WITH NO DATA');
    await c.query('CREATE TEMP TABLE _k2 ON COMMIT DROP AS SELECT * FROM md.kdm2 WITH NO DATA');
    for (const [t, d] of docs) {
      const p = [plan.sucursal, d.serie, d.folio];
      await c.query(`INSERT INTO _k1 SELECT * FROM md.kdm1 WHERE ${llave(t)}`, p);
      await c.query(`INSERT INTO _k2 SELECT * FROM md.kdm2 WHERE ${llave(t)}`, p);
    }
    const afectadas: Record<string, number> = {};
    for (const s of sentenciasCancelacion(plan, { kdm1: '_k1', kdm2: '_k2' })) {
      const r = await c.query(s.sql, s.params);
      afectadas[s.que] = r.rowCount ?? 0;
      if (r.rowCount !== s.esperadas) no.push(`${s.que}: ${r.rowCount} filas, se esperaban ${s.esperadas}`);
    }
    const p = (t: string, d: { serie: string; folio: string }) => [plan.sucursal, d.serie, d.folio];
    const oc = (await c.query(`SELECT btrim(c43) c43, c13::text c13, c14::text c14, c15::text c15, c16::text c16, c42::text c42, btrim(c67) c67, c68::text c68, btrim(c69) c69 FROM _k1 WHERE ${llave('35')}`, p('35', plan.oc))).rows[0] ?? {};
    const ocRen = (await c.query(`SELECT count(*)::int n FROM _k2 WHERE ${llave('35')}`, p('35', plan.oc))).rows[0].n;
    if (oc.c43 !== 'C') no.push(`OC c43 = ${oc.c43}`);
    for (const k of ['c13', 'c14', 'c15', 'c16', 'c42']) if (Number(oc[k]) !== 0) no.push(`OC ${k} = ${oc[k]}`);
    if (oc.c67 !== plan.capturista) no.push(`OC c67 = ${oc.c67}`);
    if (!String(oc.c68).startsWith(plan.fecha)) no.push(`OC c68 = ${oc.c68}`);
    if (oc.c69 !== plan.hora) no.push(`OC c69 = ${oc.c69}`);
    if (ocRen !== 0) no.push(`OC con ${ocRen} renglones`);
    let req: Record<string, unknown> | null = null;
    if (plan.requisicion) {
      req = (await c.query(`SELECT btrim(c43) c43, c16::text c16, c42::text c42, btrim(c67) c67, c68::text c68 FROM _k1 WHERE ${llave('30')}`, p('30', plan.requisicion))).rows[0] ?? {};
      const rr = (await c.query(`SELECT count(*)::int n, count(*) FILTER (WHERE c24 <> c9)::int distintos FROM _k2 WHERE ${llave('30')}`, p('30', plan.requisicion))).rows[0];
      if (req.c43 !== 'A') no.push(`requisición c43 = ${req.c43}`);
      if (Number(req.c42) !== Number(req.c16)) no.push(`requisición c42 ${req.c42} ≠ c16 ${req.c16}`);
      if (rr.distintos !== 0) no.push(`requisición: ${rr.distintos} de ${rr.n} renglones con c24 ≠ c9`);
      req = { ...req, renglones: rr.n };
    }
    // Los permisos, preguntados uno por uno: el ensayo no escribe en las tablas reales.
    const permisos: Record<string, boolean> = {};
    for (const expr of permisosNecesarios(!!plan.requisicion)) {
      const ok = (await c.query(`SELECT (${expr}) ok`)).rows[0].ok === true;
      permisos[expr.replace(/^has_\w+\(current_user, /, '').replace(/\)$/, '')] = ok;
      if (!ok) no.push(`falta permiso: ${expr}`);
    }
    this.fallas = no;
    this.revisado = { plan, afectadas, oc_despues: oc, requisicion_despues: req, permisos };
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
  const p = JSON.parse(json) as { sucursal: string; folios: string[] };
  const env: Env = { [`KEPLER_PUSH_URL_${p.sucursal}`]: url };

  const { Client } = await import('pg');
  const k = new Client({ connectionString: url });
  await k.connect();
  const estado = async (f: string) => (await k.query(
    `SELECT btrim(c43) e, c16::text c16 FROM md.kdm1 WHERE btrim(c1)=$1 AND c2='X' AND c3='A' AND btrim(c4::text)='35' AND btrim(c6)=$2`,
    [p.sucursal, f])).rows[0] ?? null;

  let malo = false;
  for (const folio of p.folios) {
    const antes = await estado(folio);
    const ad = new AdaptadorEnsayo(env);
    const r = await ad.cancelar({ sucursal: p.sucursal, folio, capturista: 'SUITE', fecha: '2026-11-13', hora: '00:00' });
    await ad.onModuleDestroy();
    const despues = await estado(folio);
    // El control: la OC real quedó exactamente como estaba.
    const intacta = JSON.stringify(antes) === JSON.stringify(despues);
    if (!intacta || ad.fallas.length) malo = true;
    console.log(JSON.stringify({ folio, resultado: r, revisado: ad.revisado, fallas: ad.fallas, control: { antes, despues, intacta } }, null, 1));
  }
  await k.end();
  if (malo) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR', (e as Error).message); process.exit(1); });
