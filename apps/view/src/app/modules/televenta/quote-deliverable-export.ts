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
import { desglose } from './quote-units';

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
  unit_price: number | null;
  line_total: number;
  price_source?: string;
  free_goods?: { sku: string; quantity: number } | null;
  discount_pct?: number | null;
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
  quoteDate?: string | Date;
  validUntil: string;
  items: QuoteDeliverableItem[];
  subtotal: number;
  discountPct?: number;
  discountAmount?: number;
  total: number;
  notes?: string | null;
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
    doc.setTextColor(228, 232, 238);
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
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadPdfLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const M = 36;
  const contentWidth = pageWidth - M * 2;

  // Paleta formal
  const cInk: [number, number, number] = [28, 25, 23];         // stone-900
  const cAccent: [number, number, number] = [240, 90, 40];     // Sunset #F05A28
  const cMuted: [number, number, number] = [100, 116, 139];    // slate-500
  const cRule: [number, number, number] = [226, 232, 240];     // slate-200
  const cCardBg: [number, number, number] = [248, 250, 252];   // slate-50

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
  doc.setTextColor(...cAccent);
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

  const now = new Date();
  const fechaStr = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...cAccent);
  doc.text('COTIZACIÓN FORMAL', metaBoxX + 8, currentY + 10);

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
    doc.setTextColor(185, 28, 28); // Rose-700
    doc.text('Folio: SIN ASIGNAR (borrador)', metaBoxX + 8, currentY + 22);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...cInk);
  }
  doc.text(`Emisión: ${fechaStr}`, metaBoxX + 8, currentY + 33);
  doc.text(`Vigencia hasta: ${data.validUntil || '15 días'}`, metaBoxX + 8, currentY + 44);
  doc.text(`Sucursal: ${data.branchCode} — ${data.branchName.slice(0, 18)}`, metaBoxX + 8, currentY + 55);

  // 5. Banner de Aviso / Marca de agua visible
  currentY += 67;
  doc.setFillColor(254, 242, 242); // Rose-50
  doc.setDrawColor(252, 165, 165); // Rose-300
  doc.setLineWidth(0.75);
  doc.roundedRect(M, currentY, contentWidth, 16, 3, 3, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(185, 28, 28); // Rose-700
  doc.text(
    'ESTO ES UNA COTIZACIÓN, NO UNA VENTA · EFECTOS INFORMATIVOS PARA EL CLIENTE QUE SOLICITÓ LA INFORMACIÓN',
    pageWidth / 2,
    currentY + 11,
    { align: 'center' }
  );

  // Línea divisoria de acento
  currentY += 22;
  doc.setDrawColor(...cAccent);
  doc.setLineWidth(1.5);
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
  doc.setTextColor(...cAccent);
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
  doc.setTextColor(...cAccent);
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
  doc.text(`Atención: Sucursal ${data.branchCode} — ${data.branchName}`, card2X + 8, currentY + 34);
  doc.text(dtoText, card2X + 8, currentY + 45);

  // 7. Tabla de Artículos con Descuentos y Unidades Menores
  currentY += infoCardH + 10;

  const hasDiscount = Boolean(
    (data.discountPct && data.discountPct > 0) ||
    (data.discountAmount && data.discountAmount > 0) ||
    data.items.some((it) => it.discount_pct && it.discount_pct > 0)
  );

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
        5: { halign: 'center' as const, fontStyle: 'bold' as const, textColor: [22, 163, 74] as [number, number, number], cellWidth: 42 },
        6: { halign: 'right' as const, fontStyle: 'bold' as const, cellWidth: 92 },
        7: { halign: 'right' as const, fontStyle: 'bold' as const, textColor: [15, 118, 110] as [number, number, number], cellWidth: 62 },
      }
    : {
        0: { halign: 'center' as const, cellWidth: 22 },
        1: { fontStyle: 'bold' as const, cellWidth: 50 },
        2: { cellWidth: 'auto' as const },
        3: { halign: 'center' as const, cellWidth: 55 },
        4: { halign: 'right' as const, fontStyle: 'bold' as const, cellWidth: 35 },
        5: { halign: 'right' as const, fontStyle: 'bold' as const, cellWidth: 92 },
        6: { halign: 'right' as const, fontStyle: 'bold' as const, textColor: [15, 118, 110] as [number, number, number], cellWidth: 68 },
      };

  const tableBody = data.items.map((it, idx) => {
    let descripcion = it.name;
    if (it.content) descripcion += ` (${it.content})`;
    if (it.barcode) descripcion += `\nEAN: ${it.barcode}`;
    if (it.free_goods) descripcion += `\n🎁 Regalo ERP: ${it.free_goods.quantity} de ${it.free_goods.sku}`;

    const dtoPct = (it.discount_pct !== undefined && it.discount_pct !== null && it.discount_pct > 0)
      ? it.discount_pct
      : (data.discountPct || 0);

    const factor = getFactor(it);
    const isMayor = isUnidadMayor(it);

    if (hasDiscount) {
      // Precio unitario neto descontado
      const unitNeto = it.unit_price !== null
        ? (dtoPct > 0 ? it.unit_price * (1 - dtoPct / 100) : it.unit_price)
        : null;

      // Desglose de unidad menor posterior al precio unitario dentro del mismo cuadro
      let pUnitarioLabel = '—';
      if (unitNeto !== null) {
        if (isMayor && factor && factor > 1) {
          const menorNeto = unitNeto / factor;
          pUnitarioLabel = `${moneyFormat(unitNeto)} ${etiquetaDesglose(factor, it.base_unit, menorNeto, it.pack_size)}`;
        } else {
          pUnitarioLabel = moneyFormat(unitNeto);
        }
      }

      const importeNeto = unitNeto !== null
        ? unitNeto * it.quantity
        : (dtoPct > 0 ? it.line_total * (1 - dtoPct / 100) : it.line_total);

      const dtoString = dtoPct > 0 ? `${dtoPct}%` : '—';

      return [
        idx + 1,
        it.sku,
        descripcion,
        it.unit_label,
        it.quantity.toLocaleString('es-MX'),
        dtoString,
        pUnitarioLabel,
        moneyFormat(importeNeto),
      ];
    } else {
      let pUnitarioLabel = '—';
      if (it.unit_price !== null) {
        if (isMayor && factor && factor > 1) {
          const menor = it.unit_price / factor;
          pUnitarioLabel = `${moneyFormat(it.unit_price)} ${etiquetaDesglose(factor, it.base_unit, menor, it.pack_size)}`;
        } else {
          pUnitarioLabel = moneyFormat(it.unit_price);
        }
      }

      return [
        idx + 1,
        it.sku,
        descripcion,
        it.unit_label,
        it.quantity.toLocaleString('es-MX'),
        pUnitarioLabel,
        moneyFormat(it.line_total),
      ];
    }
  });

  autoTable(doc, {
    startY: currentY,
    margin: { left: M, right: M },
    head,
    body: tableBody,
    theme: 'grid',
    headStyles: {
      fillColor: [30, 41, 59], // Slate 800
      textColor: [255, 255, 255],
      fontSize: 7.5,
      fontStyle: 'bold',
      halign: 'left',
      cellPadding: 4,
    },
    styles: {
      fontSize: 7,
      textColor: [30, 41, 59],
      cellPadding: 4,
      valign: 'middle',
      lineColor: [226, 232, 240],
      lineWidth: 0.5,
    },
    columnStyles,
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    didDrawPage: (_data: any) => {
      // Marca de agua diagonal en cada página subsiguiente
      drawPdfWatermark(doc, pageWidth, pageHeight);

      // Pie de página en cada hoja
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...cMuted);
      doc.text(
        `${EMPRESA_NOMBRE} · ESTO ES UNA COTIZACIÓN, NO UNA VENTA · EFECTOS INFORMATIVOS`,
        M,
        pageHeight - 20,
      );
      const pageStr = `Pág. ${doc.getNumberOfPages()}`;
      doc.text(pageStr, pageWidth - M - doc.getTextWidth(pageStr), pageHeight - 20);
    },
  });

  const finalY = (doc as any).lastAutoTable?.finalY ?? currentY + 120;

  // 8. Resumen financiero & Notas
  let summaryY = finalY + 10;
  if (summaryY + 85 > pageHeight - 35) {
    doc.addPage();
    summaryY = M;
  }

  // Recuadro de términos y condiciones
  const notesW = contentWidth - 190;
  doc.setFillColor(...cCardBg);
  doc.setDrawColor(...cRule);
  doc.setLineWidth(1);
  doc.roundedRect(M, summaryY, notesW, 76, 4, 4, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...cInk);
  doc.text('CONDICIONES GENERALES Y VIGENCIA:', M + 8, summaryY + 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.setTextColor(...cMuted);
  doc.text('• Precios expresados en Moneda Nacional (MXN) con impuestos incluidos.', M + 8, summaryY + 23);
  doc.text('• ESTO ES UNA COTIZACIÓN, NO UNA VENTA. Efectos informativos para el cliente que solicitó la información.', M + 8, summaryY + 34);
  doc.text('• Precios y promociones sujetos a existencias físicas al confirmar su pedido formal.', M + 8, summaryY + 45);
  doc.text(`• Válida hasta el ${data.validUntil || 'término indicado'} en sucursal ${data.branchCode} (${data.branchName}).`, M + 8, summaryY + 56);
  if (data.notes) {
    doc.text(`• Nota: ${data.notes.slice(0, 75)}`, M + 8, summaryY + 67);
  }

  // Recuadro de Totales
  const totBoxW = 180;
  const totBoxX = pageWidth - M - totBoxW;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...cRule);
  doc.roundedRect(totBoxX, summaryY, totBoxW, 76, 4, 4, 'FD');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...cMuted);
  doc.text('Subtotal Lista:', totBoxX + 10, summaryY + 16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...cInk);
  const subStr = moneyFormat(data.subtotal);
  doc.text(subStr, totBoxX + totBoxW - 10 - doc.getTextWidth(subStr), summaryY + 16);

  if ((data.discountAmount || 0) > 0 || hasDiscount) {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(21, 128, 61); // Green 700
    const pctLabel = data.discountPct ? ` (${data.discountPct}%)` : '';
    doc.text(`Descuento Cliente${pctLabel}:`, totBoxX + 10, summaryY + 32);
    const dtoMonto = data.discountAmount || ((data.subtotal || 0) * (data.discountPct || 0) / 100);
    const dtoStr = `- ${moneyFormat(dtoMonto)}`;
    doc.text(dtoStr, totBoxX + totBoxW - 10 - doc.getTextWidth(dtoStr), summaryY + 32);
  }

  doc.setDrawColor(...cRule);
  doc.setLineWidth(0.75);
  doc.line(totBoxX + 8, summaryY + 42, totBoxX + totBoxW - 8, summaryY + 42);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...cInk);
  doc.text(hasDiscount ? 'TOTAL NETO COTIZADO:' : 'TOTAL COTIZACIÓN:', totBoxX + 10, summaryY + 58);

  doc.setFontSize(10.5);
  doc.setTextColor(...cAccent);
  const totStr = moneyFormat(data.total);
  doc.text(totStr, totBoxX + totBoxW - 10 - doc.getTextWidth(totStr), summaryY + 58);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...cMuted);
  const mxnStr = 'Pesos Mexicanos (MXN)';
  doc.text(mxnStr, totBoxX + totBoxW - 10 - doc.getTextWidth(mxnStr), summaryY + 68);

  // Descarga del PDF
  const filename = generateQuoteFilename(data, 'pdf');
  doc.save(filename);
}

