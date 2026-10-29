/**
 * `[MX.1.4]` — **Catálogo de excepciones de movimientos de inventario**: qué es cada documento y si
 * va a la bandeja de excepciones (Fase MX; ADR-056: la regla vive una vez, en `libs/`).
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 * Hoy se audita a mano el Diario completo: medido el 2026-10-28, el 90.7 % de 4,282 marcas
 * «auditado» cayó en documentos que el motor ya cuadraba, y sólo 21 tocaron una excepción de 1,222
 * disponibles. La bandeja trae SÓLO lo que el motor no puede dar por bueno; este catálogo es la regla
 * que lo decide, para que la API de la bandeja, el Diario y el PDF no la repitan cada uno a su modo.
 *
 * ── Reglas (decisiones D3 y D5 de la fase) ─────────────────────────────────────────────────
 *  · Traspaso que cuadra (misma suma Y misma firma de productos, MX.1.1) → `cuadrado`, NO va.
 *  · Traspaso en tránsito (a almacén, ≤ 15 días) → `en_transito`, todavía NO va.
 *  · Salida a ruta o cliente → `sin_recepcion_esperada`: nadie emite acuse, NO va.
 *  · Diferencia, sin acuse (> 15 días), recepción sin origen → SÍ va.
 *  · Ajuste de inventario (`InvOut1` / `InvIn1`) → SÍ va siempre: un ajuste ya es una excepción.
 *  · Cualquier otro tipo (compras, ventas, inventario físico, Wincaja) → `sin_comparacion`: el motor
 *    no tiene contra qué compararlo; NO va, y NO se pinta como bueno (ADR-056).
 *  · Un importe incompleto (renglones con costo 0 en Kepler, MX.1.2) se AGREGA como excepción a lo
 *    que ya sea el documento: un traspaso que cuadra en piezas con dinero sin verificar SÍ va.
 */

/**
 * `[MX.1.7]` — **El importe de una SALIDA de traspaso no tiene una sola unidad: depende del destino.**
 * El importe sale del documento (`kdm2.c13`). Medido el 2026-10-28 (MX.0.2):
 *  · a SUCURSAL → valor de traspaso: idéntico al de la recepción en 1,762 de 1,764 pares;
 *  · a CLIENTE  → precio de venta (`c12 ≈ c66`, lista): el kardex (costo) vale 0.83×, 0 de 119 iguales;
 *  · a RUTA     → mezcla: 74 de 181 iguales al kardex, 1.07× en promedio.
 * Ningún total suma las tres sin decirlo.
 */
export type DestinoSalida = 'sucursal' | 'ruta' | 'cliente';
export type UnidadImporte = 'valor_traspaso' | 'precio_venta' | 'mixta';
export const UNIDAD_IMPORTE_SALIDA: Readonly<Record<DestinoSalida, UnidadImporte>> = {
  sucursal: 'valor_traspaso', cliente: 'precio_venta', ruta: 'mixta',
};
export const ETIQUETA_UNIDAD_IMPORTE: Readonly<Record<UnidadImporte, string>> = {
  valor_traspaso: 'valor de traspaso', precio_venta: 'a precio de venta', mixta: 'costo y precio mezclados',
};

/**
 * `[MX.2.3]` — **Respuesta de la bandeja de excepciones** (`GET /commercial/movements/exceptions`).
 * Los totales se calculan sobre el conjunto COMPLETO; `rows` es una página. El importe se suma POR
 * UNIDAD (MX.1.7), nunca en un solo número: una salida a cliente está a precio de venta.
 */
export interface ExcepcionMovimientoItem {
  tipo: 'traspaso' | 'ajuste';
  excepciones: ExcepcionMovimiento[];
  fecha: string;
  /**
   * `[MX.2.4]` El documento al que se refiere la incidencia —el que se abre y se resuelve—: la salida
   * si existe; si no (recepción sin origen), la recepción; en un ajuste, el ajuste.
   */
  documento: { warehouse_id: string; doc_code: string; doc_serie: string; folio: string };
  /** Traspaso: el almacén que envió. Ajuste: el almacén del ajuste. */
  origen: { warehouse_id: string | null; nombre: string | null; folio: string | null; doc_code: string; doc_serie: string | null };
  /** Sólo traspaso: a quién iba (o quién recibió). */
  destino: { warehouse_id: string | null; nombre: string | null; folio: string | null } | null;
  piezas_enviadas: number | null;
  piezas_recibidas: number | null;
  /** Traspaso: recibidas − enviadas. Ajuste: piezas con signo (+ entrada, − salida). */
  delta_piezas: number | null;
  importe: number | null;
  /** `null` = unidad NO MEDIDA (ajustes; recepción sin origen). */
  unidad_importe: UnidadImporte | null;
  lineas_sin_importe: number;
  /** Días desde la salida (traspaso) o desde el ajuste. */
  dias: number;
  /**
   * `[MX.2.4]` DÓNDE está el error, en una línea: el producto y las piezas, no sólo el total
   * («COCADA MINI: salieron 840, llegaron 0»). Lo arma {@link resumirDonde}. Vacío si no se calculó.
   */
  donde: string;
  /** `[MX.2.4]` Cuántos productos del documento explican la incidencia (0 = no calculado). */
  productos_con_error: number;
  /** `[MX.2.4]` Lo que una persona dijo del documento; `null` = nadie lo ha tocado. */
  resolucion: ResolucionIncidencia | null;
}

