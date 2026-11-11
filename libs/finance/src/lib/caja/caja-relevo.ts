import type { Knex } from 'knex';
import { diaDeFecha, warehouseName } from '@megadulces/contracts';
import { casarPorImporte, CUADRE_TOLERANCIA_PESOS } from './caja-cuadre.engine';
import { cobroDeRutaComoKepler, type CobroDeRuta } from './caja-kepler-libro.engine';

/**
 * `[CGA-A.43]` **Desde qué día la caja vive en el libro nuevo**: la fecha del PRIMER corte de
 * `finance.cash_ledger_cuts`. Una sola definición para todo el módulo.
 *
 * ── Por qué es el borde de la cola ───────────────────────────────────────────────────────────
 *
 * El Access Control dejó de capturar el 10-oct 12:39 y el primer corte del libro (`CC-2026-00001`,
 * 12-oct) abre con el fondo del arqueo `A23641` de ese día. Lo anterior a ese corte es de la era
 * Control: medido el 2026-10-20 con el Cuadre de `/finanzas/caja`, de 541 documentos de Kepler
 * del 1 al 11-oct que la cola tenía «pendientes», Control ya había saldado todos salvo 15. Antes de
 * septiembre son 11,404 más. Ninguno de ésos es trabajo del libro.
 *
 * Desde el corte en adelante, en cambio, la cola es exacta: medido ese día, 61 documentos /
 * $779,568.24. Por eso la bandeja deja de necesitar una ventana de días (Edgar, 2026-10-20: «ya
 * sabemos qué movimientos están pendientes»).
 *
 * Sale de los DATOS, no de una constante: si el libro arrancara otro día, o se reiniciara, el borde
 * se mueve solo.
 *
 * @returns `YYYY-MM-DD`, o `null` si todavía no hay ningún corte (y entonces el llamador decide su
 *          ventana de siempre).
 */
export async function primerCorteDelLibro(trx: Knex | Knex.Transaction, tenantId: string): Promise<string | null> {
  const r: { fecha: unknown } | undefined = await trx('finance.cash_ledger_cuts')
    .where('tenant_id', tenantId).orderBy('fecha', 'asc').first('fecha');
  return r ? diaDeFecha(r.fecha) ?? null : null;
}

/**
 * `[CGA-A.66]` **La edad del dato de la caja**: el último `ok` del carril `ods_live_caja`, que es el
 * que escribe `kdm1` y, por trigger, la tesorería y la cola (ADR-104). Una sola definición: la usan
 * la bandeja de Captura y el Cuadre, que tienen que decir la misma edad del mismo dato.
 *
 * `null` = no se pudo medir, y quien lo pinta lo declara «sin medir», nunca como fresco.
 */
export async function frescuraCaja(trx: Knex | Knex.Transaction, tenantId: string): Promise<string | null> {
  try {
    const r = await trx('analytics.cron_run_log')
      .where({ tenant_id: tenantId, job_key: 'ods_live_caja', status: 'ok' })
      .max({ al: 'finished_at' })
      .first();
    return (r as { al?: string } | undefined)?.al ?? null;
  } catch {
    return null;
  }
}

/** `[CGA-A.44]` El primer día del mes de una fecha `YYYY-MM-DD`. */
export function inicioDelMes(dia: string): string {
  return `${dia.slice(0, 7)}-01`;
}

