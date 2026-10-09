/**
 * `[PF.1]` Flujo de venta de CUALQUIER producto del catálogo — la lógica pura, sin base.
 *
 * Pedido de Compras (2026-10-09): lo de Productos nuevos para todos los productos, más
 *  - el flujo de venta comparado con el mes anterior, en tiempo real;
 *  - si se estancó y en qué sucursales;
 *  - si de verdad hace falta comprarlo, y en qué afecta.
 *
 * Reglas (ADR-056):
 *  - Se compara el mes en curso contra LOS MISMOS DÍAS del mes anterior (del 1 al día de hoy), no
 *    contra el mes completo: comparar 9 días contra 30 siempre daría "va abajo".
 *  - La venta va CON impuestos: es la medida en que la historia cerrada y lo de hoy coinciden al centavo.
 *  - Lo que no se puede medir se declara: sin venta en la ventana, los días sin vender son NULL con
 *    motivo; sin ritmo de venta no hay cobertura (no se dibuja "infinito" ni cero).
 *  - Los umbrales son una PROPUESTA a calibrar con Compras (`CRITERIO_FLUJO`), no una verdad.
 */
import type { UnidadEscalera } from '@megadulces/contracts';
import { escaleraDeFicha, existenciaEnDuda, type ExistenciaDuda, type FichaPlaza, type KardexPlaza } from './new-products';

export const CRITERIO_FLUJO = {
  /** Días para medir el ritmo de venta (venta por día, cobertura). */
  ventanaRitmo: 30,
  /** Hasta dónde se busca la última venta. Más atrás se declara "más de N días". */
  ventanaHistoria: 120,
  /** Con existencia y sin vender tantos días: estancado. */
  diasEstancado: 14,
  /** El mes va por debajo de esta fracción de los mismos días del mes anterior: se frenó. */
  caidaFrenado: 0.5,
  /** Con menos días transcurridos del mes no se juzga el frenado: pocos días mueven mucho el porcentaje. */
  diasMinimosComparar: 7,
  /** Días de inventario por debajo de los cuales conviene comprar. */
  coberturaComprar: 15,
  /** Días de inventario por encima de los cuales sobra. */
  coberturaSobra: 60,
  /** Al sugerir un traspaso, la sucursal que da se queda con tantos días de su propia venta. */
  coberturaQueSeQueda: 30,
  /** Las compras recientes (reparto) se miran en esta ventana. */
  ventanaReparto: 90,
} as const;