/**
 * `[MX.2.4]` Estado humano del documento (D8: vive en `commercial.stock_movement_audits`).
 * `motivo: null` = marca «auditado» del Diario SIN motivo: NO cuenta como resuelta.
 */
export interface ResolucionIncidencia {
  motivo: MotivoResolucion | null;
  nota: string | null;
  por: string | null;
  fecha: string | null;
}

export interface MovimientosExcepcionesResponse {
  range: { from: string; to: string };
  totals: {
    items: number;
    /** Por excepción: un ítem con dos excepciones cuenta en las dos. */
    por_excepcion: Partial<Record<ExcepcionMovimiento, { n: number; importe: number }>>;
    /** El importe, separado por unidad; `sin_unidad` = no medida. */
    importe_por_unidad: Record<UnidadImporte | 'sin_unidad', number>;
    /** De cuántos documentos salió la bandeja (para decir qué fracción es excepción). */
    universo: { traspasos: number; ajustes: number };
    /** `[MX.2.4]` Incidencias del rango ya resueltas CON motivo (fuera de `items`, fuera de la lista). */
    resueltas: number;
  };
  /** El pareo trae a lo más 50,000 filas; si llegó, la bandeja está INCOMPLETA. */
  capped: boolean;
  page: number; pageSize: number; total: number;
  rows: ExcepcionMovimientoItem[];
}

/** Por qué un documento está en la bandeja. Un documento puede tener más de una. */
export type ExcepcionMovimiento =
  | 'diferencia'          // piezas o productos distintos entre salida y recepción
  | 'sin_acuse'           // salió a un almacén y nadie registró la recepción en el umbral
  | 'sin_origen'          // recepción sin una salida que la respalde
  | 'ajuste_inventario'   // InvOut1 / InvIn1: siempre se revisa
  | 'importe_incompleto'; // renglones con costo 0 en Kepler: el dinero no se pudo verificar

/** Qué es el documento para el motor, haya o no excepción. */
export type EstadoMovimiento =
  | 'cuadrado'
  | 'en_transito'
  | 'sin_recepcion_esperada'
  | 'sin_comparacion'
  | 'excepcion';

/** Tipos de documento que el motor sí compara (salida ↔ recepción). */
export const DOC_CODES_TRASPASO: readonly string[] = ['TrsfShip', 'TrsfRcv'];
/** Ajustes de inventario: van siempre a la bandeja (decisión D3). */
export const DOC_CODES_AJUSTE: readonly string[] = ['InvOut1', 'InvIn1'];

/** Estado del documento de traspaso como lo publica el motor (`transfer_status` del Diario). */
export type EstadoTraspaso = 'en_transito' | 'sin_acuse' | 'sin_recepcion_esperada' | 'completado' | 'diferencia' | 'sin_origen';

export interface DocumentoAClasificar {
  doc_code: string;
  /** Sólo traspasos: el estado que calculó el motor. Ausente en un traspaso = no se sabe. */
  transfer_status?: EstadoTraspaso | null;
  /** Renglones con costo 0 en Kepler (MX.1.2). */
  lineas_sin_importe?: number | null;
}

export interface ClasificacionMovimiento {
  estado: EstadoMovimiento;
  excepciones: ExcepcionMovimiento[];
  /** `true` = va a la bandeja de excepciones. */
  a_bandeja: boolean;
}

