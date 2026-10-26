/**
 * Compras › Catálogo › vista Detallado: lo que la pantalla dice en palabras, en funciones puras (sin Angular).
 * Las decisiones (veredicto, traspasos, estado de un lote, líderes) son del motor PF del servidor; aquí sólo se
 * redactan y se componen las cantidades en las unidades del producto (`unidades-composicion.ts`).
 *
 * Lo que no se midió se declara («Sin dato», «sin medir»): nunca un cero ni un verde.
 */
import type { CatalogoListaDetallada, ComprasProducto, FichaProducto, FiltroDetallado, FilaCatalogoDetallada } from './catalogo-productos.service';
import type { FlujoDetalle, LoteCaducidad, MargenesProducto, PlazaFlujo, VeredictoCompra } from './productos-flujo.service';
import { CantidadEnUnidad, UnidadFactor, componerEnUnidades } from './unidades-composicion';
import { nombrePropio } from './catalogo-proveedor';

// ─────────────────────────────── el menú «Mostrar» ───────────────────────────────

export interface OpcionDetallado { id: FiltroDetallado; label: string }
export interface GrupoDetallado { titulo: string; opciones: OpcionDetallado[] }

/** Agrupado como en la maqueta aprobada: qué hacer, qué cuidar hoy, y lo de catálogo (lo de Sencillo + sin proveedor). */
export const GRUPOS_DETALLADO: readonly GrupoDetallado[] = [
  { titulo: 'Qué hacer', opciones: [
    { id: 'comprar', label: 'Comprar' },
    { id: 'traspasar', label: 'Mover entre sucursales' },
    { id: 'esperar', label: 'Esperar' },
    { id: 'sobra', label: 'Le sobra' },
    { id: 'no_comprar', label: 'No comprar' },
  ] },
  { titulo: 'Para cuidar hoy', opciones: [
    { id: 'lideres_pendiente', label: 'Líderes con pendiente' },
    { id: 'no_se_venden', label: 'No se venden' },
    { id: 'caducidad', label: 'Por caducar o caducado' },
    { id: 'nuevos', label: 'Productos nuevos' },
  ] },
  { titulo: 'Catálogo', opciones: [
    { id: 'todos', label: 'Todos' },
    { id: 'varios_codigos', label: 'Con varios códigos' },
    { id: 'sin_codigo', label: 'Sin código de barras' },
    { id: 'sin_precio', label: 'Alguna unidad sin precio' },
    { id: 'sin_proveedor', label: 'Sin proveedor asignado' },
  ] },
];

export const OPCIONES_DETALLADO: readonly OpcionDetallado[] = GRUPOS_DETALLADO.flatMap((g) => g.opciones);
export const etiquetaFiltro = (id: FiltroDetallado) => OPCIONES_DETALLADO.find((o) => o.id === id)?.label ?? 'Todos';

const enteroFmt = new Intl.NumberFormat('es-MX');
/** El conteo de una opción: número, «sin medir» (null del servidor), o nada mientras no hay respuesta. */
export function conteoDetallado(l: Pick<CatalogoListaDetallada, 'conteos'> | null | undefined, id: FiltroDetallado): string {
  if (!l) return '';
  const v = l.conteos[id];
  return v === null || v === undefined ? 'sin medir' : enteroFmt.format(v);
}
/** Una opción sin medir no se puede elegir (filtrarla diría «ninguno» cuando no se sabe). */
export const noMedibleDetallado = (l: Pick<CatalogoListaDetallada, 'conteos'> | null | undefined, id: FiltroDetallado) =>
  !!l && (l.conteos[id] === null || l.conteos[id] === undefined);

// ─────────────────────────────── el renglón ───────────────────────────────

const dineroFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
export const dineroEntero = (v: number) => dineroFmt.format(Number(v));
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mesDe = (iso: string) => MESES[Number(iso.slice(5, 7)) - 1] ?? '';
const diaDe = (iso: string) => Number(iso.slice(8, 10));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const diaAnterior = (iso: string) => new Date(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);

/** La celda «Este mes»: monto, flecha con el % y su explicación en el title. */
export interface CeldaMes {
  texto: string;
  tipo: 'monto' | 'sin_venta' | 'sin_dato';
  variacion: { texto: string; tono: 'sube' | 'baja' | 'igual' } | null;
  titulo: string | null;
}

