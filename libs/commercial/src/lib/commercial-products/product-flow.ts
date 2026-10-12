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
import {
  escaleraDeFicha, existenciaEnDuda, margenesDe,
  type ExistenciaDuda, type FichaPlaza, type KardexPlaza, type Margen, type MargenFuente, type Margenes,
} from './new-products';

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
  /** `[PF.2]` Líder: está entre los productos que juntos hacen esta fracción de la venta de la red (90 días). */
  lideresCorte: 0.5,
  /** `[PF.2]` A un líder se le compra antes: con menos de estos días de inventario. */
  coberturaComprarLider: 21,
  /** `[PF.3]` Un lote que caduca en estos días o menos se avisa aunque alcance a venderse. */
  caducidadAviso: 30,
  /** `[PF.4]` Con existencia y sin una venta en la red en tantos días: no se vende. */
  diasSinVenta: 30,
  /** `[PF.4]` Hasta dónde se busca la última venta; más atrás se dice "sin venta en el año". */
  ventanaSinVenta: 365,
  /** `[PF.4]` Los productos nuevos de estos días van en su propia pestaña, no aquí. */
  ventanaNuevos: 90,
  /** `[PF.4]` Cuántos se traen (los de más dinero detenido primero). */
  limiteNoSeVenden: 300,
  /** `[PF.5]` Días CERRADOS para los márgenes (hasta ayer). */
  ventanaMargen: 30,
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

