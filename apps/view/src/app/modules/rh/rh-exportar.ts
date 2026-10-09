import type jsPDFType from 'jspdf';
import type { HrPersonaAsistencia } from '@megadulces/contracts';
import {
  ACTION, HEAD, INK, M, MUTED, RULE, ZEBRA, dibujarEncabezado, fecha, fechaHoraArchivo, lastY, loadLibs, loadLogo, textoParaArchivo,
} from '../compras/compras-pdf-comun';
import {
  type ColumnaDia, type GrupoDepartamento, celdaDe, departamentoDe, diasPorFecha, difHorario, firmaHoras, horarioDe, horasTexto, pausasDelDia,
} from './reporte-formato';

/**
 * Fase RH · `[RH.1.7c]` — el reporte de asistencia en PDF (para firmar) y en Excel. Regla de RH que viene de Mega
 * Talento: LO QUE SE VE ES LO QUE SALE. Sale exactamente lo que está filtrado en pantalla, y si es parcial lo dice en
 * el encabezado («· solo SISTEMAS»), igual que la pantalla.
 *
 * Plaza: horizontal, por departamento, con D y C debajo de cada día (en Mega Talento el PDF de plaza no los traía).
 * Una persona: vertical, con su horario, sus totales y las líneas de firma.
 *
 * Sólo Latin-1 en el PDF: las fuentes estándar de jsPDF no traen el guion largo ni los puntos suspensivos.
 */

export interface ContextoExport {
  plaza: string;
  periodo: string;
  /** «solo SISTEMAS» (vacío si es toda la plaza). */
  parcial: string;
  columnas: ColumnaDia[];
  hoy: string;
  mideRetardo: boolean;
}

/** Texto apto para las fuentes estándar del PDF. */
export function latin1(s: string): string {
  return s.replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/[«»]/g, '"');
}

export interface FilaExport {
  tipo: 'depto' | 'persona' | 'subtotal';
  /** Para 'depto': el nombre del departamento. */
  titulo?: string;
  celdas: string[];
}

/**
 * Los renglones del reporte para el PDF y el Excel, de los MISMOS grupos que pinta la pantalla. Cada día:
 * «jornada / pausas / D x C y» en tres líneas.
 */
export function filasExportacion(grupos: GrupoDepartamento[], todas: HrPersonaAsistencia[], c: ContextoExport, conSubtotales: boolean): { encabezado: string[]; filas: FilaExport[] } {
  const hayAsig = todas.some((p) => !!p.horarioAsignado);
  const encabezado = ['Clv', 'Nombre', 'Horario', ...c.columnas.map((x) => `${x.dow} ${x.dia}`), 'Horas', c.mideRetardo ? 'Min. retardo' : 'Retardo', ...(hayAsig ? ['vs. horario'] : [])];
  const o = { hoy: c.hoy, mideRetardo: c.mideRetardo };
  const filas: FilaExport[] = [];
  for (const g of grupos) {
    filas.push({ tipo: 'depto', titulo: `${g.departamento} (${g.personas.length === g.total ? g.total : `${g.personas.length} de ${g.total}`})`, celdas: [] });
    for (const p of g.personas) {
      const dias = diasPorFecha(p);
      const dia = c.columnas.map((col) => {
        const x = celdaDe(p, dias, col.fecha, o);
        const pz = [x.desMin !== null ? `D ${x.desMin}` : '', x.comMin !== null ? `C ${x.comMin}` : ''].filter(Boolean).join(' ');
        return [x.jornada, x.tramos.join(' '), pz].filter(Boolean).join('\n');
      });
      filas.push({
        tipo: 'persona',
        celdas: [p.codigo, p.nombreCompleto || p.nombre, horarioDe(p).texto, ...dia, horasTexto(p.minutosTrabajados),
          c.mideRetardo ? String(p.atrasoBrutoMin || '') : '-', ...(hayAsig ? [firmaHoras(difHorario(p))] : [])],
      });
    }
    if (conSubtotales) {
      // Del departamento COMPLETO, como en pantalla.
      const completo = todas.filter((p) => departamentoDe(p) === g.departamento);
      const min = completo.reduce((t, p) => t + p.minutosTrabajados, 0);
      const ret = completo.reduce((t, p) => t + p.atrasoBrutoMin, 0);
      filas.push({ tipo: 'subtotal', celdas: ['', '', '', ...c.columnas.map(() => ''), horasTexto(min), c.mideRetardo ? String(ret) : '', ...(hayAsig ? [''] : [])] });
    }
  }
  return { encabezado, filas };
}

