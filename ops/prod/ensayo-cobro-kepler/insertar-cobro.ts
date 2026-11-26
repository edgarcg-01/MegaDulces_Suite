/* eslint-disable no-console */
/**
 * `[CC.25]` ⛔⛔ **ESCRIBE UN COBRO `U-A-7` DE VERDAD EN KEPLER. CONFIRMA. NO DESHACE.**
 *
 * Hermano de `ensayo.ts`, que es el que **deshace**. Éste existe aparte y se llama como lo que hace, a propósito:
 * el ensayo no tiene que aprender a confirmar, porque su `ROLLBACK` incondicional es su valor.
 *
 * **Para qué existe:** Edgar, el 2026-11-26, después de medir que el timbre lo pone el programa de Kepler y no la
 * base (`CC.24`): *«insertémoslo y veamos qué pasa»*. Es la única forma de contestar **si un cobro escrito por la
 * Suite se timbra o no**: no se deduce, se hace una vez y se mira.
 *
 * ── Lo que hay que saber antes de correrlo ──────────────────────────────────────────────────────────────────────
 *  · ⛔ **Puede quedar un cobro SIN complemento de pago.** Si eso pasa, es una obligación fiscal incumplida y hay
 *    que arreglarla: cancelar el cobro en Kepler (`c43='C'`) y recapturarlo a mano, o timbrarlo desde Kepler.
 *  · ⭐ **El cobro que se escribe es LEGÍTIMO de todos modos**: el dinero entró al banco, la ficha del cliente
 *    cuadra al peso y a la fecha, y la factura existe. No se inventa un documento — se adelanta uno que falta.
 *  · La **fecha del cobro es la del depósito**, no la de hoy: el complemento declara cuándo se pagó.
 *  · Deja su huella: `kdm1.c11` lleva la referencia, y `c67` dice **SUITE**. Con eso se encuentra siempre.
 *
 * ── El testigo del timbre, medido el 2026-11-26 ─────────────────────────────────────────────────────────────────
 * ⛔ **NO es `fiscal.cfdis`**: ésa es la descarga del SAT y tarda ~3 días. El testigo rápido es
 * **`md.kdfe33pagm1`** dentro del propio Kepler (serie `<suc>UA07<serie>`, `c3` = el folio del cobro). Validado:
 * los cobros `0000868` y `0000871`, que a `fiscal.cfdis` le faltaban, **sí están ahí**.
 *
 * Entrada por stdin, una línea cada una:
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { "sucursal":"06", "cliente":"C3065", "fecha":"2026-11-23",
 *              "facturas":[{ "tipo":8, "serie":1, "folio":"0001446", "monto":15539.63 }] }
 * Y **el argumento `--escribir-de-verdad`**: sin él, no escribe nada y lo dice.
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { reservarFolioKepler } from '../../../libs/platform-core/src/lib/kepler/kepler-folio';
import { clonarFila } from '../../../libs/finance/src/lib/shared/kepler-filas';

interface FacturaAplicada { tipo: number; serie: number; folio: string; monto: number }
interface Entrada { sucursal: string; cliente: string; fecha: string; facturas: FacturaAplicada[] }

const TIPO = 7;
const SERIE = 1;
/** ⛔ `kdm1.c11` es `varchar(20)`. La huella con la que este cobro se encuentra siempre. */
const REFERENCIA = `SUITE-CC-${Date.now().toString(36)}`.slice(0, 20);
const PASOS: string[] = [];
const paso = (q: string, n: number | null | undefined): void => { PASOS.push(`${q} → ${n ?? 0}`); };
const tablaPoliza = (fecha: string): string => `kdc2${fecha.slice(2, 4)}${fecha.slice(5, 7)}`;

const SALDO_SQL = `
  SELECT round(k.c16::numeric, 2) AS importe,
         round(k.c16::numeric - coalesce((SELECT sum(m.c12::numeric) FROM md.kdm5 m
            WHERE m.c1 = k.c1 AND m.c8 = 'D' AND m.c9 = k.c4 AND m.c10 = k.c5 AND btrim(m.c11) = btrim(k.c6)), 0), 2) AS saldo
    FROM md.kdm1 k
   WHERE k.c1 = $1 AND k.c2 = 'U' AND k.c3 = 'D' AND k.c4 = $2::numeric AND k.c5 = $3::numeric AND btrim(k.c6) = $4`;

