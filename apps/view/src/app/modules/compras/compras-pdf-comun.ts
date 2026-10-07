/**
 * `[RA-PRO.61]` Piezas comunes de los PDF de Compras (requisición por producto, requisición global
 * y orden de compra de Kepler): logo, colores, encabezado, recuadros, tabla de puntos de entrega,
 * notas, firmas, pie de página y nombre de archivo. Salieron de `pedido-requisicion-pdf.ts` tal cual
 * para que los tres documentos se vean igual sin copiar código.
 *
 * Sólo Latin-1: las fuentes estándar de jsPDF (Helvetica) no traen flechas ni símbolos.
 */
import type jsPDFType from 'jspdf';

export type JsPDFCtor = typeof jsPDFType;
export type AutoTableFn = (doc: jsPDFType, options: Record<string, unknown>) => void;

export const EMPRESA = 'MEGA DULCES DE LOS ALTOS';
export const LOGO_URL = 'assets/logos/mega-dulces-logo-print.png';

// Paleta sobria (Stone de DESIGN.md) + el sunset de acción sólo en la raya del título.
export const INK: [number, number, number] = [28, 25, 23];       // stone-900
export const MUTED: [number, number, number] = [120, 113, 108];  // stone-500
export const RULE: [number, number, number] = [231, 229, 228];   // stone-200
export const HEAD: [number, number, number] = [68, 64, 60];      // stone-700
export const ZEBRA: [number, number, number] = [245, 245, 244];  // stone-100
export const ACTION: [number, number, number] = [240, 90, 40];   // --action #F05A28
export const M = 36;

export const money = (v: number) =>
  (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });
export const num1 = (v: number) => (Math.round((Number(v) || 0) * 10) / 10).toLocaleString('es-MX');
export const dias = (d: number | null) => (d == null ? 's/venta' : d > 999 ? '+999 d' : `${Math.round(d)} d`);
export const fecha = (d: Date) =>
  d.toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

let libs: Promise<{ jsPDF: JsPDFCtor; autoTable: AutoTableFn }> | null = null;
export function loadLibs() {
  // Carga perezosa: jsPDF + autoTable pesan ~500 KB y sólo se necesitan al imprimir.
  libs ??= Promise.all([import('jspdf'), import('jspdf-autotable')]).then(([a, b]) => ({
    jsPDF: a.default as JsPDFCtor,
    autoTable: b.default as unknown as AutoTableFn,
  }));
  return libs;
}