export function analizarCompra(p: Periodos, plazas: PlazaFlujo[], total: { mes: number; mes_anterior_mismo: number },
  extra: { lider?: Lider | null; caducidad?: CaducidadResumen | null } = {}): AnalisisCompra {
  const C = CRITERIO_FLUJO;
  const lider = extra.lider ?? null;
  // A un líder se le compra antes: que falte cuesta más que tener unos días de más.
  const umbralComprar = lider ? C.coberturaComprarLider : C.coberturaComprar;
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

  if (lider) {
    motivos.push(`Es líder: el #${lider.rank} en venta de la red en 90 días (${(lider.participacion * 100).toFixed(1)}% de la venta). No debe faltar`);
  }
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
  } else if (cobertura !== null && cobertura < umbralComprar) {
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
  } else if (traspasos.length && (agotadas.length || plazas.some((x) => x.cobertura_dias !== null && x.cobertura_dias < umbralComprar))) {
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
      impacto.push(`Conviene revisarlo en unos ${Math.max(1, Math.round(cobertura - umbralComprar))} días, cuando quede para ${umbralComprar}`);
    }
  }
  if (lider && agotadas.length) {
    const perdida = agotadas.reduce((a, x) => a + x.venta_dia, 0);
    impacto.push(`Es líder y está agotado en ${nombres(agotadas)}: ahí se dejan de vender cerca de ${pesos(perdida)} por día`);
  }
  const cad = extra.caducidad ?? null;
  if (cad && (cad.vencido > 0 || cad.en_riesgo > 0)) {
    motivos.push(cad.vencido > 0
      ? `Hay lotes registrados como ya caducados en ${cad.plazas_vencido.join(', ')}: confirmarlos en el piso y sacarlos`
      : `Hay lotes que caducan antes de venderse en ${cad.plazas_en_riesgo.join(', ')}: sacarlos antes (ver Caducidad)`);
    if (veredicto === 'comprar') impacto.push('Antes de comprar, mover o promover lo que está por caducar');
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
  /** Con lo que vendía por día cada una (lo que hoy se deja de vender ahí). */
  agotadas: Array<{ plaza: string; nombre: string | null; venta_dia: number }>;
  compra: AnalisisCompra;
  /** `[PF.2]` NULL = no es líder. */
  lider: Lider | null;
  /** `[PF.3]` NULL = no tiene ningún lote con fecha registrada (NO quiere decir que no caduque). */
  caducidad: CaducidadResumen | null;
  /** `[PF.5]` Margen real de los últimos días cerrados. NULL = sin permiso de costo o sin venta. */
  margen_real?: Margen | null;
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

export function resumirProducto(productId: string, p: Periodos, plazas: PlazaFlujo[],
  extra: { lider?: Lider | null; caducidad?: CaducidadResumen | null } = {}): FlujoResumen {
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
    agotadas: plazas.filter((x) => x.estado === 'agotado').map((x) => ({ plaza: x.plaza, nombre: x.nombre, venta_dia: x.venta_dia })),
    compra: analizarCompra(p, plazas, { mes, mes_anterior_mismo: ant }, extra),
    lider: extra.lider ?? null,
    caducidad: extra.caducidad ?? null,
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
  /** `[PF.3]` Cada lote con fecha registrada, juzgado contra el ritmo de su sucursal. */
  lotes: LoteCaducidad[];
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

// ─────────────────────────────── [PF.2] líderes ───────────────────────────────

export interface Lider {
  /** Lugar en la venta de la red en 90 días (1 = el que más vende). */
  rank: number;
  /** Fracción de la venta de la red que hace este producto (0.013 = 1.3%). */
  participacion: number;
}

/**
 * Un líder pide atención si le falta (comprar), está mal repartido (mover), se agotó donde se vende o la venta
 * de toda la red se frenó. Una sucursal estancada sola NO: en un líder casi siempre hay alguna, y con ese
 * criterio pedían atención 239 de 245 (medido en prod el 2026-10-09): una lista que lo marca todo no ayuda.
 */
export function liderPideAtencion(p: Periodos, r: FlujoResumen): boolean {
  return motivosLider(p, r).length > 0;
}

export type MotivoLider = 'agotado' | 'comprar' | 'mover' | 'se_freno';

/** Por qué pide atención un líder (puede ser más de uno). */
export function motivosLider(p: Periodos, r: FlujoResumen): MotivoLider[] {
  const C = CRITERIO_FLUJO;
  const out: MotivoLider[] = [];
  if (r.agotadas.length) out.push('agotado');
  if (r.compra.veredicto === 'comprar') out.push('comprar');
  if (r.compra.veredicto === 'traspasar') out.push('mover');
  if (p.dias >= C.diasMinimosComparar && r.variacion !== null && r.variacion <= -C.caidaFrenado) out.push('se_freno');
  return out;
}

/**
 * Lo que se juega por día, para ordenar: lo que YA se deja de vender donde está agotado, más toda su venta si
 * se acaba en menos de una semana. Medido en prod el 2026-10-09: 217 de 245 líderes piden algo (104 agotados
 * en alguna sucursal): sin orden la lista no dice por dónde empezar.
 */
export function enJuegoPorDia(r: FlujoResumen): number {
  const yaSePierde = r.agotadas.reduce((a, x) => a + x.venta_dia, 0);
  const seAcaba = r.compra.veredicto === 'comprar' && r.compra.cobertura_dias !== null && r.compra.cobertura_dias < 7
    ? r.venta_dia : 0;
  return r2(Math.max(yaSePierde, seAcaba));
}

// ─────────────────────────────── [PF.3] caducidad ───────────────────────────────

/** La sucursal de Kepler del CEDIS. */
export const PLAZA_CEDIS = '00';

/** Un lote con fecha registrada, tal como sale de `commercial.stock_lots`. */
export interface LoteFila {
  product_id: string;
  plaza: string;
  lote: string;
  /** `YYYY-MM-DD`. */
  caduca: string;
  /** La cantidad REGISTRADA, en unidad base. */
  cantidad: number | string;
  registrado: string | null;
}

export type EstadoLote = 'caducado' | 'no_alcanza' | 'justo' | 'a_tiempo';

export interface LoteCaducidad {
  plaza: string;
  nombre: string | null;
  lote: string | null;
  caduca: string;
  /** Días que faltan (negativo = ya caducó). */
  dias: number;
  /** Lo que se registró con esa fecha. */
  registrado: number;
  /**
   * Lo que se da por presente hoy: lo registrado topado con la existencia de la sucursal, repartida del lote
   * más viejo al más nuevo (si de verdad se vendió primero lo viejo, aquí sobra: es el lado prudente).
   * NULL = la existencia de la sucursal no se pudo medir (se usa lo registrado).
   */
  en_existencia: number | null;
  /** Lo que alcanza a venderse antes de que caduque, al ritmo de los últimos 30 días. */
  se_vende_antes: number;
  /** Lo que caducaría sin venderse. */
  queda: number;
  estado: EstadoLote;
  /** Qué hacer, en una frase. */
  accion: string;
  /** A dónde moverlo: las sucursales que lo venden antes de que caduque, la que más absorbe primero. */
  mover_a: Array<{ plaza: string; nombre: string | null; cantidad: number }>;
  /** Lo que ninguna sucursal alcanza a vender a tiempo (promover o devolver). */
  sin_destino: number;
  escalera: UnidadEscalera[] | null;
}

export interface CaducidadResumen {
  /** Unidades base ya caducadas según el registro. */
  vencido: number;
  /** Unidades base que caducarían sin venderse. */
  en_riesgo: number;
  /** Lotes con existencia que caducan en `caducidadAviso` días o menos (aunque alcancen a venderse). */
  por_caducar: number;
  /** La fecha más próxima de un lote que pide acción (caducado, no alcanza o justo). NULL = ninguno. */
  proxima: string | null;
  plazas_vencido: string[];
  plazas_en_riesgo: string[];
  lotes: number;
}

/**
 * Juzga los lotes de UN producto contra el ritmo de venta de cada sucursal.
 *  - Lo presente se topa con la existencia de hoy (Kepler no descuenta por lote).
 *  - Se vende primero lo que caduca primero (FEFO): cada lote sólo cuenta con la venta que le queda después
 *    de los lotes que caducan antes.
 *  - Lo que no alcanza se propone moverlo a la sucursal que sí lo vende a tiempo (después de su propia
 *    existencia, que se vende primero); si ninguna, promoverlo o devolverlo al proveedor.
 */
export function juzgarLotes(p: Periodos, lotes: LoteFila[], plazas: PlazaFlujo[], nombres: Map<string, string>): LoteCaducidad[] {
  const C = CRITERIO_FLUJO;
  // El CEDIS surte a las sucursales, no vende en mostrador: su lote se agota al ritmo de toda la red.
  const ritmoRed = plazas.filter((x) => x.plaza !== PLAZA_CEDIS).reduce((a, x) => a + x.unidades_dia, 0);
  const porPlaza = new Map(plazas.map((x) => [x.plaza, x]));
  const out: LoteCaducidad[] = [];
  // Lo que ya se le propuso mover a cada sucursal (para no mandarle más de lo que vende a tiempo).
  const yaRecibe = new Map<string, number>();
  const grupos = new Map<string, LoteFila[]>();
  for (const l of lotes) grupos.set(l.plaza, [...(grupos.get(l.plaza) ?? []), l]);
  for (const [plaza, ls] of [...grupos].sort(([a], [b]) => a.localeCompare(b))) {
    const pl = porPlaza.get(plaza);
    const esCedis = plaza === PLAZA_CEDIS;
    const ritmo = esCedis ? Math.max(pl?.unidades_dia ?? 0, ritmoRed) : pl?.unidades_dia ?? 0;
    const existencia = pl ? pl.existencia_usada : null;
    let porRepartir = existencia === null ? Infinity : Math.max(0, existencia);
    let vendidoAntes = 0;
    for (const l of [...ls].sort((a, b) => a.caduca.localeCompare(b.caduca))) {
      const registrado = num(l.cantidad) ?? 0;
      const presente = Math.min(registrado, porRepartir);
      porRepartir -= presente;
      const dias = diasEntre(p.hoy, l.caduca);
      const capacidad = Math.max(0, ritmo * Math.max(0, dias) - vendidoAntes);
      const seVende = dias < 0 ? 0 : Math.min(presente, Math.floor(capacidad));
      vendidoAntes += seVende;
      const queda = Math.max(0, Math.round((presente - seVende) * 1000) / 1000);
      let estado: EstadoLote;
      if (presente <= 0) estado = 'a_tiempo';
      else if (dias < 0) estado = 'caducado';
      else if (queda >= 1) estado = 'no_alcanza';
      else if (dias <= C.caducidadAviso) estado = 'justo';
      else estado = 'a_tiempo';
      const moverA: LoteCaducidad['mover_a'] = [];
      let sinDestino = 0;
      let accion: string;
      if (presente <= 0) {
        accion = 'Ya no hay existencia para este lote: seguramente se vendió';
      } else if (estado === 'caducado') {
        accion = 'Caducado según el registro: confirmarlo en el piso y sacarlo de la venta';
      } else if (estado === 'no_alcanza' && esCedis) {
        accion = ritmo > 0
          ? 'Ni toda la red lo alcanza a vender antes de que caduque: promoverlo o devolverlo al proveedor'
          : 'No se vende en ninguna sucursal: promoverlo o devolverlo al proveedor antes de que caduque';
      } else if (estado === 'no_alcanza') {
        // Las que lo pueden vender a tiempo, después de su propia existencia; la que más absorbe primero.
        const destinos = plazas
          .filter((x) => x.plaza !== plaza && x.plaza !== PLAZA_CEDIS && x.unidades_dia > 0)
          .map((x) => ({ x, cabe: Math.floor(x.unidades_dia * dias - Math.max(0, x.existencia_usada ?? 0) - (yaRecibe.get(x.plaza) ?? 0)) }))
          .filter((d) => d.cabe >= 1)
          .sort((a, b) => b.cabe - a.cabe);
        let falta = Math.ceil(queda);
        for (const d of destinos) {
          if (falta <= 0) break;
          const q = Math.min(falta, d.cabe);
          yaRecibe.set(d.x.plaza, (yaRecibe.get(d.x.plaza) ?? 0) + q);
          moverA.push({ plaza: d.x.plaza, nombre: d.x.nombre, cantidad: q });
          falta -= q;
        }
        sinDestino = Math.max(0, falta);
        if (!moverA.length) {
          accion = 'Ninguna sucursal lo alcanza a vender a tiempo: promoverlo o devolverlo al proveedor';
        } else {
          accion = (ritmo > 0
            ? 'Aquí no se alcanza a vender antes de que caduque: moverlo a donde sí se vende'
            : 'Aquí no se vende: moverlo a donde sí se vende antes de que caduque')
            + (sinDestino > 0 ? '. Lo que no cabe en ninguna: promoverlo o devolverlo al proveedor' : '');
        }
      } else if (estado === 'justo') {
        accion = 'Alcanza a venderse, pero con poco margen: ponerlo al frente';
      } else {
        accion = 'Alcanza a venderse antes de que caduque';
      }
      out.push({
        plaza, nombre: pl?.nombre ?? nombres.get(plaza) ?? null, lote: l.lote && l.lote !== 'NA' ? l.lote : null,
        caduca: l.caduca, dias, registrado,
        en_existencia: existencia === null ? null : Math.round(presente * 1000) / 1000,
        se_vende_antes: seVende, queda: presente <= 0 ? 0 : queda, estado, accion, mover_a: moverA,
        sin_destino: estado === 'no_alcanza' && esCedis ? queda : sinDestino,
        escalera: pl?.escalera ?? null,
      });
    }
  }
  const ORDEN: Record<EstadoLote, number> = { caducado: 0, no_alcanza: 1, justo: 2, a_tiempo: 3 };
  return out.sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado] || a.caduca.localeCompare(b.caduca) || a.plaza.localeCompare(b.plaza));
}

