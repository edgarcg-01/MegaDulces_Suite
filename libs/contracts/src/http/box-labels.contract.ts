import { diaMxDeInstante } from '../finance/dia-negocio.contract';

/**
 * `[RE.ETQ]` Etiquetas de caja en la TSC TE200 — el contrato que comparten la API y la pantalla.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_ETQ_GR_ETIQUETAS_GRANEL.md`. La regla de cada campo sale de la forma
 * vigente de Kepler (`MD_OE.rep_etiq`, leída el 2026-11-05 y el 2026-11-19) y de las decisiones D1–D6:
 *
 *  · Una etiqueta por caja del renglón: `1:20 … 20:20`. Kepler imprime `floor(c56)` y la caja incompleta se
 *    queda sin etiqueta; la Suite le imprime una más que dice sus piezas sueltas (`[RE.ETQ.1.5]`).
 *  · UXC = `kdm2.c58` del renglón, no el catálogo (factor 0 en el 39 % de los renglones en caja).
 *  · Código = `C` + clave en toda unidad de empaque (D5).
 *  · Fecha (D6) = el día de la PRIMERA impresión, en la cuenta de Kepler (1-ene = 0) y hora de la Ciudad de
 *    México. La pone el SERVIDOR y la reimpresión la repite: si se recalculara, la etiqueta de reemplazo no
 *    coincidiría con sus hermanas (el defecto 4 de Kepler).
 */

/** Las unidades de empaque que llevan etiqueta (las mismas que la forma vigente de Kepler). */
export const UNIDADES_CON_ETIQUETA = ['CJA', 'BTO', 'CUB'] as const;

/** Vía A: el navegador con el controlador de Windows. Vía B: comandos TSPL directos (D3). */
export type BoxLabelVia = 'navegador' | 'tspl';
export const BOX_LABEL_VIAS: readonly BoxLabelVia[] = ['navegador', 'tspl'];

export type BoxLabelMotivo = 'primera' | 'reimpresion';

/** Lo que la pantalla avisa por renglón. Ninguno impide imprimir. */
export type BoxLabelAvisoTipo =
  | 'caja_incompleta'
  | 'kepler_no_lee_codigo'
  | 'catalogo_factor_0'
  | 'catalogo_factor_distinto'
  | 'kepler_caja_otra_unidad'
  | 'sin_catalogo';

export interface BoxLabelAviso {
  tipo: BoxLabelAvisoTipo;
  texto: string;
}

/** Un renglón de `analytics.v_box_label_lines`, tal como lo entrega la API. */
export interface BoxLabelLineRow {
  sucursal: string;
  sucursal_nombre: string | null;
  serie: number;
  folio: string;
  linea: number;
  sku: string;
  nombre: string | null;
  unidad: string;
  unidad_base: string | null;
  uxc: number | null;
  cajas: number | null;
  cajas_completas: number;
  piezas_sueltas: number;
  codigo: string;
  kepler_unidad_caja: string | null;
  kepler_factor_caja: number | null;
  kepler_codigo_caja: string | null;
  sin_catalogo: boolean;
}

/** Lo que la bitácora sabe de un renglón. */
export interface BoxLabelLineEstado {
  /** Cuántas etiquetas DISTINTAS del renglón se han enviado a imprimir (de `total_etiquetas`). */
  enviadas: number;
  /** Los consecutivos que falta enviar (1..total menos los enviados): lo que imprime «Imprimir» de un clic. */
  pendientes: number[];
  /** La primera vez: su fecha impresa queda congelada. `null` = nunca se envió. */
  primera: { fecha_etiqueta: string; enviada_at: string; usuario: string | null } | null;
  reimpresiones: number;
}

export interface BoxLabelLine extends BoxLabelLineRow, BoxLabelLineEstado {
  total_etiquetas: number;
  avisos: BoxLabelAviso[];
}

export type BoxLabelOrderEstado = 'por_etiquetar' | 'parcial' | 'enviada';

export interface BoxLabelOrder {
  sucursal: string;
  sucursal_nombre: string | null;
  serie: number;
  folio: string;
  /** Día en que se capturó la orden en Kepler (`kdm1.c68`). No se imprime (D6). */
  capturada_el: string | null;
  capturada_hora: string | null;
  fecha_documento: string | null;
  vale_folio: string | null;
  /** Día en que se capturó el vale (la llegada). No se imprime: mide el atraso llegada → etiqueta. */
  vale_capturado_el: string | null;
  renglones: BoxLabelLine[];
  etiquetas_total: number;
  etiquetas_enviadas: number;
  estado: BoxLabelOrderEstado;
}

