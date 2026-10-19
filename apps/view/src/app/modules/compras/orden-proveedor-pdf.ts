import {
  ACTION, HEAD, INK, M, MUTED, RULE, ZEBRA,
  dibujarEncabezado, fecha, fechaHoraArchivo, lastY, loadLibs, loadLogo, money, num1, textoParaArchivo,
} from './compras-pdf-comun';

/**
 * `[OC.3]` — **El pedido completo de UN proveedor, en un solo papel.**
 *
 * Lo que se imprime desde `/compras/ordenes`: todas las órdenes abiertas de ese proveedor,
 * **consolidadas en una fila por SKU**, con la columna de destino diciendo a qué almacenes va.
 *
 * ── La forma la decidió el negocio, y lo que pierde se compensa ──────────────────────────────
 *
 * Decisión del 2026-10-19: el proveedor quiere **una** lista, no nueve. Sumar el mismo SKU entre
 * órdenes **borra a qué folio pertenecía cada cantidad**, así que el documento lo compensa en dos
 * lugares visibles, no con una promesa:
 *
 *  · **los folios van en el encabezado** — el papel dice de qué órdenes salió;
 *  · **los almacenes van por renglón** — se sabe a dónde va cada cantidad.
 *
 * Al recibir, el cuadre vuelve a ser contra la orden. Este papel es para **pedir**, no para
 * cuadrar, y lo dice en el pie.
 *
 * ── ⚠️ El costo que varía no se esconde ──────────────────────────────────────────────────────
 *
 * Si el mismo SKU viene a dos precios entre órdenes, el renglón trae el **promedio ponderado** y
 * se marca con `~`. Publicar uno de los dos como si fuera el precio sería inventar una cotización
 * que nadie dio.
 */

/** Un renglón ya consolidado. Los números llegan como `number | string` porque `numeric` de
 *  Postgres viaja como texto y este repo no registra un parser para el OID 1700. */
export interface OcProvFila {
  sku: string;
  nombre: string;
  cantidad: number | string;
  pendiente: number | string;
  unit_cost: number | string;
  importe: number | string;
  costo_varia: boolean;
  destinos: string[];
}

export interface OcProvData {
  emitido: Date;
  elaboro: string;
  proveedor: { code: string | null; name: string };
  /** Las órdenes que entraron al papel. Su folio es la única liga hacia atrás. */
  ordenes: Array<{ folio: string; warehouse_code: string | null; expected_date: string | null }>;
  filas: OcProvFila[];
  totales: { cantidad: number; pendiente: number; importe: number };
}

const n = (v: unknown): number => Number(v) || 0;

/**
 * ¿Hay algo recibido a medias? Sólo entonces el papel agrega la columna «Falta»: en el caso
 * normal (órdenes abiertas sin recibir) pedido y pendiente son el mismo número y una columna que
 * repite la de al lado es ruido.
 */
export function hayParciales(filas: readonly OcProvFila[]): boolean {
  return (filas ?? []).some((f) => n(f.pendiente) !== n(f.cantidad));
}

/** El rótulo del destino: "00, 01". Vacío → "—", nunca una celda en blanco que parezca un olvido. */
export function textoDestinos(destinos: readonly string[] | null | undefined): string {
  const d = (destinos ?? []).filter((x) => !!x && String(x).trim());
  return d.length ? d.join(', ') : '—';
}

/** Nombre del archivo: proveedor + fecha, sin acentos ni caracteres que rompan una descarga. */
export function nombreArchivo(proveedor: string, emitido: Date): string {
  return `pedido-${textoParaArchivo(proveedor, 30)}-${fechaHoraArchivo(emitido)}.pdf`;
}