async function saldos(c: PoolClient, suc: string, fs: FacturaAplicada[]): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const f of fs) {
    const r = await c.query(SALDO_SQL, [suc, f.tipo, f.serie, f.folio]);
    out.push({ factura: `${f.tipo}-${f.serie}-${f.folio}`, ...(r.rows[0] ?? { importe: null, saldo: null }) });
  }
  return out;
}

/** El testigo del timbre DENTRO de Kepler (no `fiscal.cfdis`, que tarda días). */
async function timbre(c: PoolClient, suc: string, folio: string): Promise<Record<string, unknown> | null> {
  const r = await c.query(
    `SELECT c2 AS serie, c3 AS folio, c7 AS fecha_pago, c12 AS monto FROM md.kdfe33pagm1
      WHERE c1 = $1 AND btrim(c3) = $2 LIMIT 1`, [suc, folio]);
  return r.rows[0] ?? null;
}

async function escribir(c: PoolClient, e: Entrada): Promise<Record<string, unknown>> {
  const total = Math.round(e.facturas.reduce((s, f) => s + Number(f.monto), 0) * 100) / 100;
  const hora = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  const TP = tablaPoliza(e.fecha);
  if (!/^kdc2\d{4}$/.test(TP)) throw new Error(`Tabla de pólizas inválida: ${TP}`);

  // 1 · La plantilla: el cobro ANTERIOR del MISMO cliente. De ahí sale la caja (c12), que no se adivina.
  const pl = await c.query(
    `SELECT btrim(c6) AS folio, btrim(coalesce(c12,'')) AS caja FROM md.kdm1
      WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric
        AND btrim(c10) = $4 AND btrim(coalesce(c43,'')) <> 'C'
      ORDER BY c9 DESC LIMIT 1`, [e.sucursal, TIPO, SERIE, e.cliente]);
  if (pl.rowCount !== 1) throw new Error(`El cliente ${e.cliente} no tiene un cobro anterior en ${e.sucursal}: sin él no se sabe por qué caja entra y NO se inventa`);
  const base = String(pl.rows[0].folio);
  const caja = String(pl.rows[0].caja);
  paso(`plantilla ${base} · caja ${caja || '(vacía)'}`, 1);

  // 1b · ⛔ Que no esté ya escrito: la misma referencia no entra dos veces.
  const ya = await c.query(
    `SELECT btrim(c6) AS folio FROM md.kdm1 WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND btrim(c11) = $3`,
    [e.sucursal, TIPO, REFERENCIA]);
  if (ya.rowCount) throw new Error(`Ya existe un cobro con la referencia ${REFERENCIA}`);

  // 1c · ⛔ Y que la factura siga debiendo lo que se va a aplicar: si alguien ya la cobró, no se cobra dos veces.
  for (const f of e.facturas) {
    const s = (await c.query(SALDO_SQL, [e.sucursal, f.tipo, f.serie, f.folio])).rows[0];
    if (!s) throw new Error(`Kepler no tiene la factura ${f.tipo}-${f.serie}-${f.folio}`);
    if (Math.abs(Number(s.saldo) - Number(f.monto)) > 0.005) {
      throw new Error(`La factura ${f.tipo}-${f.serie}-${f.folio} debe ${Number(s.saldo).toFixed(2)} y se iban a aplicar ${Number(f.monto).toFixed(2)}: alguien la movió`);
    }
  }
  paso('las facturas siguen debiendo lo que se va a aplicar', e.facturas.length);

  const fol = await reservarFolioKepler(c, { sucursal: e.sucursal, grupo: 'U', naturaleza: 'A', tipo: TIPO, serie: SERIE });
  if (!fol.ok) throw new Error(`Folio: ${fol.motivo}`);
  const folio = fol.valor.folio;
  paso(`folio ${folio} del contador ${fol.valor.llave} (antes ${fol.valor.contadorAntes})`, 1);

  const temporales = async (t: string, filtro: string, params: unknown[]): Promise<number> => {
    await c.query(`CREATE TEMP TABLE _${t}0 ON COMMIT DROP AS SELECT * FROM md.${t} WHERE ${filtro}`, params);
    await c.query(`CREATE TEMP TABLE _${t} ON COMMIT DROP AS SELECT * FROM md.${t} WHERE false`);
    return Number((await c.query(`SELECT count(*)::int AS n FROM _${t}0`)).rows[0].n);
  };

  const nH = await temporales('kdm1', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4`, [e.sucursal, TIPO, SERIE, base]);
  if (nH !== 1) throw new Error('La plantilla no trae exactamente un encabezado');
  await clonarFila(c, '_kdm10', '_kdm1', {
    c6: folio, c9: e.fecha, c68: e.fecha, c69: hora, c10: e.cliente, c11: REFERENCIA,
    c12: caja, c16: total, c42: total, c43: 'N', c67: 'SUITE',
  });
  paso('kdm1 armado', 1);

  const nE = await temporales('kdue', `c1 = $1 AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4`, [e.sucursal, TIPO, SERIE, base]);
  if (nE !== 1) throw new Error('La plantilla no trae exactamente un renglón de kdue');
  await clonarFila(c, '_kdue0', '_kdue', { c2: e.cliente, c6: folio, c7: e.fecha, c11: total, c16: REFERENCIA, c17: total, c29: 'A' });
  paso('kdue armado', 1);

  const nM = await temporales('kdm5', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4 LIMIT 1`, [e.sucursal, TIPO, SERIE, base]);
  if (nM !== 1) throw new Error('La plantilla no trae aplicaciones de kdm5');
  let n = 0;
  for (const f of e.facturas) {
    n += 1;
    await clonarFila(c, '_kdm50', '_kdm5', {
      c6: folio, c7: n, c9: f.tipo, c10: f.serie, c11: f.folio, c12: f.monto, c13: f.monto, c14: REFERENCIA,
    });
  }
  paso('kdm5 armado', n);

  // La póliza: 2 renglones que cuadran.
  const nP = await temporales(TP, `btrim(c15) = 'U' AND btrim(c16) = 'A' AND btrim(c17::text) = $1 AND btrim(c19) = $2`, [String(TIPO), base]);
  if (nP !== 2) throw new Error(`La póliza del cobro plantilla trae ${nP} renglones y se esperaban 2`);
  const poliza = Number((await c.query(`SELECT coalesce(max(c1), 0)::int AS m FROM md.${TP} WHERE c8 = 'I'`)).rows[0].m) + 1;
  const nom = await c.query(`SELECT btrim(coalesce(c3,'')) AS nombre FROM md.kdud WHERE btrim(c2) = $1 LIMIT 1`, [e.cliente]);
  const concepto = String(nom.rows[0]?.nombre ?? '').slice(0, 40);
  for (const cuenta of ['102', '115'] as const) {
    const r = await c.query(`INSERT INTO _${TP} SELECT * FROM _${TP}0 WHERE btrim(c3) = $1 RETURNING ctid::text AS t`, [cuenta]);
    if (r.rowCount !== 1) throw new Error(`La póliza plantilla no trae un renglón de la cuenta ${cuenta}`);
    await c.query(
      `UPDATE _${TP} SET c1 = $2, c2 = $3::timestamp, c5 = $4, c6 = $5, c19 = $6, c7 = CASE WHEN btrim(c3) = '115' THEN $6 ELSE c7 END
        WHERE ctid = $1::tid`, [r.rows[0].t, poliza, e.fecha, total, concepto, folio]);
  }
  paso(`poliza I ${poliza} en ${TP}`, 2);

  for (const t of ['kdm1', 'kdue', 'kdm5', TP]) {
    const r = await c.query(`INSERT INTO md.${t} SELECT * FROM _${t}`);
    paso(`INSERT INTO md.${t}`, r.rowCount);
    if (!r.rowCount) throw new Error(`El INSERT en md.${t} no tocó ninguna fila`);
  }

  // El efecto, DENTRO de la transacción: si no quedó como se esperaba, se aborta y no se confirma.
  const dentro = await saldos(c, e.sucursal, e.facturas);
  for (const s of dentro) {
    if (Math.abs(Number(s.saldo)) > 0.005) throw new Error(`La factura ${s.factura} quedó en ${s.saldo} y debía quedar en 0.00`);
  }
  const cuadre = (await c.query(
    `SELECT round(sum(c5::numeric) FILTER (WHERE c4 = 'C'), 2) AS cargo, round(sum(c5::numeric) FILTER (WHERE c4 = 'A'), 2) AS abono
       FROM md.${TP} WHERE c1 = $1 AND c8 = 'I' AND btrim(c19) = $2`, [poliza, folio])).rows[0];
  if (String(cuadre.cargo) !== String(cuadre.abono)) throw new Error(`La póliza no cuadra: cargo ${cuadre.cargo} contra abono ${cuadre.abono}`);
  paso(`poliza cuadra (${cuadre.cargo})`, 1);

  return { folio, caja, poliza, tabla_poliza: TP, referencia: REFERENCIA, total, saldos_dentro: dentro, contador: fol.valor };
}