function guardarBlob(buf: ArrayBuffer, nombre: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob([buf], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function nombreArchivo(c: ContextoExport, sufijo: string, ext: string): string {
  return `ASISTENCIA-${textoParaArchivo(c.plaza, 24)}-${textoParaArchivo(sufijo || 'PLAZA', 24)}-${fechaHoraArchivo(new Date())}.${ext}`;
}

/** El reporte de la plaza (lo que se ve), horizontal y por departamento. */
export async function exportarPdfPlaza(grupos: GrupoDepartamento[], todas: HrPersonaAsistencia[], c: ContextoExport, conSubtotales: boolean): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const y = dibujarEncabezado(doc, logo, {
    titulo: 'Reporte de asistencia',
    cajaTitulo: latin1(`${c.plaza} · ${c.periodo}`).toUpperCase(),
    cajaLineas: [c.parcial ? latin1(`Parcial: ${c.parcial}`) : 'Toda la plaza', `Emitido: ${fecha(new Date())}`],
  });
  const { encabezado, filas } = filasExportacion(grupos, todas, c, conSubtotales);
  const nDias = c.columnas.length;
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [encabezado.map(latin1)],
    body: filas.map((f) => f.tipo === 'depto'
      ? [{ content: latin1(f.titulo ?? ''), colSpan: encabezado.length, styles: { fillColor: ZEBRA, fontStyle: 'bold', textColor: HEAD } }]
      : f.celdas.map((x) => ({ content: latin1(x), styles: f.tipo === 'subtotal' ? { fontStyle: 'bold', textColor: MUTED } : {} }))),
    styles: { font: 'helvetica', fontSize: nDias > 7 ? 5.5 : 6.5, cellPadding: 2.5, textColor: INK, lineColor: RULE, lineWidth: 0.4, valign: 'top' },
    headStyles: { fillColor: HEAD, textColor: [255, 255, 255], fontStyle: 'bold', halign: 'center' },
    columnStyles: { 0: { cellWidth: 28 }, 1: { cellWidth: 104 }, 2: { cellWidth: 62 } },
  });
  pie(doc);
  doc.save(nombreArchivo(c, c.parcial, 'pdf'));
}

