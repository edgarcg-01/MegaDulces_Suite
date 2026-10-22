/**
 * `[COT.ENTREGABLE]` — Generación de entregables formales de cotización al cliente
 * en formato PDF (jsPDF + autoTable) y Excel (.xlsx vía exceljs).
 *
 * Satisface los requerimientos de Dirección Comercial:
 * 1. Nombre de archivo exacto: (NUMERO CLIENTE)(NOMBRE CLIENTE)(AAAA,MM,DD,HH,MM).pdf / .xlsx
 * 2. Leyenda en formato Marca de Agua tanto en PDF como en XLSX:
 *    "ESTO ES UNA COTIZACION, NO UNA VENTA, EFECTOS INFORMATIVOS PARA EL CLIENTE QUE SOLICITO LA INFORMACION"
 * 3. En productos de unidad mayor (CJA/Caja), cálculo del precio unitario de unidad menor
 *    posterior al precio unitario dentro del mismo cuadro:
 *    Ejemplo: PAL JUMBO CEREZA  CJA  1  $969.84 (12 PAQ 80.82)  969.84
 * 4. Si incluye descuento, columna "Descuento" entre Cantidad y P. Unitario, con encabezados
 *    "P. Unitario Neto" e "Importe Neto" para que el cliente vea claramente el precio neto.
 */

import type jsPDFType from 'jspdf';
import { totalesCotizacion, type QuoteTotals } from '@megadulces/contracts';
import { desglose } from './quote-units';
import { PALETA_DOCUMENTO as P, rgb, argb } from '../../shared/util/paleta-documento';

export type JsPDFCtor = typeof jsPDFType;
export type AutoTableFn = (doc: jsPDFType, options: Record<string, unknown>) => void;

export interface QuoteDeliverableItem {
  sku: string;
  name: string;
  barcode?: string | null;
  content?: string | null;
  unit_label: string;
  rung?: string | null;
  factor?: number | null;
  /**
   * Abreviatura de la unidad BASE (PZA, PAQ, KG…) para el desglose "(12 PAQ $41.82)". Sin ella
   * el papel decía "12PZS" también para un bulto de 20 KG (COT.16). Ausente = PZA, lo de antes.
   */
  base_unit?: string | null;
  /**
   * Unidades base del PAQUETE que va dentro de la unidad mayor (KINDER: 10 dentro de la caja de
   * 140). Con él el desglose muestra también la unidad del medio: "(14 PAQ 121.86 · 140 PZA
   * 12.19)" (COT.17). Sólo en renglones de unidad mayor; ausente = sin paquete, como antes.
   */
  pack_size?: number | null;
  quantity: number;
  /** Precio cotizado de la unidad (YA trae volumen/promo). null = sin precio. */
  unit_price: number | null;
  line_total: number;
  price_source?: string;
  free_goods?: { sku: string; quantity: number } | null;
  /** Renglón de regalo del ERP (precio cero REAL): se imprime «Regalo», no $0.00. */
  regalo?: boolean;
  /**
   * `[E.25]` IVA e IEPS del producto (fracción, `kdii.c18`/`c19`). Ausentes o null = cotización
   * anterior a E.25: la cuenta ASUME IVA 16 % y las condiciones lo dicen.
   */
  iva_rate?: number | null;
  ieps_rate?: number | null;
  // ⛔ `[E.19]` Ya no hay `discount_pct` por renglón. El único descuento que el papel aplica es
  // el del CLIENTE (`QuoteDeliverableData.discountPct`, capa de documento). El de volumen/promo
  // ya está dentro de `unit_price`: pasarlo acá lo aplicaba DOS veces (auditoría C2).
}

export interface QuoteDeliverableData {
  /**
   * Folio de la cotización (COT-YYYY-NNNNN).
   *
   * NULL significa **una cosa concreta**: este papel todavía no está respaldado por ninguna
   * fila. El documento lo dice con todas sus letras en vez de omitirlo, porque un entregable
   * sin folio y sin aviso es imposible de volver a encontrar cuando el cliente llama citándolo.
   */
  quoteCode?: string | null;
  customerCode: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  branchCode: string;
  branchName: string;
  salespersonCode?: string | null;
  salespersonName?: string | null;
  /** Fecha de la COTIZACIÓN (no la de hoy): es la que se imprime como emisión. */
  quoteDate?: string | Date;
  validUntil: string;
  items: QuoteDeliverableItem[];
  /**
   * `[E.19]` El % negociado del cliente, congelado en la cotización. Es TODO lo que el papel
   * necesita: importe, descuento, total, IVA y netos salen de `totalesCotizacion` (libs/contracts),
   * la misma cuenta que el servidor. Ya no se reciben `subtotal`/`total` sueltos: cada pantalla
   * los armaba distinto y el papel no cerraba (auditoría C1).
   */
  discountPct: number | null;
  /**
   * `[E.29]` Plazo de pago del cliente en esa sucursal (`kdud.c16`), congelado en la cotización
   * (`terms_payment_days`). La cotización (VEN-001) promete condiciones de pago: se imprimen las
   * del ERP. null/ausente = sin dato, y entonces no se imprime ninguna (no se inventa «contado»).
   */
  paymentDays?: number | null;
  /**
   * El total que GUARDÓ el servidor. Si viene y la cuenta no lo reproduce al centavo, el papel
   * NO se genera: un entregable con un total distinto al de la base no se le manda a nadie.
   */
  totalGuardado?: number | null;
  /** Lo que la cabecera tiene que avisar. Ausente = vigente. */
  estado?: 'borrador' | 'vigente' | 'vencida' | 'cancelada';
  /** Notas PARA EL CLIENTE. ⛔ No el mensaje crudo que pegó el operador (`customer_request`). */
  notes?: string | null;
  /**
   * `[E.29]` Control del documento. `actualizada` = última modificación de la cotización: un
   * borrador se puede editar después de enviarlo, y sin esto dos papeles con el MISMO folio y
   * distinto contenido no se distinguían. `elaboro` = quién la capturó. `orderCode` = el pedido
   * en que se convirtió, si ya se convirtió.
   */
  actualizada?: string | Date | null;
  elaboro?: string | null;
  orderCode?: string | null;
}

/** Una fila del papel, ya resuelta. Los dos formatos (PDF y Excel) pintan esto y nada más. */
export interface FilaEntregable {
  n: number;
  item: QuoteDeliverableItem;
  tipo: 'precio' | 'sin_precio' | 'regalo';
  /** Precio unitario que se imprime: el neto (con el % del cliente) si hay descuento. */
  unitario: number | null;
  /** Importe que se imprime: el neto repartido (Σ = total) si hay descuento. */
  importe: number | null;
}