/** `[CGA-A.44]` El día anterior a una fecha `YYYY-MM-DD` (aritmética de calendario, sin zona). */
export function diaAnterior(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Un movimiento reducido a lo que el casamiento del Cuadre necesita, con su día y dirección. */
export interface MovDelDia { key: string; importe: number; fecha: string; dir: 'in' | 'out' }

/**
 * `[CGA-A.44]` **Qué documentos de Kepler ya saldó el Control**, con el MISMO casamiento que el
 * Cuadre de `/finanzas/caja`: por día y por dirección, `casarPorImporte` con ±$5. Devuelve las
 * llaves de Kepler (`sucursal|doc|folio|clave`) que casaron. Función pura: los datos los trae
 * `saldadosPorControl`.
 *
 * ⚠️ Es por DÍA, igual que el Cuadre: un cobro que el Control anotó días después NO se da por
 * saldado aquí (no aguantó el placebo como regla — `[CGA-A.35]`). Así que lo que la cola muestre
 * de la era Control es un TECHO de lo que falta, no la cifra exacta, y la pantalla lo dice.
 */
export function casadosPorControl(control: MovDelDia[], kepler: MovDelDia[], tolerancia = CUADRE_TOLERANCIA_PESOS): Set<string> {
  return new Set(paresDelMismoDia(control, kepler, tolerancia).map((p) => p.kepler));
}

/** El casamiento del MISMO día, con qué renglón del Control saldó cada documento. */
function paresDelMismoDia(control: MovDelDia[], kepler: MovDelDia[], tolerancia: number): Array<{ kepler: string; control: string }> {
  const out: Array<{ kepler: string; control: string }> = [];
  const llave = (m: MovDelDia) => `${m.fecha}|${m.dir}`;
  const kPor = new Map<string, MovDelDia[]>();
  for (const k of kepler) { const g = kPor.get(llave(k)); if (g) g.push(k); else kPor.set(llave(k), [k]); }
  const cPor = new Map<string, MovDelDia[]>();
  for (const c of control) { const g = cPor.get(llave(c)); if (g) g.push(c); else cPor.set(llave(c), [c]); }
  for (const [g, cs] of cPor) {
    const ks = kPor.get(g);
    if (!ks) continue;
    for (const p of casarPorImporte(cs, ks, tolerancia).pares) out.push({ kepler: p.otro.key, control: p.caja.key });
  }
  return out;
}

/**
 * ⭐ `[CGA-A.73]` **Lo que el Control anotó DÍAS DESPUÉS, cuando su texto dice de quién es.**
 *
 * Edgar, 2026-11-11 («hagámoslo»), tras revisar la cola uno por uno: de 43 pendientes de la era
 * Control, el Control había anotado 33 entre 1 y 4 días después —«Ventas Canindo 05/10 RD501», la
 * ruta y el día de la venta, al peso— y la cola los seguía ofreciendo porque el casamiento de arriba
 * es del MISMO día.
 *
 * ⛔ **No es casar por importe con ventana de días**: eso ya se probó y el placebo casó más que lo
 * real (19 % contra 7 %, `caja-kepler-libro.engine.ts`). Aquí el importe es la ÚLTIMA condición; lo
 * que casa es lo que el Control ESCRIBIÓ:
 *   1 · **ruta** — el cobro de camioneta de la ruta N, y el Control dice «RD N» con un día de venta
 *       de hasta 3 días antes del cobro;
 *   2 · **Morelia** — el depósito de una sucursal de Morelia, y el Control dice «Morelia» con un día
 *       de venta de hasta 7 días antes (Morelia deposita días después de vender);
 *   3 · **vecinal** — la venta vecinal de una sucursal («VENTAS 2-10-2026 RV CANDY…»), que el Control
 *       anotó partida en DOS renglones del mismo día de venta («Ventas RV 02/10» + «Ventas
 *       RutaVecinal 02/10»): la suma de los dos.
 * Siempre: el Control lo anotó de 0 a `DIAS_CONTROL_DESPUES` días después del documento, dentro de
 * la tolerancia del Cuadre, y uno con uno — si hay dos candidatos, no se decide.
 *
 * Control negativo medido en prod el 2026-11-11 sobre la era Control (1–11 oct): ver
 * `FASE_LE` / tracker `[CGA-A.73]`; con el importe corrido, la ruta vecina o el documento una
 * semana antes, ninguna de las tres reglas casa.
 *
 * ⚠️ El Cuadre de `/finanzas/caja` sigue siendo POR DÍA y no usa esto: en su día el documento sale
 * «solo Kepler», y es cierto — ese día el Control no lo recibió. Lo que cambia es la COLA, que
 * pregunta otra cosa: «¿falta capturarlo?». Lo que el Cuadre da por casado la cola también lo da
 * (el paso del mismo día va primero y no cambió).
 */
export const DIAS_CONTROL_DESPUES = 4;
const DIAS_VENTA_ANTES_RUTA = 3;
const DIAS_VENTA_ANTES_MORELIA = 7;

/** Un renglón del Control con su texto (`nombre_cliente` + `concepto`). */
export interface ControlConTexto extends MovDelDia { texto: string | null }
/** Un documento de Kepler con lo que dice de quién es. */
export interface KeplerConLugar extends MovDelDia {
  /** La ruta de la camioneta (`ruta_501` → `'501'`), o `null` si no es cobro de camioneta. */
  ruta: string | null;
  /** El nombre de la sucursal dice «Morelia». */
  morelia: boolean;
  /** El concepto de Kepler: de ahí sale el día de una venta vecinal. */
  concepto: string | null;
}

export interface LeidoDelControl { ruta: string | null; dia: string | null; morelia: boolean; vecinal: boolean }

const pad2 = (n: number) => String(n).padStart(2, '0');
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
/** Un día `d/m` escrito sin año: el del documento, o el anterior si caería después. */
const conAnio = (d: number, m: number, ref: string): string | null => {
  if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return null;
  const anio = Number(ref.slice(0, 4));
  const x = `${anio}-${pad2(m)}-${pad2(d)}`;
  return x > ref ? `${anio - 1}-${pad2(m)}-${pad2(d)}` : x;
};
const esVecinal = (t: string) => /vecinal|vecnal|(?<![a-z])rv(?![a-z0-9])/i.test(t);

/**
 * Lo que el Control escribió en un renglón: «Ventas Canindo 05/10 RD501», «Ventas PH 09/10RD 28»,
 * «Ventas RD 07/10 502», «ventas Rutas Morelia 01/10», «Ventas RutaVecinal 02/10».
 * ⚠️ «RD 07/10» NO es la ruta 7: un número seguido de `/` es el día.
 */
export function leeTextoDelControl(texto: string | null, fechaControl: string): LeidoDelControl {
  const t = String(texto ?? '');
  const f = /(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/.exec(t);
  const r = /(?<![a-z])(?:ruta|rd|r)\s*(\d{2,3})(?![\d/])/i.exec(t) ?? /(?:^|\s)(\d{3})\s*$/.exec(t);
  const morelia = /morelia/i.test(t);
  return {
    ruta: r ? String(Number(r[1])) : null,
    dia: f ? conAnio(Number(f[1]), Number(f[2]), fechaControl) : null,
    morelia,
    vecinal: !morelia && esVecinal(t),
  };
}

/** El día de una venta vecinal que Kepler escribe en el concepto: «VENTAS 2-10-2026 RV CANDY Y DO». */
export function diaVecinalDeKepler(concepto: string | null): string | null {
  const t = String(concepto ?? '');
  if (!esVecinal(t)) return null;
  const f = /(?<!\d)(\d{1,2})-(\d{1,2})-(\d{4})(?!\d)/.exec(t);
  if (!f) return null;
  const [d, m] = [Number(f[1]), Number(f[2])];
  return d >= 1 && d <= 31 && m >= 1 && m <= 12 ? `${f[3]}-${pad2(m)}-${pad2(d)}` : null;
}

/**
 * `[CGA-A.73]` Las tres reglas de arriba, sobre lo que el paso del mismo día dejó suelto. Devuelve
 * cada documento saldado con los renglones del Control que lo saldaron. Pura.
 */
export function casadosPorControlDespues(
  control: readonly ControlConTexto[], kepler: readonly KeplerConLugar[], tolerancia = CUADRE_TOLERANCIA_PESOS,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const usados = new Set<string>();
  const cs = control.filter((c) => c.dir === 'in').map((c) => ({ c, l: leeTextoDelControl(c.texto, c.fecha) }));
  const ks = kepler.filter((k) => k.dir === 'in');
  const aTiempo = (k: KeplerConLugar, c: ControlConTexto) => { const x = diasEntre(k.fecha, c.fecha); return x >= 0 && x <= DIAS_CONTROL_DESPUES; };
  const ventaAntes = (k: KeplerConLugar, dia: string | null, max: number) => { if (!dia) return false; const x = diasEntre(dia, k.fecha); return x >= 0 && x <= max; };
  const cerca = (a: number, b: number) => Math.abs(a - b) <= tolerancia + 1e-9;

  // Reglas 1 y 2: un renglón del Control por documento, uno con uno.
  const cand = new Map<string, string[]>();
  const porControl = new Map<string, number>();
  for (const k of ks) {
    const c = cs.filter(({ c, l }) => aTiempo(k, c) && cerca(c.importe, k.importe) && (
      (k.ruta !== null && l.ruta === k.ruta && ventaAntes(k, l.dia, DIAS_VENTA_ANTES_RUTA))
      || (k.ruta === null && k.morelia && l.morelia && ventaAntes(k, l.dia, DIAS_VENTA_ANTES_MORELIA))
    )).map(({ c }) => c.key);
    cand.set(k.key, c);
    for (const x of c) porControl.set(x, (porControl.get(x) ?? 0) + 1);
  }
  for (const k of ks) {
    const c = cand.get(k.key) ?? [];
    if (c.length === 1 && porControl.get(c[0]) === 1) { out.set(k.key, c); usados.add(c[0]); }
  }

  // Regla 3: la venta vecinal, en uno o en dos renglones del mismo día de venta. Una sola forma.
  for (const k of ks) {
    if (out.has(k.key) || k.ruta !== null) continue;
    const dia = diaVecinalDeKepler(k.concepto);
    if (!dia) continue;
    const v = cs.filter(({ c, l }) => !usados.has(c.key) && l.vecinal && l.dia === dia && aTiempo(k, c)).map(({ c }) => c);
    const formas: string[][] = [];
    for (let i = 0; i < v.length; i++) {
      if (cerca(v[i].importe, k.importe)) formas.push([v[i].key]);
      for (let j = i + 1; j < v.length; j++) if (cerca(v[i].importe + v[j].importe, k.importe)) formas.push([v[i].key, v[j].key]);
    }
    if (formas.length === 1) { out.set(k.key, formas[0]); for (const x of formas[0]) usados.add(x); }
  }
  return out;
}

/**
 * `[CGA-A.44]` Lee el Control y la Caja General de Kepler (tesorería + cobros de camioneta) de un
 * rango de la era Control y devuelve las llaves que el Control ya saldó. Las mismas fuentes que usa
 * el Cuadre (`kepler_bank_movements` con `account_label='CG'` y `route_collections` cuenta 0011),
 * para que la cola y el Cuadre no puedan decir cosas distintas.
 *
 * ⚠️ Los cobros de camioneta van en SAVEPOINT (se leen por FDW): si fallan, se devuelve
 * `ruta_disponible: false` y esos cobros NO se dan por saldados — quedan visibles en la cola. Es
 * el lado seguro: mostrar de más se corrige mirando; esconder no se ve.
 */
export async function saldadosPorControl(trx: Knex.Transaction, tenantId: string, from: string, to: string): Promise<{ llaves: Set<string>; ruta_disponible: boolean; despues: number }> {
  // `[CGA-A.73]` Hasta `DIAS_CONTROL_DESPUES` días después del rango: el Control anotaba tarde.
  const hastaControl = new Date(Date.parse(`${to}T12:00:00Z`) + DIAS_CONTROL_DESPUES * 86400000).toISOString().slice(0, 10);
  const ctl: Array<{ tipo_dto: unknown; mov_id: unknown; fecha: unknown; ingreso: unknown; gasto: unknown; nombre_cliente: unknown; concepto: unknown }> = await trx('analytics.caja_general_movimientos')
    .where('tenant_id', tenantId).whereBetween('fecha', [from, hastaControl])
    .select('tipo_dto', 'mov_id', 'fecha', 'ingreso', 'gasto', 'nombre_cliente', 'concepto');
  // ⚠️ `mv_caja_movimientos` (materializada) y no `kepler_bank_movements` (la vista viva que lee el
  // Cuadre): la viva tardó 3.0–3.4 s para 10 días y esto corre en cada carga de la cola. Medido el
  // 2026-10-20 del 1-sep al 20-oct: 2,073 documentos en las dos, CERO diferencias en llave, fecha,
  // importe y signo. Si algún día divergen, la cola y el Cuadre dejarían de coincidir: el control es
  // comparar las dos con EXCEPT, como se hizo aquí.
  const tes: Array<{ sucursal: string; doc_tipo: string; folio: string; clave_banco: string; fecha: unknown; importe: unknown; signo: unknown; concepto: string | null }> = await trx('analytics.mv_caja_movimientos')
    .where('tenant_id', tenantId).andWhere('clave_banco', '0011')
    .andWhere('fecha_valor', '>=', from).andWhere('fecha_valor', '<=', to)
    .select('sucursal', 'doc_tipo', 'folio', 'clave_banco', 'fecha_valor as fecha', 'importe', 'signo', 'concepto');
  let ruta: Array<ReturnType<typeof cobroDeRutaComoKepler> & { truck: string | null }> = [];
  let ruta_disponible = true;
  await trx.raw('SAVEPOINT cga_a44_ruta');
  try {
    const rc: CobroDeRuta[] = await trx('analytics.route_collections')
      .where('tenant_id', tenantId).andWhere('cuenta', '0011')
      .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
      .groupBy('almacen', 'cobro_folio', 'fecha')
      .select('almacen', 'cobro_folio', 'fecha', trx.raw('SUM(importe)::numeric AS importe'),
        trx.raw(`string_agg(DISTINCT truck, ' · ') AS truck`), trx.raw(`string_agg(DISTINCT COALESCE(referencia, folio_corte), ' · ') AS concepto`));
    await trx.raw('RELEASE SAVEPOINT cga_a44_ruta');
    ruta = rc.map((r) => ({ ...cobroDeRutaComoKepler(r), truck: r.truck }));
  } catch {
    await trx.raw('ROLLBACK TO SAVEPOINT cga_a44_ruta').catch(() => undefined);
    ruta_disponible = false;
  }
  return { ...casadosPorControlConRezago(ctl, tes, ruta), ruta_disponible };
}

/**
 * `[CGA-A.73]` Lo que `saldadosPorControl` hace con lo que leyó, sin base: el paso del MISMO día
 * (el del Cuadre) y después el de `casadosPorControlDespues` sobre lo que quedó suelto. Separado
 * para medirlo contra prod con sus controles negativos sin tocar la consulta.
 */
export function casadosPorControlConRezago(
  ctl: ReadonlyArray<{ tipo_dto: unknown; mov_id: unknown; fecha: unknown; ingreso: unknown; gasto: unknown; nombre_cliente?: unknown; concepto?: unknown }>,
  tes: ReadonlyArray<{ sucursal: string; doc_tipo: string; folio: string; clave_banco: string; fecha: unknown; importe: unknown; signo: unknown; concepto?: string | null }>,
  ruta: ReadonlyArray<{ sucursal: string; doc_tipo: string; folio: string; clave_banco: string; fecha: unknown; importe: unknown; signo: unknown; concepto?: string | null; truck?: string | null }>,
): { llaves: Set<string>; despues: number } {
  const n = (x: unknown) => Number(x) || 0;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const control: ControlConTexto[] = [];
  for (const r of ctl) {
    const fecha = diaDeFecha(r.fecha) ?? '';
    const key = `${String(r.tipo_dto)}|${String(r.mov_id)}`;
    const texto = [r.nombre_cliente, r.concepto].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ') || null;
    if (n(r.ingreso) > 0) control.push({ key, fecha, dir: 'in', importe: r2(n(r.ingreso)), texto });
    if (n(r.gasto) > 0) control.push({ key, fecha, dir: 'out', importe: r2(n(r.gasto)), texto });
  }
  // La ruta de la camioneta: `ruta_501` → `'501'`. Una unidad sola; si el cobro junta dos, no hay ruta.
  const rutaDe = (truck: string | null | undefined) => {
    const m = /^ruta_(\d+)$/i.exec(String(truck ?? '').trim());
    return m ? String(Number(m[1])) : null;
  };
  const kepler: KeplerConLugar[] = [
    ...tes.map((r) => ({ r, ruta: null as string | null })),
    ...ruta.map((r) => ({ r, ruta: rutaDe(r.truck) })),
  ].map(({ r, ruta: rt }) => ({
    key: `${r.sucursal}|${r.doc_tipo}|${r.folio}|${r.clave_banco}`,
    fecha: diaDeFecha(r.fecha) ?? '',
    dir: n(r.signo) > 0 ? 'in' as const : 'out' as const,
    importe: r2(n(r.importe)),
    ruta: rt,
    morelia: !r.sucursal.includes('-') && /morelia/i.test(warehouseName(r.sucursal)),
    concepto: r.concepto ?? null,
  }));
  const mismoDia = paresDelMismoDia(control, kepler, CUADRE_TOLERANCIA_PESOS);
  const kUsados = new Set(mismoDia.map((p) => p.kepler));
  const cUsados = new Set(mismoDia.map((p) => p.control));
  const despues = casadosPorControlDespues(control.filter((c) => !cUsados.has(c.key)), kepler.filter((k) => !kUsados.has(k.key)));
  return { llaves: new Set([...kUsados, ...despues.keys()]), despues: despues.size };
}