export function clasificarMovimiento(doc: DocumentoAClasificar): ClasificacionMovimiento {
  const excepciones: ExcepcionMovimiento[] = [];
  let estado: EstadoMovimiento;

  if (DOC_CODES_AJUSTE.includes(doc.doc_code)) {
    excepciones.push('ajuste_inventario');
    estado = 'excepcion';
  } else if (DOC_CODES_TRASPASO.includes(doc.doc_code)) {
    switch (doc.transfer_status) {
      case 'completado': estado = 'cuadrado'; break;
      case 'en_transito': estado = 'en_transito'; break;
      case 'sin_recepcion_esperada': estado = 'sin_recepcion_esperada'; break;
      case 'diferencia': excepciones.push('diferencia'); estado = 'excepcion'; break;
      case 'sin_acuse': excepciones.push('sin_acuse'); estado = 'excepcion'; break;
      case 'sin_origen': excepciones.push('sin_origen'); estado = 'excepcion'; break;
      // Un traspaso sin veredicto no se da por bueno: se declara sin comparación.
      default: estado = 'sin_comparacion';
    }
  } else {
    estado = 'sin_comparacion';
  }

  if ((Number(doc.lineas_sin_importe) || 0) > 0 && estado !== 'sin_comparacion') {
    excepciones.push('importe_incompleto');
    estado = 'excepcion';
  }
  return { estado, excepciones, a_bandeja: excepciones.length > 0 };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// [MX.2.4] DÓNDE está el error y con qué MOTIVO se resolvió
// ════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `[MX.2.4]` — **Motivos para dar por resuelta una incidencia** (decisión D8: se guardan en
 * `commercial.stock_movement_audits.resolution_reason`). Codificados para poder contar después
 * cuántas fueron faltante real y cuántas captura; la nota libre va aparte.
 * `aplica` = a qué excepciones se ofrece; `pide_nota` = sin nota no se acepta.
 */
export type MotivoResolucion =
  | 'corregido_en_kepler'
  | 'faltante_confirmado'
  | 'sobrante_confirmado'
  | 'error_de_captura'
  | 'ajuste_justificado'
  | 'costo_revisado'
  | 'otro';

export interface MotivoResolucionDef {
  codigo: MotivoResolucion;
  etiqueta: string;
  aplica: readonly ExcepcionMovimiento[];
  pide_nota: boolean;
}

const TODAS: readonly ExcepcionMovimiento[] = ['diferencia', 'sin_acuse', 'sin_origen', 'ajuste_inventario', 'importe_incompleto'];

export const MOTIVOS_RESOLUCION_MOVIMIENTO: readonly MotivoResolucionDef[] = [
  { codigo: 'corregido_en_kepler', etiqueta: 'Se corrigió el documento en Kepler', aplica: TODAS, pide_nota: false },
  { codigo: 'faltante_confirmado', etiqueta: 'Faltante real: se levantó acta o ajuste', aplica: ['diferencia', 'sin_acuse'], pide_nota: true },
  { codigo: 'sobrante_confirmado', etiqueta: 'Sobrante real: se regularizó', aplica: ['diferencia', 'sin_origen'], pide_nota: false },
  { codigo: 'error_de_captura', etiqueta: 'Error de captura, la mercancía física está bien', aplica: ['diferencia', 'sin_acuse', 'sin_origen', 'ajuste_inventario'], pide_nota: false },
  { codigo: 'ajuste_justificado', etiqueta: 'Ajuste revisado y justificado', aplica: ['ajuste_inventario'], pide_nota: false },
  { codigo: 'costo_revisado', etiqueta: 'Costo 0 revisado: el producto no lleva costo', aplica: ['importe_incompleto'], pide_nota: false },
  { codigo: 'otro', etiqueta: 'Otro motivo', aplica: TODAS, pide_nota: true },
];

/** Los motivos que aplican a un documento: los que cubren ALGUNA de sus excepciones. */
export function motivosPara(excepciones: readonly ExcepcionMovimiento[]): MotivoResolucionDef[] {
  return MOTIVOS_RESOLUCION_MOVIMIENTO.filter((m) => m.aplica.some((e) => excepciones.includes(e)));
}

/** Valida una resolución. Devuelve el error en palabras, o `null` si es aceptable. */
export function validarResolucion(motivo: string | null | undefined, nota: string | null | undefined): string | null {
  const def = MOTIVOS_RESOLUCION_MOVIMIENTO.find((m) => m.codigo === motivo);
  if (!def) return 'Elige un motivo de la lista.';
  if (def.pide_nota && (nota ?? '').trim().length < 3) return `«${def.etiqueta}» necesita una nota que diga qué pasó.`;
  if ((nota ?? '').length > 1000) return 'La nota pasa de 1,000 caracteres.';
  return null;
}