async function main(): Promise<void> {
  const deVerdad = process.argv.includes('--escribir-de-verdad');
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const e = JSON.parse(json) as Entrada;
  if (!e.sucursal || !e.cliente || !e.fecha || !e.facturas?.length) throw new Error('El JSON pide sucursal, cliente, fecha y al menos una factura');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.fecha)) throw new Error(`Fecha inválida «${e.fecha}»: va la del DEPÓSITO, no la de hoy`);
  if (!deVerdad) { console.log('SIN --escribir-de-verdad: no se escribió nada. Esto es lo que haría:'); }

  const { Client } = await import('pg');
  const abrir = async (): Promise<PoolClient> => {
    const k = new Client({ connectionString: url });
    await k.connect();
    return k as unknown as PoolClient;
  };

  const c0 = await abrir();
  const antes = await saldos(c0, e.sucursal, e.facturas);
  console.log(`ANTES: ${JSON.stringify({ saldos: antes })}`);
  await (c0 as unknown as { end(): Promise<void> }).end();

  const c = await abrir();
  let salida: Record<string, unknown> | null = null;
  let error: string | null = null;
  let confirmado = false;
  try {
    await c.query('BEGIN');
    salida = await escribir(c, e);
    if (deVerdad) { await c.query('COMMIT'); confirmado = true; }
    else { await c.query('ROLLBACK'); }
  } catch (err) {
    error = (err as Error).message;
    await c.query('ROLLBACK').catch(() => undefined);
  } finally {
    await (c as unknown as { end(): Promise<void> }).end();
  }
  console.log(JSON.stringify({ resultado: salida, error, confirmado, pasos: PASOS }, null, 1));
  if (error) process.exit(1);
  if (!confirmado) { console.log('(no se confirmó: faltó --escribir-de-verdad)'); return; }

  // ── Y AHORA LO QUE IMPORTA: ¿se timbró? El testigo es kdfe33pagm1 DENTRO de Kepler ───────────
  const folio = String((salida as { folio: string }).folio);
  const c2 = await abrir();
  const despues = await saldos(c2, e.sucursal, e.facturas);
  const t0 = await timbre(c2, e.sucursal, folio);
  console.log(`DESPUES: saldos ${JSON.stringify(despues)}`);
  console.log(`TIMBRE (al instante): ${t0 ? JSON.stringify(t0) : 'TODAVÍA NO'}`);
  await (c2 as unknown as { end(): Promise<void> }).end();
  console.log(`\n⛔ Para volver a mirar el timbre dentro de un rato, sin escribir nada:`);
  console.log(`   SELECT c2, c3, c7, c12 FROM md.kdfe33pagm1 WHERE c1='${e.sucursal}' AND btrim(c3)='${folio}';`);
  console.log(`⛔ Y si NO timbra: el cobro es ${e.sucursal}/U-A-7/${folio}, referencia ${REFERENCIA}, capturista SUITE.`);
  console.log(`   Se cancela en Kepler (c43='C') y se recaptura a mano, o se timbra desde Kepler.`);
}

main().catch((err) => { console.error(`ERROR: ${(err as Error).message}`); process.exit(1); });