export function resumirCaducidad(lotes: LoteCaducidad[]): CaducidadResumen | null {
  if (!lotes.length) return null;
  const nombre = (l: LoteCaducidad) => l.nombre || `Sucursal ${l.plaza}`;
  const unicos = (xs: string[]) => [...new Set(xs)];
  const presente = (l: LoteCaducidad) => l.en_existencia ?? l.registrado;
  const caducados = lotes.filter((l) => l.estado === 'caducado');
  const riesgo = lotes.filter((l) => l.estado === 'no_alcanza');
  const accion = lotes.filter((l) => l.estado !== 'a_tiempo');
  return {
    vencido: caducados.reduce((a, l) => a + presente(l), 0),
    en_riesgo: riesgo.reduce((a, l) => a + l.queda, 0),
    por_caducar: lotes.filter((l) => l.dias >= 0 && l.dias <= CRITERIO_FLUJO.caducidadAviso && presente(l) > 0).length,
    proxima: accion.map((l) => l.caduca).sort()[0] ?? null,
    plazas_vencido: unicos(caducados.map(nombre)),
    plazas_en_riesgo: unicos(riesgo.map(nombre)),
    lotes: lotes.length,
  };
}

// ─────────────────────────────── [PF.4] los que no se venden ───────────────────────────────