/** Un producto de UN documento, ya sumado (un documento puede repetir el producto en varios renglones). */
export interface RenglonDocumento {
  sku: string;
  producto: string;
  /** Piezas: en un traspaso, sin signo; en un ajuste, con signo (+ entrada, − salida). */
  piezas: number;
  importe: number | null;
  /** Renglones de este producto con costo 0 en Kepler. */
  sin_costo: number;
  /** La serie que trae el documento en el feed (para completar la llave de una recepción). */
  doc_serie?: string;
}

/**
 * Qué le pasó a un producto. `cuadra` = salió y llegó igual · `falta`/`sobra` = llegó distinto ·
 * `no_llego` = salió y no aparece en la recepción · `no_venia` = llegó sin haber salido ·
 * `pendiente` = la recepción no existe todavía · `sin_respaldo` = recepción sin salida ·
 * `ajustado` = renglón de un ajuste.
 */
export type EstadoRenglonMovimiento = 'cuadra' | 'falta' | 'sobra' | 'no_llego' | 'no_venia' | 'pendiente' | 'sin_respaldo' | 'ajustado';

export interface RenglonComparado {
  sku: string;
  producto: string;
  /** Piezas en la salida (`null` = no hay salida: ajuste o recepción sin origen). */
  salida: number | null;
  /** Piezas en la recepción (`null` = no hay recepción). */
  recepcion: number | null;
  /** Traspaso con ambos lados: recepción − salida. Ajuste: piezas con signo. Si no aplica, 0. */
  delta: number;
  /** Importe del renglón en el documento principal (la salida; o la recepción si no hay salida). */
  importe: number | null;
  /** Valor de la diferencia al precio del renglón de salida; `null` si no se puede valuar. */
  importe_diferencia: number | null;
  sin_costo: boolean;
  estado: EstadoRenglonMovimiento;
  /** `true` = este producto es parte de lo que hay que revisar. */
  con_error: boolean;
}

const TOL = 0.01;

/**
 * Compara un documento contra su contraparte PRODUCTO POR PRODUCTO (por SKU, que el feed trae
 * siempre aunque el producto no esté en catálogo). `recepcion === null` = no hay recepción;
 * `salida === null` = no hay salida (recepción sin origen). Para un ajuste: `{ ajuste: renglones }`.
 *
 * Medido el 2026-10-29 sobre las 6 diferencias de 90 días: cada una la explica UN producto, y la
 * suma de los productos con error iguala el Δ del motor en 6 de 6.
 * Orden: primero lo que tiene error, por valor de la diferencia; después lo que cuadra.
 */
export function compararRenglones(
  args: { salida: RenglonDocumento[] | null; recepcion: RenglonDocumento[] | null } | { ajuste: RenglonDocumento[] },
): RenglonComparado[] {
  const out: RenglonComparado[] = [];
  if ('ajuste' in args) {
    for (const r of args.ajuste) {
      out.push({ sku: r.sku, producto: r.producto, salida: null, recepcion: null, delta: r.piezas, importe: r.importe,
        importe_diferencia: r.importe, sin_costo: r.sin_costo > 0, estado: 'ajustado', con_error: true });
    }
  } else {
    const { salida, recepcion } = args;
    const porSku = new Map<string, { producto: string; s: RenglonDocumento | null; r: RenglonDocumento | null }>();
    for (const s of salida ?? []) porSku.set(s.sku, { producto: s.producto, s, r: null });
    for (const r of recepcion ?? []) {
      const e = porSku.get(r.sku);
      if (e) e.r = r; else porSku.set(r.sku, { producto: r.producto, s: null, r });
    }
    for (const [sku, { producto, s, r }] of porSku) {
      const ps = s ? s.piezas : null;
      const pr = r ? r.piezas : null;
      let estado: EstadoRenglonMovimiento;
      if (salida === null) estado = 'sin_respaldo';
      else if (recepcion === null) estado = 'pendiente';
      else if (!s) estado = 'no_venia';
      else if (!r) estado = 'no_llego';
      else if (Math.abs((pr ?? 0) - (ps ?? 0)) < TOL) estado = 'cuadra';
      else estado = (pr ?? 0) < (ps ?? 0) ? 'falta' : 'sobra';
      const delta = salida !== null && recepcion !== null ? (pr ?? 0) - (ps ?? 0) : 0;
      // precio por pieza de la salida; si el producto no salió, el de la recepción
      const base = s && s.piezas && s.importe != null ? s.importe / s.piezas
        : r && r.piezas && r.importe != null ? r.importe / r.piezas : null;
      // el importe sale de la salida (MX.1.2): el costo 0 que cuenta es el de ella; sin salida, el de la recepción
      const sinCosto = s ? s.sin_costo > 0 : (r?.sin_costo ?? 0) > 0;
      out.push({
        sku, producto, salida: ps, recepcion: pr, delta,
        importe: s ? s.importe : r ? r.importe : null,
        importe_diferencia: !delta ? 0 : base != null ? delta * base : null,
        sin_costo: sinCosto, estado,
        con_error: estado !== 'cuadra' || sinCosto,
      });
    }
  }
  const peso = (x: RenglonComparado) => Math.abs(x.importe_diferencia || x.importe || 0);
  return out.sort((a, b) => Number(b.con_error) - Number(a.con_error) || peso(b) - peso(a) || a.producto.localeCompare(b.producto));
}

