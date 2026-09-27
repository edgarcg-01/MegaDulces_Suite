/**
 * PDF "Orden de requisición" de `/compras/pedido`, en dos formas:
 *  - `[RA-PRO.53]` POR PRODUCTO (`generarRequisicionPdf`) — el botón del desglose.
 *  - `[RA-PRO.54]` GLOBAL (`generarRequisicionGlobalPdf`) — los productos marcados, una hoja por
 *    proveedor.
 *
 * Es el papel que acompaña al pedido: qué se le compra al proveedor, dónde lo entrega, y cómo se
 * REPARTE después cuando llega consolidado a un CEDIS. Se arma en el navegador con lo que el
 * comprador tiene en pantalla (sus ediciones incluidas), sin pasar por el servidor.
 *
 * Forma por producto (acordada con Compras 2026-09-25, pensada para caber en UNA hoja):
 *  1. Proveedor · cobertura objetivo
 *  2. Producto · unidades por caja · órdenes abiertas
 *  3. Recuadros título/valor: Pedido · Precio por caja · Importe · Puntos de entrega (con O. Compra)
 *  4. UNA tabla: la repartición (por punto de entrega) con el estado de cada sucursal al momento
 *     de la requisición al lado — venta 30 d, existencia, días de inventario hoy y con el pedido.
 *
 * Decisiones que importan:
 *  - **Es BORRADOR.** El folio RQ-AAAA-NNNNN lo asigna el servidor al registrar la requisición;
 *    este PDF no escribe nada, así que no finge un folio. Lo dice en el encabezado.
 *  - **La O. Compra va en blanco**, un renglón por punto de entrega: se anota a mano cuando se le
 *    dio trámite. Un punto de entrega = una requisición del sistema = una O. Compra.
 *  - **Sólo Latin-1.** Las fuentes estándar de jsPDF (Helvetica) no traen flechas ni símbolos:
 *    un "→" sale como basura. Por eso acá se escribe "a", "->" o se usa el punto medio.
 *
 * Los modelos los arma el componente; este archivo sólo dibuja.
 */
import type { HojaProveedor } from './pedido-requisicion-global';
import { textoCajasPiezas, textoSumaCajasPiezas } from './pedido-redondeo';

import {
  INK, M, MUTED, RULE, altoPuntos, alinearTitulos, dias, dibujarEncabezado, encabezadoRequisicion,
  dibujarFirmas, dibujarNotas, dibujarPies, dibujarPuntos, dibujarRecuadro, fechaHoraArchivo, lastY, loadLibs,
  loadLogo, money, num1, tablaBase, textoParaArchivo,
} from './compras-pdf-comun';

// Se re-exporta: las pruebas y quien ya lo importaba de acá siguen funcionando.
export { textoParaArchivo } from './compras-pdf-comun';

/** Un renglón de la tabla de repartición: a quién le toca, y cómo está esa sucursal hoy. */
export interface ReqPdfFila {
  qtyTxt: string;              // "148 cj", "5 pz"
  destino: string;             // "01 · Padre Hidalgo" (o "... (se queda)" si es el propio CEDIS)
  vta: number;                 // venta 30 d, en cajas
  exis: number;                // existencia, en cajas
  diasActual: number | null;   // días de inventario HOY, sin el pedido
  diasCon: number | null;      // días de inventario con el pedido
  valor: number;
}
/** Un bloque de la tabla: "00 · CEDIS recibe 293 cj 5 pz y reparte así" o "Entrega directa". */
export interface ReqPdfGrupo { titulo: string; filas: ReqPdfFila[]; }
export interface ReqPdfData {
  emitido: Date;
  datosAl: Date | null;
  elaboro: string;
  coberturaDias: number;
  producto: {
    sku: string; nombre: string; proveedor: string;
    uxc: number; unidad: string;
    transitoTxt: string | null;   // "12 cj" en órdenes abiertas, o null
  };
  resumen: {
    pedidoTxt: string;        // "293 cj 5 pz"
    precio: number | null;    // costo por caja; null si no hay pedido
    precioVaria: boolean;     // el costo de caja cambia entre sucursales -> es promedio ponderado
    importe: number;
    entregas: { code: string; name: string }[];   // puntos de entrega: un renglón cada uno, con la OC en blanco
  };
  grupos: ReqPdfGrupo[];
  nTraspasos: number;
  avisos: string[];
}

/** `[RA-PRO.54]` Requisición global: una hoja por proveedor con los productos marcados. */
export interface ReqGlobalPdfData {
  emitido: Date;
  datosAl: Date | null;
  elaboro: string;
  coberturaDias: number;
  alcance: string;          // "12 productos seleccionados"
  hojas: HojaProveedor[];
  avisos: string[];
}