/** Una persona: vertical, su horario, sus días, sus totales y las líneas de firma. */
export async function exportarPdfPersona(p: HrPersonaAsistencia, c: ContextoExport): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const nombre = p.nombreCompleto || p.nombre;
  let y = dibujarEncabezado(doc, logo, {
    titulo: 'Asistencia de una persona',
    cajaTitulo: latin1(`${c.plaza} · ${c.periodo}`).toUpperCase(),
    cajaLineas: [latin1(`#${p.codigo} · ${nombre}`), `Emitido: ${fecha(new Date())}`],
  });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...INK);
  doc.text(latin1(nombre), M, y + 4);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  const h = p.horarioAsignado
    ? `Horario asignado por RH: ${p.horarioAsignado.entrada} a ${p.horarioAsignado.salida}, comida ${p.horarioAsignado.comidaMin} min${p.horarioAsignado.sabado ? ', trabaja el sábado' : ''}.`
    : `No tiene horario asignado: se mide contra el que sale de sus checadas (${horarioDe(p).texto}).`;
  doc.text(latin1(h), M, y + 18);
  y += 30;

  const dias = diasPorFecha(p);
  const o = { hoy: c.hoy, mideRetardo: c.mideRetardo };
  const conVs = !!p.horarioAsignado;
  const body = c.columnas.map((col) => {
    const d = dias.get(col.fecha);
    const x = celdaDe(p, dias, col.fecha, o);
    const dia = `${col.dow} ${col.dia}`;
    if (x.tipo !== 'dia' || !d) return [dia, { content: latin1(x.titulo || x.jornada), colSpan: conVs ? 7 : 6, styles: { textColor: MUTED } }];
    const pz = pausasDelDia(d);
    return [
      dia,
      `${d.entrada ?? ''}${c.mideRetardo && d.atrasoMin > 0 ? ` (+${d.atrasoMin})` : ''}`,
      pz.desayuno ? `${pz.desayuno} (${d.desayunoMin} min)` : '-',
      pz.comida ? `${pz.comida}${d.comidaMin != null ? ` (${d.comidaMin} min)` : ''}` : '-',
      `${d.salida ?? ''}${(d.salidaAntesMin || 0) > 0 ? ` (-${d.salidaAntesMin})` : ''}`,
      horasTexto(d.netasMin), c.mideRetardo ? String(d.atrasoMin || '') : '-',
      ...(conVs ? [d.netasMin != null && d.esperadoMin != null ? firmaHoras(d.netasMin - d.esperadoMin) : ''] : []),
    ].map((v) => (typeof v === 'string' ? latin1(v) : v));
  });
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [['Día', 'Entrada', 'Desayuno', 'Comida', 'Salida', 'Horas', c.mideRetardo ? 'Min. retardo' : 'Retardo', ...(conVs ? ['vs. horario'] : [])]],
    body,
    foot: [['Total', '', '', '', '', horasTexto(p.minutosTrabajados), c.mideRetardo ? String(p.atrasoBrutoMin) : '-', ...(conVs ? [latin1(firmaHoras(difHorario(p)))] : [])]],
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 3, textColor: INK, lineColor: RULE, lineWidth: 0.4 },
    headStyles: { fillColor: HEAD, textColor: [255, 255, 255], fontStyle: 'bold' },
    footStyles: { fillColor: ZEBRA, textColor: INK, fontStyle: 'bold' },
  });
  // Las firmas: RH entrega este papel y lo firman la persona y quien revisó.
  const W = doc.internal.pageSize.getWidth();
  const fy = Math.min(lastY(doc, y) + 70, doc.internal.pageSize.getHeight() - 70);
  doc.setDrawColor(...INK); doc.setLineWidth(0.6);
  const ancho = (W - 2 * M - 40) / 2;
  doc.line(M, fy, M + ancho, fy);
  doc.line(M + ancho + 40, fy, W - M, fy);
  doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text(latin1(nombre), M, fy + 12);
  doc.text('Recursos Humanos', M + ancho + 40, fy + 12);
  pie(doc);
  doc.save(nombreArchivo(c, nombre, 'pdf'));
}

function pie(doc: jsPDFType): void {
  const n = doc.getNumberOfPages();
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(...ACTION); doc.setLineWidth(0.8); doc.line(M, H - 28, W - M, H - 28);
    doc.setFontSize(7); doc.setTextColor(...MUTED);
    doc.text('Semana de nómina de jueves a miércoles. D = minutos de desayuno, C = minutos de comida.', M, H - 16);
    doc.text(`Página ${i} de ${n}`, W - M, H - 16, { align: 'right' });
  }
}

/** El mismo reporte en Excel: un renglón por persona, un día por columna. */
export async function exportarExcel(grupos: GrupoDepartamento[], todas: HrPersonaAsistencia[], c: ContextoExport, conSubtotales: boolean): Promise<void> {
  const mod = (await import('exceljs')) as unknown as { default?: unknown };
  const ExcelJS = (mod.default ?? mod) as { Workbook: new () => ExcelWorkbook };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Asistencia');
  const { encabezado, filas } = filasExportacion(grupos, todas, c, conSubtotales);
  ws.addRow([`${c.plaza} · ${c.periodo}${c.parcial ? ` · ${c.parcial}` : ''}`]).font = { bold: true, size: 12 };
  ws.addRow([]);
  const head = ws.addRow(encabezado);
  head.font = { bold: true };
  for (const f of filas) {
    const r = ws.addRow(f.tipo === 'depto' ? [f.titulo ?? ''] : f.celdas);
    if (f.tipo !== 'persona') r.font = { bold: true };
    r.alignment = { vertical: 'top', wrapText: true };
  }
  ws.columns.forEach((col, i) => { col.width = i === 1 ? 34 : i === 2 ? 20 : i < 3 + c.columnas.length ? 16 : 12; });
  const buf = await wb.xlsx.writeBuffer();
  guardarBlob(buf, nombreArchivo(c, c.parcial, 'xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/** Lo mínimo de exceljs que se usa (el paquete trae sus tipos, pero se carga perezoso). */
interface ExcelWorkbook {
  addWorksheet(nombre: string): {
    addRow(v: unknown[]): { font: unknown; alignment: unknown };
    columns: Array<{ width?: number }>;
  };
  xlsx: { writeBuffer(): Promise<ArrayBuffer> };
}