export interface BoxLabelOrdersResponse {
  ordenes: BoxLabelOrder[];
  date_from: string;
  date_to: string;
  /** Sucursales que el alcance del usuario deja ver. `null` = todas. */
  sucursales: string[] | null;
  /**
   * La última orden de entrada que trajo el ODS (frescura, ADR-056), con su zona: la hora de captura de Kepler es la
   * de la Ciudad de México (`-06:00`, sin horario de verano desde 2022). `null` = no se pudo medir.
   */
  ods_ultima_captura: string | null;
  generado_at: string;
}

/** Lo que la pantalla pide imprimir. Sin `consecutivos` = todas las etiquetas del renglón. */
export interface BoxLabelPrintRequest {
  sucursal: string;
  serie: number;
  folio: string;
  renglones: Array<{ linea: number; consecutivos?: number[] }>;
  via: BoxLabelVia;
}

/** Una etiqueta lista para dibujar (navegador) o para mandar en TSPL. */
export interface EtiquetaCaja {
  clave: string;
  codigo: string;
  /** `7:20` */
  consecutivo: string;
  n: number;
  total: number;
  /** `UXC 18` o, en la caja incompleta, `6 PZA`. */
  contenido: string;
  /** `320-26` */
  fecha: string;
  nombre: string;
  /** `Suc 08 Sucursal Morelia Abastos` */
  pie: string;
  incompleta: boolean;
}

export interface BoxLabelPrintResponse {
  etiquetas: EtiquetaCaja[];
  /** Un registro de la bitácora por renglón enviado. */
  registros: Array<{ linea: number; motivo: BoxLabelMotivo; fecha_etiqueta: string; consecutivos: number[] }>;
}

/** Defectos del catálogo de Kepler en lo recibido, para que Compras los corrija allá (la Suite no escribe Kepler). */
export interface BoxLabelCatalogDefect {
  sucursal: string;
  sku: string;
  nombre: string | null;
  unidad: string;
  uxc_recibida: number | null;
  kepler_factor_caja: number | null;
  kepler_codigo_caja: string | null;
  kepler_unidad_caja: string | null;
  defectos: BoxLabelAvisoTipo[];
  renglones: number;
  ultima_captura: string | null;
}

/** `GET commercial/receiving/box-labels/catalog-defects`: los defectos y el periodo que se leyó. */
export interface BoxLabelCatalogDefectsResponse {
  defectos: BoxLabelCatalogDefect[];
  date_from: string;
  date_to: string;
}

// ── Reglas puras ───────────────────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Texto de una cantidad sin ceros sobrantes: 18 → "18", 0.5 → "0.5", 12.25 → "12.25". */
export function cantidadTexto(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

/**
 * La fecha de la etiqueta en la cuenta de Kepler: días desde el 1-ene **contando el 1-ene como 0**, sin ceros a
 * la izquierda, y el año a 2 dígitos (`fnDate("dif", fecha, anio&"-01-01")` en `MD_OE.rep_etiq`). El día es el
 * de la Ciudad de México: impresa a las 23:30 del 17-nov (05:30 UTC del 18) sigue siendo `320-26`.
 * Devuelve `null` si el instante no se puede leer: una fecha que no se pudo calcular no se imprime.
 */
export function fechaKepler(instante: Date | string): string | null {
  const dia = diaMxDeInstante(instante);
  if (!dia) return null;
  const [y, m, d] = dia.split('-').map(Number);
  const doy = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000);
  return `${doy}-${String(y).slice(-2)}`;
}

/** Pie de la etiqueta, como Kepler: `"Suc " & clave & " " & nombre`. */
export function pieSucursal(sucursal: string, nombre: string | null): string {
  return `Suc ${sucursal}${nombre ? ` ${nombre}` : ''}`;
}

/** Cuántas etiquetas lleva un renglón: una por caja completa, más una si hay piezas sueltas. */
export function totalEtiquetas(l: Pick<BoxLabelLineRow, 'cajas_completas' | 'piezas_sueltas'>): number {
  const completas = Math.max(0, Math.floor(num(l.cajas_completas) ?? 0));
  return completas + ((num(l.piezas_sueltas) ?? 0) > 0 ? 1 : 0);
}

/**
 * Las etiquetas de un renglón. `consecutivos` elige cuáles (reimpresión de una sola, p. ej. `[7]`); fuera de
 * rango se ignoran. La caja incompleta es la última y dice sus piezas sueltas en la unidad base del renglón.
 */