/**
 * `[RA-PRO.56]` Nombre del PDF global, para llevar control de los archivos emitidos:
 * `Requisicion-global_<PROVEEDOR>_AAAA-MM-DD-HH-MM.pdf`. Con varios proveedores dice
 * `VARIOS-PROVEEDORES`.
 */
export function nombreArchivoRequisicionGlobal(proveedores: string[], d: Date): string {
  const unicos = [...new Set(proveedores.map((p) => (p || '').trim()).filter(Boolean))];
  const prov = unicos.length === 1 ? unicos[0] : unicos.length > 1 ? 'VARIOS PROVEEDORES' : 'SIN PROVEEDOR';
  return `Requisicion-global_${textoParaArchivo(prov) || 'SIN-PROVEEDOR'}_${fechaHoraArchivo(d)}.pdf`;
}

/**
 * `[RA-PRO.58]` Nombre del PDF por producto, con el mismo control que el global:
 * `Requisicion_<CODIGO>_<NOMBRE>_AAAA-MM-DD-HH-MM.pdf`. El código conserva sus letras y números
 * (tope de 30 sólo por defensa: los reales son de ~5, y es la llave con la que se busca); el
 * nombre se limpia y se recorta a 40 caracteres.
 */
export function nombreArchivoRequisicion(sku: string, nombre: string, d: Date): string {
  const cod = textoParaArchivo(sku, 30) || 'SIN-CODIGO';
  const nom = textoParaArchivo(nombre);
  return `Requisicion_${cod}${nom ? `_${nom}` : ''}_${fechaHoraArchivo(d)}.pdf`;
}

// ── PDF por producto ───────────────────────────────────────────────────────────────────────

export async function generarRequisicionPdf(data: ReqPdfData): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const p = data.producto;
  const r = data.resumen;
  let y = dibujarEncabezado(doc, logo, encabezadoRequisicion(data.emitido, data.elaboro));

  // ── Renglón 1: proveedor + cobertura · Renglón 2: producto + unidades + órdenes abiertas ─
  autoTable(doc, {
    startY: y, margin: { left: M, right: M }, theme: 'plain',
    styles: { fontSize: 9, cellPadding: { top: 2, bottom: 2, left: 0, right: 8 }, textColor: INK },
    columnStyles: {
      0: { textColor: MUTED, cellWidth: 58 }, 1: { cellWidth: 300 },
      2: { textColor: MUTED, cellWidth: 92 }, 3: { cellWidth: 80 },
      4: { textColor: MUTED, cellWidth: 92 },
    },
    body: [
      ['Proveedor', { content: p.proveedor || 'Sin proveedor asignado', styles: { fontStyle: 'bold' } },
        'Cobertura objetivo', `${data.coberturaDias} días`, '', ''],
      ['Producto', { content: `${p.sku} · ${p.nombre}`, styles: { fontStyle: 'bold' } },
        'Unidades por caja', `${p.uxc.toLocaleString('es-MX')} ${p.unidad}`,
        'En órdenes abiertas', p.transitoTxt || 'Nada pendiente'],
    ],
  });
  y = lastY(doc, y) + 10;

  // ── Renglón 3: recuadros + puntos de entrega (todos a la misma altura) ───────────────────
  const gap = 10;
  const widths = [0.18, 0.18, 0.2, 0.44].map((f) => f * (W - 2 * M - gap * 3));
  const cardH = altoPuntos(r.entregas.length);
  const cards: [string, string][] = [
    ['Pedido', r.pedidoTxt],
    [r.precioVaria ? 'Precio por caja (prom.)' : 'Precio por caja', r.precio == null ? '-' : money(r.precio)],
    ['Importe', money(r.importe)],
  ];
  let cx = M;
  cards.forEach(([t, v], i) => { dibujarRecuadro(doc, cx, y, widths[i], cardH, t, v); cx += widths[i] + gap; });
  dibujarPuntos(doc, cx, y, widths[3], cardH, r.entregas);
  y += cardH + 18;

  // ── Repartición + detalle al momento de la requisición, en UNA tabla ─────────────────────
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text('REPARTICIÓN UNA VEZ RECIBIDA LA MERCANCÍA', M, y);
  if (data.nTraspasos) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    doc.text(`${data.nTraspasos} traspaso${data.nTraspasos === 1 ? '' : 's'} CEDIS a sucursal`, W - M, y, { align: 'right' });
  }
  y += 6;

  const body: unknown[] = [];
  for (const g of data.grupos) {
    body.push([{ content: g.titulo, colSpan: 7, styles: { fillColor: RULE, fontStyle: 'bold', textColor: INK, halign: 'left' } }]);
    for (const f of g.filas) {
      body.push([f.qtyTxt, f.destino, num1(f.vta), num1(f.exis), dias(f.diasActual), dias(f.diasCon), money(f.valor)]);
    }
  }
  autoTable(doc, {
    ...tablaBase, startY: y + 4,
    head: [['Cantidad', 'Destino', 'Venta 30 d (cj)', 'Existencia (cj)', 'Días inv. hoy', 'Días inv. con pedido', 'Valor']],
    body,
    columnStyles: {
      0: { halign: 'right', fontStyle: 'bold', cellWidth: 80 },
      2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' },
      6: { halign: 'right' },
    },
    didParseCell: alinearTitulos([0, 2, 3, 4, 5, 6]),
  });
  y = lastY(doc, y) + 10;

  y = dibujarNotas(doc, y, [
    'Días de inventario = existencia (+ pedido) / (venta 30 d / 30.4). "s/venta" = sin venta en 30 días, no se puede calcular.',
    'Valor = pedido en cajas x costo de caja registrado en cada sucursal.',
    ...data.avisos,
  ]);
  dibujarFirmas(doc, y, data.elaboro);
  dibujarPies(doc, `Requisición ${p.sku}`, data.datosAl);
  doc.save(nombreArchivoRequisicion(p.sku, p.nombre, data.emitido));
}