const pz = (n: number | null) => (n == null ? '—' : n.toLocaleString('es-MX', { maximumFractionDigits: 2 }));
const mas = (n: number, que: string) => (n > 0 ? ` y ${n} ${que}${n === 1 ? '' : 's'} más` : '');

/**
 * `[MX.2.4]` **Dónde está el error, en una línea**, a partir de los renglones ya comparados.
 * El producto con más valor en juego primero; el resto se cuenta. Una frase por excepción, unidas
 * con « · ». `ctx` aporta lo que no está en los renglones (a quién iba, cuántos días lleva).
 */
export function resumirDonde(
  excepciones: readonly ExcepcionMovimiento[],
  renglones: readonly RenglonComparado[],
  ctx: { destino?: string | null; dias?: number } = {},
): string {
  const partes: string[] = [];
  const productos = (n: number) => `${n} producto${n === 1 ? '' : 's'}`;
  for (const e of excepciones) {
    if (e === 'diferencia') {
      const mal = renglones.filter((r) => r.estado === 'falta' || r.estado === 'sobra' || r.estado === 'no_llego' || r.estado === 'no_venia');
      if (!mal.length) { partes.push('Las piezas no cuadran, pero ningún producto por separado explica la diferencia'); continue; }
      const p = mal[0];
      const txt = p.estado === 'no_venia' ? `${p.producto}: llegaron ${pz(p.recepcion)} y no venía en la salida`
        : p.estado === 'no_llego' ? `${p.producto}: salieron ${pz(p.salida)} y no llegó`
        : `${p.producto}: salieron ${pz(p.salida)}, llegaron ${pz(p.recepcion)}`;
      partes.push(txt + mas(mal.length - 1, 'producto'));
    } else if (e === 'sin_acuse') {
      const piezas = renglones.reduce((s, r) => s + (r.salida ?? 0), 0);
      const donde = ctx.destino ? ` en ${ctx.destino}` : '';
      const cuando = ctx.dias != null ? ` en ${ctx.dias} días` : '';
      partes.push(`Nadie registró la recepción${donde}${cuando}: ${productos(renglones.length)}, ${pz(piezas)} piezas`);
    } else if (e === 'sin_origen') {
      partes.push(`Se recibió${ctx.destino ? ` en ${ctx.destino}` : ''} sin una salida que la respalde: ${productos(renglones.length)}`);
    } else if (e === 'ajuste_inventario') {
      const p = renglones[0];
      if (p) partes.push(`${p.producto}: ${p.delta > 0 ? '+' : ''}${pz(p.delta)} piezas${mas(renglones.length - 1, 'producto')}`);
    } else if (e === 'importe_incompleto') {
      const sc = renglones.filter((r) => r.sin_costo);
      if (sc.length) partes.push(`Sin costo en Kepler: ${sc[0].producto}${mas(sc.length - 1, 'producto')}`);
    }
  }
  return partes.join(' · ');
}

/** `[MX.2.4]` Respuesta de `GET /commercial/movements/exceptions/detail`: el documento, producto por producto. */
export interface DetalleIncidenciaMovimiento {
  documento: { warehouse_id: string; nombre: string | null; doc_code: string; doc_serie: string | null; folio: string; fecha: string };
  /** La otra mitad del traspaso, si existe. */
  contraparte: { warehouse_id: string; nombre: string | null; doc_code: string; folio: string; fecha: string } | null;
  /** A quién iba la salida (aunque no haya recepción). */
  destino: string | null;
  excepciones: ExcepcionMovimiento[];
  donde: string;
  renglones: RenglonComparado[];
  resolucion: ResolucionIncidencia | null;
  /** Los motivos que se ofrecen para este documento. */
  motivos: MotivoResolucionDef[];
}
