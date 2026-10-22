/**
 * `[RA-NEG.1]` Lógica PURA del panel «Costo y negociación» de `/compras/pedido`: convierte lo que
 * devuelve SQL en el contrato. Sin I/O, para poder probarla con filas fabricadas.
 * Contrato y fuentes: `libs/contracts/src/http/pedido-negociacion.contract.ts`.
 */
import { MAX_ENTRADAS_NEGOCIACION, type NegociacionAlEstandar, type NegociacionCosto, type NegociacionPagado, type NegociacionPagoMes } from '@megadulces/contracts';

/** Escalera de unidades de la ficha: rótulo y piezas BASE por unidad. */
export interface EscaleraFicha {
  u1: string | null;
  u2: string | null;
  u3: string | null;
  f2: number | null;
  f3: number | null;
}

/** Un renglón de orden de entrada `X-A-20` del proveedor del producto. */
export interface EntradaFila {
  fecha: string;          // AAAA-MM-DD (captura)
  plaza: string;          // código de la sucursal que recibió ('00' = capturada en oficinas, plaza sin resolver)
  folio?: string;
  unidad: string | null;
  cantidad: number;
  costo: number;          // por la unidad del renglón
}

/** Dos costos más cerca que esto son el mismo (centavos de redondeo de Kepler). */
export const TOLERANCIA_COSTO = 0.005;
/** Ventana de lo «reciente» para detectar entradas al costo estándar. */
export const DIAS_RECIENTE = 45;

