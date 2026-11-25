/* eslint-disable no-console */
/**
 * `[GP.R.3]` **Ensayo de escribir un Ajuste Abono `U-A-30` en el Kepler vivo, desde `md`, con ROLLBACK.**
 *
 * Prueba de escritura del anexo RC: reserva el folio con el candado real de Kepler, **clona** un Ajuste Abono que
 * Kepler ya aceptó (las 200 columnas de `kdm1` son `NOT NULL`: ADR-092) y le pisa sólo lo decidido, inserta su
 * renglón de `kdue` y una aplicación de `kdm5` por factura, comprueba que el saldo de cada factura baja lo aplicado
 * — y **deshace todo**. No existe ningún camino que confirme: el `ROLLBACK` es incondicional, en `finally`.
 *
 * ⛔ **Lo que este ensayo NO puede descubrir** (medido el 2026-11-24): `kdm1`, `kdm5`, `kdud`, `kdue` y `sqliov`
 *    tienen **cero disparadores**, así que lo que mueve el PROGRAMA de Kepler al postear un ajuste —acumulados,
 *    póliza— no se ve aquí: lo movería la aplicación, que en el ensayo no participa. Eso se mira sobre un ajuste
 *    real capturado por una persona, con foto antes/después. Acá se prueban permisos, folio, llaves y `rowCount`.
 *
 * Entrada por stdin, una línea cada una (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { "sucursal": "08", "cliente": "C1234",
 *              "facturas": [ { "tipo": 8, "serie": 1, "folio": "0001446", "monto": 0.37 } ] }
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { reservarFolioKepler } from '../../../libs/platform-core/src/lib/kepler/kepler-folio';
import { clonarFila } from '../../../libs/finance/src/lib/shared/kepler-filas';

interface FacturaAplicada { tipo: number; serie: number; folio: string; monto: number }
interface Entrada { sucursal: string; cliente: string; facturas: FacturaAplicada[] }

/** La referencia que marca al documento del ensayo. Nunca se parece a una de negocio. */
const REF_ENSAYO = `RC-${Date.now().toString(36)}`; // ⛔ kdm1.c11 es varchar(20): la llave de idempotencia TIENE que caber ahí
const PASOS: string[] = [];
const paso = (q: string, n: number | null | undefined): void => { PASOS.push(`${q} → ${n ?? 0}`); };

/** El saldo REAL de una factura de cartera: importe − Σ aplicado (Kepler no lo guarda; 632/632 medidas). */
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

