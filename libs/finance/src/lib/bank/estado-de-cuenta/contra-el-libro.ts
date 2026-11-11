import { cierreDelDia } from './saldo-del-libro';
import { MapaDeSucursal, type LlaveDeSucursal } from './sucursal';

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
 * Lo mismo del lado del libro (2026-11-10: el libro se subió el 9-nov a las 17:23 con 1 de los 14
 * movimientos de BTE 7133 de ese día): su ÚLTIMO día, si sólo le faltan renglones y no le sobra
 * ninguno, queda `sin_libro` con `libro_a_medias` hasta que el libro traiga un día posterior.
 *
 * ⚠️ El cierre no siempre se puede afirmar: BBVA asienta a veces un cargo con la fecha de un día y
 * antes que los del día anterior (5712, 3-nov), y la cadena del día tiene dos «finales». Entonces el
 * día cuadra sólo si, además de casar todo, los SALDOS de todos sus renglones son los mismos de los
 * dos lados (`cuadre_por: 'saldos'`), que es más exigente que comparar un cierre.
 */
export interface RenglonComparable {
  id: string;
  fecha: string; // YYYY-MM-DD
  amount_in: number | string;
  amount_out: number | string;
  running_balance: number | string | null;
  concepto?: string | null;
  /** `[CB.61]` Sólo del libro: la categoría que tiene hoy y el documento de Kepler con que casó. */
  categoria?: string | null;
  doc_tipo?: string | null;
  entidad?: string | null;
  /** `[CB.61]` Banco: la referencia del renglón. Libro: su S (unidad de negocio). */
  referencia?: string | null;
  sucursal?: string | null;
}

/** `[CB.61]` Un movimiento pareado cuya sucursal deducida sin el libro no es la S del libro. */
export interface SucursalDistinta {
  fecha: string; lado: 'entra' | 'sale'; importe: number; concepto: string | null;
  banco: string; por: LlaveDeSucursal; libro: string;
}

/**
 * `[CB.61]` La sucursal sin el libro contra la S del libro. Se deduce de lo aprendido en días ANTERIORES de
 * la misma cuenta (ver `sucursal.ts`). `sin_senal`: el libro tiene S y ninguna llave pura la da.
 */
export interface SucursalesContraElLibro {
  con_sucursal_libro: number; deducidas: number; coinciden: number; sin_senal: number;
  distintas: SucursalDistinta[];
}

/**
 * `[CB.61]` Clasifica el renglón del banco sin M/C. Recibe su par del libro sólo para tomar el documento
 * de Kepler con que casó ese mismo movimiento (mientras la descarga no pase por el motor), nunca su categoría.
 */
export type ClasificarSinLibro = (banco: RenglonComparable, par: RenglonComparable) => { categoria: string; por: string | null };

/** `[CB.61]` Un movimiento pareado cuya categoría sin el libro no es la del libro. */
export interface CategoriaDistinta {
  fecha: string; lado: 'entra' | 'sale'; importe: number; concepto: string | null;
  banco: string; por: string | null; libro: string;
}

/**
 * `[CB.61]` La categoría sin el libro contra la del libro, en cada movimiento pareado.
 * `sin_categoria`: el libro la tiene y la sombra no. `libro_sin_categoria`: al revés.
 */
export interface CategoriasContraElLibro {
  pareados: number; coinciden: number; difieren: number; sin_categoria: number; libro_sin_categoria: number;
  distintas: CategoriaDistinta[];
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
  /** Último día del libro y sólo le faltan renglones: el libro se subió antes de cerrarlo. */
  libro_a_medias: boolean;
  /** Si cuadra: por el cierre del día, o (cierre indeterminado) porque todos los saldos coinciden. */
  cuadre_por: 'cierre' | 'saldos' | null;
  solo_banco: SueltoDelDia[];
  solo_libro: SueltoDelDia[];
}

export interface CuentaContraElLibro {
  desde: string | null;
  hasta: string | null;
  dias: DiaContraElLibro[];
  resumen: { cuadra: number; difiere: number; sin_libro: number; abierto: number; solo_banco: number; solo_libro: number; monto_solo_banco: number; monto_solo_libro: number };
  categorias: CategoriasContraElLibro;
  sucursales: SucursalesContraElLibro;
  /** `[CB.60b]` ¿Puede la cuenta dejar el libro? (Edgar, 2026-11-11: 10 días hábiles seguidos que cuadran.) */
  listo_para_banco: ListoParaBanco;
  /** Renglones del banco en $0.00 que no se comparan (BanBajío lista la comisión exenta de cada SPEI). */
  renglones_en_cero: number;
}

