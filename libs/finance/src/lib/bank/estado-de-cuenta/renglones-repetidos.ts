/**
 * `[BFU.3.4]` **El mismo renglón del banco en dos descargas encimadas, aunque el banco le haya cambiado el concepto.**
 *
 * ⛔ El hueco (medido en prod el 2026-11-19, tras pasar 15 cuentas al banco): BBVA completa DESPUÉS la referencia de
 * los depósitos en efectivo. La descarga del 14-nov dice «DEPOSITO EN EFECTIVO/» y la siguiente, del mismo día, importe
 * y saldo, «DEPOSITO EN EFECTIVO/0021089». La llave del renglón (`llaveDeLinea`) lleva el concepto, así que la segunda
 * descarga los metió como nuevos: **18 depósitos repetidos** en dos cuentas BBVA — la diferencia
 * exacta de «no cierra» en Cuentas. El cuadre de la descarga no lo vio porque juzga los saldos con que abre cada
 * archivo, no los renglones guardados.
 *
 * Lo que identifica a un renglón sin depender del texto es su **huella**: día, cargo, abono y el saldo con que quedó
 * la cuenta. Dos movimientos distintos con la misma huella exigen que el saldo vuelva exactamente al mismo valor con
 * el mismo importe el mismo día: puede pasar dentro de un archivo, y por eso se cuenta como MULTICONJUNTO (k renglones
 * iguales en el archivo contra k guardados), nunca como conjunto.
 */
export interface Huella { fecha: string; cargo_centavos: number; abono_centavos: number; saldo_centavos: number }

export const huellaDe = (h: Huella): string => [h.fecha, h.cargo_centavos, h.abono_centavos, h.saldo_centavos].join('|');

const centavos = (v: number | string) => Math.round(Number(v) * 100);

/** La huella de un renglón ya guardado (`bank_statement_lines`). */
export const huellaGuardada = (r: { fecha: string; amount_in: number | string; amount_out: number | string; running_balance: number | string }): string =>
  huellaDe({ fecha: r.fecha, cargo_centavos: centavos(r.amount_out), abono_centavos: centavos(r.amount_in), saldo_centavos: centavos(r.running_balance) });

export interface RenglonNuevo { llave: string; huella: string; concepto: string }
export interface RenglonGuardado { id: string; line_key: string; huella: string; concept: string }

export interface YaCargado {
  existe: boolean;
  /** El guardado que es este mismo renglón con OTRO concepto (sólo cuando no casó por llave). */
  mismo_que: RenglonGuardado | null;
}

/**
 * Por cada renglón del archivo, si ya está guardado. Primero casa por llave (el mismo texto); lo que sobra, por huella,
 * 1:1 y en orden: k renglones iguales en el archivo consumen a lo más k guardados.
 */
export function marcarYaCargados(nuevos: readonly RenglonNuevo[], guardados: readonly RenglonGuardado[]): YaCargado[] {
  const usados = new Set<string>();
  const porLlave = new Map<string, RenglonGuardado[]>();
  for (const g of guardados) porLlave.set(g.line_key, [...(porLlave.get(g.line_key) ?? []), g]);
  const out: YaCargado[] = nuevos.map(() => ({ existe: false, mismo_que: null }));
  nuevos.forEach((n, i) => {
    const g = (porLlave.get(n.llave) ?? []).find((x) => !usados.has(x.id));
    if (g) { usados.add(g.id); out[i] = { existe: true, mismo_que: null }; }
  });
  nuevos.forEach((n, i) => {
    if (out[i].existe) return;
    const g = guardados.find((x) => !usados.has(x.id) && x.huella === n.huella);
    if (g) { usados.add(g.id); out[i] = { existe: true, mismo_que: g }; }
  });
  return out;
}

const normal = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * ¿El concepto nuevo COMPLETA al guardado? Sólo si lo extiende (el banco agregó la referencia): «DEPOSITO EN
 * EFECTIVO/» → «DEPOSITO EN EFECTIVO/0021089». Si es otro texto, no se toca: no se adivina cuál vale.
 */
export function completaElConcepto(guardado: string, nuevo: string): boolean {
  const g = normal(guardado), n = normal(nuevo);
  return n.length > g.length && n.startsWith(g);
}

export interface RenglonDeArchivo { archivo: string; huella: string; importe_centavos: number }

/**
 * Los renglones guardados que repiten a otro de OTRO archivo: por huella, lo guardado menos lo que trae el archivo que
 * más trae (un archivo puede traer k iguales; dos archivos, no). Para el cuadre: una cuenta con repetidos no cuadra.
 */
export function repetidosEntreArchivos(lineas: readonly RenglonDeArchivo[]): { renglones: number; importe: number } {
  const porHuella = new Map<string, Map<string, number>>();
  const importe = new Map<string, number>();
  for (const l of lineas) {
    const m = porHuella.get(l.huella) ?? new Map<string, number>();
    m.set(l.archivo, (m.get(l.archivo) ?? 0) + 1);
    porHuella.set(l.huella, m);
    importe.set(l.huella, l.importe_centavos);
  }
  let renglones = 0, centavosRep = 0;
  porHuella.forEach((m, h) => {
    const cuentas = Array.from(m.values());
    const sobran = cuentas.reduce((a, b) => a + b, 0) - Math.max(...cuentas);
    if (sobran > 0 && importe.get(h)) { renglones += sobran; centavosRep += sobran * (importe.get(h) ?? 0); }
  });
  return { renglones, importe: centavosRep / 100 };
}