async function ensayar(c: PoolClient, e: Entrada): Promise<Record<string, unknown>> {
  const total = Math.round(e.facturas.reduce((s, f) => s + Number(f.monto), 0) * 100) / 100;

  // 1 · La plantilla: un Ajuste Abono que Kepler ya aceptó en ESTE servidor.
  const pl = await c.query(
    `SELECT btrim(c6) AS folio FROM md.kdm1
      WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = 30 AND c5 = 1 AND btrim(coalesce(c43,'')) <> 'C'
      ORDER BY c9 DESC LIMIT 1`, [e.sucursal]);
  paso('plantilla U-A-30', pl.rowCount);
  if (pl.rowCount !== 1) throw new Error(`No hay un Ajuste Abono vivo que clonar en ${e.sucursal}: sin plantilla no se inventa un documento`);
  const base = String(pl.rows[0].folio);

  // 2 · El folio, con el candado real del contador (KFUA3001.<sucursal>).
  const fol = await reservarFolioKepler(c, { sucursal: e.sucursal, grupo: 'U', naturaleza: 'A', tipo: 30, serie: 1 });
  if (!fol.ok) throw new Error(`Folio: ${fol.motivo}`);
  paso(`reservarFolioKepler ${fol.valor.llave} (antes ${fol.valor.contadorAntes}, max ${fol.valor.maximo})`, 1);

  // ⭐ El patrón de la casa (`kepler-nota-sink.adapter.ts`): plantilla → tabla de ARMADO → una sola escritura a `md`.
  // ⛔ `clonarFila` INSERTA y después pisa, así que clonar directo a `md.kdm1` choca con `pk_kdm1` (el folio de la
  //    plantilla entra tal cual). Por eso se arma en una temporal sin llave y al final se vuelca.
  const temporales = async (t: string, filtro: string, params: unknown[]): Promise<number> => {
    await c.query(`CREATE TEMP TABLE _${t}0 ON COMMIT DROP AS SELECT * FROM md.${t} WHERE ${filtro}`, params);
    await c.query(`CREATE TEMP TABLE _${t} ON COMMIT DROP AS SELECT * FROM md.${t} WHERE false`);
    const n = await c.query(`SELECT count(*)::int AS n FROM _${t}0`);
    return Number(n.rows[0].n);
  };

  // 3 · El encabezado: se CLONA el de la plantilla y se le pisa sólo lo decidido.
  const nH = await temporales('kdm1', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = 30 AND c5 = 1 AND btrim(c6) = $2`, [e.sucursal, base]);
  paso('plantilla kdm1', nH);
  if (nH !== 1) throw new Error('La plantilla no trae exactamente un encabezado');
  await clonarFila(c, '_kdm10', '_kdm1', {
    c6: fol.valor.folio, c10: e.cliente, c11: REF_ENSAYO, c16: total, c42: total, c67: 'ENSAYO',
  });
  paso('clonarFila _kdm10 → _kdm1 (armado)', 1);

  // 4 · El renglón del abono en la cartera: también clonado del de la plantilla.
  const nE = await temporales('kdue', `c1 = $1 AND c3 = 'A' AND c4 = 30 AND c5 = 1 AND btrim(c6) = $2`, [e.sucursal, base]);
  paso('plantilla kdue', nE);
  if (nE !== 1) throw new Error('La plantilla no trae exactamente un renglón de kdue: no se inventa la cartera');
  await clonarFila(c, '_kdue0', '_kdue', { c2: e.cliente, c6: fol.valor.folio, c11: total, c17: String(total), c16: REF_ENSAYO });
  paso('clonarFila _kdue0 → _kdue (armado)', 1);

  // 5 · Una aplicación por factura. Se clona la primera de la plantilla para no inventar columnas.
  const nM = await temporales('kdm5', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = 30 AND c5 = 1 AND btrim(c6) = $2 LIMIT 1`, [e.sucursal, base]);
  paso('plantilla kdm5', nM);
  if (nM !== 1) throw new Error('La plantilla no trae aplicaciones de kdm5: no se inventa la aplicación');
  let n = 0;
  for (const f of e.facturas) {
    n += 1;
    await clonarFila(c, '_kdm50', '_kdm5', {
      c6: fol.valor.folio, c7: n, c9: f.tipo, c10: f.serie, c11: f.folio, c12: f.monto, c13: f.monto, c14: REF_ENSAYO,
    });
    paso(`clonarFila _kdm50 → _kdm5 (${f.tipo}-${f.serie}-${f.folio} por ${f.monto})`, 1);
  }

  // 5b · La ÚNICA escritura a Kepler, y lo que el ROLLBACK deshace.
  for (const t of ['kdm1', 'kdue', 'kdm5']) {
    const r = await c.query(`INSERT INTO md.${t} SELECT * FROM _${t}`);
    paso(`INSERT INTO md.${t}`, r.rowCount);
    if (!r.rowCount) throw new Error(`El INSERT en md.${t} no tocó ninguna fila`);
  }

  // 6 · El efecto: ¿el saldo de cada factura bajó lo aplicado?
  const despues = await saldos(c, e.sucursal, e.facturas);
  const doc = await c.query(
    `SELECT btrim(c6) AS folio, btrim(c10) AS cliente, round(c16::numeric,2) AS importe, btrim(c11) AS referencia
       FROM md.kdm1 WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = 30 AND c5 = 1 AND btrim(c6) = $2`,
    [e.sucursal, fol.valor.folio]);
  paso('leer el documento recién escrito', doc.rowCount);

  return { folio: fol.valor.folio, contador: fol.valor, documento: doc.rows[0] ?? null, saldos_dentro: despues, total };
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const e = JSON.parse(json) as Entrada;
  if (!e.sucursal || !e.cliente || !e.facturas?.length) throw new Error('El JSON pide sucursal, cliente y al menos una factura');

  const { Client } = await import('pg');
  const abrir = async (): Promise<PoolClient> => {
    const k = new Client({ connectionString: url });
    await k.connect();
    return k as unknown as PoolClient;
  };

  // ANTES, con su propia conexión.
  const c0 = await abrir();
  const antes = await saldos(c0, e.sucursal, e.facturas);
  const cont0 = await c0.query(`SELECT c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [`KFUA3001.${e.sucursal}`]);
  console.log(`ANTES: ${JSON.stringify({ saldos: antes, contador: cont0.rows[0]?.c4 ?? null })}`);
  await (c0 as unknown as { end(): Promise<void> }).end();

  // EL ENSAYO: una transacción que SIEMPRE se deshace.
  const c = await abrir();
  let salida: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    await c.query('BEGIN');
    salida = await ensayar(c, e);
  } catch (err) {
    error = (err as Error).message;
  } finally {
    await c.query('ROLLBACK');                      // ⛔ incondicional: no hay camino que confirme
    await (c as unknown as { end(): Promise<void> }).end();
  }
  console.log(JSON.stringify({ resultado: salida, error, deshecho: true, pasos: PASOS }, null, 1));

  // EL CONTROL, con una tercera conexión: después del ROLLBACK nada quedó.
  const c2 = await abrir();
  const quedo = await c2.query(
    `SELECT count(*)::int AS n FROM md.kdm1 WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = 30 AND btrim(c11) = $2`,
    [e.sucursal, REF_ENSAYO]);
  const cont1 = await c2.query(`SELECT c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [`KFUA3001.${e.sucursal}`]);
  const despues = await saldos(c2, e.sucursal, e.facturas);
  await (c2 as unknown as { end(): Promise<void> }).end();

  const docs = Number(quedo.rows[0].n);
  const contIgual = String(cont1.rows[0]?.c4 ?? '') === String(cont0.rows[0]?.c4 ?? '');
  const saldosIguales = JSON.stringify(despues) === JSON.stringify(antes);
  console.log(`CONTROL: documentos del ensayo = ${docs} (tiene que ser 0) · contador ${contIgual ? 'IGUAL' : '⛔ CAMBIÓ'} · saldos ${saldosIguales ? 'IGUALES' : '⛔ CAMBIARON'}`);
  if (docs !== 0 || !contIgual || !saldosIguales) process.exit(2);
  if (error) process.exit(3);
}

main().catch((err) => { console.error(`ERROR: ${(err as Error).message}`); process.exit(1); });
