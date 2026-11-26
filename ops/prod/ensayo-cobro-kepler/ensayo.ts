/* eslint-disable no-console */
/**
 * `[CC.23]` **Ensayo de escribir un COBRO `U-A-7` en el Kepler vivo, desde `md`, con ROLLBACK.**
 *
 * Contesta la pregunta de Edgar (2026-11-26): *«¿podemos insertar los abonos adecuadamente?»* — escribiendo uno de
 * verdad y **deshaciéndolo**. No existe ningún camino que confirme: el `ROLLBACK` es incondicional, en `finally`.
 *
 * ── ⛔⛔ POR QUÉ ESTE ENSAYO ES MÁS DELICADO QUE EL DEL AJUSTE ABONO ─────────────────────────────────────────────
 * Un Ajuste Abono no emite CFDI. **Un cobro sí**: medido el 2026-11-26 sobre los cobros de noviembre, **783 de 785
 * tienen su complemento de pago timbrado** (serie `<suc>UA07<serie>` + el mismo folio). O sea que **en cuanto el
 * cobro existe, el comprobante fiscal sale solo** — y un cobro mal escrito se vuelve un CFDI mal timbrado, que ya
 * no se edita: sólo se cancela. Por eso esto se ensaya ANTES de que exista un adaptador, y por eso deshace.
 *
 * ── Lo que escribe un cobro (medido en los cobros reales de la sucursal 06, nov-2026) ───────────────────────────
 *
 * | Tabla | Qué | Medido |
 * |---|---|---|
 * | `kdm1` | el documento `U-A-7-01-<folio>` | `c31='Cob'`, `c63='UA0701-'`, `c43='N'` |
 * | `kdue` | **UN** renglón de abono en la cartera | 94 cobros → 94 renglones |
 * | `kdm5` | una aplicación por factura | 94 cobros → 170 aplicaciones (1.8 por cobro) |
 * | `kdm2` | **NADA** | 0 renglones: un cobro no tiene producto |
 * | `kdc2AAMM` | ⛔ **la póliza, que el Ajuste Abono NO tiene**: 2 renglones que cuadran | cargo a `102` (bancos), abono a `115` (clientes), `c8='I'` |
 *
 * ⭐ **La caja (`kdm1.c12`) NO se inventa: se deriva del cobro ANTERIOR del mismo cliente.** Es un código por
 * sucursal (la 06 usa `30003` y `30004`, la 08 `20003`–`20006`) y **no se adivina cuál va**: si el cliente no tiene
 * un cobro previo en ese servidor, el ensayo se niega.
 *
 * ⛔ **Lo que este ensayo NO puede descubrir** (igual que el del ajuste): `kdm1`, `kdm5`, `kdue` y `sqliov` tienen
 * **cero disparadores**, así que lo que mueve el PROGRAMA de Kepler al postear —y **el timbrado del complemento**—
 * no se ve acá. Eso se mira sobre un cobro real capturado por una persona.
 *
 * Entrada por stdin, una línea cada una (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { "sucursal": "06", "cliente": "C3065",
 *              "facturas": [ { "tipo": 8, "serie": 1, "folio": "0001446", "monto": 15539.63 } ] }
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { reservarFolioKepler } from '../../../libs/platform-core/src/lib/kepler/kepler-folio';
import { clonarFila } from '../../../libs/finance/src/lib/shared/kepler-filas';

interface FacturaAplicada { tipo: number; serie: number; folio: string; monto: number }
interface Entrada { sucursal: string; cliente: string; facturas: FacturaAplicada[] }

/** `U-A-7` serie 1: el cobro de cliente. */
const TIPO = 7;
const SERIE = 1;
/** ⛔ `kdm1.c11` es `varchar(20)`: la llave de la Suite TIENE que caber ahí (medido escribiendo el 2026-11-24). */
const REF_ENSAYO = `EC-${Date.now().toString(36)}`;
const PASOS: string[] = [];
const paso = (q: string, n: number | null | undefined): void => { PASOS.push(`${q} → ${n ?? 0}`); };