export function celdaMes(f: Pick<FilaCatalogoDetallada, 'mes' | 'mesAnterior' | 'variacion'>, periodos: CatalogoListaDetallada['venta']['periodos']): CeldaMes {
  if (f.mes === null) return { texto: 'Sin dato', tipo: 'sin_dato', variacion: null, titulo: 'No se pudo medir la venta del mes' };
  const base = periodos
    ? `Contra los mismos días de ${mesDe(periodos.prevIni)} (1 al ${diaDe(diaAnterior(periodos.prevFin))}): ${dineroEntero(f.mesAnterior ?? 0)}`
    : null;
  const v = f.variacion;
  const variacion = v === null ? null : {
    texto: `${v > 0 ? '▲' : v < 0 ? '▼' : '='} ${Math.abs(Math.round(v * 100))}%`,
    tono: (v > 0 ? 'sube' : v < 0 ? 'baja' : 'igual') as 'sube' | 'baja' | 'igual',
  };
  if (!f.mes) return { texto: 'Sin venta', tipo: 'sin_venta', variacion, titulo: base };
  return { texto: dineroEntero(f.mes), tipo: 'monto', variacion, titulo: base };
}

// ─────────────────────────────── la ficha ───────────────────────────────

/** Los factores de las unidades del producto (de la ficha de catálogo, los mismos de Sencillo). */
export const factoresDe = (f: Pick<FichaProducto, 'unidades'> | null | undefined): UnidadFactor[] =>
  (f?.unidades ?? []).map((u) => ({ unidad: u.unidad, factorBase: Number(u.factorBase) }));

/** «65 CJA 5 PAQ»; sin factores, la cifra en la unidad base que se pasa. Cero o nada: null (quien pinta lo dice). */
export function cantidadCompuesta(q: number | null | undefined, factores: UnidadFactor[], base: string): string | null {
  if (q === null || q === undefined || !Number.isFinite(Number(q)) || Number(q) === 0) return null;
  const partes: CantidadEnUnidad[] = componerEnUnidades(Number(q), factores);
  const n = (x: number) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(x);
  if (!partes.length) return `${n(Number(q))} ${base}`.trim();
  return partes.map((p) => `${n(p.cantidad)} ${p.unidad}`).join(' ');
}

export const VEREDICTO_ETIQUETA: Record<VeredictoCompra, string> = {
  comprar: 'Comprar', traspasar: 'Mover entre sucursales', esperar: 'Esperar', sobra: 'Le sobra',
  no_comprar: 'No comprar', sin_movimiento: 'Sin movimiento',
};

/** Las etiquetas de la ficha (las mismas del renglón). */
export interface EtiquetasProducto { lider: number | null; nuevo: string | null; caducidad: 'caducado' | 'pronto' | null }
export function etiquetasTexto(e: EtiquetasProducto | null | undefined): Array<{ clase: 'lider' | 'nuevo' | 'cad'; texto: string }> {
  if (!e) return [];
  const out: Array<{ clase: 'lider' | 'nuevo' | 'cad'; texto: string }> = [];
  if (e.lider !== null) out.push({ clase: 'lider', texto: `Líder #${e.lider}` });
  if (e.nuevo) out.push({ clase: 'nuevo', texto: e.nuevo });
  if (e.caducidad) out.push({ clase: 'cad', texto: e.caducidad === 'caducado' ? 'Caducado' : 'Caduca pronto' });
  return out;
}

/** Qué hacer: el veredicto del motor con su porqué y los traspasos en cajas/paquetes. */
export function queHacer(d: Pick<FlujoDetalle, 'resumen'>, factores: UnidadFactor[], base: string) {
  const c = d.resumen.compra;
  return {
    veredicto: c.veredicto,
    etiqueta: VEREDICTO_ETIQUETA[c.veredicto],
    titulo: c.titulo,
    motivos: c.motivos,
    traspasos: c.traspasos.map((t) => ({
      cantidad: cantidadCompuesta(t.cantidad, factores, base) ?? '0',
      desde: t.desde_nombre ? nombrePropio(t.desde_nombre) : `Sucursal ${t.desde}`,
      hacia: t.hacia_nombre ? nombrePropio(t.hacia_nombre) : `Sucursal ${t.hacia}`,
    })),
  };
}

export interface FilaSucursalDetallada {
  codigo: string;
  nombre: string;
  /** Monto con impuestos; null = sin venta (o sin dato si `vendidoMedido` es false). */
  monto: string | null;
  vendidoMedido: boolean;
  unidades: string | null;
  existencia: { tipo: 'sin_dato' | 'agotado' | 'cero' | 'cantidad'; texto: string };
  sinVender: string;
}

/** «Hoy vendió» / «1 día» / «45 días» / «Más de 120 días». */
export function sinVenderTexto(p: Pick<PlazaFlujo, 'dias_sin_venta'> | null | undefined, ventanaHistoria: number): string {
  if (!p || p.dias_sin_venta === null) return `Más de ${ventanaHistoria} días`;
  if (p.dias_sin_venta <= 0) return 'Hoy vendió';
  return p.dias_sin_venta === 1 ? '1 día' : `${p.dias_sin_venta} días`;
}

