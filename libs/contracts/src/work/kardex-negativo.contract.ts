/**
 * `[MX.1.9]` — **El kardex de un producto en negativo y las pistas que deja: con qué investiga Prevención.**
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-11-03: «¿qué herramientas le damos al usuario para encontrar ese error en saldos
 * negativos?». La bandeja de MX.3.3 dice QUÉ está en negativo; el porqué sólo el dato lo prueba en
 * 14–20 de ~3,030 casos (vale sin orden de entrada). Para el resto, la persona necesita ver el saldo
 * día por día, el día en que cruzó a negativo y qué documento lo movió.
 *
 * ── De dónde sale y cuánto se le cree (medido 2026-11-03, prod, sólo lectura) ────────────────
 *  · Los renglones de `kepler_ods.kdm2` de los documentos que afectan inventario (`kdmm.c8 = 'S'`).
 *  · Paridad: la suma del kardex = la existencia de Kepler (`kdil c4+c8−c9`) en **79 de 80** negativos
 *    al azar (todas las sucursales). El que no cuadra se DECLARA ({@link KardexNegativoResponse.cuadra}):
 *    con el kardex roto, el día de cruce y las pistas no se calculan — se dibujaría un saldo falso.
 *  · Tiempo: p50 59 ms, p95 289 ms (cliente, 80 consultas).
 *
 * ── Qué es una pista y qué NO ───────────────────────────────────────────────────────────────
 * Evidencia que el dato muestra, nunca un veredicto: la causa la escribe Prevención en el motivo.
 * Cada pista se calcula SÓLO si su dirección explica un negativo (una venta que descontó de más; una
 * entrada que sumó de menos) — una anomalía que infla la existencia no explica nada aquí.
 *
 * ⚠️ Deuda con nombre (no se adivina): «traspaso en camino» por producto (la recepción U-A-50 apunta
 * a su embarque con el folio en blanco: `c19/c20/c21` = D/41/2, `c22 = ''`, 8 Esquinas 0000329) y
 * «clave hermana con sobrante» (sin medir si acierta). Ver FASE_MX, MX.1.10.
 */

import { diaCorto } from '../finance/dia-corto.contract';

/** Para qué sirve el documento, en llano. Sale del tipo de Kepler (`género-naturaleza-tipo`). */
export type FamiliaMovimiento =
  | 'compra' | 'traspaso_entra' | 'devolucion_cliente' | 'conteo' | 'carga_inicial' | 'otra_entrada'
  | 'venta' | 'embarque' | 'traspaso_sale' | 'devolucion_proveedor' | 'otra_salida';

const FAMILIA_FIJA: Readonly<Record<string, FamiliaMovimiento>> = {
  'N-A-6': 'traspaso_entra', 'N-A-25': 'traspaso_entra', 'U-A-50': 'traspaso_entra',
  'U-A-10': 'devolucion_cliente', 'U-A-20': 'devolucion_cliente', 'U-A-21': 'devolucion_cliente', 'U-A-25': 'devolucion_cliente',
  'N-A-30': 'conteo', 'N-A-31': 'conteo', 'N-A-32': 'conteo', 'N-D-30': 'conteo', 'N-D-32': 'conteo',
  'N-A-20': 'carga_inicial',
  'U-D-10': 'venta', 'U-D-9': 'venta', 'U-D-45': 'venta',
  'U-D-41': 'embarque',
  'N-D-6': 'traspaso_sale', 'N-D-25': 'traspaso_sale',
  'X-D-30': 'devolucion_proveedor', 'X-D-40': 'devolucion_proveedor',
};

/** `doc` = `género-naturaleza-tipo` de Kepler (p. ej. `U-D-10`). Lista medida en `kdmm` el 2026-11-03. */
export function familiaDeDocumento(doc: string): FamiliaMovimiento {
  const fija = FAMILIA_FIJA[doc];
  if (fija) return fija;
  if (doc.startsWith('X-A-')) return 'compra';
  return doc.split('-')[1] === 'A' ? 'otra_entrada' : 'otra_salida';
}

/** Tickets de mostrador: se agrupan por día y caja (cientos de tickets no caben en un panel). */
export const DOCS_AGRUPADOS_POR_CAJA: readonly string[] = ['U-D-10', 'U-D-9'];

/** Un renglón agregado del kardex, como lo entrega la consulta. */
export interface MovimientoKardex {
  /** `YYYY-MM-DD`. */
  dia: string;
  /** `género-naturaleza-tipo` (`X-A-40`). */
  doc: string;
  /** Subtipo de Kepler; en tickets de mostrador es la CAJA. */
  sub: number;
  /** Nombre del documento en el catálogo de Kepler (`kdmm`). */
  nombre: string;
  /** `null` en tickets de mostrador (agrupados por día y caja). */
  folio: string | null;
  documentos: number;
  /** Con signo: + entra, − sale. En la unidad base de Kepler (la de la existencia). */
  piezas: number;
  importe: number | null;
  unidad: string | null;
  factor: number | null;
}