export async function generarOrdenProveedorPdf(data: OcProvData): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const parciales = hayParciales(data.filas);

  const folios = data.ordenes.map((o) => o.folio);
  let y = dibujarEncabezado(doc, logo, {
    titulo: 'Pedido a proveedor',
    cajaTitulo: (data.proveedor.name || '').toUpperCase(),
    cajaTitulo2: data.proveedor.code ? `Código ${data.proveedor.code}` : undefined,
    cajaLineas: [`Emitido: ${fecha(data.emitido)}`, `Elaboró: ${data.elaboro}`],
  });

  // ── De qué órdenes salió. Es la liga hacia atrás que la consolidación borra del renglón. ──
  autoTable(doc, {
    startY: y, margin: { left: M, right: M }, theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: { top: 2, bottom: 2, left: 0, right: 8 }, textColor: MUTED },
    body: [
      [{ content: `Órdenes incluidas (${data.ordenes.length}):`, styles: { fontStyle: 'bold', textColor: HEAD } },
        { content: folios.join(' · ') || '—' }],
      [{ content: 'Entrega esperada:', styles: { fontStyle: 'bold', textColor: HEAD } },
        { content: textoEntregas(data.ordenes) }],
    ],
    columnStyles: { 0: { cellWidth: 110 } },
  });
  y = lastY(doc, y) + 10;

  const cab = ['SKU', 'Producto', 'Destino', 'Cant.'];
  if (parciales) cab.push('Falta');
  cab.push('Costo', 'Importe');

  autoTable(doc, {
    startY: y, margin: { left: M, right: M }, theme: 'grid',
    head: [cab],
    headStyles: { fillColor: HEAD, textColor: [255, 255, 255], fontSize: 8.5, halign: 'left' },
    styles: { fontSize: 8.5, cellPadding: 3, textColor: INK, lineColor: RULE, lineWidth: 0.5 },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: {
      0: { cellWidth: 52 },
      2: { cellWidth: 58 },
      3: { halign: 'right', cellWidth: 44 },
      ...(parciales
        ? { 4: { halign: 'right', cellWidth: 40 }, 5: { halign: 'right', cellWidth: 58 }, 6: { halign: 'right', cellWidth: 68 } }
        : { 4: { halign: 'right', cellWidth: 58 }, 5: { halign: 'right', cellWidth: 68 } }),
    },
    body: data.filas.map((f) => {
      const fila: (string | number)[] = [f.sku, f.nombre, textoDestinos(f.destinos), num1(n(f.cantidad))];
      if (parciales) fila.push(num1(n(f.pendiente)));
      // El `~` delante del costo es la declaración de que ese SKU vino a más de un precio.
      fila.push((f.costo_varia ? '~' : '') + money(n(f.unit_cost)), money(n(f.importe)));
      return fila;
    }),
  });
  y = lastY(doc, y) + 12;

  // ── Totales ───────────────────────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text(`${data.filas.length} renglón(es) · ${num1(data.totales.cantidad)} unidades`, M, y);
  doc.setTextColor(...ACTION);
  doc.text(`TOTAL ${money(data.totales.importe)}`, W - M, y, { align: 'right' });
  y += 16;

  if (data.filas.some((f) => f.costo_varia)) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text('~ el costo de ese renglón varía entre órdenes: el que se muestra es el promedio ponderado.', M, y);
    y += 11;
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  doc.text('Las cantidades están sumadas de las órdenes listadas arriba. Para recibir y cuadrar, usa el folio de cada orden.', M, y);

  doc.save(nombreArchivo(data.proveedor.name, data.emitido));
}

/** "24/10 (00), 25/10 (01)" — o "sin fecha" si ninguna orden la trae. */
export function textoEntregas(ordenes: readonly { warehouse_code: string | null; expected_date: string | null }[]): string {
  const con = (ordenes ?? []).filter((o) => !!o.expected_date);
  if (!con.length) return 'sin fecha comprometida';
  const vistas = new Set<string>();
  const partes: string[] = [];
  for (const o of con) {
    const d = String(o.expected_date).slice(0, 10).split('-');
    const txt = `${d[2]}/${d[1]}${o.warehouse_code ? ` (${o.warehouse_code})` : ''}`;
    if (vistas.has(txt)) continue;
    vistas.add(txt); partes.push(txt);
  }
  return partes.join(', ');
}