// ─────────────────────────────── utilidades ───────────────────────────────

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
const DIA_MS = 86_400_000;
const aMs = (f: string) => Date.parse(`${f.slice(0, 10)}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const sumarDias = (f: string, n: number) => iso(aMs(f) + n * DIA_MS);
export const diasEntre = (a: string, b: string) => Math.round((aMs(b) - aMs(a)) / DIA_MS);

/** Los periodos que se comparan, para un día de hoy. Fechas `YYYY-MM-DD`; los fines son EXCLUSIVOS. */
export interface Periodos {
  hoy: string;
  /** Primer día del mes en curso. */
  mesIni: string;
  /** Días transcurridos del mes, contando hoy. */
  dias: number;
  /** Primer día del mes anterior. */
  prevIni: string;
  /** Fin (exclusivo) de los mismos días del mes anterior; nunca pasa del fin de ese mes. */
  prevFin: string;
  desde30: string;
  desdeHistoria: string;
}

export function periodos(hoy: string): Periodos {
  const [y, m, d] = hoy.slice(0, 10).split('-').map(Number);
  const mesIni = `${y}-${String(m).padStart(2, '0')}-01`;
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevIni = `${prevY}-${String(prevM).padStart(2, '0')}-01`;
  // Con hoy = 31 y un mes anterior de 30 días, "los mismos días" es el mes anterior completo.
  const prevFin = iso(Math.min(aMs(prevIni) + d * DIA_MS, aMs(mesIni)));
  return {
    hoy: hoy.slice(0, 10), mesIni, dias: d, prevIni, prevFin,
    desde30: sumarDias(hoy, -(CRITERIO_FLUJO.ventanaRitmo - 1)),
    desdeHistoria: sumarDias(hoy, -CRITERIO_FLUJO.ventanaHistoria),
  };
}

/** Variación del mes contra los mismos días del anterior. NULL si el anterior no vendió (no hay base). */
export function variacion(actual: number, anterior: number): number | null {
  return anterior > 0 ? r2(actual / anterior - 1) : null;
}

// ─────────────────────────────── entrada ───────────────────────────────

/** Historia cerrada de una sucursal, ya partida en periodos (lista). */
export interface HistoriaPlaza {
  product_id: string;
  plaza: string;
  mes: number | string;
  mes_anterior_mismo: number | string;
  mes_anterior_total: number | string;
  monto30: number | string;
  unidades30: number | string;
  ultima: string | null;
}

/** Venta en vivo (del corte a hoy) por SKU, sucursal y día. */
export interface VentaVivo {
  sku: string;
  plaza: string;
  fecha: string;
  monto: number | string;
  unidades: number | string;
}

/** Existencia de Kepler de hoy en el almacén principal (con el piso en cero). */
export interface ExistenciaPlaza {
  product_id: string;
  plaza: string;
  sucursal: string;
  cantidad: number | string;
}

/** Lo que el servidor junta para UNA sucursal antes de juzgarla. */
export interface DatosPlaza {
  plaza: string;
  nombre: string | null;
  mes: number;
  mes_anterior_mismo: number;
  mes_anterior_total: number;
  monto30: number;
  unidades30: number;
  ultima: string | null;
  /** NULL = no hay renglón de existencia. */
  existencia: number | null;
  duda: ExistenciaDuda | null;
  escalera: UnidadEscalera[] | null;
  /** Costo estándar de Kepler por unidad base (`kdii.c77`). NULL = sin costo o sin permiso. */
  costo: number | null;
}

/** Suma la historia cerrada y lo en vivo de una sucursal. */
export function juntarPlaza(p: Periodos, hist: HistoriaPlaza | undefined, vivo: VentaVivo[]): Pick<DatosPlaza,
  'mes' | 'mes_anterior_mismo' | 'mes_anterior_total' | 'monto30' | 'unidades30' | 'ultima'> {
  let mes = num(hist?.mes) ?? 0;
  let mesAntMismo = num(hist?.mes_anterior_mismo) ?? 0;
  let mesAntTotal = num(hist?.mes_anterior_total) ?? 0;
  let monto30 = num(hist?.monto30) ?? 0;
  let u30 = num(hist?.unidades30) ?? 0;
  let ultima = hist?.ultima ?? null;
  for (const v of vivo) {
    const f = v.fecha.slice(0, 10);
    const m = num(v.monto) ?? 0;
    const u = num(v.unidades) ?? 0;
    if (f >= p.mesIni && f <= p.hoy) mes += m;
    // Si el nocturno falló, el tramo en vivo puede caer en el mes anterior.
    if (f >= p.prevIni && f < p.prevFin) mesAntMismo += m;
    if (f >= p.prevIni && f < p.mesIni) mesAntTotal += m;
    if (f >= p.desde30 && f <= p.hoy) { monto30 += m; u30 += u; }
    if (u > 0 && (!ultima || f > ultima)) ultima = f;
  }
  return { mes: r2(mes), mes_anterior_mismo: r2(mesAntMismo), mes_anterior_total: r2(mesAntTotal),
    monto30: r2(monto30), unidades30: Math.round(u30 * 1000) / 1000, ultima };
}

// ─────────────────────────────── juicio por sucursal ───────────────────────────────

export type EstadoPlaza = 'se_mueve' | 'le_sobra' | 'se_freno' | 'estancado' | 'agotado' | 'sin_movimiento';

export interface PlazaFlujo {
  plaza: string;
  nombre: string | null;
  mes: number;
  mes_anterior_mismo: number;
  mes_anterior_total: number;
  /** Mes contra los mismos días del anterior. NULL = el anterior no vendió. */
  variacion: number | null;
  venta_dia: number;
  unidades_dia: number;
  ultima_venta: string | null;
  /** NULL = no vendió en toda la ventana de historia (se dice "más de N días"). */
  dias_sin_venta: number | null;
  /** Existencia de Kepler (con piso en cero). NULL = sin renglón. */
  existencia: number | null;
  existencia_duda: ExistenciaDuda | null;
  /** La que decide: la estimada si la de Kepler está en duda. NULL = no se pudo medir. */
  existencia_usada: number | null;
  /** Días que alcanza al ritmo de los últimos 30. NULL = no se vende (sin ritmo no hay cobertura). */
  cobertura_dias: number | null;
  estado: EstadoPlaza;
  motivo: string;
  escalera: UnidadEscalera[] | null;
  /** Pesos inmovilizados a costo estándar. NULL = sin costo o sin permiso. */
  inmovilizado: number | null;
}

export function juzgarPlaza(p: Periodos, d: DatosPlaza): PlazaFlujo {
  const C = CRITERIO_FLUJO;
  const ventaDia = r2(d.monto30 / C.ventanaRitmo);
  const unidadesDia = d.unidades30 / C.ventanaRitmo;
  const diasSin = d.ultima ? diasEntre(d.ultima, p.hoy) : null;
  const usada = d.duda ? d.duda.estimada : d.existencia;
  const hay = usada !== null && usada > 0;
  const cobertura = hay && unidadesDia > 0 ? r1(usada / unidadesDia) : null;
  const vari = variacion(d.mes, d.mes_anterior_mismo);
  let estado: EstadoPlaza;
  let motivo: string;
  if (hay && (diasSin === null || diasSin >= C.diasEstancado)) {
    estado = 'estancado';
    motivo = diasSin === null
      ? `Hay existencia y no se vendió en más de ${C.ventanaHistoria} días`
      : `Hay existencia y lleva ${diasSin} días sin venderse`;
  } else if (!hay && d.monto30 > 0 && !(d.duda && d.duda.estimada === null)) {
    estado = 'agotado';
    motivo = 'Se vende y hoy no tiene existencia';
  } else if (!hay && d.monto30 <= 0) {
    estado = 'sin_movimiento';
    motivo = 'Sin existencia y sin venta en los últimos 30 días';
  } else if (p.dias >= C.diasMinimosComparar && vari !== null && vari <= -C.caidaFrenado) {
    estado = 'se_freno';
    motivo = `En lo que va del mes vende ${Math.round(-vari * 100)}% menos que los mismos días del mes anterior`;
  } else if (cobertura !== null && cobertura > C.coberturaSobra) {
    // Se vende, pero tiene para mucho más de lo que necesita: de aquí se puede mover a donde falta.
    estado = 'le_sobra';
    motivo = `Tiene para ${Math.round(cobertura)} días al ritmo actual`;
  } else {
    estado = 'se_mueve';
    motivo = cobertura !== null ? `Alcanza para ${Math.round(cobertura)} días al ritmo actual` : 'Se vende';
  }
  return {
    plaza: d.plaza, nombre: d.nombre,
    mes: d.mes, mes_anterior_mismo: d.mes_anterior_mismo, mes_anterior_total: d.mes_anterior_total,
    variacion: vari, venta_dia: ventaDia, unidades_dia: Math.round(unidadesDia * 1000) / 1000,
    ultima_venta: d.ultima, dias_sin_venta: diasSin,
    existencia: d.existencia, existencia_duda: d.duda, existencia_usada: usada,
    cobertura_dias: cobertura, estado, motivo, escalera: d.escalera,
    inmovilizado: d.costo !== null && usada !== null && usada > 0 ? r2(usada * d.costo) : null,
  };
}

// ─────────────────────────────── ¿hace falta comprar? ───────────────────────────────

export type VeredictoCompra = 'comprar' | 'traspasar' | 'esperar' | 'sobra' | 'no_comprar' | 'sin_movimiento';

export interface TraspasoSugerido {
  desde: string;
  desde_nombre: string | null;
  hacia: string;
  hacia_nombre: string | null;
  /** En unidad base de Kepler. */
  cantidad: number;
}

export interface AnalisisCompra {
  veredicto: VeredictoCompra;
  /** La frase corta para la tabla. */
  titulo: string;
  motivos: string[];
  /** Qué pasa si no se compra / si se compra. */
  impacto: string[];
  traspasos: TraspasoSugerido[];
  cobertura_dias: number | null;
  /** Fecha estimada en que se acaba al ritmo actual. NULL = no se vende o no hay existencia medible. */
  se_acaba: string | null;
  /** Pesos que se dejan de vender por día si se acaba. */
  venta_en_riesgo_dia: number;
  /** Pesos inmovilizados (a costo estándar). NULL = sin permiso o sin costo. */
  inmovilizado: number | null;
}

const pesos = (v: number) => `$${Math.round(v).toLocaleString('es-MX')}`;
/** "14 de octubre" (sin año: es dentro de los próximos días). */
export const fechaTexto = (f: string) => new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  .format(Date.parse(`${f.slice(0, 10)}T00:00:00Z`));

/** Traspasos de las sucursales que les sobra (o donde está estancado) a las que les falta. */
export function sugerirTraspasos(plazas: PlazaFlujo[]): TraspasoSugerido[] {
  const C = CRITERIO_FLUJO;
  const faltan = plazas
    .filter((x) => x.unidades_dia > 0 && (x.cobertura_dias === null || x.cobertura_dias < C.coberturaComprar)
      && x.existencia_usada !== null)
    .map((x) => ({ x, falta: Math.max(0, x.unidades_dia * C.coberturaComprar - Math.max(0, x.existencia_usada ?? 0)) }))
    .filter((f) => f.falta >= 1)
    .sort((a, b) => b.falta - a.falta);
  const sobran = plazas
    .filter((x) => (x.existencia_usada ?? 0) > 0 && (x.estado === 'estancado'
      || (x.cobertura_dias !== null && x.cobertura_dias > C.coberturaSobra)))
    .map((x) => ({ x, sobra: Math.floor((x.existencia_usada ?? 0) - (x.estado === 'estancado' ? 0 : x.unidades_dia * C.coberturaQueSeQueda)) }))
    .filter((s) => s.sobra >= 1)
    .sort((a, b) => b.sobra - a.sobra);
  const out: TraspasoSugerido[] = [];
  for (const f of faltan) {
    let falta = Math.ceil(f.falta);
    for (const s of sobran) {
      if (falta <= 0) break;
      if (s.sobra <= 0 || s.x.plaza === f.x.plaza) continue;
      const q = Math.min(falta, s.sobra);
      out.push({ desde: s.x.plaza, desde_nombre: s.x.nombre, hacia: f.x.plaza, hacia_nombre: f.x.nombre, cantidad: q });
      s.sobra -= q;
      falta -= q;
    }
  }
  return out;
}

export function analizarCompra(p: Periodos, plazas: PlazaFlujo[], total: { mes: number; mes_anterior_mismo: number }): AnalisisCompra {
  const C = CRITERIO_FLUJO;
  const unidadesDia = plazas.reduce((a, x) => a + x.unidades_dia, 0);
  const ventaDia = r2(plazas.reduce((a, x) => a + x.venta_dia, 0));
  const sinMedir = plazas.filter((x) => x.existencia_duda && x.existencia_duda.estimada === null);
  const existencia = plazas.reduce((a, x) => a + Math.max(0, x.existencia_usada ?? 0), 0);
  const cobertura = unidadesDia > 0 ? r1(existencia / unidadesDia) : null;
  const seAcaba = cobertura !== null ? sumarDias(p.hoy, Math.floor(cobertura)) : null;
  const inmov = plazas.some((x) => x.inmovilizado !== null)
    ? r2(plazas.reduce((a, x) => a + (x.inmovilizado ?? 0), 0)) : null;
  const estancadas = plazas.filter((x) => x.estado === 'estancado');
  const agotadas = plazas.filter((x) => x.estado === 'agotado');
  const enDuda = plazas.filter((x) => x.existencia_duda);
  const traspasos = sugerirTraspasos(plazas);
  const motivos: string[] = [];
  const impacto: string[] = [];
  const vari = variacion(total.mes, total.mes_anterior_mismo);
  const nombres = (xs: PlazaFlujo[]) => xs.map((x) => x.nombre || `Sucursal ${x.plaza}`).join(', ');

  if (enDuda.length) {
    motivos.push(`La existencia de Kepler está en duda en ${nombres(enDuda)}: conviene contarla antes de decidir`);
  }
  if (estancadas.length) motivos.push(`Estancado en ${nombres(estancadas)}`);
  if (agotadas.length) motivos.push(`Agotado en ${nombres(agotadas)}, donde sí se vende`);
  // Una caída de la venta con sucursales agotadas NO es falta de demanda: no se vende lo que no hay.
  const caidaPorAgotado = vari !== null && vari < 0 && agotadas.length > 0;
  if (p.dias >= C.diasMinimosComparar && vari !== null) {
    motivos.push(vari >= 0
      ? `En lo que va del mes vende ${Math.round(vari * 100)}% más que los mismos días del mes anterior`
      : caidaPorAgotado
        ? `En lo que va del mes vende ${Math.round(-vari * 100)}% menos que los mismos días del mes anterior, en buena parte porque se agotó: no es que se pida menos`
        : `En lo que va del mes vende ${Math.round(-vari * 100)}% menos que los mismos días del mes anterior`);
  }

  let veredicto: VeredictoCompra;
  let titulo: string;
  if (unidadesDia <= 0) {
    veredicto = existencia > 0 ? 'no_comprar' : 'sin_movimiento';
    titulo = existencia > 0 ? 'No comprar: no se vende' : 'Sin movimiento';
    if (existencia > 0) {
      impacto.push(inmov !== null
        ? `Comprar más sumaría a ${pesos(inmov)} que ya están detenidos en inventario`
        : 'Comprar más sumaría a un inventario que no se está vendiendo');
    }
  } else if (cobertura !== null && cobertura < C.coberturaComprar) {
    veredicto = 'comprar';
    if (existencia <= 0) {
      titulo = 'Comprar: ya no hay existencia';
      impacto.push(`Ya se están dejando de vender cerca de ${pesos(ventaDia)} por día`);
    } else {
      titulo = cobertura < 1 ? 'Comprar: alcanza para menos de un día' : `Comprar: alcanza para ${Math.round(cobertura)} días`;
      impacto.push(seAcaba === p.hoy
        ? 'Si no se compra, al ritmo actual se acaba hoy'
        : `Si no se compra, al ritmo actual se acaba alrededor del ${fechaTexto(seAcaba ?? p.hoy)}`);
      impacto.push(`Desde entonces se dejarían de vender cerca de ${pesos(ventaDia)} por día`);
    }
    if (traspasos.length) impacto.push('Antes de comprar, se puede mover existencia de las sucursales que les sobra (abajo)');
  } else if (traspasos.length && (agotadas.length || plazas.some((x) => x.cobertura_dias !== null && x.cobertura_dias < C.coberturaComprar))) {
    veredicto = 'traspasar';
    titulo = 'No comprar: mover entre sucursales';
    impacto.push(`En la red alcanza para ${Math.round(cobertura ?? 0)} días, pero está en las sucursales equivocadas`);
    impacto.push('Mover la existencia evita comprar y libera lo estancado');
  } else if (cobertura !== null && cobertura > C.coberturaSobra) {
    veredicto = 'sobra';
    titulo = `No comprar: hay para ${Math.round(cobertura)} días`;
    impacto.push(inmov !== null
      ? `Hay ${pesos(inmov)} en inventario; comprar ahora los aumentaría sin necesidad`
      : 'Comprar ahora aumentaría un inventario que ya alcanza de sobra');
  } else {
    veredicto = 'esperar';
    titulo = `Esperar: alcanza para ${Math.round(cobertura ?? 0)} días`;
    if (cobertura !== null) {
      impacto.push(`Conviene revisarlo en unos ${Math.max(1, Math.round(cobertura - C.coberturaComprar))} días, cuando quede para ${C.coberturaComprar}`);
    }
  }
  if (sinMedir.length) {
    motivos.push(`En ${nombres(sinMedir)} no se pudo estimar la existencia (unidad que no se puede convertir)`);
  }
  if (vari !== null && vari <= -C.caidaFrenado && p.dias >= C.diasMinimosComparar && veredicto === 'comprar' && !caidaPorAgotado) {
    impacto.push('Ojo: la venta del mes va muy abajo; comprar al ritmo de antes podría sobrar');
  }
  return {
    veredicto, titulo, motivos, impacto, traspasos,
    cobertura_dias: cobertura, se_acaba: seAcaba, venta_en_riesgo_dia: ventaDia, inmovilizado: inmov,
  };
}

// ─────────────────────────────── salida ───────────────────────────────

export interface FlujoResumen {
  product_id: string;
  mes: number;
  mes_anterior_mismo: number;
  mes_anterior_total: number;
  variacion: number | null;
  venta_dia: number;
  /** Sucursales por estado, con su nombre. */
  estancadas: Array<{ plaza: string; nombre: string | null; dias_sin_venta: number | null }>;
  frenadas: Array<{ plaza: string; nombre: string | null; variacion: number | null }>;
  agotadas: Array<{ plaza: string; nombre: string | null }>;
  compra: AnalisisCompra;
}

export interface FlujoListaRespuesta {
  periodos: Periodos;
  /** Hasta dónde llega la historia cerrada; de ahí a ahora es en vivo. */
  corte: string;
  en_vivo_al: string;
  costo_visible: boolean;
  criterio: typeof CRITERIO_FLUJO;
  productos: FlujoResumen[];
}

export function resumirProducto(productId: string, p: Periodos, plazas: PlazaFlujo[]): FlujoResumen {
  const mes = r2(plazas.reduce((a, x) => a + x.mes, 0));
  const ant = r2(plazas.reduce((a, x) => a + x.mes_anterior_mismo, 0));
  return {
    product_id: productId,
    mes, mes_anterior_mismo: ant,
    mes_anterior_total: r2(plazas.reduce((a, x) => a + x.mes_anterior_total, 0)),
    variacion: variacion(mes, ant),
    venta_dia: r2(plazas.reduce((a, x) => a + x.venta_dia, 0)),
    estancadas: plazas.filter((x) => x.estado === 'estancado')
      .map((x) => ({ plaza: x.plaza, nombre: x.nombre, dias_sin_venta: x.dias_sin_venta })),
    frenadas: plazas.filter((x) => x.estado === 'se_freno')
      .map((x) => ({ plaza: x.plaza, nombre: x.nombre, variacion: x.variacion })),
    agotadas: plazas.filter((x) => x.estado === 'agotado').map((x) => ({ plaza: x.plaza, nombre: x.nombre })),
    compra: analizarCompra(p, plazas, { mes, mes_anterior_mismo: ant }),
  };
}

/** El día a día acumulado del mes en curso contra el mismo día del mes anterior (para la gráfica). */
export interface SerieMes {
  /** Día del mes (1..N). */
  dias: number[];
  actual: Array<number | null>;
  anterior: number[];
}

export function serieAcumulada(p: Periodos, porDia: Map<string, number>): SerieMes {
  const prevDias = diasEntre(p.prevIni, p.mesIni);
  const n = Math.max(p.dias, prevDias);
  const dias: number[] = [];
  const actual: Array<number | null> = [];
  const anterior: number[] = [];
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    dias.push(i + 1);
    if (i < p.dias) { a += porDia.get(sumarDias(p.mesIni, i)) ?? 0; actual.push(r2(a)); } else actual.push(null);
    if (i < prevDias) b += porDia.get(sumarDias(p.prevIni, i)) ?? 0;
    anterior.push(r2(b));
  }
  return { dias, actual, anterior };
}

/** Lo recibido y repartido por sucursal en la ventana de reparto, por rótulo de Kepler. */
export interface RepartoPlaza {
  plaza: string;
  nombre: string | null;
  comprado: Record<string, number>;
  recibido: Record<string, number>;
  mandado_sucursales: Record<string, number>;
  mandado_rutas: Record<string, number>;
  escalera: UnidadEscalera[] | null;
}

export interface LlegadaProducto {
  primera_compra: string | null;
  primera_compra_plazas: Array<{ plaza: string; nombre: string | null }>;
  ultima_compra: string | null;
  ultima_compra_plazas: Array<{ plaza: string; nombre: string | null }>;
}

export interface FlujoDetalle {
  product_id: string;
  sku: string;
  nombre: string | null;
  periodos: Periodos;
  corte: string;
  en_vivo_al: string;
  costo_visible: boolean;
  criterio: typeof CRITERIO_FLUJO;
  resumen: FlujoResumen;
  serie: SerieMes;
  plazas: PlazaFlujo[];
  llegada: LlegadaProducto;
  reparto: RepartoPlaza[];
  /** La escalera común a sus sucursales (para los totales); NULL si difieren. */
  escalera: UnidadEscalera[] | null;
}

/** Orden de las sucursales en el detalle: primero lo que pide acción. */
const ORDEN_ESTADO: Record<EstadoPlaza, number> = { agotado: 0, estancado: 1, se_freno: 2, le_sobra: 3, se_mueve: 4, sin_movimiento: 5 };
export const ordenPlazasFlujo = (a: PlazaFlujo, b: PlazaFlujo) =>
  ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado] || b.venta_dia - a.venta_dia || a.plaza.localeCompare(b.plaza);

/** Kardex por (sucursal, rótulo) → KardexPlaza por sucursal + llegada. */
export interface KardexFila {
  plaza: string;
  sku: string;
  unidad: string;
  q: number | string;
  ult: string | null;
  aj: string | null;
  primera_compra: string | null;
  ultima_compra: string | null;
  comprado: number | string;
}

export function kardexPorPlaza(filas: KardexFila[], kdil: Map<string, number>): Map<string, KardexPlaza> {
  const out = new Map<string, KardexPlaza>();
  for (const f of filas) {
    const k = out.get(f.plaza) ?? { u: {}, crudo: 0 };
    (k.u as Record<string, { q: number; ult?: string }>)[f.unidad] = { q: num(f.q) ?? 0, ult: f.ult ?? undefined };
    k.crudo = (num(k.crudo) ?? 0) + (num(f.q) ?? 0);
    if (f.aj && (!k.aj || f.aj > k.aj)) k.aj = f.aj;
    out.set(f.plaza, k);
  }
  for (const [plaza, k] of out) if (kdil.has(plaza)) k.kdil = kdil.get(plaza);
  return out;
}

export function llegadaDeKardex(filas: KardexFila[], nombres: Map<string, string>): LlegadaProducto {
  const prim = filas.map((f) => f.primera_compra).filter((x): x is string => !!x).sort()[0] ?? null;
  const ult = filas.map((f) => f.ultima_compra).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const plazas = (fecha: string | null, campo: 'primera_compra' | 'ultima_compra') =>
    fecha ? [...new Set(filas.filter((f) => f[campo] === fecha).map((f) => f.plaza))].sort()
      .map((plaza) => ({ plaza, nombre: nombres.get(plaza) ?? null })) : [];
  return {
    primera_compra: prim, primera_compra_plazas: plazas(prim, 'primera_compra'),
    ultima_compra: ult, ultima_compra_plazas: plazas(ult, 'ultima_compra'),
  };
}

export { escaleraDeFicha, existenciaEnDuda };
export type { FichaPlaza, KardexPlaza };