export interface RenglonKardex extends MovimientoKardex {
  familia: FamiliaMovimiento;
  /** Saldo después de este renglón. */
  saldo: number;
}

export type TipoPista = 'entrada_tardia' | 'conteo' | 'sin_conteo' | 'unidad';

export interface PistaNegativo {
  tipo: TipoPista;
  /** La evidencia en una frase. */
  texto: string;
  dia: string | null;
  folio: string | null;
}

export interface SalidaDesdeCruce {
  /** Nombre del documento (`Ticket Contado Caja 2`, `Embarque Sucursal`). */
  nombre: string;
  familia: FamiliaMovimiento;
  piezas: number;
  importe: number;
  documentos: number;
}

export interface AnalisisKardex {
  cuadra: boolean;
  /** Kardex − Kepler; `0` si cuadra. */
  diferencia: number;
  /** Primer día del episodio negativo ACTUAL; `null` si no está en negativo o no cuadra. */
  cruce: { dia: string; saldo_antes: number } | null;
  /** Lo que salió desde el cruce, por documento/caja, de más a menos piezas. */
  salidas_desde_cruce: SalidaDesdeCruce[];
  pistas: PistaNegativo[];
  renglones: RenglonKardex[];
}

export interface KardexNegativoResponse extends AnalisisKardex {
  warehouse_id: string;
  sucursal: string;
  sku: string;
  producto: string | null;
  existencia_kepler: number;
  /** Primer movimiento que el ODS tiene de este producto en esta sucursal; `null` = ninguno. */
  desde: string | null;
  /** Saldo antes del primer renglón publicado (los anteriores se omiten por tamaño). */
  saldo_inicial: number;
  renglones_omitidos: number;
}

/** Holgura para decir «en negativo» o «cuadra» (Kepler guarda fracciones de pieza). */
const EPS = 0.001;
/** Una línea desentona si su precio por pieza difiere tantas veces de la mediana de su familia. */
export const VECES_UNIDAD_DESENTONA = 3;
/** Mínimo de renglones con importe en la familia para que la mediana signifique algo. */
const MIN_MUESTRA_UNIDAD = 5;
/** Renglones de contexto antes del cruce, y tope de renglones publicados. */
const CONTEXTO_ANTES_DEL_CRUCE = 5;
export const TOPE_RENGLONES_KARDEX = 150;

const ENTRADAS_DE_MERCANCIA: readonly FamiliaMovimiento[] = ['compra', 'traspaso_entra'];

function r2(x: number): number { return Math.round(x * 100) / 100; }
function pz(x: number): string { return `${Number(Math.abs(x).toFixed(2)).toLocaleString('es-MX')} pz`; }
function dineroCorto(x: number): string {
  return x.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
}
function conFolio(r: Pick<MovimientoKardex, 'nombre' | 'folio'>): string {
  return r.folio ? `${r.nombre} ${r.folio}` : r.nombre;
}
function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Saldo corrido, día de cruce y pistas. `movs` llega ordenado por día con las entradas antes que las
 * salidas del mismo día (así el cruce nunca se fecha antes de tiempo por el orden dentro del día).
 */
export function analizarKardex(movs: readonly MovimientoKardex[], existenciaKepler: number): AnalisisKardex {
  let saldo = 0;
  const renglones: RenglonKardex[] = movs.map((m) => {
    saldo = r2(saldo + m.piezas);
    return { ...m, familia: familiaDeDocumento(m.doc), saldo };
  });
  const diferencia = r2(saldo - existenciaKepler);
  const cuadra = Math.abs(diferencia) < 0.01;
  if (!cuadra) return { cuadra, diferencia, cruce: null, salidas_desde_cruce: [], pistas: [], renglones };

  // El episodio actual: desde el final hacia atrás mientras el saldo siga en negativo.
  let iCruce = -1;
  if (saldo < -EPS) {
    iCruce = renglones.length - 1;
    while (iCruce > 0 && renglones[iCruce - 1].saldo < -EPS) iCruce--;
  }
  const cruce = iCruce >= 0
    ? { dia: renglones[iCruce].dia, saldo_antes: iCruce > 0 ? renglones[iCruce - 1].saldo : 0 }
    : null;

  const salidas = new Map<string, SalidaDesdeCruce>();
  if (iCruce >= 0) {
    for (const r of renglones.slice(iCruce)) {
      if (r.piezas >= 0) continue;
      const s = salidas.get(r.nombre) ?? { nombre: r.nombre, familia: r.familia, piezas: 0, importe: 0, documentos: 0 };
      s.piezas = r2(s.piezas - r.piezas);
      s.importe = r2(s.importe + (r.importe ?? 0));
      s.documentos += r.documentos;
      salidas.set(r.nombre, s);
    }
  }
  const salidas_desde_cruce = [...salidas.values()].sort((a, b) => b.piezas - a.piezas || a.nombre.localeCompare(b.nombre));

  return {
    cuadra, diferencia, cruce, salidas_desde_cruce,
    // la unidad primero: cuando dispara, suele explicar el negativo entero (control: 44320 en 8 Esquinas)
    pistas: [...pistaUnidad(renglones, existenciaKepler), ...pistaEntradaTardia(renglones), ...pistaConteo(renglones, cruce)],
    renglones,
  };
}

