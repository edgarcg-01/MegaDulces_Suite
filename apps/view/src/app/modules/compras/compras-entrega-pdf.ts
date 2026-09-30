/**
 * `[RE.32]` PDF de la entrega de compras a Finanzas.
 *
 * Es el respaldo en papel del folio `ENT-YYYY-NNNNN`: lo que Compras entrega, a quién y con qué
 * firmas. Se arma en el navegador con lo que devuelve `GET /commercial/purchase-deliveries/:id`
 * (los renglones son el snapshot guardado al generar la entrega, no una consulta nueva a Kepler), así
 * que la reimpresión sale igual que el original. No escribe nada.
 */
import type { PurchaseDeliveryDetail, PurchaseDeliveryLine } from '@megadulces/contracts';
import {
  HEAD, INK, M, MUTED, RULE, alinearTitulos, dibujarEncabezado, dibujarPies, dibujarRecuadro, fecha,
  lastY, loadLibs, loadLogo, money, tablaBase,
} from './compras-pdf-comun';
import { ESTADO_ENTREGA_LABEL, agruparPorSucursal, dia, evidenciaLabel, nombreArchivoEntrega, sumar } from './compras-entrega';

const LINEA_LABEL: Record<string, string> = { entregado: '', aceptado: 'Aceptado', rechazado: 'RECHAZADO', cancelado: 'Cancelado' };