export interface ModeloEntregable {
  conDescuento: boolean;
  filas: FilaEntregable[];
  totales: QuoteTotals;
  emision: Date;
  titulo: string;
  /** true = el título va en rojo (vencida, cancelada). */
  alerta: boolean;
}

/**
 * `[E.19]` Arma el papel. Pura: no dibuja nada, y es lo que prueba `quote-deliverable-export.spec`.
 *
 * Lanza si `totalGuardado` viene y no coincide con la cuenta: preferible no entregar a entregar
 * un precio distinto al de la base.
 */
export function modeloEntregable(data: QuoteDeliverableData): ModeloEntregable {
  const tipoDe = (it: QuoteDeliverableItem): FilaEntregable['tipo'] =>
    it.regalo ? 'regalo' : it.unit_price === null ? 'sin_precio' : 'precio';
  const importes = data.items.map((it) => {
    const t = tipoDe(it);
    return t === 'sin_precio' ? null : t === 'regalo' ? 0 : Number(it.line_total) || 0;
  });
  const totales = totalesCotizacion(
    importes,
    data.discountPct,
    data.items.map((it) => ({ iva: it.iva_rate ?? null, ieps: it.ieps_rate ?? null })),
  );
  if (data.totalGuardado !== undefined && data.totalGuardado !== null
      && Math.abs(totales.total - Number(data.totalGuardado)) > 0.005) {
    throw new Error(
      `La cuenta del papel (${moneyFormat(totales.total)}) no coincide con el total guardado `
      + `(${moneyFormat(Number(data.totalGuardado))}). No se genera el entregable: recargá la cotización.`,
    );
  }
  const conDescuento = totales.descuento_pct !== null;
  const filas: FilaEntregable[] = data.items.map((it, i) => {
    const tipo = tipoDe(it);
    if (tipo !== 'precio') return { n: i + 1, item: it, tipo, unitario: null, importe: null };
    const importe = conDescuento ? (totales.netos[i] as number) : Number(it.line_total) || 0;
    const unitario = conDescuento
      ? (it.quantity > 0 ? importe / it.quantity : null)
      : it.unit_price;
    return { n: i + 1, item: it, tipo, unitario, importe };
  });
  // `[E.29]` `AAAA-MM-DD` (lo que manda el servidor) se lee en hora LOCAL: `new Date(iso)` es la
  // medianoche UTC, que en México todavía es el día ANTERIOR, y el papel imprimía la emisión un
  // día antes.
  const fecha = data.quoteDate instanceof Date ? data.quoteDate
    : fechaDeIso(data.quoteDate) ?? (data.quoteDate ? new Date(data.quoteDate) : new Date());
  const emision = isNaN(fecha.getTime()) ? new Date() : fecha;
  const titulo = data.estado === 'cancelada' ? 'COTIZACIÓN CANCELADA'
    : data.estado === 'vencida' ? 'COTIZACIÓN VENCIDA'
    : 'COTIZACIÓN FORMAL';
  return { conDescuento, filas, totales, emision, titulo, alerta: data.estado === 'cancelada' || data.estado === 'vencida' };
}

/** Lo que va en la columna de precio unitario: el precio y, si es unidad mayor, su desglose. */
function etiquetaUnitario(f: FilaEntregable): string {
  if (f.tipo === 'regalo') return 'Regalo';
  if (f.tipo === 'sin_precio' || f.unitario === null) return 'Sin precio';
  const factor = getFactor(f.item);
  return isUnidadMayor(f.item) && factor && factor > 1
    ? `${moneyFormat(f.unitario)} ${etiquetaDesglose(factor, f.item.base_unit, f.unitario / factor, f.item.pack_size)}`
    : moneyFormat(f.unitario);
}

/** Lo que va en la columna de importe: nunca $0.00 por algo que no tiene precio (ADR-056). */
function etiquetaImporte(f: FilaEntregable): string {
  if (f.tipo === 'regalo') return 'Regalo';
  if (f.tipo === 'sin_precio' || f.importe === null) return 'Sin precio';
  return moneyFormat(f.importe);
}