/**
 * Exporta el entregable en hoja de cálculo Excel (.xlsx) ejecutiva y formal.
 */
export async function exportQuoteXlsx(data: QuoteDeliverableData): Promise<void> {
  const ExcelJS = await loadExcelLib();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mega Dulces de los Altos';
  wb.created = new Date();

  const ws = wb.addWorksheet('Cotización', {
    views: [{ showGridLines: true }],
  });

  // Configuración de encabezados y pies de impresión (marca de agua en impresión)
  ws.headerFooter = {
    oddHeader: '&C&B&9ESTO ES UNA COTIZACION, NO UNA VENTA, EFECTOS INFORMATIVOS PARA EL CLIENTE QUE SOLICITO LA INFORMACION',
    oddFooter: '&L&8Mega Dulces de los Altos S.A. de C.V.&C&8Documento informativo sujeto a existencias&R&8Página &P de &N',
  };

  const hasDiscount = Boolean(
    (data.discountPct && data.discountPct > 0) ||
    (data.discountAmount && data.discountAmount > 0) ||
    data.items.some((it) => it.discount_pct && it.discount_pct > 0)
  );

  // Configuración de columnas
  if (hasDiscount) {
    ws.columns = [
      { key: 'num', width: 6 },
      { key: 'sku', width: 14 },
      { key: 'barcode', width: 16 },
      { key: 'name', width: 40 },
      { key: 'unit', width: 14 },
      { key: 'qty', width: 11 },
      { key: 'dto', width: 13 },
      { key: 'price', width: 26 },
      { key: 'total', width: 18 },
      { key: 'notes', width: 28 },
    ];
  } else {
    ws.columns = [
      { key: 'num', width: 6 },
      { key: 'sku', width: 14 },
      { key: 'barcode', width: 16 },
      { key: 'name', width: 44 },
      { key: 'unit', width: 16 },
      { key: 'qty', width: 12 },
      { key: 'price', width: 26 },
      { key: 'total', width: 18 },
      { key: 'notes', width: 28 },
    ];
  }

  const lastColLetter = hasDiscount ? 'J' : 'I';

  // 1. Título Corporativo
  ws.mergeCells(`A1:${lastColLetter}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = EMPRESA_NOMBRE;
  titleCell.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 26;

  ws.mergeCells(`A2:${lastColLetter}2`);
  const subCell = ws.getCell('A2');
  subCell.value = 'COTIZACIÓN COMERCIAL DE MAYOREO';
  subCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF05A28' } };
  subCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 19;

  // 2. Marca de Agua / Aviso en Hoja Excel
  ws.mergeCells(`A3:${lastColLetter}3`);
  const watermarkCell = ws.getCell('A3');
  watermarkCell.value = LEYENDA_MARCA_AGUA;
  watermarkCell.font = { name: 'Arial', size: 8.5, bold: true, color: { argb: 'FF991B1B' } };
  watermarkCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF2F2' } };
  watermarkCell.alignment = { vertical: 'middle', horizontal: 'center' };
  watermarkCell.border = {
    top: { style: 'thin', color: { argb: 'FFFCA5A5' } },
    bottom: { style: 'thin', color: { argb: 'FFFCA5A5' } },
  };
  ws.getRow(3).height = 20;

  // 3. Metadatos de la cotización
  ws.getCell('A5').value = 'Cliente:';
  ws.getCell('A5').font = { bold: true, size: 9 };
  ws.getCell('B5').value = data.customerCode ? `[${data.customerCode}] ${data.customerName}` : data.customerName;
  ws.getCell('B5').font = { size: 9 };

  const rightMetaCol = hasDiscount ? 'H' : 'G';
  const rightValCol = hasDiscount ? 'I' : 'H';

  // Folio arriba de la fecha, y declarado cuando falta (mismo criterio que el PDF).
  ws.getCell('A4').value = 'Folio:';
  ws.getCell('A4').font = { bold: true, size: 9 };
  ws.getCell('B4').value = data.quoteCode || 'SIN ASIGNAR (borrador)';
  ws.getCell('B4').font = data.quoteCode
    ? { bold: true, size: 9 }
    : { bold: true, size: 9, color: { argb: 'FFB91C1C' } };

  ws.getCell(`${rightMetaCol}5`).value = 'Fecha Emisión:';
  ws.getCell(`${rightMetaCol}5`).font = { bold: true, size: 9 };
  ws.getCell(`${rightValCol}5`).value = new Date();
  ws.getCell(`${rightValCol}5`).numFmt = 'dd/mm/yyyy';
  ws.getCell(`${rightValCol}5`).font = { size: 9 };

  ws.getCell('A6').value = 'Contacto:';
  ws.getCell('A6').font = { bold: true, size: 9 };
  ws.getCell('B6').value = [data.customerPhone, data.customerEmail].filter(Boolean).join(' / ') || 'Venta directa';
  ws.getCell('B6').font = { size: 9 };

  ws.getCell(`${rightMetaCol}6`).value = 'Vigencia Hasta:';
  ws.getCell(`${rightMetaCol}6`).font = { bold: true, size: 9 };
  ws.getCell(`${rightValCol}6`).value = data.validUntil || '15 días';
  ws.getCell(`${rightValCol}6`).font = { size: 9 };

  ws.getCell('A7').value = 'Sucursal:';
  ws.getCell('A7').font = { bold: true, size: 9 };
  ws.getCell('B7').value = `Sucursal ${data.branchCode} — ${data.branchName}`;
  ws.getCell('B7').font = { size: 9 };

  ws.getCell(`${rightMetaCol}7`).value = 'Asesor Venta:';
  ws.getCell(`${rightMetaCol}7`).font = { bold: true, size: 9 };
  ws.getCell(`${rightValCol}7`).value = data.salespersonName ? `${data.salespersonName} (${data.salespersonCode || ''})` : 'Telemarketing';
  ws.getCell(`${rightValCol}7`).font = { size: 9 };

  // 4. Encabezados de tabla
  const headRowIdx = 9;
  const headRow = ws.getRow(headRowIdx);
  if (hasDiscount) {
    headRow.values = [
      '#',
      'SKU',
      'Código Barras',
      'Descripción del Artículo',
      'Presentación',
      'Cantidad',
      'Descuento',
      'P. Unitario Neto',
      'Importe Neto',
      'Observaciones / Promociones',
    ];
  } else {
    headRow.values = [
      '#',
      'SKU',
      'Código Barras',
      'Descripción del Artículo',
      'Presentación',
      'Cantidad',
      'P. Unitario',
      'Importe Total',
      'Observaciones / Promociones',
    ];
  }

  headRow.height = 22;
  headRow.eachCell((cell: any) => {
    cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'medium', color: { argb: 'FF0F172A' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    };
  });

  // 5. Filas de productos
  let rowIdx = 10;
  data.items.forEach((it, idx) => {
    const row = ws.getRow(rowIdx);
    const obs = it.free_goods ? `Regalo ERP: ${it.free_goods.quantity} de ${it.free_goods.sku}` : (it.price_source || '');

    const dtoPct = (it.discount_pct !== undefined && it.discount_pct !== null && it.discount_pct > 0)
      ? it.discount_pct
      : (data.discountPct || 0);

    const factor = getFactor(it);
    const isMayor = isUnidadMayor(it);

    if (hasDiscount) {
      const unitNeto = it.unit_price !== null
        ? (dtoPct > 0 ? it.unit_price * (1 - dtoPct / 100) : it.unit_price)
        : null;

      let pUnitarioLabel = '—';
      if (unitNeto !== null) {
        if (isMayor && factor && factor > 1) {
          const menorNeto = unitNeto / factor;
          pUnitarioLabel = `$${formatDec(unitNeto)} ${etiquetaDesglose(factor, it.base_unit, menorNeto, it.pack_size)}`;
        } else {
          pUnitarioLabel = `$${formatDec(unitNeto)}`;
        }
      }

      const importeNeto = unitNeto !== null
        ? unitNeto * it.quantity
        : (dtoPct > 0 ? it.line_total * (1 - dtoPct / 100) : it.line_total);

      const dtoString = dtoPct > 0 ? `${dtoPct}%` : '—';

      row.values = [
        idx + 1,
        it.sku,
        it.barcode || '',
        it.name + (it.content ? ` (${it.content})` : ''),
        it.unit_label,
        it.quantity,
        dtoString,
        pUnitarioLabel,
        importeNeto,
        obs,
      ];

      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(2).font = { bold: true };
      row.getCell(3).alignment = { horizontal: 'center' };
      row.getCell(4).alignment = { horizontal: 'left' };
      row.getCell(5).alignment = { horizontal: 'center' };
      row.getCell(6).alignment = { horizontal: 'right' };
      row.getCell(6).numFmt = '#,##0';
      row.getCell(7).alignment = { horizontal: 'center' };
      row.getCell(7).font = { bold: true, color: { argb: 'FF16A34A' } };
      row.getCell(8).alignment = { horizontal: 'right' };
      row.getCell(8).font = { bold: true };
      row.getCell(9).alignment = { horizontal: 'right' };
      row.getCell(9).numFmt = '$#,##0.00';
      row.getCell(9).font = { bold: true, color: { argb: 'FF0F766E' } };
    } else {
      let pUnitarioLabel = '—';
      if (it.unit_price !== null) {
        if (isMayor && factor && factor > 1) {
          const menor = it.unit_price / factor;
          pUnitarioLabel = `$${formatDec(it.unit_price)} ${etiquetaDesglose(factor, it.base_unit, menor, it.pack_size)}`;
        } else {
          pUnitarioLabel = `$${formatDec(it.unit_price)}`;
        }
      }

      row.values = [
        idx + 1,
        it.sku,
        it.barcode || '',
        it.name + (it.content ? ` (${it.content})` : ''),
        it.unit_label,
        it.quantity,
        pUnitarioLabel,
        it.line_total,
        obs,
      ];

      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(2).font = { bold: true };
      row.getCell(3).alignment = { horizontal: 'center' };
      row.getCell(4).alignment = { horizontal: 'left' };
      row.getCell(5).alignment = { horizontal: 'center' };
      row.getCell(6).alignment = { horizontal: 'right' };
      row.getCell(6).numFmt = '#,##0';
      row.getCell(7).alignment = { horizontal: 'right' };
      row.getCell(7).font = { bold: true };
      row.getCell(8).alignment = { horizontal: 'right' };
      row.getCell(8).numFmt = '$#,##0.00';
      row.getCell(8).font = { bold: true, color: { argb: 'FF0F766E' } };
    }

    // Zebra striping
    if (idx % 2 === 1) {
      row.eachCell((cell: any) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      });
    }

    row.eachCell((cell: any) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
    });

    rowIdx++;
  });

  // 6. Totales
  rowIdx++;
  const labelCol = hasDiscount ? 'H' : 'G';
  const valCol = hasDiscount ? 'I' : 'H';

  // Subtotal
  ws.getCell(`${labelCol}${rowIdx}`).value = 'Subtotal Lista:';
  ws.getCell(`${labelCol}${rowIdx}`).font = { bold: true, size: 9 };
  ws.getCell(`${labelCol}${rowIdx}`).alignment = { horizontal: 'right' };
  ws.getCell(`${valCol}${rowIdx}`).value = data.subtotal;
  ws.getCell(`${valCol}${rowIdx}`).numFmt = '$#,##0.00';
  ws.getCell(`${valCol}${rowIdx}`).font = { bold: true, size: 9 };
  rowIdx++;

  // Descuento si aplica
  if ((data.discountAmount || 0) > 0 || hasDiscount) {
    const dtoMonto = data.discountAmount || ((data.subtotal || 0) * (data.discountPct || 0) / 100);
    const pctLabel = data.discountPct ? ` (${data.discountPct}%)` : '';
    ws.getCell(`${labelCol}${rowIdx}`).value = `Descuento Cliente${pctLabel}:`;
    ws.getCell(`${labelCol}${rowIdx}`).font = { bold: true, size: 9, color: { argb: 'FF15803D' } };
    ws.getCell(`${labelCol}${rowIdx}`).alignment = { horizontal: 'right' };
    ws.getCell(`${valCol}${rowIdx}`).value = -dtoMonto;
    ws.getCell(`${valCol}${rowIdx}`).numFmt = '$#,##0.00';
    ws.getCell(`${valCol}${rowIdx}`).font = { bold: true, size: 9, color: { argb: 'FF15803D' } };
    rowIdx++;
  }

  // TOTAL COTIZACIÓN
  const totalRow = ws.getRow(rowIdx);
  totalRow.height = 24;
  ws.getCell(`${labelCol}${rowIdx}`).value = hasDiscount ? 'TOTAL NETO COTIZADO:' : 'TOTAL COTIZACIÓN:';
  ws.getCell(`${labelCol}${rowIdx}`).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell(`${labelCol}${rowIdx}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  ws.getCell(`${labelCol}${rowIdx}`).alignment = { horizontal: 'right', vertical: 'middle' };

  ws.getCell(`${valCol}${rowIdx}`).value = data.total;
  ws.getCell(`${valCol}${rowIdx}`).numFmt = '$#,##0.00';
  ws.getCell(`${valCol}${rowIdx}`).font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell(`${valCol}${rowIdx}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF05A28' } };
  ws.getCell(`${valCol}${rowIdx}`).alignment = { horizontal: 'right', vertical: 'middle' };
  rowIdx += 2;

  // 7. Leyenda y condiciones finales
  ws.getCell(`A${rowIdx}`).value = 'Aviso:';
  ws.getCell(`A${rowIdx}`).font = { bold: true, size: 8, color: { argb: 'FF991B1B' } };
  ws.getCell(`B${rowIdx}`).value = LEYENDA_MARCA_AGUA;
  ws.getCell(`B${rowIdx}`).font = { bold: true, size: 8, color: { argb: 'FF991B1B' } };
  rowIdx++;

  ws.getCell(`A${rowIdx}`).value = 'Notas:';
  ws.getCell(`A${rowIdx}`).font = { bold: true, size: 8 };
  ws.getCell(`B${rowIdx}`).value = 'Precios en Moneda Nacional (MXN) con impuestos incluidos. Precios y promociones sujetos a existencias físicas y a confirmación al levantar el pedido.';
  ws.getCell(`B${rowIdx}`).font = { size: 8, color: { argb: 'FF64748B' } };
  rowIdx++;

  ws.getCell(`B${rowIdx}`).value = `Cotización válida hasta ${data.validUntil || 'la fecha indicada'}. Atención personalizada con su asesor de ventas.`;
  ws.getCell(`B${rowIdx}`).font = { size: 8, color: { argb: 'FF64748B' } };

  // Buffer y descarga
  const buf = await wb.xlsx.writeBuffer();
  const filename = generateQuoteFilename(data, 'xlsx');
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  triggerDownload(blob, filename);
}