const VENTANA_DIAS = 3;
const centavos = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100);
const lado = (r: RenglonComparable): 'entra' | 'sale' => (centavos(r.amount_out) > 0 ? 'sale' : 'entra');
const llave = (r: RenglonComparable) => `${lado(r)}|${lado(r) === 'sale' ? centavos(r.amount_out) : centavos(r.amount_in)}`;
const diasEntre = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000));
const sumarDias = (f: string, n: number) => new Date(Date.parse(`${f}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** Los saldos de todos los renglones del día, como conjunto, son los mismos en los dos lados. */
function mismosSaldos(a: readonly RenglonComparable[], b: readonly RenglonComparable[]): boolean {
  const saldos = (rs: readonly RenglonComparable[]) => rs.map((r) => (r.running_balance === null || r.running_balance === undefined ? null : centavos(r.running_balance)));
  const x = saldos(a), y = saldos(b);
  if (!x.length || x.length !== y.length || x.includes(null) || y.includes(null)) return false;
  const ordena = (v: (number | null)[]) => (v as number[]).slice().sort((p, q) => p - q).join(',');
  return ordena(x) === ordena(y);
}
const suelto = (r: RenglonComparable): SueltoDelDia => ({
  id: r.id, fecha: r.fecha, lado: lado(r),
  importe: (lado(r) === 'sale' ? centavos(r.amount_out) : centavos(r.amount_in)) / 100, concepto: r.concepto ?? null,
});

/**
 * Compara UNA cuenta. `libro` puede traer días fuera del rango del banco (la ventana de ±3 los
 * necesita); sólo se juzgan los días en que hay banco.
 */
/** `[CB.60b]` Días hábiles SEGUIDOS que cuadran para poder usar el banco (decisión firmada por Edgar, 2026-11-11). */
export const DIAS_PARA_USAR_EL_BANCO = 10;

/**
 * `[CB.60b]` La racha de días que cuadran que termina en el último día juzgado. Al final se saltan el día
 * `abierto` del banco y los días a los que el libro todavía no llega (`sin_libro`); a la mitad, cualquier día
 * que no cuadra (difiere o sin libro) corta la racha: un día que no se pudo comparar no se cuenta a favor.
 * `desde` es el día siguiente al último que cuadra: ahí empezaría a mandar el banco, sin tocar nada que el
 * libro ya tenga cerrado.
 */
export interface ListoParaBanco { dias_seguidos: number; cumple: boolean; ultimo_que_cuadra: string | null; desde: string | null }

export function listoParaBanco(dias: readonly DiaContraElLibro[]): ListoParaBanco {
  let i = dias.length - 1;
  while (i >= 0 && (dias[i].veredicto === 'abierto' || dias[i].veredicto === 'sin_libro')) i--;
  let n = 0;
  const ultimo = i >= 0 && dias[i].veredicto === 'cuadra' ? dias[i].fecha : null;
  while (i >= 0 && dias[i].veredicto === 'cuadra') { n++; i--; }
  return { dias_seguidos: n, cumple: n >= DIAS_PARA_USAR_EL_BANCO, ultimo_que_cuadra: ultimo, desde: ultimo ? sumarDias(ultimo, 1) : null };
}

/** `mapa`: si se pasa, la sucursal se aprende ahí (para guardar el catálogo al usar el banco). */
export function compararContraElLibro(bancoTodo: readonly RenglonComparable[], libroTodo: readonly RenglonComparable[], clasificar?: ClasificarSinLibro, mapa = new MapaDeSucursal()): CuentaContraElLibro {
  // Un renglón en $0.00 no mueve dinero: no se busca en el libro ni entra a la cadena de saldos (repite el
  // saldo y deja el cierre del día sin afirmar). Se declara cuántos hubo (BB 4166, 2026-11-10: 6).
  const enCero = (r: RenglonComparable) => centavos(r.amount_in) === 0 && centavos(r.amount_out) === 0;
  const banco = bancoTodo.filter((r) => !enCero(r));
  const libro = libroTodo.filter((r) => !enCero(r));
  const diasBanco = Array.from(new Set(banco.map((b) => b.fecha))).sort();
  const ultimoDia = diasBanco[diasBanco.length - 1] ?? null;
  const pareado = new Set<string>(); // ids de los dos lados ya usados
  const parDe = new Map<string, RenglonComparable>(); // id del banco → su renglón del libro
  const fechaDistinta = new Map<string, number>(); // día del banco → pares con otro día

  // Pase 1: mismo día, mismo lado, mismo importe.
  const libroPorDiaLlave = new Map<string, RenglonComparable[]>();
  for (const l of libro) {
    const k = `${l.fecha}|${llave(l)}`;
    (libroPorDiaLlave.get(k) || libroPorDiaLlave.set(k, []).get(k)!).push(l);
  }
  for (const b of banco) {
    const l = (libroPorDiaLlave.get(`${b.fecha}|${llave(b)}`) || []).find((x) => !pareado.has(x.id));
    if (l) { pareado.add(b.id); pareado.add(l.id); parDe.set(b.id, l); }
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
      pareado.add(b.id); pareado.add(mejor.id); parDe.set(b.id, mejor);
      fechaDistinta.set(b.fecha, (fechaDistinta.get(b.fecha) ?? 0) + 1);
    }
  }

  // Último día del libro. Las fechas absurdas (año mal capturado: 2027 en BTE 7744, CB.UI.9) no cuentan.
  const tope = ultimoDia ? sumarDias(ultimoDia, 31) : null;
  const ultimoDelLibro = libro.map((l) => l.fecha).filter((f) => !tope || f <= tope).sort().pop() ?? null;

  const resumen = { cuadra: 0, difiere: 0, sin_libro: 0, abierto: 0, solo_banco: 0, solo_libro: 0, monto_solo_banco: 0, monto_solo_libro: 0 };
  const dias: DiaContraElLibro[] = diasBanco.map((fecha) => {
    const delBanco = banco.filter((b) => b.fecha === fecha);
    const delLibro = libro.filter((l) => l.fecha === fecha);
    const soloBanco = delBanco.filter((b) => !pareado.has(b.id)).map(suelto);
    const soloLibro = delLibro.filter((l) => !pareado.has(l.id)).map(suelto);
    const cierreBanco = cierreDelDia(delBanco);
    const cierreLibro = delLibro.length ? cierreDelDia(delLibro) : null;
    const libroAMedias = delLibro.length > 0 && fecha === ultimoDelLibro && soloBanco.length > 0 && !soloLibro.length;
    const todoCasa = !soloBanco.length && !soloLibro.length;
    const cuadrePor: DiaContraElLibro['cuadre_por'] = !todoCasa ? null
      : cierreBanco !== null && cierreBanco === cierreLibro ? 'cierre'
      : (cierreBanco === null || cierreLibro === null) && mismosSaldos(delBanco, delLibro) ? 'saldos'
      : null;
    const veredicto: VeredictoDelDia = fecha === ultimoDia ? 'abierto'
      : !delLibro.length || libroAMedias ? 'sin_libro'
      : cuadrePor ? 'cuadra'
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
      cierre_banco: cierreBanco, cierre_libro: cierreLibro, libro_a_medias: libroAMedias,
      cuadre_por: veredicto === 'cuadra' ? cuadrePor : null, solo_banco: soloBanco, solo_libro: soloLibro,
    };
  });
  resumen.monto_solo_banco = Math.round(resumen.monto_solo_banco * 100) / 100;
  resumen.monto_solo_libro = Math.round(resumen.monto_solo_libro * 100) / 100;

  // [CB.61] Categoría: todo par cuenta, también el del día abierto (lo incompleto ahí es el saldo, no el par).
  const categorias: CategoriasContraElLibro = { pareados: 0, coinciden: 0, difieren: 0, sin_categoria: 0, libro_sin_categoria: 0, distintas: [] };
  const conCat = (c: string | null | undefined) => (c && c !== 'sin_clasificar' ? c : null);
  for (const b of banco) {
    const l = parDe.get(b.id);
    if (!l || !clasificar) continue;
    categorias.pareados++;
    const sombra = clasificar(b, l);
    const cb = conCat(sombra.categoria), cl = conCat(l.categoria);
    if (cb === cl) { categorias.coinciden++; continue; }
    if (!cl) { categorias.libro_sin_categoria++; continue; }
    if (!cb) categorias.sin_categoria++; else categorias.difieren++;
    const s = suelto(b);
    categorias.distintas.push({ fecha: s.fecha, lado: s.lado, importe: s.importe, concepto: s.concepto, banco: cb ?? 'sin_clasificar', por: sombra.por, libro: cl });
  }
  // [CB.61] Sucursal: cada día se deduce con lo aprendido de los días ANTERIORES y después se aprende el día.
  const sucursales: SucursalesContraElLibro = { con_sucursal_libro: 0, deducidas: 0, coinciden: 0, sin_senal: 0, distintas: [] };
  const sLibro = (l: RenglonComparable) => String(l.sucursal ?? '').trim() || null;
  const paraSucursal = (b: RenglonComparable, l: RenglonComparable) =>
    ({ amount_in: b.amount_in, concepto: b.concepto, referencia: b.referencia });
  for (const fecha of diasBanco) {
    const pares = banco.filter((b) => b.fecha === fecha && parDe.has(b.id)).map((b) => [b, parDe.get(b.id)!] as const);
    for (const [b, l] of pares) {
      const s = sLibro(l);
      if (!s) continue;
      sucursales.con_sucursal_libro++;
      const d = mapa.deducir(paraSucursal(b, l));
      if (!d) { sucursales.sin_senal++; continue; }
      sucursales.deducidas++;
      if (d.sucursal === s) { sucursales.coinciden++; continue; }
      const x = suelto(b);
      sucursales.distintas.push({ fecha: x.fecha, lado: x.lado, importe: x.importe, concepto: x.concepto, banco: d.sucursal, por: d.por, libro: s });
    }
    for (const [b, l] of pares) { const s = sLibro(l); if (s) mapa.aprender(paraSucursal(b, l), s); }
  }
  return { desde: diasBanco[0] ?? null, hasta: ultimoDia, dias, resumen, categorias, sucursales, listo_para_banco: listoParaBanco(dias), renglones_en_cero: bancoTodo.length - banco.length };
}