function fechaCorta(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** `[E.29]` Fecha y hora de GENERACIÓN del archivo (distinta de la emisión de la cotización). */
export function fechaHora(d: Date): string {
  return `${fechaCorta(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * `[E.29]` La vigencia llega como `AAAA-MM-DD` y se imprimía así, al lado de una emisión en
 * `dd/mm/aaaa`: dos formatos de fecha en el mismo papel. Se lee en hora LOCAL (con `new Date(iso)`
 * sería medianoche UTC = el día anterior en México). Lo que no parsea se devuelve tal cual.
 */
export function fechaVigencia(validUntil: string | null | undefined): { texto: string; fecha: Date | null } {
  const fecha = fechaDeIso(validUntil);
  return fecha ? { texto: fechaCorta(fecha), fecha } : { texto: validUntil || 'término indicado', fecha: null };
}

/** `AAAA-MM-DD` como medianoche LOCAL. null si no tiene esa forma. */
export function fechaDeIso(v: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((v ?? '').trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * `[E.29]` ExcelJS escribe las fechas en UTC: una hora local de las 14:05 en México salía 20:05 en
 * la hoja. Se le pasa la hora de pared local como si fuera UTC.
 */
export function paraExcel(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
}

/**
 * `[E.29]` Identificador de la PLANTILLA (no del documento): con él se sabe con qué reglas de
 * formato salió un papel que alguien trae impreso. Se sube al cambiar la estructura del papel.
 */
export const PLANTILLA_COTIZACION = 'VEN-001 v2';

/**
 * `[E.29]` La línea de control del pie: folio, versión (última modificación), quién la elaboró y
 * el pedido al que se convirtió. Sólo lo que hay: un dato ausente no se imprime vacío.
 */
export function lineaControl(data: QuoteDeliverableData): string {
  const act = data.actualizada ? new Date(data.actualizada) : null;
  return [
    `Folio ${data.quoteCode || 'SIN ASIGNAR'}`,
    act && !isNaN(act.getTime()) ? `Versión del ${fechaHora(act)}` : null,
    data.elaboro ? `Elaboró ${data.elaboro}` : null,
    data.orderCode ? `Pedido ${data.orderCode}` : null,
  ].filter(Boolean).join(' · ');
}

/** Las condiciones que se imprimen al pie, en orden. */
export function condiciones(data: QuoteDeliverableData, m: ModeloEntregable): string[] {
  const out = [
    'Precios expresados en Moneda Nacional (MXN) con impuestos incluidos.',
    'ESTO ES UNA COTIZACIÓN, NO UNA VENTA. Efectos informativos para el cliente que solicitó la información.',
    'Precios y promociones sujetos a existencias físicas al confirmar su pedido formal.',
    // La sucursal por NOMBRE: el código («01») no le dice nada al cliente.
    `Válida hasta el ${fechaVigencia(data.validUntil).texto} en ${data.branchName}.`,
  ];
  if (data.paymentDays !== null && data.paymentDays !== undefined && Number.isFinite(Number(data.paymentDays))) {
    const d = Number(data.paymentDays);
    out.push(d > 0 ? `Plazo de pago: ${d} días de crédito.` : 'Plazo de pago: de contado (sin días de crédito).');
  }
  if (m.totales.sin_precio > 0) {
    out.push(`${m.totales.sin_precio} artículo(s) sin precio: se cotizan aparte y no están en el total.`);
  }
  if (m.totales.impuesto_asumido > 0) {
    out.push(`Impuesto estimado en ${m.totales.impuesto_asumido} artículo(s): IVA 16 % asumido, sin la tasa del producto.`);
  }
  // Completa: antes se cortaba a 90 caracteres sin avisar. El PDF la parte en renglones.
  if (data.notes) out.push(`Nota: ${data.notes}`);
  return out;
}

export const EMPRESA_NOMBRE = 'MEGA DULCES DE LOS ALTOS S.A. DE C.V.';
export const EMPRESA_SLOGAN = 'Venta de Mayoreo y Medio Mayoreo en Confitería y Abarrotes';
export const LOGO_URL = 'assets/logos/mega-dulces-logo-print.png';

export const LEYENDA_MARCA_AGUA =
  'ESTO ES UNA COTIZACION, NO UNA VENTA, EFECTOS INFORMATIVOS PARA EL CLIENTE QUE SOLICITO LA INFORMACION';

let cachedPdfLibs: Promise<{ jsPDF: JsPDFCtor; autoTable: AutoTableFn }> | null = null;

export function loadPdfLibs(): Promise<{ jsPDF: JsPDFCtor; autoTable: AutoTableFn }> {
  cachedPdfLibs ??= Promise.all([import('jspdf'), import('jspdf-autotable')]).then(([a, b]) => ({
    jsPDF: a.default as unknown as JsPDFCtor,
    autoTable: b.default as unknown as AutoTableFn,
  }));
  return cachedPdfLibs;
}

export async function loadLogo(): Promise<string | null> {
  try {
    const res = await fetch(LOGO_URL);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function loadExcelLib(): Promise<any> {
  const mod = (await import('exceljs')) as unknown as Record<string, any>;
  return mod['default'] ?? mod;
}

/**
 * Genera el nombre del archivo según el formato requerido:
 * (NUMERO CLIENTE)(NOMBRE CLIENTE)(AAAA,MM,DD,HH,MM).ext
 */
export function generateQuoteFilename(data: QuoteDeliverableData, ext: 'pdf' | 'xlsx'): string {
  // El folio va PRIMERO cuando existe: es lo único con lo que el operador puede volver a
  // encontrar el documento que el cliente tiene en la mano. Sin él, el archivo sólo se podía
  // ubicar por cliente y hora, que es justo lo que no se recuerda por teléfono.
  const folio = (data.quoteCode || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  const code = (data.customerCode || 'PROSPECTO').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const name = (data.customerName || 'CLIENTE')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32)
    .toUpperCase();

  const dateObj = data.quoteDate ? new Date(data.quoteDate) : new Date();
  const validDate = isNaN(dateObj.getTime()) ? new Date() : dateObj;
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${validDate.getFullYear()},${pad(validDate.getMonth() + 1)},${pad(validDate.getDate())},${pad(validDate.getHours())},${pad(validDate.getMinutes())}`;

  return folio
    ? `${folio}(${code})(${name})(${timestamp}).${ext}`
    : `(${code})(${name})(${timestamp}).${ext}`;
}

export function formatDec(n: number | null | undefined): string {
  const val = Number(n) || 0;
  return val.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function moneyFormat(n: number | null | undefined): string {
  const val = Number(n) || 0;
  return '$' + val.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Desglose de la unidad menor que acompaña al precio de una unidad mayor: "(12 PAQ 80.82)".
 * La unidad es la BASE del producto (PAQ, KG, PZA…); antes era "PZS" fijo y un bulto de 20 KG
 * salía como "(20PZS 56.50)" en el papel del cliente (COT.16). Sin unidad conocida → PZA.
 *
 * Con `packSize`, también la unidad del MEDIO, de mayor a menor: la caja de KINDER sale
 * "(14 PAQ 121.86 · 140 PZA 12.19)" — antes se perdía el paquete (COT.17).
 */
export function etiquetaDesglose(
  factor: number,
  baseUnit: string | null | undefined,
  precioMenor: number,
  packSize?: number | null,
): string {
  const pasos = desglose(precioMenor * factor, factor, baseUnit, packSize);
  return `(${pasos.map((p) => `${p.cantidad} ${p.unidad} ${formatDec(p.precio)}`).join(' · ')})`;
}

/**
 * Obtiene el factor de piezas de la unidad mayor (CJA/PAQ) si aplica.
 */
export function getFactor(it: QuoteDeliverableItem): number | null {
  if (it.factor && it.factor > 1) return it.factor;
  const match = (it.content || it.name || '').match(/(\d+)\s*(?:pzas?|pz|piezas?)/i) || (it.content || '').match(/^(\d+)\//);
  if (match) {
    const f = Number(match[1]);
    if (Number.isFinite(f) && f > 1) return f;
  }
  return null;
}

export function isUnidadMayor(it: QuoteDeliverableItem): boolean {
  if (it.rung === 'box' || it.rung === 'pack') return true;
  const u = (it.unit_label || '').toUpperCase();
  if (u.includes('CJA') || u.includes('CAJA') || u.includes('PAQ') || u.includes('PAQUETE')) return true;
  // ⚠️ `BTO`/`CUB` sólo son unidad mayor si traen factor: medido en prod, 13 SKUs los tienen como
  // unidad BASE (`15143` nace `BTO` a $89.39 y no tiene caja). Sin esta guarda, un renglón viejo
  // sin `rung` guardado se exportaría como si fuera un bulto de varias piezas.
  const esGranel = u === 'BTO' || u.includes('BULTO') || u === 'CUB' || u.includes('CUBETA');
  return esGranel && (getFactor(it) ?? 0) > 1;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Dibuja la marca de agua diagonal translúcida en la hoja del PDF.
 */
function drawPdfWatermark(doc: jsPDFType, pageWidth: number, pageHeight: number): void {
  try {
    if (typeof (doc as any).saveGraphicsState === 'function') {
      (doc as any).saveGraphicsState();
    }
    // Color grisáceo translúcido no invasivo para marca de agua de fondo
    doc.setTextColor(...rgb(P.regla));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    const cx = pageWidth / 2;
    const cy = pageHeight / 2;
    doc.text('ESTO ES UNA COTIZACION, NO UNA VENTA', cx, cy - 14, { align: 'center', angle: -32 });
    doc.text('EFECTOS INFORMATIVOS PARA EL CLIENTE QUE SOLICITO LA INFORMACION', cx, cy + 12, { align: 'center', angle: -32 });
    if (typeof (doc as any).restoreGraphicsState === 'function') {
      (doc as any).restoreGraphicsState();
    }
  } catch {
    // Si la plataforma no soporta transformaciones gráficas, continúa
  }
}

/**
 * Exporta el entregable en PDF formal de alta presentación ejecutiva.
 */
export async function exportQuotePdf(data: QuoteDeliverableData): Promise<void> {
  // Primero la cuenta: si no cuadra con lo guardado, se corta ANTES de cargar nada.
  const m = modeloEntregable(data);
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadPdfLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const M = 36;
  const contentWidth = pageWidth - M * 2;

  // [E.29] La paleta de documentos (espejo de tokens.css en claro). Papel SOBRIO: la marca vive en
  // el logo y en UN filete bajo el encabezado; todo lo demás es tinta y grises, y la jerarquía la
  // dan el tamaño y el peso. El color de estado (rojo) sólo aparece cuando HAY un estado
  // (vencida, cancelada, sin folio), siempre con su texto. En revisión: «tiene mucho color».
  const cInk = rgb(P.tinta);
  const cMarca = rgb(P.marca);
  const cMuted = rgb(P.tintaSecundaria);
  const cRule = rgb(P.regla);
  const cCardBg = rgb(P.fondoSuave);
  const cError = rgb(P.estado.error.fg);

  // 1. Marca de agua en la página 1
  drawPdfWatermark(doc, pageWidth, pageHeight);

  let currentY = M;

  // 2. Logotipo institucional
  if (logo) {
    try {
      doc.addImage(logo, 'PNG', M, currentY, 46, 46);
    } catch {
      // continua sin error si falla la imagen
    }
  }

  // 3. Encabezado principal
  const textLeft = logo ? M + 54 : M;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...cInk);
  doc.text(EMPRESA_NOMBRE, textLeft, currentY + 14);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...cMuted);
  doc.text('COTIZACIÓN COMERCIAL DE MAYOREO', textLeft, currentY + 28);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...cMuted);
  doc.text(EMPRESA_SLOGAN, textLeft, currentY + 40);

  // 4. Recuadro de Metadatos (Derecha)
  const metaBoxW = 160;
  const metaBoxX = pageWidth - M - metaBoxW;
  // Un renglón más cuando hay folio que imprimir (o que declarar ausente).
  const metaBoxH = 61;

  doc.setFillColor(...cCardBg);
  doc.setDrawColor(...cRule);
  doc.setLineWidth(1);
  doc.roundedRect(metaBoxX, currentY - 2, metaBoxW, metaBoxH, 4, 4, 'FD');

  // La emisión es la de la COTIZACIÓN: reimprimirla otro día no la vuelve de hoy (auditoría M1).
  const fechaStr = fechaCorta(m.emision);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  if (m.alerta) doc.setTextColor(...cError); // vencida o cancelada: estado de error, con su texto
  else doc.setTextColor(...cInk);
  doc.text(m.titulo, metaBoxX + 8, currentY + 10);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...cInk);
  // El folio, en negrita y arriba de todo: es el dato con el que el cliente vuelve a
  // referirse a este papel. Cuando no hay, se DECLARA — un hueco silencioso haría creer
  // que el documento es rastreable cuando no lo es.
  if (data.quoteCode) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...cInk);
    doc.text(`Folio: ${data.quoteCode}`, metaBoxX + 8, currentY + 22);
    doc.setFont('helvetica', 'normal');
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...cError);
    doc.text('Folio: SIN ASIGNAR (borrador)', metaBoxX + 8, currentY + 22);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...cInk);
  }
  doc.text(`Emisión: ${fechaStr}`, metaBoxX + 8, currentY + 33);
  doc.text(`Vigencia hasta: ${fechaVigencia(data.validUntil).texto}`, metaBoxX + 8, currentY + 44);
  doc.text(doc.splitTextToSize(`Sucursal: ${data.branchName}`, metaBoxW - 16)[0], metaBoxX + 8, currentY + 55);

  // 5. Banner de Aviso / Marca de agua visible
  currentY += 67;
  // La leyenda no es un error: va neutra y en negrita; el rojo queda para lo que de verdad falla.
  doc.setFillColor(...rgb(P.encabezado));
  doc.setDrawColor(...cRule);
  doc.setLineWidth(0.75);
  doc.roundedRect(M, currentY, contentWidth, 16, 3, 3, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...cInk);
  doc.text(
    'ESTO ES UNA COTIZACIÓN, NO UNA VENTA · EFECTOS INFORMATIVOS PARA EL CLIENTE QUE SOLICITÓ LA INFORMACIÓN',
    pageWidth / 2,
    currentY + 11,
    { align: 'center' }
  );

  // Línea divisoria de acento: la marca como TRAZO.
  currentY += 22;
  doc.setDrawColor(...cMarca);
  doc.setLineWidth(1);
  doc.line(M, currentY, pageWidth - M, currentY);

  // 6. Bloques de Información: Cliente y Asesor
  currentY += 10;
  const colGap = 12;
  const colW = (contentWidth - colGap) / 2;
  const infoCardH = 54;

  // Tarjeta Cliente
  doc.setFillColor(...cCardBg);
  doc.setDrawColor(...cRule);
  doc.setLineWidth(1);
  doc.roundedRect(M, currentY, colW, infoCardH, 4, 4, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...cMuted);
  doc.text('DATOS DEL DESTINATARIO', M + 8, currentY + 11);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...cInk);
  const clienteNom = data.customerCode ? `[${data.customerCode}] ${data.customerName}` : data.customerName;
  const lineasNom = doc.splitTextToSize(clienteNom, colW - 16);
  doc.text(lineasNom.slice(0, 2), M + 8, currentY + 23);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...cMuted);
  const contactText = [data.customerPhone ? `Tel: ${data.customerPhone}` : null, data.customerEmail ? `Correo: ${data.customerEmail}` : null]
    .filter(Boolean)
    .join('  ·  ');
  doc.text(contactText || 'Cliente registrado en catálogo mayorista', M + 8, currentY + 45);

  // Tarjeta Asesor / Condiciones
  const card2X = M + colW + colGap;
  doc.setFillColor(...cCardBg);
  doc.roundedRect(card2X, currentY, colW, infoCardH, 4, 4, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...cMuted);
  doc.text('ASESOR DE SEGUIMIENTO Y CONDICIONES', card2X + 8, currentY + 11);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...cInk);
  const asesorNom = data.salespersonName
    ? `${data.salespersonName}${data.salespersonCode ? ` (${data.salespersonCode})` : ''}`
    : 'Equipo Comercial Telemarketing';
  doc.text(doc.splitTextToSize(asesorNom, colW - 16)[0], card2X + 8, currentY + 23);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...cMuted);
  const dtoText = (data.discountPct || 0) > 0 ? `Descuento cliente: ${data.discountPct}% aplicado` : 'Precios netos de lista de mayoreo';
  doc.text(`Atención: ${data.branchName}`, card2X + 8, currentY + 34);
  doc.text(dtoText, card2X + 8, currentY + 45);

  // 7. Tabla de Artículos con Descuentos y Unidades Menores
  currentY += infoCardH + 10;

  const hasDiscount = m.conDescuento;

  const head = hasDiscount
    ? [['#', 'SKU', 'Descripción del artículo', 'Presentación', 'Cant.', 'Descuento', 'P. Unitario Neto', 'Importe Neto']]
    : [['#', 'SKU', 'Descripción del artículo', 'Presentación', 'Cant.', 'P. Unitario', 'Importe']];

  const columnStyles = hasDiscount
    ? {
        0: { halign: 'center' as const, cellWidth: 18 },
        1: { fontStyle: 'bold' as const, cellWidth: 44 },
        2: { cellWidth: 'auto' as const },
        3: { halign: 'center' as const, cellWidth: 46 },
        4: { halign: 'right' as const, fontStyle: 'bold' as const, cellWidth: 28 },
        5: { halign: 'center' as const, fontStyle: 'bold' as const, textColor: cInk, cellWidth: 42 },
        6: { halign: 'right' as const, fontStyle: 'bold' as const, cellWidth: 92 },
        7: { halign: 'right' as const, fontStyle: 'bold' as const, textColor: cInk, cellWidth: 62 },
      }
    : {
        0: { halign: 'center' as const, cellWidth: 22 },
        1: { fontStyle: 'bold' as const, cellWidth: 50 },
        2: { cellWidth: 'auto' as const },
        3: { halign: 'center' as const, cellWidth: 55 },
        4: { halign: 'right' as const, fontStyle: 'bold' as const, cellWidth: 35 },
        5: { halign: 'right' as const, fontStyle: 'bold' as const, cellWidth: 92 },
        6: { halign: 'right' as const, fontStyle: 'bold' as const, textColor: cInk, cellWidth: 68 },
      };

  // `[E.19]` Las filas salen del modelo: el descuento de la columna es el del CLIENTE (el único
  // que el papel aplica), y el neto es su parte repartida — la columna suma el total de abajo.
  const tableBody = m.filas.map((f) => {
    const it = f.item;
    let descripcion = it.name;
    if (it.content) descripcion += ` (${it.content})`;
    if (it.barcode) descripcion += `\nEAN: ${it.barcode}`;
    if (it.free_goods) descripcion += `\nRegalo ERP: ${it.free_goods.quantity} de ${it.free_goods.sku}`;
    const base = [f.n, it.sku, descripcion, it.unit_label, it.quantity.toLocaleString('es-MX')];
    return hasDiscount
      ? [...base, f.tipo === 'precio' ? `${m.totales.descuento_pct}%` : '—', etiquetaUnitario(f), etiquetaImporte(f)]
      : [...base, etiquetaUnitario(f), etiquetaImporte(f)];
  });

  autoTable(doc, {
    startY: currentY,
    // Abajo, lugar para las tres líneas del pie (empresa · control · generación).
    margin: { left: M, right: M, bottom: 46 },
    head,
    body: tableBody,
    theme: 'grid',
    headStyles: {
      // Encabezado claro: un relleno oscuro gasta tinta y no se imprime mejor.
      fillColor: rgb(P.encabezado),
      textColor: cInk,
      fontSize: 7.5,
      fontStyle: 'bold',
      halign: 'left',
      cellPadding: 4,
    },
    styles: {
      fontSize: 7,
      textColor: cInk,
      cellPadding: 4,
      valign: 'middle',
      lineColor: cRule,
      lineWidth: 0.5,
    },
    // Sin renglones cebra (DESIGN.md §tablas): el divisor de 1px separa las filas.
    columnStyles,
    didDrawPage: (_data: any) => {
      // Marca de agua diagonal en cada página de la tabla. El pie va al final, cuando ya se sabe
      // cuántas páginas son (antes decía «Pág. 2» sin decir de cuántas).
      drawPdfWatermark(doc, pageWidth, pageHeight);
    },
  });

  const finalY = (doc as any).lastAutoTable?.finalY ?? currentY + 120;

  // 8. Resumen financiero & Notas. `[E.29]` Cada condición se parte en renglones al ancho de su
  // recuadro: antes iba en UNA línea y las largas (la nota del cliente, la leyenda) se salían
  // por encima del recuadro de totales.
  const notesW = contentWidth - 190;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  const lineasCond = condiciones(data, m).flatMap((t) => doc.splitTextToSize(`• ${t}`, notesW - 16) as string[]);
  const boxH = Math.max(86, 12 + lineasCond.length * 9 + 11);
  let summaryY = finalY + 10;
  if (summaryY + boxH > pageHeight - 46) {
    doc.addPage();
    drawPdfWatermark(doc, pageWidth, pageHeight); // la página del resumen también es cotización
    summaryY = M;
  }

  doc.setFillColor(...cCardBg);
  doc.setDrawColor(...cRule);
  doc.setLineWidth(1);
  doc.roundedRect(M, summaryY, notesW, boxH, 4, 4, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...cInk);
  doc.text('CONDICIONES GENERALES Y VIGENCIA:', M + 8, summaryY + 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.setTextColor(...cMuted);
  lineasCond.forEach((t, i) => doc.text(t, M + 8, summaryY + 23 + i * 9));

  // Recuadro de Totales — `[E.19]` importe → descuento del cliente → total, la misma cuenta que
  // el servidor. Antes decía «Subtotal Lista» sobre una base que ya traía el descuento y no el IVA.
  const totBoxW = 180;
  const totBoxX = pageWidth - M - totBoxW;
  doc.setFillColor(...rgb(P.blanco));
  doc.setDrawColor(...cRule);
  doc.roundedRect(totBoxX, summaryY, totBoxW, 86, 4, 4, 'FD');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...cMuted);
  doc.text('Importe de los artículos:', totBoxX + 10, summaryY + 16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...cInk);
  const subStr = moneyFormat(m.totales.importe);
  doc.text(subStr, totBoxX + totBoxW - 10 - doc.getTextWidth(subStr), summaryY + 16);

  if (hasDiscount) {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...cMuted); // un descuento no es un estado: el signo menos ya lo dice
    doc.text(`Descuento cliente (${m.totales.descuento_pct}%):`, totBoxX + 10, summaryY + 32);
    const dtoStr = `- ${moneyFormat(m.totales.descuento)}`;
    doc.text(dtoStr, totBoxX + totBoxW - 10 - doc.getTextWidth(dtoStr), summaryY + 32);
  }

  doc.setDrawColor(...cRule);
  doc.setLineWidth(0.75);
  doc.line(totBoxX + 8, summaryY + 42, totBoxX + totBoxW - 8, summaryY + 42);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...cInk);
  doc.text(hasDiscount ? 'TOTAL NETO COTIZADO:' : 'TOTAL COTIZACIÓN:', totBoxX + 10, summaryY + 58);

  // El total destaca por tamaño y peso, no por color.
  doc.setFontSize(12);
  doc.setTextColor(...cInk);
  const totStr = moneyFormat(m.totales.total);
  doc.text(totStr, totBoxX + totBoxW - 10 - doc.getTextWidth(totStr), summaryY + 58);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...cMuted);
  // `[E.25]` El desglose como el documento de Kepler: subtotal sin impuestos, IVA e IEPS, con la
  // tasa de cada producto (antes: «incluye IVA» calculado al 16 % sobre todo, falso en el 86 %).
  const subStrSin = `Subtotal sin impuestos ${moneyFormat(m.totales.subtotal)}`;
  doc.text(subStrSin, totBoxX + totBoxW - 10 - doc.getTextWidth(subStrSin), summaryY + 68);
  const mxnStr = `IVA ${moneyFormat(m.totales.iva)} · IEPS ${moneyFormat(m.totales.ieps)} · MXN`;
  doc.text(mxnStr, totBoxX + totBoxW - 10 - doc.getTextWidth(mxnStr), summaryY + 78);

  // 9. `[E.29]` Pie en TODAS las páginas, con el total ya conocido: folio, cuándo se generó el
  // archivo (no es la emisión: un papel reimpreso dice cuándo salió) y con qué plantilla.
  const total = doc.getNumberOfPages();
  const generado = `Generado ${fechaHora(new Date())} · Plantilla ${PLANTILLA_COTIZACION}`;
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...cMuted);
    doc.text(`${EMPRESA_NOMBRE} · ESTO ES UNA COTIZACIÓN, NO UNA VENTA`, M, pageHeight - 33);
    doc.text(lineaControl(data), M, pageHeight - 24);
    doc.text(generado, M, pageHeight - 15);
    const pageStr = `Página ${p} de ${total}`;
    doc.text(pageStr, pageWidth - M - doc.getTextWidth(pageStr), pageHeight - 15);
  }

  // Descarga del PDF
  const filename = generateQuoteFilename(data, 'pdf');
  doc.save(filename);
}