export async function loadLogo(): Promise<string | null> {
  // Sin logo el documento sigue siendo válido: no se cancela la impresión por una imagen.
  try {
    const blob = await (await fetch(LOGO_URL)).blob();
    return await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * `[RA-PRO.56]` Texto apto para nombre de archivo (Windows y adjuntos de correo): sin acentos,
 * signos ni espacios (guiones en su lugar), en mayúsculas y recortado a `max` sin guion colgando.
 * Vacío si no queda nada legible.
 */
export function textoParaArchivo(txt: string, max = 40): string {
  return (txt || '').normalize('NFD').replace(/\p{M}/gu, '')   // quita los acentos que NFD separó de su letra
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase().slice(0, max).replace(/-+$/, '');
}

/** Fecha y hora LOCAL para el nombre del archivo: AAAA-MM-DD-HH-MM (formato pedido por Compras). */
export function fechaHoraArchivo(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${ymd(d)}-${p2(d.getHours())}-${p2(d.getMinutes())}`;
}

// ── Piezas compartidas por los dos PDF ─────────────────────────────────────────────────────

export const lastY = (doc: jsPDFType, fallback: number) =>
  (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;

/** Lo que dice cada documento en su encabezado. */
export interface EncabezadoPdf {
  titulo: string;              // "Orden de requisición de compra", "Orden de compra (Kepler)"…
  cajaTitulo: string;          // la línea destacada de la caja de la derecha ("BORRADOR · SIN FOLIO")
  cajaLineas: string[];        // hasta 3 líneas chicas debajo
}

/** Encabezado con logo, empresa, título y la caja de la derecha. Devuelve la y donde sigue el contenido. */
export function dibujarEncabezado(doc: jsPDFType, logo: string | null, e: EncabezadoPdf): number {
  const W = doc.internal.pageSize.getWidth();
  const y = M;
  if (logo) doc.addImage(logo, 'PNG', M, y - 4, 44, 44);
  const tx = logo ? M + 54 : M;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...INK);
  doc.text(EMPRESA, tx, y + 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...HEAD);
  doc.text(e.titulo, tx, y + 28);

  const bw = 220, bx = W - M - bw;
  doc.setDrawColor(...RULE); doc.setFillColor(...ZEBRA);
  doc.roundedRect(bx, y - 6, bw, 54, 4, 4, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...ACTION);
  doc.text(doc.splitTextToSize(e.cajaTitulo, bw - 20)[0], bx + 10, y + 8);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  e.cajaLineas.slice(0, 3).forEach((l, i) => doc.text(doc.splitTextToSize(l, bw - 20)[0], bx + 10, y + 21 + i * 11));

  doc.setDrawColor(...ACTION); doc.setLineWidth(1.5); doc.line(M, y + 58, W - M, y + 58);
  doc.setLineWidth(0.5);
  return y + 72;
}

/** El encabezado de las requisiciones: BORRADOR, porque el folio real lo asigna el servidor. */
export function encabezadoRequisicion(emitido: Date, elaboro: string): EncabezadoPdf {
  return {
    titulo: 'Orden de requisición de compra',
    cajaTitulo: 'BORRADOR · SIN FOLIO',
    cajaLineas: [`Emitido: ${fecha(emitido)}`, `Elaboró: ${elaboro}`, 'El folio RQ-AAAA-NNNNN se asigna al registrarla.'],
  };
}

export const OC_ROW = 20, OC_HEAD = 30;
/** Altura que ocupa la tabla de puntos de entrega con `n` renglones. */
export const altoPuntos = (n: number) => Math.max(38, OC_HEAD + n * OC_ROW + 4);

/** Recuadro simple: título arriba, valor abajo. */
export function dibujarRecuadro(doc: jsPDFType, x: number, y: number, w: number, h: number, titulo: string, valor: string): void {
  doc.setFillColor(...ZEBRA); doc.setDrawColor(...RULE);
  doc.roundedRect(x, y, w, h, 4, 4, 'FD');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  doc.text(titulo.toUpperCase(), x + 9, y + 12);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...INK);
  doc.text(doc.splitTextToSize(valor, w - 18)[0], x + 9, y + 29);
}

/**
 * Tabla "Puntos de entrega (N)": ALMACÉN | O. COMPRA, un renglón por punto. La O. Compra va EN
 * BLANCO a propósito — se anota a mano cuando se le dio trámite al pedido.
 */
export function dibujarPuntos(doc: jsPDFType, x: number, y: number, w: number, h: number, puntos: { code: string; name: string }[]): void {
  const colOc = x + w * 0.58;   // dónde empieza la columna O. COMPRA
  doc.setFillColor(...ZEBRA); doc.setDrawColor(...RULE);
  doc.roundedRect(x, y, w, h, 4, 4, 'FD');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  doc.text(`PUNTOS DE ENTREGA (${puntos.length})`, x + 9, y + 12);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
  doc.text('ALMACÉN', x + 9, y + 25);
  doc.text('O. COMPRA', colOc + 6, y + 25);
  doc.setDrawColor(...MUTED);
  doc.line(x + 9, y + OC_HEAD - 2, x + w - 9, y + OC_HEAD - 2);
  puntos.forEach((e, i) => {
    const ry = y + OC_HEAD + i * OC_ROW;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text(doc.splitTextToSize(`${e.code} · ${e.name}`, colOc - x - 14)[0], x + 9, ry + 13);
    // Espacio para escribir: fondo blanco con línea base, no una celda vacía que se confunda con "sin OC".
    doc.setFillColor(255, 255, 255); doc.setDrawColor(...RULE);
    doc.rect(colOc, ry + 2, x + w - 9 - colOc, OC_ROW - 5, 'FD');
    doc.setDrawColor(...MUTED);
    doc.line(colOc + 4, ry + OC_ROW - 6, x + w - 13, ry + OC_ROW - 6);
  });
}

/** Notas al pie del contenido. Devuelve la y donde terminan. */
export function dibujarNotas(doc: jsPDFType, y: number, notas: string[]): number {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  for (const n of notas) {
    const lines = doc.splitTextToSize(n, W - 2 * M);
    if (y + lines.length * 10 > H - 90) { doc.addPage(); y = M; }
    doc.text(lines, M, y); y += lines.length * 10;
  }
  return y;
}

/** Líneas de firma al fondo de la hoja (o de una hoja nueva si ya no caben). */
export function dibujarFirmas(doc: jsPDFType, y: number, elaboro: string): void {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  if (y > H - 90) { doc.addPage(); y = M; }
  y = Math.max(y + 34, H - 78);
  const firmas = ['Elaboró (Compras)', 'Autorizó', 'Recibió (CEDIS / sucursal)'];
  const fw = (W - 2 * M - 40) / 3;
  firmas.forEach((f, i) => {
    const fx = M + i * (fw + 20);
    doc.setDrawColor(...HEAD); doc.line(fx, y, fx + fw, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(i === 0 ? `${f} · ${elaboro}` : f, fx, y + 11);
  });
}

/** Pie en cada página: de dónde sale el documento y el número de página. */
export function dibujarPies(doc: jsPDFType, etiqueta: string, datosAl: Date | null, pantalla = 'Compras > Pedido'): void {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
    const origen = `${EMPRESA} · ${etiqueta} · Generado desde ${pantalla}`
      + (datosAl ? ` · datos consultados ${fecha(datosAl)}` : '');
    doc.text(origen, M, H - 18);
    doc.text(`Página ${i} de ${total}`, W - M, H - 18, { align: 'right' });
  }
}

export const tablaBase = {
  margin: { left: M, right: M }, theme: 'grid',
  styles: { fontSize: 8.5, cellPadding: 4, textColor: INK, lineColor: RULE, lineWidth: 0.5 },
  headStyles: { fillColor: HEAD, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
};
/** Alinea a la derecha el título y el total de las columnas numéricas (DESIGN, regla D.0). */
export const alinearTitulos = (cols: number[]) =>
  (h: { section: string; column: { index: number }; cell: { styles: { halign: string } } }) => {
    if ((h.section === 'head' || h.section === 'foot') && cols.includes(h.column.index)) h.cell.styles.halign = 'right';
  };