/**
 * Dónde se mueve y dónde se estancó: venta del mes y existencia de la ficha de catálogo (las mismas de
 * Sencillo), «Sin vender» del motor PF. Las sucursales que ni venden ni tienen ni el motor ve se omiten (no lo
 * manejan); las que el motor ve y la ficha no (el CEDIS) entran con lo del motor.
 */
export function sucursalesDetalladas(f: FichaProducto, d: Pick<FlujoDetalle, 'plazas' | 'criterio'> | null): FilaSucursalDetallada[] {
  const factores = factoresDe(f);
  const base = f.unidadBase ?? '';
  const pf = new Map((d?.plazas ?? []).map((p) => [p.plaza, p]));
  const ventana = d?.criterio.ventanaHistoria ?? 120;
  const existenciaDe = (q: number | null, vendio: boolean): FilaSucursalDetallada['existencia'] => {
    if (q === null) return { tipo: 'sin_dato', texto: 'Sin dato' };
    if (q === 0) return vendio ? { tipo: 'agotado', texto: 'Agotado' } : { tipo: 'cero', texto: `0 ${base}`.trim() };
    return { tipo: 'cantidad', texto: cantidadCompuesta(q, factores, base) ?? '' };
  };
  const filas: FilaSucursalDetallada[] = [];
  for (const s of f.sucursales ?? []) {
    const p = pf.get(s.codigo);
    const ex = s.existenciaBase === null || s.existenciaBase === undefined ? null : Number(s.existenciaBase);
    const vendidas = s.vendidoMes ? Number(s.vendidoMes.unidadesBase) : 0;
    const monto = s.vendidoMes && Number(s.vendidoMes.monto) ? dineroEntero(Number(s.vendidoMes.monto)) : null;
    const loManeja = !!monto || vendidas !== 0 || (ex !== null && ex !== 0) || (!!p && p.estado !== 'sin_movimiento');
    if (!loManeja && ex !== null) continue;
    filas.push({
      codigo: s.codigo,
      nombre: s.nombre ? nombrePropio(s.nombre) : `Sucursal ${s.codigo}`,
      monto,
      vendidoMedido: !!s.vendidoMes,
      unidades: cantidadCompuesta(vendidas, factores, base),
      existencia: existenciaDe(ex, vendidas > 0),
      sinVender: sinVenderTexto(p, ventana),
    });
  }
  const enFicha = new Set((f.sucursales ?? []).map((s) => s.codigo));
  for (const p of d?.plazas ?? []) {
    if (enFicha.has(p.plaza) || p.estado === 'sin_movimiento') continue;
    filas.push({
      codigo: p.plaza,
      nombre: p.nombre ? nombrePropio(p.nombre) : `Sucursal ${p.plaza}`,
      monto: p.mes ? dineroEntero(p.mes) : null,
      vendidoMedido: true,
      unidades: null,
      existencia: existenciaDe(p.existencia, p.mes > 0),
      sinVender: sinVenderTexto(p, ventana),
    });
  }
  return filas;
}

/** ¿Cómo va la venta este mes? En palabras y dos barras: para quien no lee gráficas. */
export interface ComoVa {
  tono: 'sube' | 'baja' | 'igual';
  flecha: '▲' | '▼' | '=';
  titulo: string;
  frase: string;
  /** El monto que se resalta dentro de la frase (diferencia), o null. */
  barras: Array<{ etiqueta: string; monto: string; pct: number; clase: 'act' | 'ant' }>;
}