/**
 * Exporta el entregable en hoja de cálculo Excel (.xlsx) ejecutiva y formal.
 */
export async function exportQuoteXlsx(data: QuoteDeliverableData): Promise<void> {
  const m = modeloEntregable(data);
  const ExcelJS = await loadExcelLib();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mega Dulces de los Altos';
  wb.created = new Date();

  const headRowIdx = 9;
  // `[E.29]` Encabezado de la tabla congelado: con 40 renglones, al bajar se perdía qué columna era cuál.
  const ws = wb.addWorksheet('Cotización', {
    views: [{ state: 'frozen', ySplit: headRowIdx, showGridLines: true }],
  });

  // Configuración de encabezados y pies de impresión (marca de agua en impresión). `[E.29]` El pie
  // dice cuándo se generó el archivo y con qué plantilla, igual que el PDF.
  ws.headerFooter = {
    oddHeader: '&C&B&9ESTO ES UNA COTIZACION, NO UNA VENTA, EFECTOS INFORMATIVOS PARA EL CLIENTE QUE SOLICITO LA INFORMACION',
    oddFooter: `&L&8Mega Dulces de los Altos S.A. de C.V.&C&8Generado ${fechaHora(new Date())} · Plantilla ${PLANTILLA_COTIZACION}&R&8Página &P de &N`,
  };

  const hasDiscount = m.conDescuento;

  // `[E.29]` El precio unitario es un NÚMERO (se puede sumar y filtrar); el desglose «(12 PAQ
  // 80.82)», que antes iba pegado al precio como texto, tiene su propia columna.
  const columnas = [
    { key: 'num', width: 6 },
    { key: 'sku', width: 12 },
    { key: 'barcode', width: 16 },
    { key: 'name', width: hasDiscount ? 38 : 42 },
    { key: 'unit', width: 13 },
    { key: 'qty', width: 10 },
    ...(hasDiscount ? [{ key: 'dto', width: 11 }] : []),
    { key: 'price', width: 15 },
    { key: 'desglose', width: 26 },
    { key: 'total', width: 16 },
    { key: 'notes', width: 26 },
  ];
  ws.columns = columnas;
  const colLetra = (key: string): string => String.fromCharCode(65 + columnas.findIndex((c) => c.key === key));
  const lastColLetter = colLetra('notes');

  // 1. Título Corporativo
  ws.mergeCells(`A1:${lastColLetter}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = EMPRESA_NOMBRE;
  // [E.29] Paleta de documentos: fondo blanco, tinta, y la marca como filete (no como relleno).
  titleCell.font = { name: 'Arial', size: 13, bold: true, color: { argb: argb(P.tinta) } };
  titleCell.border = { bottom: { style: 'medium', color: { argb: argb(P.marca) } } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 26;

  ws.mergeCells(`A2:${lastColLetter}2`);
  const subCell = ws.getCell('A2');
  subCell.value = m.alerta ? `COTIZACIÓN COMERCIAL DE MAYOREO · ${m.titulo}` : 'COTIZACIÓN COMERCIAL DE MAYOREO';
  // Blanco sobre naranja daba 3.39:1. El estado (vencida/cancelada) va en su color Y en el texto.
  subCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: argb(m.alerta ? P.estado.error.fg : P.tintaSecundaria) } };
  subCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 19;

  // 2. Marca de Agua / Aviso en Hoja Excel
  ws.mergeCells(`A3:${lastColLetter}3`);
  const watermarkCell = ws.getCell('A3');
  watermarkCell.value = LEYENDA_MARCA_AGUA;
  // La leyenda no es un error: neutra y en negrita.
  watermarkCell.font = { name: 'Arial', size: 8.5, bold: true, color: { argb: argb(P.tinta) } };
  watermarkCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(P.encabezado) } };
  watermarkCell.alignment = { vertical: 'middle', horizontal: 'center' };
  watermarkCell.border = {
    top: { style: 'thin', color: { argb: argb(P.regla) } },
    bottom: { style: 'thin', color: { argb: argb(P.regla) } },
  };
  ws.getRow(3).height = 20;

  // 3. Metadatos de la cotización
  ws.getCell('A5').value = 'Cliente:';
  ws.getCell('A5').font = { bold: true, size: 9 };
  ws.getCell('B5').value = data.customerCode ? `[${data.customerCode}] ${data.customerName}` : data.customerName;
  ws.getCell('B5').font = { size: 9 };

  const rightMetaCol = colLetra('price');
  const rightValCol = colLetra('desglose');

  // Folio arriba de la fecha, y declarado cuando falta (mismo criterio que el PDF).
  ws.getCell('A4').value = 'Folio:';
  ws.getCell('A4').font = { bold: true, size: 9 };
  ws.getCell('B4').value = data.quoteCode || 'SIN ASIGNAR (borrador)';
  ws.getCell('B4').font = data.quoteCode
    ? { bold: true, size: 9 }
    : { bold: true, size: 9, color: { argb: argb(P.estado.error.fg) } };

  ws.getCell(`${rightMetaCol}5`).value = 'Fecha Emisión:';
  ws.getCell(`${rightMetaCol}5`).font = { bold: true, size: 9 };
  ws.getCell(`${rightValCol}5`).value = paraExcel(m.emision);
  ws.getCell(`${rightValCol}5`).numFmt = 'dd/mm/yyyy';
  ws.getCell(`${rightValCol}5`).font = { size: 9 };

  ws.getCell('A6').value = 'Contacto:';
  ws.getCell('A6').font = { bold: true, size: 9 };
  ws.getCell('B6').value = [data.customerPhone, data.customerEmail].filter(Boolean).join(' / ') || 'Venta directa';
  ws.getCell('B6').font = { size: 9 };

  ws.getCell(`${rightMetaCol}6`).value = 'Vigencia Hasta:';
  ws.getCell(`${rightMetaCol}6`).font = { bold: true, size: 9 };
  // [E.29] Fecha de verdad (se ordena y se filtra), no el texto AAAA-MM-DD.
  const vig = fechaVigencia(data.validUntil);
  ws.getCell(`${rightValCol}6`).value = vig.fecha ? paraExcel(vig.fecha) : vig.texto;
  if (vig.fecha) ws.getCell(`${rightValCol}6`).numFmt = 'dd/mm/yyyy';
  ws.getCell(`${rightValCol}6`).font = { size: 9 };

  ws.getCell('A7').value = 'Sucursal:';
  ws.getCell('A7').font = { bold: true, size: 9 };
  ws.getCell('B7').value = data.branchName;
  ws.getCell('B7').font = { size: 9 };

  ws.getCell(`${rightMetaCol}7`).value = 'Asesor Venta:';
  ws.getCell(`${rightMetaCol}7`).font = { bold: true, size: 9 };
  ws.getCell(`${rightValCol}7`).value = data.salespersonName ? `${data.salespersonName} (${data.salespersonCode || ''})` : 'Telemarketing';
  ws.getCell(`${rightValCol}7`).font = { size: 9 };

  // [E.29] Control del documento, igual que el pie del PDF: versión (última modificación), quién
  // la elaboró y el pedido al que se convirtió. Sólo lo que hay.
  const act = data.actualizada ? new Date(data.actualizada) : null;
  if (act && !isNaN(act.getTime())) {
    ws.getCell(`${rightMetaCol}4`).value = 'Versión del:';
    ws.getCell(`${rightMetaCol}4`).font = { bold: true, size: 9 };
    ws.getCell(`${rightValCol}4`).value = paraExcel(act);
    ws.getCell(`${rightValCol}4`).numFmt = 'dd/mm/yyyy hh:mm';
    ws.getCell(`${rightValCol}4`).font = { size: 9 };
  }
  if (data.elaboro) {
    ws.getCell('A8').value = 'Elaboró:';
    ws.getCell('A8').font = { bold: true, size: 9 };
    ws.getCell('B8').value = data.elaboro;
    ws.getCell('B8').font = { size: 9 };
  }
  if (data.orderCode) {
    ws.getCell(`${rightMetaCol}8`).value = 'Pedido:';
    ws.getCell(`${rightMetaCol}8`).font = { bold: true, size: 9 };
    ws.getCell(`${rightValCol}8`).value = data.orderCode;
    ws.getCell(`${rightValCol}8`).font = { bold: true, size: 9 };
  }

  // 4. Encabezados de tabla
  const titulos: Record<string, string> = {
    num: '#',
    sku: 'SKU',
    barcode: 'Código Barras',
    name: 'Descripción del Artículo',
    unit: 'Presentación',
    qty: 'Cantidad',
    dto: 'Descuento',
    price: hasDiscount ? 'P. Unitario Neto' : 'P. Unitario',
    desglose: 'Precio por unidad menor',
    total: hasDiscount ? 'Importe Neto' : 'Importe',
    notes: 'Observaciones / Promociones',
  };
  const headRow = ws.getRow(headRowIdx);
  headRow.values = columnas.map((c) => titulos[c.key]);

  headRow.height = 22;
  headRow.eachCell((cell: any) => {
    cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: argb(P.tinta) } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(P.encabezado) } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: argb(P.regla) } },
      bottom: { style: 'medium', color: { argb: argb(P.tintaSecundaria) } },
      left: { style: 'thin', color: { argb: argb(P.regla) } },
      right: { style: 'thin', color: { argb: argb(P.regla) } },
    };
  });

  // 5. Filas de productos. `[E.29]` Cada celda con su TIPO: cantidad, %, precio e importe son
  // números (antes el precio y el % eran texto, «$969.84 (12 PAQ 80.82)» y «3%»: no se podían
  // sumar ni filtrar). Lo que no tiene precio deja la celda vacía y lo dice en «Precio por unidad
  // menor»: un texto en una columna de importes rompe la suma del cliente. Sin renglones cebra.
  let rowIdx = headRowIdx + 1;
  for (const f of m.filas) {
    const it = f.item;
    const conPrecio = f.tipo === 'precio' && f.unitario !== null;
    const factor = getFactor(it);
    const desgloseTxt = f.tipo === 'regalo' ? 'Regalo'
      : !conPrecio ? 'Sin precio'
      : isUnidadMayor(it) && factor && factor > 1
        ? etiquetaDesglose(factor, it.base_unit, (f.unitario as number) / factor, it.pack_size)
        : '';
    const valores: Record<string, unknown> = {
      num: f.n,
      sku: it.sku,
      barcode: it.barcode || '',
      name: it.name + (it.content ? ` (${it.content})` : ''),
      unit: it.unit_label,
      qty: it.quantity,
      dto: f.tipo === 'precio' && m.totales.descuento_pct !== null ? m.totales.descuento_pct / 100 : null,
      price: conPrecio ? f.unitario : null,
      desglose: desgloseTxt,
      // El regalo es un cero REAL; lo sin precio queda vacío (no es cero, ADR-056).
      total: f.tipo === 'regalo' ? 0 : f.importe,
      notes: it.free_goods ? `Regalo ERP: ${it.free_goods.quantity} de ${it.free_goods.sku}` : (it.price_source || ''),
    };
    const row = ws.getRow(rowIdx);
    row.values = columnas.map((c) => valores[c.key] ?? null);

    const celda = (key: string): any => row.getCell(columnas.findIndex((c) => c.key === key) + 1);
    celda('num').alignment = { horizontal: 'center' };
    celda('sku').alignment = { horizontal: 'center' };
    celda('sku').font = { bold: true };
    celda('barcode').alignment = { horizontal: 'center' };
    celda('unit').alignment = { horizontal: 'center' };
    celda('qty').alignment = { horizontal: 'right' };
    // Con decimales sólo si los hay: «#,##0» mostraba 2.5 kg como 3.
    celda('qty').numFmt = '#,##0.###';
    if (hasDiscount) {
      celda('dto').alignment = { horizontal: 'center' };
      celda('dto').numFmt = '0.##%';
    }
    celda('price').alignment = { horizontal: 'right' };
    celda('price').numFmt = '$#,##0.00';
    celda('price').font = { bold: true };
    celda('desglose').font = { size: 8, color: { argb: argb(P.tintaSecundaria) } };
    celda('total').alignment = { horizontal: 'right' };
    celda('total').numFmt = '$#,##0.00';
    celda('total').font = { bold: true };

    row.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.border = {
        bottom: { style: 'thin', color: { argb: argb(P.regla) } },
      };
    });

    rowIdx++;
  }
  // `[E.29]` Filtros en el encabezado: el cliente busca por presentación, por SKU o por marca.
  ws.autoFilter = { from: { row: headRowIdx, column: 1 }, to: { row: rowIdx - 1, column: columnas.length } };

  // 6. Totales
  rowIdx++;
  const labelCol = colLetra('desglose');
  const valCol = colLetra('total');

  // `[E.19]` importe → descuento del cliente → total: la misma cuenta que el servidor.
  ws.getCell(`${labelCol}${rowIdx}`).value = 'Importe de los artículos:';
  ws.getCell(`${labelCol}${rowIdx}`).font = { bold: true, size: 9 };
  ws.getCell(`${labelCol}${rowIdx}`).alignment = { horizontal: 'right' };
  ws.getCell(`${valCol}${rowIdx}`).value = m.totales.importe;
  ws.getCell(`${valCol}${rowIdx}`).numFmt = '$#,##0.00';
  ws.getCell(`${valCol}${rowIdx}`).font = { bold: true, size: 9 };
  rowIdx++;

  // Descuento si aplica
  if (hasDiscount) {
    ws.getCell(`${labelCol}${rowIdx}`).value = `Descuento cliente (${m.totales.descuento_pct}%):`;
    ws.getCell(`${labelCol}${rowIdx}`).font = { bold: true, size: 9, color: { argb: argb(P.tintaSecundaria) } };
    ws.getCell(`${labelCol}${rowIdx}`).alignment = { horizontal: 'right' };
    ws.getCell(`${valCol}${rowIdx}`).value = -m.totales.descuento;
    ws.getCell(`${valCol}${rowIdx}`).numFmt = '$#,##0.00';
    ws.getCell(`${valCol}${rowIdx}`).font = { bold: true, size: 9, color: { argb: argb(P.tintaSecundaria) } };
    rowIdx++;
  }

  // TOTAL COTIZACIÓN
  const totalRow = ws.getRow(rowIdx);
  totalRow.height = 24;
  ws.getCell(`${labelCol}${rowIdx}`).value = hasDiscount ? 'TOTAL NETO COTIZADO:' : 'TOTAL COTIZACIÓN:';
  ws.getCell(`${labelCol}${rowIdx}`).font = { name: 'Arial', size: 10, bold: true, color: { argb: argb(P.tinta) } };
  ws.getCell(`${labelCol}${rowIdx}`).alignment = { horizontal: 'right', vertical: 'middle' };

  ws.getCell(`${valCol}${rowIdx}`).value = m.totales.total;
  ws.getCell(`${valCol}${rowIdx}`).numFmt = '$#,##0.00';
  // El total: tinta, más grande, con la raya contable arriba. Sin color (antes, blanco sobre naranja).
  ws.getCell(`${valCol}${rowIdx}`).font = { name: 'Arial', size: 12, bold: true, color: { argb: argb(P.tinta) } };
  ws.getCell(`${valCol}${rowIdx}`).border = {
    top: { style: 'thin', color: { argb: argb(P.tinta) } },
    bottom: { style: 'double', color: { argb: argb(P.tinta) } },
  };
  ws.getCell(`${valCol}${rowIdx}`).alignment = { horizontal: 'right', vertical: 'middle' };
  rowIdx++;
  // `[E.25]` Subtotal sin impuestos, IVA e IEPS con la tasa de cada producto (como Kepler).
  for (const [rotulo, valor] of [
    ['Subtotal sin impuestos:', m.totales.subtotal],
    ['IVA:', m.totales.iva],
    ['IEPS:', m.totales.ieps],
  ] as const) {
    ws.getCell(`${labelCol}${rowIdx}`).value = rotulo;
    ws.getCell(`${labelCol}${rowIdx}`).font = { size: 8, color: { argb: argb(P.tintaSecundaria) } };
    ws.getCell(`${labelCol}${rowIdx}`).alignment = { horizontal: 'right' };
    ws.getCell(`${valCol}${rowIdx}`).value = valor;
    ws.getCell(`${valCol}${rowIdx}`).numFmt = '$#,##0.00';
    ws.getCell(`${valCol}${rowIdx}`).font = { size: 8, color: { argb: argb(P.tintaSecundaria) } };
    rowIdx++;
  }
  rowIdx++;

  // 7. Leyenda y condiciones finales
  ws.getCell(`A${rowIdx}`).value = 'Aviso:';
  ws.getCell(`A${rowIdx}`).font = { bold: true, size: 8, color: { argb: argb(P.tinta) } };
  ws.getCell(`B${rowIdx}`).value = LEYENDA_MARCA_AGUA;
  ws.getCell(`B${rowIdx}`).font = { bold: true, size: 8, color: { argb: argb(P.tinta) } };
  rowIdx++;

  // Las mismas condiciones que el PDF (incluye «N artículos sin precio» y la nota al cliente).
  ws.getCell(`A${rowIdx}`).value = 'Notas:';
  ws.getCell(`A${rowIdx}`).font = { bold: true, size: 8 };
  for (const t of condiciones(data, m)) {
    ws.getCell(`B${rowIdx}`).value = t;
    ws.getCell(`B${rowIdx}`).font = { size: 8, color: { argb: argb(P.tintaSecundaria) } };
    rowIdx++;
  }

  // Buffer y descarga
  const buf = await wb.xlsx.writeBuffer();
  const filename = generateQuoteFilename(data, 'xlsx');
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  triggerDownload(blob, filename);
}
