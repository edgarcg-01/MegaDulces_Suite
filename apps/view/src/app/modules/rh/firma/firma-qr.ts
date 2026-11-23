import type { HrLigasFirmaDto } from '@megadulces/contracts';
import { loadLibs } from '../../compras/compras-pdf-comun';

/**
 * Fase RH · `[RH.15.11]` — Los QR para firmar la semana en el celular.
 *
 * El QR se dibuja como UN trazo SVG (`<path d>`) en la plantilla y como rectángulos en el PDF: nada de `innerHTML`
 * ni de saltarse el sanitizador de Angular. La librería (`qrcode-generator`, MIT, sin dependencias) se carga sólo
 * cuando alguien pide los QR.
 *
 * La hoja impresa lleva el NOMBRE (para que el jefe sepa a quién entregar cada tarjeta) y nada del registro.
 * ⚠️ El QR es la única llave para firmar (decisión de RH, sin número de reloj): se entrega en mano y no se fotografía.
 */

/** Un QR listo para pintar: `n` módulos por lado y el trazo de los módulos oscuros, en unidades de módulo. */
export interface QrTrazo {
  n: number;
  d: string;
}

/** El trazo de una matriz: cada renglón se recorre por tramos oscuros seguidos (un rectángulo por tramo, no por módulo). */
export function trazoDe(n: number, oscuro: (r: number, c: number) => boolean): string {
  const partes: string[] = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!oscuro(r, c)) { c++; continue; }
      const ini = c;
      while (c < n && oscuro(r, c)) c++;
      partes.push(`M${ini} ${r}h${c - ini}v1h-${c - ini}z`);
    }
  }
  return partes.join('');
}

/** Los tramos oscuros como rectángulos (para el PDF). */
export function tramosDe(n: number, oscuro: (r: number, c: number) => boolean): Array<{ r: number; c: number; largo: number }> {
  const out: Array<{ r: number; c: number; largo: number }> = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!oscuro(r, c)) { c++; continue; }
      const ini = c;
      while (c < n && oscuro(r, c)) c++;
      out.push({ r, c: ini, largo: c - ini });
    }
  }
  return out;
}

type Matriz = { n: number; oscuro: (r: number, c: number) => boolean };

/** Corrección de errores M (15 %): aguanta una hoja arrugada o un poco de tinta corrida, sin un QR demasiado denso. */
async function matrizDe(texto: string): Promise<Matriz> {
  const { default: qrcode } = await import('qrcode-generator');
  const q = qrcode(0, 'M');
  q.addData(texto, 'Byte');
  q.make();
  return { n: q.getModuleCount(), oscuro: (r, c) => q.isDark(r, c) };
}

export async function qrDe(texto: string): Promise<QrTrazo> {
  const m = await matrizDe(texto);
  return { n: m.n, d: trazoDe(m.n, m.oscuro) };
}

const fechaCorta = (ymd: string) => { const [y, m, d] = ymd.split('-'); return `${d}/${m}/${y.slice(2)}`; };
const venceTexto = (iso: string) => new Date(iso).toLocaleString('es-MX', {
  timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** La hoja para imprimir y repartir en mano: 6 tarjetas por hoja carta, cada una con nombre, QR y vencimiento. */
export async function descargarPdfQr(l: HrLigasFirmaDto, plaza: string): Promise<void> {
  const [{ jsPDF }, matrices] = await Promise.all([loadLibs(), Promise.all(l.ligas.map((x) => matrizDe(x.url)))]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const M = 36, COLS = 2, FILAS = 3, TOP = 70;
  const cw = (W - M * 2) / COLS, ch = (doc.internal.pageSize.getHeight() - TOP - M) / FILAS;
  const semana = `${fechaCorta(l.period_start)} al ${fechaCorta(l.period_end)}`;
  const encabezado = () => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(20);
    doc.text(`Firma de la semana · ${l.department}`, M, 40);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
    doc.text(`${plaza} · semana del ${semana} · entrega cada tarjeta EN MANO a su persona`, M, 56);
  };
  encabezado();
  l.ligas.forEach((x, i) => {
    const enHoja = i % (COLS * FILAS);
    if (i > 0 && enHoja === 0) { doc.addPage(); encabezado(); }
    const x0 = M + (enHoja % COLS) * cw, y0 = TOP + Math.floor(enHoja / COLS) * ch;
    doc.setDrawColor(200); doc.setLineDashPattern([3, 3], 0); doc.rect(x0 + 4, y0 + 4, cw - 8, ch - 8); doc.setLineDashPattern([], 0);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(20);
    doc.text(doc.splitTextToSize(x.nombre, cw - 28).slice(0, 2), x0 + 14, y0 + 22);
    const m = matrices[i];
    const lado = Math.min(cw - 28, ch - 90), cel = lado / (m.n + 8);   // 4 módulos de margen blanco por lado
    const qx = x0 + (cw - lado) / 2, qy = y0 + 44;
    doc.setFillColor(0, 0, 0);
    for (const t of tramosDe(m.n, m.oscuro)) doc.rect(qx + (t.c + 4) * cel, qy + (t.r + 4) * cel, t.largo * cel, cel, 'F');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60);
    doc.text('Escanéalo con la cámara de tu celular y firma tu semana.', x0 + 14, qy + lado + 14);
    doc.text(`Es personal y de un solo uso. Vence el ${venceTexto(x.expires_at)}.`, x0 + 14, qy + lado + 26);
  });
  doc.save(`QR-FIRMA-${l.department.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 24)}-${l.period_start}.pdf`);
}