export type TramoSinVenta = 'mes' | 'trimestre' | 'anio';

/** El tramo de días sin venta. NULL = no vendió en todo el año que se mira. */
export function tramoSinVenta(dias: number | null): TramoSinVenta {
  if (dias === null) return 'anio';
  return dias >= 90 ? 'trimestre' : 'mes';
}

/** Un producto con existencia en la red que no se vende, tal como sale de `NO_SE_VENDEN_SQL`. */
export interface NoSeVendeFila {
  product_id: string;
  sku: string;
  nombre: string | null;
  existencia: number | string;
  valor: number | string | null;
  sin_costo: boolean | null;
  plazas: string[] | null;
  ultima: string | null;
  dias: number | string | null;
}

export interface NoSeVende {
  product_id: string;
  sku: string;
  nombre: string | null;
  /** En unidad base de Kepler. */
  existencia: number;
  /** A costo estándar. NULL = sin permiso de costo. */
  valor: number | null;
  /** Alguna sucursal con existencia no trae costo en la ficha: el valor se queda corto. */
  valor_incompleto: boolean;
  plazas: Array<{ plaza: string; nombre: string | null }>;
  /** Última venta en el año que se mira. NULL = ninguna. */
  ultima_venta: string | null;
  dias_sin_venta: number | null;
  tramo: TramoSinVenta;
  escalera: UnidadEscalera[] | null;
  /** Hay lotes registrados que caducan o ya caducaron. */
  caducidad: CaducidadResumen | null;
}

