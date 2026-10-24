import type { Corte, SolicitudDePersona } from '@megadulces/contracts';
import { warehouseName } from '@megadulces/contracts';
// Por subruta, no por el barrel: ver tsconfig.base.json (bundle inicial).
import { ROL_LABEL } from '@megadulces/contracts/http/cierre-viaje';
import {
  alinearTitulos, dibujarEncabezado, dibujarPies, HEAD, lastY, loadLibs, loadLogo, M, money, MUTED, tablaBase,
  textoParaArchivo,
} from '../compras/compras-pdf-comun';
import { esc } from '../compras/orden-proveedor-csv';

/**
 * `[EMB.47]` — **El reporte de Pagos de viaje, para pedir el gasto en Kepler.**
 *
 * Lo pidió el usuario el 2026-10-24: «generarlo a forma de reporte para que ellos hagan sus
 * solicitudes de gasto». Cada persona lleva los renglones TAL COMO se capturan en Kepler —concepto,
 * destino, importe— y, abajo, de qué operación sale cada peso. Dos salidas del MISMO dato:
 *
 *  - **PDF**: una hoja por persona, para firmar y archivar con la solicitud.
 *  - **CSV**: un renglón por concepto × destino × persona, para trabajarlo en Excel.
 *
 * Las piezas del PDF (encabezado, tablas, pie) son las de Compras (`compras-pdf-comun.ts`), para que
 * todos los documentos de la suite se vean igual. Sólo Latin-1: Helvetica no trae guiones largos.
 */

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** «08 oct». A mano y no con `toLocaleDateString`: cada navegador pone el guion o el punto distinto. */
const fechaCorta = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[3]} ${MESES[Number(m[2]) - 1]}` : iso;
};

/** «Catorcena 08 oct a 21 oct · se paga el 23 oct». */
export function textoDelCorte(c: Corte): string {
  return `Catorcena ${fechaCorta(c.desde)} a ${fechaCorta(c.hasta)} · se paga el ${fechaCorta(c.pago)}`;
}

export const CSV_CABECERA = ['Persona', 'Concepto', 'Descripcion', 'Destino', 'Operaciones', 'Importe'] as const;

/**
 * El CSV, **con BOM** (sin él Excel abre «Ã»). Números con punto y sin miles: es para procesar.
 * Mismo criterio de comillas que el resto de la app (`esc`).
 */
export function csvSolicitudes(solicitudes: SolicitudDePersona[]): string {
  const filas: string[] = [];
  for (const s of solicitudes) {
    for (const r of s.renglones) {
      filas.push([s.persona, r.codigo, r.nombre_concepto, r.destino, r.operaciones, r.importe.toFixed(2)].map(esc).join(','));
    }
  }
  return '﻿' + [CSV_CABECERA.join(','), ...filas].join('\n');
}

/** `pagos-logistica-2026-10-08-a-2026-10-21.csv` (o con el nombre de la persona si es una). */
export function nombreArchivo(c: Corte, ext: 'csv' | 'pdf', persona?: string): string {
  const quien = persona ? `-${textoParaArchivo(persona, 30)}` : '';
  return `pagos-logistica${quien}-${c.desde}-a-${c.hasta}.${ext}`;
}

/** Arma el CSV y lo baja. Lo único que toca el navegador, y por eso lo único sin prueba. */
export function descargarCsvSolicitudes(solicitudes: SolicitudDePersona[], c: Corte): void {
  const blob = new Blob([csvSolicitudes(solicitudes)], { type: 'text/csv;charset=utf-8;' });
  bajar(blob, nombreArchivo(c, 'csv', solicitudes.length === 1 ? solicitudes[0].persona : undefined));
}

/** Una hoja por persona: lo que se captura en Kepler, de dónde sale y la firma de quien recibe. */
export async function descargarPdfSolicitudes(solicitudes: SolicitudDePersona[], c: Corte, leidoAt: string | null): Promise<void> {
  if (!solicitudes.length) return;
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();

  solicitudes.forEach((s, i) => {
    if (i > 0) doc.addPage();
    let y = dibujarEncabezado(doc, logo, {
      titulo: 'Solicitud de gasto · Comisiones y viáticos de Logística',
      cajaTitulo: s.persona,
      cajaTitulo2: `Total ${money(s.total)}`,
      cajaLineas: [textoDelCorte(c), `${s.operaciones} operaci${s.operaciones === 1 ? 'ón' : 'ones'} · ${s.roles.map((r) => ROL_LABEL[r]).join(', ')}`],
    });

    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...HEAD);
    doc.text('Para capturar en Kepler', M, y);
    autoTable(doc, {
      ...tablaBase,
      startY: y + 6,
      head: [['Concepto', 'Descripción', 'Destino', 'Operaciones', 'Importe']],
      body: s.renglones.map((r) => [r.codigo, r.nombre_concepto, r.destino, String(r.operaciones), money(r.importe)]),
      foot: [['', '', 'Total', '', money(s.total)]],
      footStyles: { fillColor: [255, 255, 255], textColor: HEAD, fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: 56 }, 3: { halign: 'right', cellWidth: 64 }, 4: { halign: 'right', cellWidth: 80 } },
      didParseCell: alinearTitulos([3, 4]),
    });
    y = lastY(doc, y) + 18;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...HEAD);
    doc.text('De dónde sale', M, y);
    autoTable(doc, {
      ...tablaBase,
      startY: y + 6,
      head: [['Fecha', 'Guía', 'Destino', 'Papel', 'Concepto', 'Importe']],
      body: s.detalle.map((d) => [
        fechaCorta(d.fecha), `${warehouseName(d.sucursal)} ${d.guia}`, d.destino, ROL_LABEL[d.rol], d.codigo, money(d.importe),
      ]),
      styles: { ...tablaBase.styles, fontSize: 7.5 },
      columnStyles: { 0: { cellWidth: 44 }, 4: { cellWidth: 48 }, 5: { halign: 'right', cellWidth: 70 } },
      didParseCell: alinearTitulos([5]),
    });
    y = lastY(doc, y);

    // Firma de quien recibe: al fondo de la hoja (o de una nueva si ya no cabe).
    if (y > H - 90) { doc.addPage(); y = M; }
    const fy = Math.max(y + 40, H - 78);
    const fw = (W - 2 * M - 40) / 2;
    ['Elaboró (Logística)', `Recibí · ${s.persona}`].forEach((t, k) => {
      const fx = M + k * (fw + 40);
      doc.setDrawColor(...HEAD); doc.line(fx, fy, fx + fw, fy);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
      doc.text(t, fx, fy + 11);
    });
  });

  dibujarPies(doc, 'Solicitud de gasto de Logística', leidoAt ? new Date(leidoAt) : null, 'Logística > Pagos de viaje');
  bajar(doc.output('blob'), nombreArchivo(c, 'pdf', solicitudes.length === 1 ? solicitudes[0].persona : undefined));
}

function bajar(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}