// ── [RA-PRO.54] PDF global: una hoja por proveedor ─────────────────────────────────────────

export async function generarRequisicionGlobalPdf(data: ReqGlobalPdfData): Promise<void> {
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const hojas = data.hojas;
  const nOc = hojas.reduce((s, h) => s + h.puntos.length, 0);
  const totalValor = hojas.reduce((s, h) => s + h.valor, 0);

  // ── Hoja de resumen, sólo si hay más de un proveedor ─────────────────────────────────────
  if (hojas.length > 1) {
    let y = dibujarEncabezado(doc, logo, encabezadoRequisicion(data.emitido, data.elaboro));
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK);
    doc.text('RESUMEN DE LA REQUISICIÓN', M, y + 4);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text(`${data.alcance} · cobertura objetivo ${data.coberturaDias} días`, M, y + 18);
    y += 28;
    autoTable(doc, {
      ...tablaBase, startY: y,
      head: [['Proveedor', 'Productos', 'Puntos de entrega', 'O. Compra a tramitar', 'Importe']],
      body: hojas.map((h) => [
        h.supplierName || 'Sin proveedor asignado', String(h.productos.length),
        h.puntos.map((p) => p.code).join(', '), String(h.puntos.length), money(h.valor),
      ]),
      foot: [['Total', String(hojas.reduce((s, h) => s + h.productos.length, 0)), '', String(nOc), money(totalValor)]],
      footStyles: { fillColor: RULE, textColor: INK, fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
      didParseCell: alinearTitulos([1, 3, 4]),
    });
    y = lastY(doc, y) + 10;
    dibujarNotas(doc, y, [
      'Cada punto de entrega de un proveedor es una requisición del sistema y lleva su propia O. Compra.',
      ...data.avisos,
    ]);
  }

  // ── Una hoja por proveedor ───────────────────────────────────────────────────────────────
  hojas.forEach((h, hi) => {
    if (hi > 0 || hojas.length > 1) doc.addPage();
    let y = dibujarEncabezado(doc, logo, encabezadoRequisicion(data.emitido, data.elaboro));

    autoTable(doc, {
      startY: y, margin: { left: M, right: M }, theme: 'plain',
      styles: { fontSize: 9, cellPadding: { top: 2, bottom: 2, left: 0, right: 8 }, textColor: INK },
      columnStyles: { 0: { textColor: MUTED, cellWidth: 58 }, 1: { cellWidth: 390 }, 2: { textColor: MUTED, cellWidth: 92 } },
      body: [['Proveedor', { content: h.supplierName || 'Sin proveedor asignado', styles: { fontStyle: 'bold' } },
        'Cobertura objetivo', `${data.coberturaDias} días`]],
    });
    y = lastY(doc, y) + 8;

    const gap = 10;
    const widths = [0.18, 0.22, 0.6].map((f) => f * (W - 2 * M - gap * 2));
    const cardH = altoPuntos(h.puntos.length);
    dibujarRecuadro(doc, M, y, widths[0], cardH, 'Productos', String(h.productos.length));
    dibujarRecuadro(doc, M + widths[0] + gap, y, widths[1], cardH, 'Importe', money(h.valor));
    dibujarPuntos(doc, M + widths[0] + widths[1] + gap * 2, y, widths[2], cardH, h.puntos);
    y += cardH + 18;

    // Pedido al proveedor: una columna por punto de entrega.
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text('PEDIDO AL PROVEEDOR', M, y);
    const pts = h.puntos;
    const head = ['Código', 'Producto', 'U/caja', 'Precio cj', ...pts.map((p) => `Entrega ${p.code} ${p.name}`), 'Total', 'Importe'];
    const nCols = head.length;
    // [RA-PRO.55] Dos renglones de total: lo pedido por almacén (cajas cerradas + piezas sueltas,
    // sin convertir piezas de productos distintos) y el importe por almacén, con el importe del
    // pedido completo en la última columna. El rótulo va en la columna de precio.
    const piezasDe = (code: string) => textoSumaCajasPiezas(
      h.productos.filter((pr) => pr.porPunto[code]).map((pr) => ({ cajas: pr.porPunto[code], uxc: pr.uxc })));
    const vacio = { content: '', colSpan: 3 };
    autoTable(doc, {
      ...tablaBase, startY: y + 6,
      head: [head],
      body: h.productos.map((pr) => [
        pr.sku, pr.nombre, `${pr.uxc.toLocaleString('es-MX')} ${pr.unidad}`,
        money(pr.cajas > 0 ? pr.valor / pr.cajas : 0),
        ...pts.map((p) => (pr.porPunto[p.code] ? textoCajasPiezas(pr.porPunto[p.code], pr.uxc) : '-')),
        textoCajasPiezas(pr.cajas, pr.uxc), money(pr.valor),
      ]),
      foot: [
        [vacio, 'Pedido por almacén', ...pts.map((p) => piezasDe(p.code)),
          textoSumaCajasPiezas(h.productos.map((pr) => ({ cajas: pr.cajas, uxc: pr.uxc }))), ''],
        [vacio, 'Importe por almacén', ...pts.map((p) => money(p.valor)), '', money(h.valor)],
      ],
      footStyles: { fillColor: RULE, textColor: INK, fontStyle: 'bold', halign: 'right' },
      // Los totales son de TODA la tabla: si se parte en dos hojas, van sólo al final (en la
      // primera se leerían como el total de lo que se ve arriba, y no lo es).
      showFoot: 'lastPage',
      // Anchos mínimos para que "6 cj 10 pz", "20 paq" y los importes no se partan en dos renglones.
      columnStyles: Object.fromEntries(
        Array.from({ length: nCols }, (_, i) => {
          const base = i >= 2 ? { halign: 'right' } : {};
          if (i === 0) return [i, { cellWidth: 40 }];
          if (i === 2) return [i, { ...base, cellWidth: 44 }];
          if (i === 3) return [i, { ...base, cellWidth: 56 }];
          if (i === nCols - 2) return [i, { ...base, fontStyle: 'bold', cellWidth: 70 }];
          if (i === nCols - 1) return [i, { ...base, cellWidth: 70 }];
          return [i, base];
        }),
      ),
      didParseCell: alinearTitulos(Array.from({ length: nCols - 2 }, (_, i) => i + 2)),
    });
    y = lastY(doc, y) + 16;

    // Repartición: por cada punto que recibe consolidado, productos x sucursal destino.
    for (const rp of h.repartos) {
      if (y > doc.internal.pageSize.getHeight() - 120) { doc.addPage(); y = M; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
      doc.text(`REPARTICIÓN UNA VEZ RECIBIDA · ${rp.code} ${rp.name}`, M, y);
      const dh = ['Producto', ...rp.destinos.map((d) => (d.code === rp.code ? `${d.code} (se queda)` : `${d.code} ${d.name}`))];
      autoTable(doc, {
        ...tablaBase, startY: y + 6,
        head: [dh],
        body: rp.filas.map((f) => [
          `${f.sku} · ${f.nombre}`,
          ...rp.destinos.map((d) => (f.porDestino[d.code] ? textoCajasPiezas(f.porDestino[d.code], f.uxc) : '-')),
        ]),
        columnStyles: Object.fromEntries(rp.destinos.map((_, i) => [i + 1, { halign: 'right' }])),
        didParseCell: alinearTitulos(rp.destinos.map((_, i) => i + 1)),
      });
      y = lastY(doc, y) + 16;
    }

    const notas = [
      'Precio cj = importe / cajas del producto (promedio si el costo de caja cambia entre sucursales).',
    ];
    if (h.nTraspasos) notas.push(`Esta requisición genera ${h.nTraspasos} traspaso${h.nTraspasos === 1 ? '' : 's'} CEDIS a sucursal.`);
    y = dibujarNotas(doc, y - 6, notas);
    dibujarFirmas(doc, y, data.elaboro);
  });

  dibujarPies(doc, `Requisición global · ${data.alcance}`, data.datosAl);
  doc.save(nombreArchivoRequisicionGlobal(hojas.map((h) => h.supplierName), data.emitido));
}