export function noSeVende(f: NoSeVendeFila, nombres: Map<string, string>, escalera: UnidadEscalera[] | null,
  puedeVerCosto: boolean, caducidad: CaducidadResumen | null = null): NoSeVende {
  const dias = num(f.dias);
  return {
    product_id: f.product_id, sku: f.sku, nombre: f.nombre,
    existencia: Math.round((num(f.existencia) ?? 0) * 1000) / 1000,
    valor: puedeVerCosto ? r2(num(f.valor) ?? 0) : null,
    valor_incompleto: puedeVerCosto && !!f.sin_costo,
    plazas: (f.plazas ?? []).map((plaza) => ({ plaza, nombre: nombres.get(plaza) ?? null })),
    ultima_venta: f.ultima, dias_sin_venta: dias, tramo: tramoSinVenta(dias), escalera, caducidad,
  };
}

// ─────────────────────────────── [PF.5] márgenes ───────────────────────────────

/** Un renglón de `MARGEN_DETALLE_SQL` (la función de Productos nuevos agrupada). */
export interface MargenFila {
  tipo: 'venta' | 'entrada' | string;
  plaza: string;
  factor: number | string | null;
  unidad_base: string | null;
  n: number | string | null;
  nc: number | string | null;
  c: number | string | null;
  q: number | string | null;
}

/**
 * Arma las fuentes de `margenesDe` (las de `[NP.15]`) desde las filas de la función: por sucursal la venta
 * neta, la que trae costo y su costo; la meta de la ficha ponderada por el peldaño VENDIDO; lo vendido por
 * unidad base; y lo comprado por unidad base. Misma suma que la matvista de Productos nuevos, en TS.
 */
export function fuentesDeMargen(filas: MargenFila[], meta: Array<{ plaza: string; factor: number | string; margen: number | string }>): {
  porPlaza: Map<string, MargenFuente>;
  compra: Record<string, { q: number; i: number }>;
} {
  const metaDe = new Map(meta.map((m) => [`${m.plaza}|${Number(m.factor).toFixed(4)}`, num(m.margen)]));
  const porPlaza = new Map<string, { n: number; nc: number; c: number; nm: number; m: number; b: Record<string, { q: number; n: number }> }>();
  const compra: Record<string, { q: number; i: number }> = {};
  for (const f of filas) {
    const n = num(f.n) ?? 0;
    const u = f.unidad_base ?? '?';
    if (f.tipo === 'entrada') {
      const x = compra[u] ?? { q: 0, i: 0 };
      x.q += num(f.q) ?? 0;
      x.i += n;
      compra[u] = x;
      continue;
    }
    if (f.tipo !== 'venta') continue;
    const p = porPlaza.get(f.plaza) ?? { n: 0, nc: 0, c: 0, nm: 0, m: 0, b: {} };
    p.n += n;
    p.nc += num(f.nc) ?? 0;
    p.c += num(f.c) ?? 0;
    const meta = metaDe.get(`${f.plaza}|${(num(f.factor) ?? 1).toFixed(4)}`);
    if (meta !== undefined && meta !== null) { p.nm += n; p.m += (n * meta) / 100; }
    const b = p.b[u] ?? { q: 0, n: 0 };
    b.q += num(f.q) ?? 0;
    b.n += n;
    p.b[u] = b;
    porPlaza.set(f.plaza, p);
  }
  return { porPlaza: new Map([...porPlaza].map(([k, v]) => [k, v as MargenFuente])), compra };
}

export interface MargenesPlaza {
  plaza: string;
  nombre: string | null;
  margenes: Margenes;
}

export interface MargenesProducto {
  product_id: string;
  /**
   * `[PF.8]` De dónde salió: la matvista nocturna (`foto`, al instante) o la función de Productos nuevos (`en_vivo`,
   * cuando la matvista no está poblada o no llega hasta ayer). Mismo periodo y mismas cifras en los dos casos.
   */
  origen: { fuente: 'foto' | 'en_vivo'; calculado_at: string | null };
  /** Primer día del periodo. */
  desde: string;
  /** Último día del periodo (ayer: lo de hoy no entra en los márgenes). */
  hasta: string;
  dias: number;
  /** NULL = no vendió en el periodo. */
  total: Margenes | null;
  plazas: MargenesPlaza[];
}