/**
 * Episodios PASADOS que una entrada de mercancía cerró: se vendió sin existencia y la entrada se
 * capturó después. Es el patrón de 17210 (cayó el 17-sep, la orden del 7-oct lo regresó a cero).
 */
function pistaEntradaTardia(rs: readonly RenglonKardex[]): PistaNegativo[] {
  const cerrados: { desde: string; cierre: RenglonKardex }[] = [];
  let desde: string | null = null;
  for (let i = 0; i < rs.length; i++) {
    const antes = i > 0 ? rs[i - 1].saldo : 0;
    if (antes >= -EPS && rs[i].saldo < -EPS) desde = rs[i].dia;
    if (antes < -EPS && rs[i].saldo >= -EPS) {
      if (desde && ENTRADAS_DE_MERCANCIA.includes(rs[i].familia)) cerrados.push({ desde, cierre: rs[i] });
      desde = null;
    }
  }
  if (!cerrados.length) return [];
  const u = cerrados[cerrados.length - 1];
  const veces = cerrados.length === 1 ? 'Ya había pasado una vez' : `Ya había pasado ${cerrados.length} veces`;
  const ultima = cerrados.length === 1 ? 'Fue' : 'La última,';
  return [{
    tipo: 'entrada_tardia',
    texto: `${veces}: siguió vendiéndose en negativo hasta que entró mercancía. ${ultima} del ${diaCorto(u.desde)} al ${diaCorto(u.cierre.dia)}: ${conFolio(u.cierre)} (+${pz(u.cierre.piezas)}) lo dejó en ${pz(u.cierre.saldo)}.`,
    dia: u.cierre.dia, folio: u.cierre.folio,
  }];
}

/** El último conteo físico: si cayó a negativo DESPUÉS, la diferencia está en lo capturado desde entonces. */
function pistaConteo(rs: readonly RenglonKardex[], cruce: AnalisisKardex['cruce']): PistaNegativo[] {
  let u: RenglonKardex | null = null;
  for (const r of rs) if (r.familia === 'conteo') u = r;
  if (!u) {
    if (!cruce || !rs.length) return [];
    return [{ tipo: 'sin_conteo', texto: `Ningún conteo físico en Kepler en lo registrado (desde ${diaCorto(rs[0].dia)}): sólo contar dice cuánto hay de verdad.`, dia: null, folio: null }];
  }
  const ajuste = `${u.piezas >= 0 ? '+' : '−'}${pz(u.piezas)}`;
  if (cruce && u.dia < cruce.dia) {
    return [{ tipo: 'conteo', texto: `El último conteo fue el ${diaCorto(u.dia)} (ajustó ${ajuste}) y cayó a negativo el ${diaCorto(cruce.dia)}, después: la diferencia está en lo capturado desde el conteo.`, dia: u.dia, folio: u.folio }];
  }
  if (u.saldo < -EPS) {
    return [{ tipo: 'conteo', texto: `El conteo del ${diaCorto(u.dia)} (ajustó ${ajuste}) lo dejó en ${u.saldo < 0 ? '−' : ''}${pz(u.saldo)}: el conteo no lo corrigió.`, dia: u.dia, folio: u.folio }];
  }
  return [{ tipo: 'conteo', texto: `El último conteo fue el ${diaCorto(u.dia)} (ajustó ${ajuste}).`, dia: u.dia, folio: u.folio }];
}

/**
 * Una línea cuyo precio por pieza desentona {@link VECES_UNIDAD_DESENTONA} veces o más de la mediana
 * de su familia — típicamente una caja capturada como pieza. Sólo en la dirección que explica el
 * negativo: una SALIDA demasiado barata por pieza (descontó más piezas de las que cobró) o una
 * ENTRADA demasiado cara por pieza (sumó menos de las que se pagaron). Sólo después del último
 * conteo: un conteo vuelve a poner la verdad y borra el efecto de lo anterior.
 */
