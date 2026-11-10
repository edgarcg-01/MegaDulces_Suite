import { cierreDelDia } from './saldo-del-libro';

/**
 * `[CB.60]` La descarga del banco contra el libro «CUENTAS», cuenta por cuenta y día por día.
 *
 * Es la compuerta de D2 (Edgar, 2026-11-09): el libro se apaga **cuenta por cuenta** cuando cuadra
 * con el banco. Cuadrar un día exige las dos cosas: cada movimiento del banco tiene su renglón en el
 * libro (mismo lado, mismo importe al centavo) y el saldo con que cierra el día es el mismo. Sólo el
 * importe no basta —dos comisiones de $3.51 se intercambian—, y sólo el cierre tampoco —dos errores
 * se compensan—.
 *
 * Lo que no casa el mismo día se busca a ±3 días (mismo lado e importe): el libro a veces anota el
 * movimiento el día en que se capturó y no el del banco. Ese par cuenta, pero declarado como
 * «fecha distinta», porque el saldo de esos días ya no puede coincidir.
 *
 * ⚠️ El último día de la descarga puede estar a medias (Banorte se bajó a las 11:54): mientras no
 * haya un renglón del banco de un día POSTERIOR, ese día queda `abierto` y no se cuenta en contra.
 */
export interface RenglonComparable {
  id: string;
  fecha: string; // YYYY-MM-DD
  amount_in: number | string;
  amount_out: number | string;
  running_balance: number | string | null;
  concepto?: string | null;
}

export type VeredictoDelDia = 'cuadra' | 'difiere' | 'sin_libro' | 'abierto';

export interface SueltoDelDia { id: string; fecha: string; lado: 'entra' | 'sale'; importe: number; concepto: string | null }

export interface DiaContraElLibro {
  fecha: string;
  veredicto: VeredictoDelDia;
  movimientos_banco: number;
  renglones_libro: number;
  pareados: number;
  /** Pareados con un renglón del libro de OTRO día (±3). */
  fecha_distinta: number;
  cierre_banco: number | null;
  cierre_libro: number | null;
  solo_banco: SueltoDelDia[];
  solo_libro: SueltoDelDia[];
}

export interface CuentaContraElLibro {
  desde: string | null;
  hasta: string | null;
  dias: DiaContraElLibro[];
  resumen: { cuadra: number; difiere: number; sin_libro: number; abierto: number; solo_banco: number; solo_libro: number; monto_solo_banco: number; monto_solo_libro: number };
}

const VENTANA_DIAS = 3;
const centavos = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100);
const lado = (r: RenglonComparable): 'entra' | 'sale' => (centavos(r.amount_out) > 0 ? 'sale' : 'entra');
const llave = (r: RenglonComparable) => `${lado(r)}|${lado(r) === 'sale' ? centavos(r.amount_out) : centavos(r.amount_in)}`;
const diasEntre = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000));
const suelto = (r: RenglonComparable): SueltoDelDia => ({
  id: r.id, fecha: r.fecha, lado: lado(r),
  importe: (lado(r) === 'sale' ? centavos(r.amount_out) : centavos(r.amount_in)) / 100, concepto: r.concepto ?? null,
});

/**
 * Compara UNA cuenta. `libro` puede traer días fuera del rango del banco (la ventana de ±3 los
 * necesita); sólo se juzgan los días en que hay banco.
 */
export function compararContraElLibro(banco: readonly RenglonComparable[], libro: readonly RenglonComparable[]): CuentaContraElLibro {
  const diasBanco = Array.from(new Set(banco.map((b) => b.fecha))).sort();
  const ultimoDia = diasBanco[diasBanco.length - 1] ?? null;
  const pareado = new Set<string>(); // ids de los dos lados ya usados
  const fechaDistinta = new Map<string, number>(); // día del banco → pares con otro día

  // Pase 1: mismo día, mismo lado, mismo importe.
  const libroPorDiaLlave = new Map<string, RenglonComparable[]>();
  for (const l of libro) {
    const k = `${l.fecha}|${llave(l)}`;
    (libroPorDiaLlave.get(k) || libroPorDiaLlave.set(k, []).get(k)!).push(l);
  }
  for (const b of banco) {
    const l = (libroPorDiaLlave.get(`${b.fecha}|${llave(b)}`) || []).find((x) => !pareado.has(x.id));
    if (l) { pareado.add(b.id); pareado.add(l.id); }
  }
  // Pase 2: lo que sobró, contra el libro de ±3 días (el más cercano).
  const libroPorLlave = new Map<string, RenglonComparable[]>();
  for (const l of libro) (libroPorLlave.get(llave(l)) || libroPorLlave.set(llave(l), []).get(llave(l))!).push(l);
  for (const b of banco) {
    if (pareado.has(b.id)) continue;
    let mejor: RenglonComparable | null = null;
    for (const l of libroPorLlave.get(llave(b)) || []) {
      if (pareado.has(l.id)) continue;
      const d = diasEntre(b.fecha, l.fecha);
      if (d <= VENTANA_DIAS && (!mejor || d < diasEntre(b.fecha, mejor.fecha))) mejor = l;
    }
    if (mejor) {
      pareado.add(b.id); pareado.add(mejor.id);
      fechaDistinta.set(b.fecha, (fechaDistinta.get(b.fecha) ?? 0) + 1);
    }
  }

  const resumen = { cuadra: 0, difiere: 0, sin_libro: 0, abierto: 0, solo_banco: 0, solo_libro: 0, monto_solo_banco: 0, monto_solo_libro: 0 };
  const dias: DiaContraElLibro[] = diasBanco.map((fecha) => {
    const delBanco = banco.filter((b) => b.fecha === fecha);
    const delLibro = libro.filter((l) => l.fecha === fecha);
    const soloBanco = delBanco.filter((b) => !pareado.has(b.id)).map(suelto);
    const soloLibro = delLibro.filter((l) => !pareado.has(l.id)).map(suelto);
    const cierreBanco = cierreDelDia(delBanco);
    const cierreLibro = delLibro.length ? cierreDelDia(delLibro) : null;
    const veredicto: VeredictoDelDia = fecha === ultimoDia ? 'abierto'
      : !delLibro.length ? 'sin_libro'
      : !soloBanco.length && !soloLibro.length && cierreBanco !== null && cierreBanco === cierreLibro ? 'cuadra'
      : 'difiere';
    resumen[veredicto]++;
    if (veredicto !== 'abierto') {
      resumen.solo_banco += soloBanco.length; resumen.solo_libro += soloLibro.length;
      resumen.monto_solo_banco += soloBanco.reduce((s, x) => s + x.importe, 0);
      resumen.monto_solo_libro += soloLibro.reduce((s, x) => s + x.importe, 0);
    }
    return {
      fecha, veredicto, movimientos_banco: delBanco.length, renglones_libro: delLibro.length,
      pareados: delBanco.length - soloBanco.length, fecha_distinta: fechaDistinta.get(fecha) ?? 0,
      cierre_banco: cierreBanco, cierre_libro: cierreLibro, solo_banco: soloBanco, solo_libro: soloLibro,
    };
  });
  resumen.monto_solo_banco = Math.round(resumen.monto_solo_banco * 100) / 100;
  resumen.monto_solo_libro = Math.round(resumen.monto_solo_libro * 100) / 100;
  return { desde: diasBanco[0] ?? null, hasta: ultimoDia, dias, resumen };
}