export async function generarEntregaPdf(d: PurchaseDeliveryDetail, emitido: Date): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const entregadoEl = d.delivered_at ? fecha(new Date(d.delivered_at)) : '—';

  let y = dibujarEncabezado(doc, logo, {
    titulo: 'Entrega de compras recibidas a Finanzas',
    cajaTitulo: d.code,
    cajaLineas: [
      `Entregada: ${entregadoEl}`,
      `Estado: ${ESTADO_ENTREGA_LABEL[d.status] ?? d.status}`,
      d.status === 'cancelada' ? 'CANCELADA — sin valor' : 'Respaldo del folio registrado en el sistema.',
    ],
  });

  // ── Quién entrega / quién recibe ─────────────────────────────────────────────────────────
  const periodo = d.period_from || d.period_to
    ? `${dia(d.period_from)} al ${dia(d.period_to)} · por fecha de ${d.date_basis === 'recepcion' ? 'recepción' : 'factura'}`
    : `por fecha de ${d.date_basis === 'recepcion' ? 'recepción' : 'factura'}`;
  autoTable(doc, {
    startY: y, margin: { left: M, right: M }, theme: 'plain',
    body: [
      ['Entrega (Compras)', { content: d.delivered_by_name || d.delivered_by, styles: { fontStyle: 'bold' } }, 'Recibe (Finanzas)', { content: d.recipient_name || d.recipient_username, styles: { fontStyle: 'bold' } }],
      ['Periodo', periodo, 'Confirmó', d.received_at ? `${d.received_by} · ${fecha(new Date(d.received_at))}` : 'Pendiente de confirmar'],
      ...(d.notes ? [['Notas', { content: d.notes, colSpan: 3 }]] : []),
    ],
    styles: { fontSize: 9, cellPadding: { top: 2, bottom: 2, left: 0, right: 8 }, textColor: INK },
    columnStyles: { 0: { textColor: MUTED, cellWidth: 100 }, 2: { textColor: MUTED, cellWidth: 100 } },
  });
  y = lastY(doc, y) + 10;

  // ── Recuadros ────────────────────────────────────────────────────────────────────────────
  // Entregado = lo que Compras puso en la mesa (incluye lo que Finanzas regresó). Aceptado = lo que
  // Finanzas se quedó. Son dos cifras distintas y el papel firmado tiene que decir las dos.
  const vivos = d.lines.filter((l) => l.status !== 'cancelado');
  const rechazados = d.lines.filter((l) => l.status === 'rechazado');
  const aceptados = d.lines.filter((l) => l.status === 'aceptado');
  const hayDecision = aceptados.length + rechazados.length > 0;
  const gap = 10;
  const cards: [string, string][] = [
    ['Órdenes de entrada', String(vivos.length)],
    ['Importe entregado', money(sumar(vivos))],
    hayDecision
      ? ['Aceptado por Finanzas', `${aceptados.length} · ${money(sumar(aceptados))}`]
      : ['Sucursales', String(new Set(vivos.map((l) => l.sucursal)).size)],
    ['Regresadas por Finanzas', rechazados.length ? `${rechazados.length} · ${money(sumar(rechazados))}` : '0'],
  ];
  const cw = (W - 2 * M - gap * (cards.length - 1)) / cards.length;
  cards.forEach(([t, v], i) => dibujarRecuadro(doc, M + i * (cw + gap), y, cw, 42, t, v));
  y += 42 + 16;

  // ── Renglones, con brinco por sucursal ───────────────────────────────────────────────────
  const head = ['#', 'Recepción', 'Factura', 'Proveedor', 'Folio Kepler', 'OC', 'Evidencia', ...(hayDecision ? ['Finanzas'] : []), 'Importe'];
  const nCols = head.length;
  const body: unknown[][] = [];
  let n = 0;
  // El subtotal por sucursal suma lo mismo que "Total entregado" (sin cancelados): los renglones
  // cancelados se siguen listando, pero no cuentan — si no, el brinco y el pie no cuadrarían.
  const subtotal = new Map(agruparPorSucursal(vivos).map((g) => [g.sucursal, g.total]));
  for (const g of agruparPorSucursal(d.lines)) {
    body.push([{ content: `${g.nombre} · ${g.rows.length} entrada${g.rows.length === 1 ? '' : 's'}`, colSpan: nCols - 1, styles: { fontStyle: 'bold', fillColor: RULE, textColor: HEAD } },
      { content: money(subtotal.get(g.sucursal) ?? 0), styles: { fontStyle: 'bold', fillColor: RULE, halign: 'right' } }]);
    for (const l of g.rows as PurchaseDeliveryLine[]) {
      n++;
      const tachado = l.status === 'rechazado' || l.status === 'cancelado';
      const st = tachado ? { textColor: MUTED } : {};
      body.push([
        String(n), dia(l.reception_date), dia(l.invoice_date), l.supplier_name || l.supplier_code || '—',
        `${l.doc_prefix} ${l.folio}`, l.oc_folio || '—', evidenciaLabel(l.evidence_status),
        ...(hayDecision ? [LINEA_LABEL[l.status] + (l.rejection_reason ? ` · ${l.rejection_reason}` : '')] : []),
        { content: money(l.amount), styles: { halign: 'right', ...st } },
      ].map((c) => (typeof c === 'string' ? { content: c, styles: st } : c)));
    }
  }
  autoTable(doc, {
    ...tablaBase, startY: y,
    head: [head],
    body,
    foot: [
      [{ content: `Total entregado · ${vivos.length} entradas`, colSpan: nCols - 1 }, money(sumar(vivos))],
      ...(hayDecision ? [[{ content: `Aceptado por Finanzas · ${aceptados.length} entradas`, colSpan: nCols - 1 }, money(sumar(aceptados))]] : []),
    ],
    footStyles: { fillColor: RULE, textColor: INK, fontStyle: 'bold', halign: 'right' },
    showFoot: 'lastPage',
    columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 58 }, 2: { cellWidth: 58 }, 4: { cellWidth: 82 }, 5: { cellWidth: 52 }, 6: { cellWidth: 62 }, [nCols - 1]: { cellWidth: 78, halign: 'right' } },
    didParseCell: alinearTitulos([nCols - 1]),
  });
  y = lastY(doc, y) + 12;

  // ── Firmas: Entregó (Compras) · Recibió (Finanzas) ───────────────────────────────────────
  if (y > H - 100) { doc.addPage(); y = M; }
  const fy = Math.max(y + 34, H - 78);
  const fw = (W - 2 * M - 60) / 2;
  const firmas = [
    `Entregó (Compras) · ${d.delivered_by_name || d.delivered_by}`,
    `Recibió (Finanzas) · ${d.recipient_name || d.recipient_username}`,
  ];
  firmas.forEach((f, i) => {
    const fx = M + i * (fw + 60);
    doc.setDrawColor(...HEAD); doc.line(fx, fy, fx + fw, fy);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(f, fx, fy + 11);
  });

  dibujarPies(doc, d.code, emitido, 'Compras > Obligaciones > Entregas');
  doc.save(nombreArchivoEntrega(d.code));
}