/** El margen real de la lista (sólo ése: el de lista y el de lo pagado necesitan el peldaño y la compra). */
export function margenRealDe(n: number | string | null, nc: number | string | null, c: number | string | null): Margen | null {
  return margenesDe([{ n: num(n) ?? 0, nc: num(nc) ?? 0, c: num(c) ?? 0, nm: 0, m: 0 }], undefined)?.real ?? null;
}

export { escaleraDeFicha, existenciaEnDuda };
export type { FichaPlaza, KardexPlaza };

/**
 * `[PF.7]` Lo que «Para cuidar hoy» muestra de cada producto. El análisis completo (motivos, impacto, traspasos,
 * sucursales) lo trae el panel del producto al abrirlo: mandarlo aquí para 545 productos pesaba ~450 KB.
 */
export interface ResumenCuidar {
  product_id: string;
  mes: number;
  variacion: number | null;
  lider: Lider | null;
  caducidad: CaducidadResumen | null;
  agotadas: Array<{ plaza: string; nombre: string | null }>;
  compra: Pick<AnalisisCompra, 'veredicto' | 'titulo'>;
  /** NULL = sin permiso de costo o sin venta. */
  margen_real: Pick<Margen, 'pct' | 'cobertura'> | null;
}

export function resumenCuidar(r: FlujoResumen): ResumenCuidar {
  return {
    product_id: r.product_id, mes: r.mes, variacion: r.variacion, lider: r.lider, caducidad: r.caducidad,
    agotadas: r.agotadas.map((a) => ({ plaza: a.plaza, nombre: a.nombre })),
    compra: { veredicto: r.compra.veredicto, titulo: r.compra.titulo },
    margen_real: r.margen_real ? { pct: r.margen_real.pct, cobertura: r.margen_real.cobertura } : null,
  };
}

/** `[PF.2]`/`[PF.3]` Para cuidar hoy (arriba de la tabla de Productos). */
export interface ProductoACuidar {
  sku: string;
  nombre: string | null;
  resumen: ResumenCuidar;
  /** `[PF.2]` Por qué pide atención (sólo líderes). */
  motivos?: MotivoLider[];
  /** `[PF.2]` Lo que se juega por día (sólo líderes): el orden de la lista. */
  en_juego_dia?: number;
}

export interface CuidarRespuesta {
  /**
   * `[PF.6]` De dónde salió: la foto que el worker calcula cada minuto, o el cálculo en vivo (sin foto o con
   * la foto vieja). `calculado_at` es cuándo se calculó lo que se ve.
   */
  origen?: { fuente: 'foto' | 'en_vivo'; calculado_at: string };
  periodos: Periodos;
  corte: string;
  en_vivo_al: string;
  costo_visible: boolean;
  criterio: typeof CRITERIO_FLUJO;
  lideres: {
    /** Cuántos productos son líderes hoy. */
    total: number;
    /** Cuándo se calculó el ranking (`product_sales_stats.computed_at`). NULL = no se pudo medir. */
    calculado: string | null;
    /** Todos los líderes, por su lugar en la venta de la red, con lo que piden. */
    lista: ProductoACuidar[];
    /** Cuántos líderes por cada motivo. */
    por_motivo: Record<MotivoLider, number>;
  };
  /** `[PF.4]` Lo que no se vende: con existencia y sin venta en la red, primero lo de más dinero detenido. */
  no_se_venden: {
    /** Si se pudieron dejar fuera los productos nuevos (su matvista está poblada). false = pueden aparecer. */
    nuevos_excluidos: boolean;
    /** Cuántos hay (puede ser más que los que se traen). */
    total: number;
    /** Dinero detenido de todos, a costo estándar. NULL = sin permiso de costo. */
    valor_total: number | null;
    por_tramo: Record<TramoSinVenta, number>;
    productos: NoSeVende[];
  };
  caducidad: {
    /** Los productos con un lote caducado, que no alcanza a venderse o que caduca pronto; el más próximo primero. */
    productos: ProductoACuidar[];
    /** Qué tanto se ha registrado: sin fecha registrada NO quiere decir que no caduque. */
    cobertura: { lotes: number; productos: number; sucursales: Array<{ plaza: string; nombre: string | null }> };
  };
}
