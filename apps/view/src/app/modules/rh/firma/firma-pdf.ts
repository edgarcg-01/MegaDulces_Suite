import type { HrHojaFirmaPersona, HrHojaFirmasDto } from '@megadulces/contracts';
import { HEAD, INK, M, MUTED, RULE, TH, loadLibs } from '../../compras/compras-pdf-comun';

/**
 * Fase RH · `[RH.15.11]` — La hoja de firmas en PDF: lo que se guarda en el expediente.
 *
 * Una sola función para los dos documentos: la hoja de un DEPARTAMENTO (todas sus personas, con la versión vigente de
 * la semana) y el COMPROBANTE de una persona (la versión exacta que firmó). Cada persona lleva su semana día por día,
 * su total, y su firma: el trazo del celular con fecha, hora, IP y navegador; o «firmó en la hoja de papel»; o
 * «SIN FIRMA» — nunca un hueco que parezca firmado.
 *
 * El PDF se arma con lo que guarda la base (la foto del cierre + el trazo + su huella): se puede volver a generar igual
 * cuando se necesite. Sólo Latin-1 (Helvetica de jsPDF): nada de rayas largas ni puntos suspensivos.
 */

const fechaCorta = (ymd: string) => { const [y, m, d] = (ymd || '').split('-'); return d ? `${d}/${m}/${y.slice(2)}` : ymd; };
/** `YYYY-MM-DDTHH:mm:ss` (ya en hora de México) → `dd/mm/aa hh:mm`. */
export const momento = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || '');
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)} ${m[4]}:${m[5]}` : s;
};
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const dia = (ymd: string) => { const d = new Date(`${ymd}T12:00:00Z`); return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()}`; };

/** Lo que dice la firma de una persona, en una línea. Se exporta para probarlo sin armar el PDF. */
export function leyendaFirma(p: HrHojaFirmaPersona): string {
  const f = p.firma;
  if (!f) return 'SIN FIRMA en esta versión de la semana.';
  if (f.via === 'papel') return `Firmó en la hoja de papel del departamento (registrada el ${momento(f.firmado_at)}).`;
  const base = `Firmó en su celular el ${momento(f.firmado_at)}${f.ip ? ` desde la IP ${f.ip}` : ''}.`;
  return f.anulada ? `ANULADA el ${momento(f.anulada.at)}: ${f.anulada.motivo}. (${base})` : base;
}

/** El nombre del archivo: departamento o persona, y la semana. */
export function nombreArchivo(h: HrHojaFirmasDto, tipo: TipoPdf): string {
  const quien = tipo === 'comprobante' && h.personas.length ? `${h.personas[0].codigo}-${h.personas[0].nombre}` : (h.department ?? '');
  return `FIRMAS-${quien.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${h.period_start}.pdf`;
}

/** 'hoja' = un departamento; 'comprobante' = la firma de una persona. */
export type TipoPdf = 'hoja' | 'comprobante';

export async function descargarPdfFirmas(h: HrHojaFirmasDto, tipo: TipoPdf): Promise<void> {
  const { jsPDF, autoTable } = await loadLibs();
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const titulo = tipo === 'comprobante' && h.personas.length ? `Comprobante de firma · ${h.personas[0].nombre}` : `Firmas de la semana · ${h.department ?? ''}`;
  const sub = `${h.site_name} · semana del ${fechaCorta(h.period_start)} al ${fechaCorta(h.period_end)} · versión ${h.version}`;

  const encabezado = () => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...INK);
    doc.text(titulo, M, 40);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text(sub, M, 55);
    if (!h.vigente) {
      doc.setFont('helvetica', 'bold'); doc.setTextColor(150, 30, 30);
      doc.text('Esta versión ya no es la vigente: la semana se reabrió después de firmar.', M, 67);
    }
    doc.setDrawColor(...RULE); doc.line(M, 74, W - M, 74);
  };
  encabezado();
  let y = 88;

  for (const p of h.personas) {
    const alto = 40 + p.dias.length * 16 + 90;
    if (y + alto > H - 60) { doc.addPage(); encabezado(); y = 88; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK);
    doc.text(`${p.nombre}  #${p.codigo}`, M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text(`${p.department} · ${p.horas_semana} h trabajadas · ${p.faltas} falta${p.faltas === 1 ? '' : 's'}`, M, y + 13);
    autoTable(doc, {
      startY: y + 20, margin: { left: M, right: M }, theme: 'plain',
      head: [['Día', 'Cómo quedó', 'Entrada', 'Salida', 'Horas', 'Incidencias']],
      body: p.dias.map((d) => [dia(d.fecha), d.etiqueta, d.entrada ?? '-', d.salida ?? '-', d.horas ?? '-', d.incidencias.join(', ')]),
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 3, textColor: INK, lineColor: RULE, lineWidth: { bottom: 0.4 } },
      headStyles: { fillColor: TH, textColor: HEAD, fontStyle: 'bold' },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 20) + 8;

    // La firma: el trazo a la derecha, la leyenda a la izquierda.
    const f = p.firma;
    if (f?.png && !f.anulada) {
      try { doc.addImage(f.png, 'PNG', W - M - 160, y, 160, 54); } catch { /* un trazo ilegible no cancela la hoja */ }
      doc.setDrawColor(...RULE); doc.line(W - M - 160, y + 56, W - M, y + 56);
    }
    doc.setFont('helvetica', f ? 'normal' : 'bold'); doc.setFontSize(8.5);
    if (f && !f.anulada) doc.setTextColor(...INK); else doc.setTextColor(150, 30, 30);
    doc.text(doc.splitTextToSize(leyendaFirma(p), W - M * 2 - 180), M, y + 12);
    if (f?.navegador) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
      doc.text(doc.splitTextToSize(`Navegador: ${f.navegador}`, W - M * 2 - 180).slice(0, 2), M, y + 36);
    }
    y += 72;
    doc.setDrawColor(...RULE); doc.line(M, y - 8, W - M, y - 8);
    y += 10;
  }

  // Pie en cada hoja: qué es y qué no es.
  const paginas = doc.getNumberOfPages();
  for (let i = 1; i <= paginas; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
    doc.text(doc.splitTextToSize('La firma indica que la persona está de acuerdo con el registro de su jornada de esa semana (LFT art. 132, '
      + 'fr. XXXIV). Es evidencia de conformidad, no una firma electrónica avanzada. La versión es la huella de la semana cerrada que se firmó.',
    W - M * 2), M, H - 34);
    doc.text(`Hoja ${i} de ${paginas}`, W - M, H - 14, { align: 'right' });
  }
  doc.save(nombreArchivo(h, tipo));
}