/** Piezas base por unidad del renglón. `null` = la unidad no está en la escalera: no se adivina. */
export function factorBase(unidad: string | null, e: EscaleraFicha): number | null {
  const u = (unidad ?? '').trim().toUpperCase();
  if (!u) return null;
  if (u === (e.u1 ?? '').toUpperCase()) return 1;
  if (u === (e.u2 ?? '').toUpperCase() && Number(e.f2) > 0) return Number(e.f2);
  if (u === (e.u3 ?? '').toUpperCase() && Number(e.f3) > 0) return Number(e.f3);
  return null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
function mediana(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function restarDias(iso: string, dias: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Lo pagado al proveedor, por unidad base: meses, último, mínimo y las entradas recientes que
 * cayeron EXACTAMENTE en el costo estándar mientras el resto pagaba otra cosa.
 *
 * ⚠️ Esa última no afirma que alguien consiguió un mejor precio: dice que el número coincide al
 * centavo con el estándar, que es lo que Kepler propone al capturar. Medido 2026-10-22 con 70056:
 * Canindo registró $78.5956 en 3 entradas de octubre (= $1,257.53 ÷ 16) y las demás $82.68 la misma
 * semana. Sin renglones de factura en la base, eso se CONFIRMA contra el papel, no se da por hecho.
 */
export function resumirPagado(filas: EntradaFila[], esc: EscaleraFicha, estandarBase: number | null, desde: string, hasta: string): NegociacionPagado {
  const conv: { fecha: string; plaza: string; base: number; costoBase: number }[] = [];
  let sinUnidad = 0;
  for (const f of filas) {
    const k = factorBase(f.unidad, esc);
    if (k == null || !(f.cantidad > 0) || !(f.costo > 0)) { sinUnidad += k == null ? 1 : 0; continue; }
    conv.push({ fecha: f.fecha, plaza: f.plaza, base: f.cantidad * k, costoBase: f.costo / k });
  }
  conv.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  // Atípicos fuera: un renglón a centavo (bonificación o captura rota) no es un precio pagado.
  const med = mediana(conv.map((c) => c.costoBase));
  const atipico = (c: { costoBase: number }) => med > 0 && (c.costoBase < med * 0.2 || c.costoBase > med * 5);
  const atipicos = conv.filter(atipico).length;
  if (atipicos) conv.splice(0, conv.length, ...conv.filter((c) => !atipico(c)));

  const porMes = new Map<string, { base: number; valor: number; min: number; max: number }>();
  for (const c of conv) {
    const m = c.fecha.slice(0, 7);
    const g = porMes.get(m) ?? { base: 0, valor: 0, min: Infinity, max: 0 };
    g.base += c.base; g.valor += c.base * c.costoBase; g.min = Math.min(g.min, c.costoBase); g.max = Math.max(g.max, c.costoBase);
    porMes.set(m, g);
  }
  const meses: NegociacionPagoMes[] = [...porMes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([mes, g]) => ({
    mes, base: r2(g.base), promedio: r4(g.valor / g.base), min: r4(g.min), max: r4(g.max),
  }));

  const ult = conv.at(-1);
  let min: (typeof conv)[number] | undefined;
  for (const c of conv) if (!min || c.costoBase < min.costoBase - TOLERANCIA_COSTO) min = c;

  // Entradas recientes al estándar exacto, sólo si la mayoría reciente pagó OTRA cosa.
  const alEstandar: NegociacionAlEstandar[] = [];
  if (estandarBase != null) {
    const corte = restarDias(hasta, DIAS_RECIENTE);
    const recientes = conv.filter((c) => c.fecha >= corte);
    const enEst = (c: { costoBase: number }) => Math.abs(c.costoBase - estandarBase) <= TOLERANCIA_COSTO;
    const baseEst = recientes.filter(enEst).reduce((s, c) => s + c.base, 0);
    const baseOtra = recientes.filter((c) => !enEst(c)).reduce((s, c) => s + c.base, 0);
    if (baseEst > 0 && baseOtra > baseEst) {
      const g = new Map<string, NegociacionAlEstandar>();
      for (const c of recientes.filter(enEst)) {
        const x = g.get(c.plaza) ?? { sucursal: c.plaza, entradas: 0, base: 0, costo_base: r4(estandarBase) };
        x.entradas++; x.base = r2(x.base + c.base);
        g.set(c.plaza, x);
      }
      alEstandar.push(...[...g.values()].sort((a, b) => b.base - a.base));
    }
  }

  return {
    desde, hasta, meses,
    ultimo: ult ? { fecha: ult.fecha, sucursal: ult.plaza, costo_base: r4(ult.costoBase) } : null,
    minimo: min ? { fecha: min.fecha, sucursal: min.plaza, costo_base: r4(min.costoBase), base: r2(min.base) } : null,
    total_base: r2(conv.reduce((s, c) => s + c.base, 0)),
    total_valor: r2(conv.reduce((s, c) => s + c.base * c.costoBase, 0)),
    renglones: filas.length,
    renglones_sin_unidad: sinUnidad,
    renglones_atipicos: atipicos,
    al_estandar_reciente: alEstandar,
    entradas: [...conv].reverse().slice(0, MAX_ENTRADAS_NEGOCIACION)
      .map((c) => ({ fecha: c.fecha, sucursal: c.plaza, base: r2(c.base), costo_base: r4(c.costoBase) })),
  };
}

/** Una fila de `analytics.v_kepler_standard_cost` (una por sucursal). */
export interface FichaCostoFila {
  sucursal: string;
  costo_estandar: number | null;
  /** El estándar de la CAJA tal como lo guarda Kepler: el de la base sale redondeado a 2 decimales. */
  costo_estandar_u3?: number | null;
  factor_tres?: number | null;
  costo_reposicion_base: number | null;
  precio_ficha: number | null;
  impuesto_pct: number | null;
  margen_ficha_pct: number | null;
  precio_si_conserva_margen: number | null;
  impacto_cogs_30d: number | null;
  venta_neta_30d: number | null;
  veredicto: string | null;
}

/**
 * El costo del producto, tomado de la sucursal que MÁS vende (la misma regla que `precio_ficha` en
 * las señales del workbook) y con el impacto sumado sobre las sucursales con el estándar abajo.
 */
export function resumirCosto(fichas: FichaCostoFila[]): NegociacionCosto {
  const conPrecio = fichas.filter((f) => f.precio_ficha != null && f.precio_ficha > 0);
  const ref = [...conPrecio].sort((a, b) => (Number(b.venta_neta_30d) || 0) - (Number(a.venta_neta_30d) || 0))[0] ?? fichas[0];
  const precios = conPrecio.map((f) => Number(f.precio_ficha));
  const afectadas = fichas.filter((f) => f.veredicto === 'estandar_bajo' && (Number(f.impacto_cogs_30d) || 0) > 0)
    .sort((a, b) => (Number(b.venta_neta_30d) || 0) - (Number(a.venta_neta_30d) || 0));
  // El precio que conserva el margen se lee donde el estándar quedó abajo: en una sucursal al día es
  // igual al precio de hoy y la pantalla concluiría que no hay nada que subir.
  const conserva = afectadas[0] ?? ref;
  return {
    // 78.6 × 16 = $1,257.60, y Kepler dice $1,257.53: el de la base viene redondeado. Se deriva de la caja.
    estandar_base: ref && Number(ref.costo_estandar_u3) > 0 && Number(ref.factor_tres) > 1
      ? Math.round((Number(ref.costo_estandar_u3) / Number(ref.factor_tres)) * 1e6) / 1e6
      : ref?.costo_estandar != null ? Number(ref.costo_estandar) : null,
    reposicion_base: ref?.costo_reposicion_base != null ? Number(ref.costo_reposicion_base) : null,
    precio_ficha: ref?.precio_ficha != null ? Number(ref.precio_ficha) : null,
    impuesto_pct: ref?.impuesto_pct != null ? Number(ref.impuesto_pct) : null,
    precio_igual_en_todas: precios.length > 0 && Math.max(...precios) - Math.min(...precios) <= TOLERANCIA_COSTO,
    margen_ficha_pct: ref?.margen_ficha_pct != null ? Number(ref.margen_ficha_pct) : null,
    precio_conserva_margen: conserva?.precio_si_conserva_margen != null ? Number(conserva.precio_si_conserva_margen) : null,
    impacto_30d: r2(afectadas.reduce((s, f) => s + Number(f.impacto_cogs_30d), 0)),
    sucursales_afectadas: afectadas.map((f) => f.sucursal).sort(),
  };
}