/** La tabla de pólizas del mes: `kdc2AAMM`. */
const tablaPoliza = (fecha: string): string => `kdc2${fecha.slice(2, 4)}${fecha.slice(5, 7)}`;

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
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  const hora = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  const TP = tablaPoliza(hoy);
  if (!/^kdc2\d{4}$/.test(TP)) throw new Error(`Tabla de pólizas inválida: ${TP}`);

  // 1 · La plantilla: el cobro ANTERIOR de ESTE cliente. De ahí sale la caja (c12), que no se adivina.
  const pl = await c.query(
    `SELECT btrim(c6) AS folio, btrim(coalesce(c12,'')) AS caja, btrim(coalesce(c10,'')) AS cliente
       FROM md.kdm1
      WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric
        AND btrim(c10) = $4 AND btrim(coalesce(c43,'')) <> 'C'
      ORDER BY c9 DESC LIMIT 1`, [e.sucursal, TIPO, SERIE, e.cliente]);
  paso('plantilla U-A-7 del MISMO cliente', pl.rowCount);
  if (pl.rowCount !== 1) {
    throw new Error(`El cliente ${e.cliente} no tiene un cobro anterior en ${e.sucursal}: sin él no se sabe por qué caja entra (c12) y NO se inventa`);
  }
  const base = String(pl.rows[0].folio);
  const caja = String(pl.rows[0].caja);
  paso(`caja derivada de su cobro anterior (c12=${caja || '(vacía)'})`, 1);

  // 2 · El folio, con el candado real del contador (KFUA0701.<sucursal>).
  const fol = await reservarFolioKepler(c, { sucursal: e.sucursal, grupo: 'U', naturaleza: 'A', tipo: TIPO, serie: SERIE });
  if (!fol.ok) throw new Error(`Folio: ${fol.motivo}`);
  paso(`reservarFolioKepler ${fol.valor.llave} (antes ${fol.valor.contadorAntes}, max ${fol.valor.maximo})`, 1);
  const folio = fol.valor.folio;

  // ⭐ El patrón de la casa: plantilla → tabla de ARMADO → una sola escritura a `md`. `clonarFila` INSERTA y
  //   después pisa, así que clonar directo a `md.*` choca con la llave primaria.
  const temporales = async (t: string, filtro: string, params: unknown[]): Promise<number> => {
    await c.query(`CREATE TEMP TABLE _${t}0 ON COMMIT DROP AS SELECT * FROM md.${t} WHERE ${filtro}`, params);
    await c.query(`CREATE TEMP TABLE _${t} ON COMMIT DROP AS SELECT * FROM md.${t} WHERE false`);
    const n = await c.query(`SELECT count(*)::int AS n FROM _${t}0`);
    return Number(n.rows[0].n);
  };

  // 3 · El encabezado.
  const nH = await temporales('kdm1', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4`, [e.sucursal, TIPO, SERIE, base]);
  paso('plantilla kdm1', nH);
  if (nH !== 1) throw new Error('La plantilla no trae exactamente un encabezado');
  await clonarFila(c, '_kdm10', '_kdm1', {
    c6: folio, c9: hoy, c68: hoy, c69: hora, c10: e.cliente, c11: REF_ENSAYO,
    c12: caja, c16: total, c42: total, c43: 'N', c67: 'ENSAYO',
  });
  paso('clonarFila _kdm10 → _kdm1 (armado)', 1);

  // 4 · El renglón del abono en la cartera.
  const nE = await temporales('kdue', `c1 = $1 AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4`, [e.sucursal, TIPO, SERIE, base]);
  paso('plantilla kdue', nE);
  if (nE !== 1) throw new Error('La plantilla no trae exactamente un renglón de kdue: no se inventa la cartera');
  await clonarFila(c, '_kdue0', '_kdue', { c2: e.cliente, c6: folio, c7: hoy, c11: total, c16: REF_ENSAYO, c17: total, c29: 'A' });
  paso('clonarFila _kdue0 → _kdue (armado)', 1);

  // 5 · Una aplicación por factura.
  const nM = await temporales('kdm5', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4 LIMIT 1`, [e.sucursal, TIPO, SERIE, base]);
  paso('plantilla kdm5', nM);
  if (nM !== 1) throw new Error('La plantilla no trae aplicaciones de kdm5: no se inventa la aplicación');
  let n = 0;
  for (const f of e.facturas) {
    n += 1;
    await clonarFila(c, '_kdm50', '_kdm5', {
      c6: folio, c7: n, c9: f.tipo, c10: f.serie, c11: f.folio, c12: f.monto, c13: f.monto, c14: REF_ENSAYO,
    });
    paso(`clonarFila _kdm50 → _kdm5 (${f.tipo}-${f.serie}-${f.folio} por ${f.monto})`, 1);
  }

  // 6 · ⛔ LA PÓLIZA — lo que el Ajuste Abono no tiene. Dos renglones que CUADRAN: 102 cargo, 115 abono.
  const hayTabla = (await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`md.${TP}`])).rows[0].ok;
  paso(`tabla de pólizas del mes (${TP})`, hayTabla ? 1 : 0);
  if (!hayTabla) throw new Error(`Kepler (${e.sucursal}) no tiene la tabla de pólizas del mes (${TP})`);
  const nP = await temporales(TP, `btrim(c15) = 'U' AND btrim(c16) = 'A' AND btrim(c17::text) = $1 AND btrim(c19) = $2`, [String(TIPO), base]);
  paso(`plantilla de póliza (${TP}, cobro ${base})`, nP);
  if (nP !== 2) throw new Error(`La póliza del cobro plantilla trae ${nP} renglones y se esperaban 2 (cargo 102 / abono 115): no se inventa un asiento`);
  const maxPol = Number((await c.query(`SELECT coalesce(max(c1), 0)::int AS m FROM md.${TP} WHERE c8 = 'I'`)).rows[0].m);
  const poliza = maxPol + 1;
  paso(`numero de poliza I (max ${maxPol} → ${poliza})`, 1);
  // El concepto es el nombre del cliente, como en las pólizas reales: se lee del padrón, no se inventa.
  const nom = await c.query(`SELECT btrim(coalesce(c3,'')) AS nombre FROM md.kdud WHERE btrim(c2) = $1 LIMIT 1`, [e.cliente]);
  const concepto = String(nom.rows[0]?.nombre ?? '').slice(0, 40);
  paso('nombre del cliente para el concepto', nom.rowCount);
  for (const cuenta of ['102', '115'] as const) {
    const r = await c.query(
      `INSERT INTO _${TP} SELECT * FROM _${TP}0 WHERE btrim(c3) = $1 RETURNING ctid::text AS t`, [cuenta]);
    if (r.rowCount !== 1) throw new Error(`La póliza plantilla no trae exactamente un renglón de la cuenta ${cuenta}`);
    await c.query(
      `UPDATE _${TP} SET c1 = $2, c2 = $3::timestamp, c5 = $4, c6 = $5, c19 = $6, c7 = CASE WHEN btrim(c3) = '115' THEN $6 ELSE c7 END
        WHERE ctid = $1::tid`,
      [r.rows[0].t, poliza, hoy, total, concepto, folio]);
    paso(`renglon de poliza cuenta ${cuenta}`, 1);
  }

  // 6b · La ÚNICA escritura a Kepler, y lo que el ROLLBACK deshace.
  for (const t of ['kdm1', 'kdue', 'kdm5', TP]) {
    const r = await c.query(`INSERT INTO md.${t} SELECT * FROM _${t}`);
    paso(`INSERT INTO md.${t}`, r.rowCount);
    if (!r.rowCount) throw new Error(`El INSERT en md.${t} no tocó ninguna fila`);
  }

  // 7 · El efecto: ¿el saldo de cada factura bajó lo aplicado, y la póliza cuadra?
  const despues = await saldos(c, e.sucursal, e.facturas);
  const cuadre = await c.query(
    `SELECT round(sum(c5::numeric) FILTER (WHERE c4 = 'C'), 2) AS cargo,
            round(sum(c5::numeric) FILTER (WHERE c4 = 'A'), 2) AS abono, count(*)::int AS renglones
       FROM md.${TP} WHERE c1 = $1 AND c8 = 'I' AND btrim(c19) = $2`, [poliza, folio]);
  const doc = await c.query(
    `SELECT btrim(c6) AS folio, btrim(c10) AS cliente, round(c16::numeric,2) AS importe,
            btrim(c11) AS referencia, btrim(coalesce(c12,'')) AS caja
       FROM md.kdm1 WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND btrim(c6) = $3`,
    [e.sucursal, TIPO, folio]);
  paso('leer el documento recién escrito', doc.rowCount);

  return {
    folio, caja, poliza, tabla_poliza: TP, contador: fol.valor,
    documento: doc.rows[0] ?? null, poliza_cuadre: cuadre.rows[0] ?? null, saldos_dentro: despues, total,
  };
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
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  const TP = tablaPoliza(hoy);

  // ANTES, con su propia conexión.
  const c0 = await abrir();
  const antes = await saldos(c0, e.sucursal, e.facturas);
  const cont0 = await c0.query(`SELECT c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [`KFUA0${TIPO}0${SERIE}.${e.sucursal}`]);
  const pol0 = await c0.query(`SELECT coalesce(max(c1), 0)::int AS m FROM md.${TP} WHERE c8 = 'I'`).catch(() => ({ rows: [{ m: null }] }));
  console.log(`ANTES: ${JSON.stringify({ saldos: antes, contador: cont0.rows[0]?.c4 ?? null, max_poliza_I: pol0.rows[0]?.m ?? null })}`);
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
    `SELECT count(*)::int AS n FROM md.kdm1 WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND btrim(c11) = $3`,
    [e.sucursal, TIPO, REF_ENSAYO]);
  const polQuedo = await c2.query(`SELECT coalesce(max(c1), 0)::int AS m FROM md.${TP} WHERE c8 = 'I'`).catch(() => ({ rows: [{ m: null }] }));
  const cont1 = await c2.query(`SELECT c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [`KFUA0${TIPO}0${SERIE}.${e.sucursal}`]);
  const despues = await saldos(c2, e.sucursal, e.facturas);
  await (c2 as unknown as { end(): Promise<void> }).end();

  const docs = Number(quedo.rows[0].n);
  const saldosIguales = JSON.stringify(despues) === JSON.stringify(antes);
  // ⛔⛔ El control NO es «el contador quedó igual»: en horario de captura **otras personas siguen cobrando**, y el
  //    contador avanza legítimamente. Medido el 2026-11-26: el ensayo reservó el folio `0000868`, lo deshizo, y
  //    minutos después ese folio ya estaba tomado por una persona (otro cliente, otro importe, su capturista) —
  //    que es, justamente, la prueba de que la reserva se liberó. Un control que se pone rojo cuando todo salió
  //    bien es peor que no tenerlo: enseña a ignorarlo.
  //    Lo que SÍ es del ensayo y por eso se comprueba: su referencia y sus saldos. Del contador sólo se puede
  //    afirmar que **no retrocedió**.
  const n0 = Number(cont0.rows[0]?.c4 ?? NaN); const n1 = Number(cont1.rows[0]?.c4 ?? NaN);
  const contadorOk = !Number.isFinite(n0) || !Number.isFinite(n1) || n1 >= n0;
  const movido = Number.isFinite(n0) && Number.isFinite(n1) && n1 > n0 ? ` (avanzó ${n1 - n0} por capturas de otras personas)` : '';
  console.log(`CONTROL: documentos con la referencia del ensayo = ${docs} (tiene que ser 0) · saldos ${saldosIguales ? 'IGUALES' : '⛔ CAMBIARON'} · contador ${contadorOk ? 'no retrocedió' : '⛔ RETROCEDIÓ'}${movido}`);
  if (docs !== 0 || !saldosIguales || !contadorOk) process.exit(2);
  if (error) process.exit(3);
}

main().catch((err) => { console.error(`ERROR: ${(err as Error).message}`); process.exit(1); });