export function etiquetasDelRenglon(
  l: Pick<BoxLabelLineRow, 'sku' | 'codigo' | 'nombre' | 'sucursal' | 'sucursal_nombre' | 'uxc' | 'cajas_completas' | 'piezas_sueltas' | 'unidad_base'>,
  fecha: string,
  consecutivos?: readonly number[] | null,
): EtiquetaCaja[] {
  const total = totalEtiquetas(l);
  const completas = Math.max(0, Math.floor(num(l.cajas_completas) ?? 0));
  const sueltas = num(l.piezas_sueltas) ?? 0;
  const uxc = num(l.uxc);
  const elegidos = consecutivos && consecutivos.length
    ? [...new Set(consecutivos.map((n) => Math.trunc(n)))].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b)
    : Array.from({ length: total }, (_, i) => i + 1);
  return elegidos.map((n) => {
    const incompleta = n > completas;
    return {
      clave: l.sku,
      codigo: l.codigo,
      consecutivo: `${n}:${total}`,
      n,
      total,
      contenido: incompleta
        ? `${cantidadTexto(sueltas)} ${l.unidad_base ?? 'PZA'}`
        : uxc != null ? `UXC ${cantidadTexto(uxc)}` : 'UXC ?',
      fecha,
      nombre: l.nombre ?? l.sku,
      pie: pieSucursal(l.sucursal, l.sucursal_nombre),
      incompleta,
    };
  });
}

/** Los avisos de un renglón, en el orden en que importan al que imprime. */
export function avisosDelRenglon(l: BoxLabelLineRow): BoxLabelAviso[] {
  const out: BoxLabelAviso[] = [];
  const sueltas = num(l.piezas_sueltas) ?? 0;
  const uxc = num(l.uxc);
  const fk = num(l.kepler_factor_caja);
  if (sueltas > 0) {
    out.push({ tipo: 'caja_incompleta', texto: `Caja incompleta: la última lleva ${cantidadTexto(sueltas)} ${l.unidad_base ?? 'PZA'} sueltas (Kepler no le imprime etiqueta).` });
  }
  if (l.sin_catalogo) {
    out.push({ tipo: 'sin_catalogo', texto: `El producto ${l.sku} no está en el catálogo de Kepler de esta sucursal.` });
    return out;
  }
  if ((l.kepler_codigo_caja ?? '').toUpperCase() !== l.codigo.toUpperCase()) {
    out.push({ tipo: 'kepler_no_lee_codigo', texto: `Kepler no reconoce ${l.codigo}: el producto no tiene ese código de caja en Kepler. La Suite sí lo lee.` });
  }
  if (fk == null || fk === 0) {
    out.push({ tipo: 'catalogo_factor_0', texto: `En el catálogo de Kepler el factor de caja está en 0; la UXC sale de la orden de entrada.` });
  } else if (uxc != null && fk !== uxc) {
    out.push({ tipo: 'catalogo_factor_distinto', texto: `La orden trae ${cantidadTexto(uxc)} por caja y el catálogo de Kepler dice ${cantidadTexto(fk)}; se imprime lo de la orden.` });
  }
  if ((l.kepler_unidad_caja ?? '') !== (l.unidad ?? '')) {
    out.push({
      tipo: 'kepler_caja_otra_unidad',
      texto: l.kepler_unidad_caja
        ? `En Kepler la caja de este producto es ${l.kepler_unidad_caja}, y el renglón llegó en ${l.unidad}.`
        : `En Kepler este producto no tiene unidad de caja; el renglón llegó en ${l.unidad}.`,
    });
  }
  return out;
}

/** El estado de una orden a partir de lo enviado. */
export function estadoDeOrden(total: number, enviadas: number): BoxLabelOrderEstado {
  if (enviadas <= 0) return 'por_etiquetar';
  return enviadas >= total ? 'enviada' : 'parcial';
}

/** ¿El pedido de impresión tiene forma válida? Devuelve el problema en texto, o `null`. */
export function validarPedidoImpresion(p: Partial<BoxLabelPrintRequest> | null | undefined): string | null {
  if (!p) return 'Falta el pedido de impresión.';
  if (!/^\d{2}$/.test(String(p.sucursal ?? ''))) return 'La sucursal debe ser una clave de 2 dígitos.';
  if (!Number.isInteger(Number(p.serie))) return 'Falta la serie de la orden.';
  if (!String(p.folio ?? '').trim()) return 'Falta el folio de la orden.';
  if (!BOX_LABEL_VIAS.includes(p.via as BoxLabelVia)) return 'La vía de impresión debe ser «navegador» o «tspl».';
  if (!Array.isArray(p.renglones) || !p.renglones.length) return 'Elige al menos un renglón.';
  for (const r of p.renglones) {
    if (!Number.isInteger(Number(r?.linea))) return 'Cada renglón necesita su número de línea.';
    if (r.consecutivos != null && (!Array.isArray(r.consecutivos) || r.consecutivos.some((n) => !Number.isInteger(Number(n)) || Number(n) < 1))) {
      return 'Los consecutivos son números de etiqueta desde 1.';
    }
  }
  return null;
}