function pistaUnidad(rs: readonly RenglonKardex[], existencia: number): PistaNegativo[] {
  let desdeConteo = 0;
  rs.forEach((r, i) => { if (r.familia === 'conteo') desdeConteo = i + 1; });
  const conPrecio = rs.filter((r) => r.familia !== 'conteo' && (r.importe ?? 0) > 0 && Math.abs(r.piezas) > EPS);
  const porFamilia = new Map<FamiliaMovimiento, number[]>();
  for (const r of conPrecio) {
    const l = porFamilia.get(r.familia) ?? [];
    l.push((r.importe as number) / Math.abs(r.piezas));
    porFamilia.set(r.familia, l);
  }
  const med = new Map([...porFamilia].filter(([, l]) => l.length >= MIN_MUESTRA_UNIDAD).map(([f, l]) => [f, mediana(l)]));

  // Un factor mal puesto se repite en cada venta: se agrupa por familia × unidad × dirección.
  interface Grupo { familia: FamiliaMovimiento; sale: boolean; unidad: string; renglones: number; piezas: number; debio: number; importe: number; desde: string; hasta: string; folio: string | null }
  const grupos = new Map<string, Grupo>();
  for (const r of rs.slice(desdeConteo)) {
    const m = med.get(r.familia);
    if (!m || !(r.importe && r.importe > 0) || Math.abs(r.piezas) <= EPS) continue;
    const ppz = r.importe / Math.abs(r.piezas);
    const sale = r.piezas < 0;
    if (sale ? ppz * VECES_UNIDAD_DESENTONA > m : ppz < m * VECES_UNIDAD_DESENTONA) continue;
    const unidad = r.unidad ? `${r.unidad}${r.factor ? ` ×${r.factor}` : ''}` : 'sin unidad';
    const k = `${r.familia}|${unidad}|${sale}`;
    const g = grupos.get(k) ?? { familia: r.familia, sale, unidad, renglones: 0, piezas: 0, debio: 0, importe: 0, desde: r.dia, hasta: r.dia, folio: r.folio };
    g.renglones++; g.piezas += Math.abs(r.piezas); g.debio += r.importe / m; g.importe += r.importe; g.hasta = r.dia;
    grupos.set(k, g);
  }
  return [...grupos.values()].map((g) => {
    const cuando = g.desde === g.hasta ? `El ${diaCorto(g.desde)}` : `Del ${diaCorto(g.desde)} al ${diaCorto(g.hasta)}`;
    const cuantos = g.renglones === 1 ? `un renglón de ${ETIQUETA_FAMILIA[g.familia]}` : `${g.renglones} renglones de ${ETIQUETA_FAMILIA[g.familia]}`;
    const exceso = Math.abs(g.piezas - g.debio);
    const quedaria = r2(existencia + exceso);
    const cierre = quedaria >= -EPS ? ` Sin eso, la existencia quedaría en ${pz(quedaria)}.` : '';
    return {
      tipo: 'unidad' as const, dia: g.desde, folio: g.renglones === 1 ? g.folio : null,
      texto: g.sale
        ? `${cuando}, ${cuantos} en ${g.unidad} descontaron ${pz(g.piezas)} por ${dineroCorto(g.importe)}; a su precio de siempre eso son ${pz(g.debio)}. Si la unidad o el factor están mal, salieron ${pz(exceso)} de más.${cierre}`
        : `${cuando}, ${cuantos} en ${g.unidad} sumaron ${pz(g.piezas)} por ${dineroCorto(g.importe)}; a su costo de siempre eso son ${pz(g.debio)}. Si la unidad o el factor están mal, faltaron ${pz(exceso)} por entrar.${cierre}`,
    };
  });
}

export const ETIQUETA_FAMILIA: Readonly<Record<FamiliaMovimiento, string>> = {
  compra: 'compra', traspaso_entra: 'traspaso recibido', devolucion_cliente: 'devolución de cliente', conteo: 'conteo físico',
  carga_inicial: 'carga inicial', otra_entrada: 'otra entrada', venta: 'venta', embarque: 'embarque',
  traspaso_sale: 'traspaso enviado', devolucion_proveedor: 'devolución a proveedor', otra_salida: 'otra salida',
};

/** Recorta lo publicado: un poco antes del cruce y hasta el final, con tope. */
export function recortarKardex(a: Pick<AnalisisKardex, 'renglones' | 'cruce'>): { renglones: RenglonKardex[]; saldo_inicial: number; omitidos: number } {
  const rs = a.renglones;
  let desde = Math.max(0, rs.length - 60);
  if (a.cruce) {
    // el episodio ACTUAL: el último arranque de una racha negativa
    let i = rs.length - 1;
    while (i > 0 && rs[i - 1].saldo < -EPS) i--;
    desde = Math.max(0, i - CONTEXTO_ANTES_DEL_CRUCE);
  }
  desde = Math.max(desde, rs.length - TOPE_RENGLONES_KARDEX);
  return { renglones: rs.slice(desde), saldo_inicial: desde > 0 ? rs[desde - 1].saldo : 0, omitidos: desde };
}