export function comoVaLaVenta(mes: number, ant: number, variacion: number | null, p: { hoy: string; prevIni: string; prevFin: string }): ComoVa {
  const dia = diaDe(p.hoy);
  const diaAnt = diaDe(diaAnterior(p.prevFin));
  const esteMes = mesDe(p.hoy);
  const pasado = mesDe(p.prevIni);
  const dif = mes - ant;
  let tono: ComoVa['tono'];
  let titulo: string;
  let frase: string;
  if (!mes && !ant) {
    tono = 'igual'; titulo = 'Sin venta';
    frase = `No se ha vendido ni este mes ni en los mismos días de ${pasado}.`;
  } else if (!ant) {
    tono = 'sube'; titulo = 'Empezó a venderse';
    frase = `En los mismos días de ${pasado} no se había vendido; del 1 al ${dia} lleva ${dineroEntero(mes)}.`;
  } else if (!mes) {
    tono = 'baja'; titulo = 'Vende menos que el mes pasado';
    frase = `Del 1 al ${dia} no se ha vendido; en los mismos días de ${pasado} llevaba ${dineroEntero(ant)}.`;
  } else if (variacion !== null && Math.abs(variacion) < 0.05) {
    tono = 'igual'; titulo = 'Vende igual que el mes pasado';
    frase = `Del 1 al ${dia} lleva ${dineroEntero(mes)}, casi lo mismo que en los mismos días de ${pasado}.`;
  } else if (dif > 0) {
    tono = 'sube'; titulo = 'Vende más que el mes pasado';
    frase = `Del 1 al ${dia} lleva ${dineroEntero(mes)}: ${dineroEntero(dif)} más que en los mismos días de ${pasado}.`;
  } else {
    tono = 'baja'; titulo = 'Vende menos que el mes pasado';
    frase = `Del 1 al ${dia} lleva ${dineroEntero(mes)}: ${dineroEntero(-dif)} menos que en los mismos días de ${pasado}.`;
  }
  const max = Math.max(mes, ant, 1);
  const pct = (v: number) => (v > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0);
  return {
    tono, flecha: tono === 'sube' ? '▲' : tono === 'baja' ? '▼' : '=', titulo, frase,
    barras: [
      { etiqueta: `${capital(esteMes)} (1 al ${dia})`, monto: dineroEntero(mes), pct: pct(mes), clase: 'act' },
      { etiqueta: `${capital(pasado)} (1 al ${diaAnt})`, monto: dineroEntero(ant), pct: pct(ant), clase: 'ant' },
    ],
  };
}

/** Margen real de los últimos días cerrados (sólo llega con permiso de costo). null = sin venta que medir. */
export function margenReal(m: Pick<MargenesProducto, 'total'> | null | undefined) {
  const t = m?.total;
  if (!t) return null;
  const cob = t.real.cobertura;
  return {
    margen: t.real.pct === null ? 'Sin medir' : `${t.real.pct.toFixed(1)}%`,
    negativo: (t.real.pct ?? 0) < 0,
    venta: dineroEntero(t.venta_neta),
    cubre: cob !== null && cob < 0.995 ? `el costo cubre el ${Math.round(cob * 100)} %` : null,
    nota: t.real.nota,
  };
}

const fechaFmt = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const fechaDia = (iso: string | null | undefined) => (iso ? fechaFmt.format(Date.parse(iso.slice(0, 10) + 'T00:00:00Z')) : null);

/** Compras de la ventana: lo comprado compuesto en las unidades del producto (si todas sus unidades se conocen). */
export function comprasTexto(c: ComprasProducto, factores: UnidadFactor[], base: string) {
  const factor = new Map(factores.map((u) => [u.unidad.toUpperCase(), u.factorBase]));
  const todas = c.comprado.every((x) => factor.has(x.unidad.toUpperCase()));
  const n = (x: number) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(x);
  const comprado = !c.comprado.length
    ? null
    : todas
      ? cantidadCompuesta(c.comprado.reduce((a, x) => a + x.cantidad * (factor.get(x.unidad.toUpperCase()) ?? 0), 0), factores, base)
      : c.comprado.map((x) => `${n(x.cantidad)} ${x.unidad}`).join(' · ');
  const u = c.ultima;
  return {
    dias: c.dias,
    entradas: c.entradas,
    comprado,
    primera: fechaDia(c.primera),
    ultima: u ? `${fechaDia(u.fecha)} · ${u.nombreSucursal ? nombrePropio(u.nombreSucursal) : 'Sucursal ' + u.sucursal}` : null,
    costoUltima: u && u.costo !== null ? { monto: new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(u.costo), unidad: u.unidad } : null,
  };
}

/** Un lote: «Caducó 5 oct · hace 21 días» o «Caduca 15 nov · en 20 días», con lo registrado compuesto. */
export function loteTexto(l: LoteCaducidad, factores: UnidadFactor[], base: string) {
  const fecha = fechaDia(l.caduca) ?? l.caduca;
  const vencido = l.dias < 0;
  return {
    sucursal: l.nombre ? nombrePropio(l.nombre) : `Sucursal ${l.plaza}`,
    lote: l.lote,
    caduca: `${vencido ? 'Caducó' : 'Caduca'} ${fecha}`,
    cuando: vencido ? (l.dias === -1 ? 'ayer' : `hace ${-l.dias} días`) : l.dias === 0 ? 'hoy' : l.dias === 1 ? 'mañana' : `en ${l.dias} días`,
    tono: (vencido ? 'bad' : l.dias <= 30 ? 'warn' : 'ok') as 'bad' | 'warn' | 'ok',
    cantidad: cantidadCompuesta(l.registrado, factores, base) ?? `0 ${base}`.trim(),
  };
}
