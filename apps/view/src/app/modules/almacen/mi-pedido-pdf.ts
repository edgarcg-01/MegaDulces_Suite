/**
 * `[AB.21]` PDF de **«Mi pedido»** para la captura manual — mientras llega la etapa 2 (envío a la
 * matriz y a Compras desde la Suite), el almacenista se lleva este papel a Kepler:
 *  · a la **matriz** que lo surte → «Pedido de traspaso», lo captura la sucursal que abastece;
 *  · al **proveedor** → «Requisición de compra», lo tramita Compras.
 *
 * Un origen por hoja y, dentro, las listas de surtido de AB.19 en tablas separadas (unidad mayor /
 * unidad menor / una sola unidad): la matriz surte una orden de cajas y otra de piezas. Es hoja de
 * transcripción y análisis: el orden de columnas sigue la captura (SKU, cantidad, unidad, producto)
 * y la última columna es el aviso del renglón, no un espacio en blanco para anotar.
 *
 * Lo que se imprime es EXACTAMENTE lo que lleva el pedido en pantalla: las posiciones marcadas, los
 * ajustes del almacenista (guardados o en curso) y el mínimo de $200. Ese cálculo lo hace la
 * pantalla (`aRenglonesPdf`); acá sólo se dibuja.
 *
 * ⚠️ Sólo Latin-1 (Helvetica de jsPDF): nada de flechas, rayas largas ni signo menos.
 */
import type jsPDFType from 'jspdf';
import { CLASE_UNIDAD_LABEL, type ClaseUnidad } from '@megadulces/contracts';
import {
  loadLibs, loadLogo, dibujarEncabezado, dibujarRecuadro, dibujarNotas, dibujarPies,
  tablaBase, alinearTitulos, lastY, money, textoParaArchivo, M, MUTED, HEAD, INK, type AutoTableFn,
} from '../compras/compras-pdf-comun';
import { fechaLarga } from './autoabasto-pdf';
import { qty } from './porques.util';

export interface MiPedidoPdfRenglon {
  sku: string;
  nombre: string;
  /** Lo que lleva el pedido (ajuste o sugerido), en `unidad`. */
  cantidad: number;
  unidad: string | null;
  /** En cajas, como la pantalla. */
  existencia: number;
  venta_30d: number | null;
  /** `null` = no se pudo valuar (se imprime «sin medir», nunca $0). */
  valor: number | null;
  /** Lo que conviene saber al capturarlo: ajustado, agotado de poco valor, atorado… */
  nota: string;
}

export interface MiPedidoPdfLista { clase: ClaseUnidad; renglones: MiPedidoPdfRenglon[] }

export interface MiPedidoPdfGrupo {
  tipo: 'matriz' | 'proveedor' | 'sin_ruta';
  /** «01 · Padre Hidalgo» o el nombre del proveedor. */
  origen: string;
  listas: MiPedidoPdfLista[];
  /** Aviso de pedido mínimo del proveedor no alcanzado, ya en palabras. */
  aviso: string | null;
}

export interface MiPedidoPdfDatos {
  almacen: { code: string; name: string };
  /** Fecha y hora del cálculo, del servidor (hora de México). */
  fecha_mx: string;
  hora_mx: string;
  elaboro: string | null;
  /** Las posiciones que entran al pedido, en palabras («Agotado, Bajo mínimo»). */
  posiciones: string[];
  grupos: MiPedidoPdfGrupo[];
}

const AYUDA_LISTA: Record<ClaseUnidad, string> = {
  mayor: 'cajas, bultos',
  menor: 'piezas, paquetes, kilos',
  unica: 'productos con una sola unidad',
  sin_unidad: 'Kepler no trae su unidad: revisar al capturar',
};

function titulo(tipo: MiPedidoPdfGrupo['tipo']): string {
  return tipo === 'matriz' ? 'Pedido de traspaso entre sucursales'
    : tipo === 'proveedor' ? 'Requisición de compra a proveedor'
      : 'Pedido sin ruta de abasto configurada';
}

function firmas(tipo: MiPedidoPdfGrupo['tipo'], elaboro: string | null): string[] {
  const yo = `Elaboró (Almacén solicitante)${elaboro ? ` · ${elaboro}` : ''}`;
  return tipo === 'proveedor'
    ? [yo, 'Autorizó (Compras)', 'Recibió (Almacén)']
    : [yo, 'Surtió (sucursal que abastece)', 'Recibió (Almacén)'];
}

/** Dibuja UN origen desde la `y` dada (página nueva ya abierta si hacía falta). */
function dibujarGrupo(
  doc: jsPDFType, autoTable: AutoTableFn,
  logo: string | null, d: MiPedidoPdfDatos, g: MiPedidoPdfGrupo,
): void {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  let y = dibujarEncabezado(doc, logo, {
    titulo: titulo(g.tipo),
    cajaTitulo: `PIDE: ${d.almacen.code} · ${d.almacen.name}`,
    // A quién se le pide, tan visible como quién pide (pedido de Francisco, 2026-10-13).
    cajaTitulo2: `${g.tipo === 'matriz' ? 'A LA SUCURSAL' : g.tipo === 'proveedor' ? 'AL PROVEEDOR' : 'ORIGEN'}: ${g.origen}`,
    cajaLineas: [
      `Fecha: ${fechaLarga(d.fecha_mx)} · ${d.hora_mx} (hora de México)`,
      `Elaboró: ${d.elaboro || 'sin usuario'}`,
    ],
  });

  // ── Recuadros: cuánto es y qué se incluyó. ──────────────────────────────────────────────
  const todos = g.listas.flatMap((l) => l.renglones);
  const mayores = g.listas.find((l) => l.clase === 'mayor')?.renglones.reduce((s, r) => s + r.cantidad, 0) ?? 0;
  const valuados = todos.filter((r) => r.valor != null);
  const valor = valuados.reduce((s, r) => s + (r.valor as number), 0);
  const cajas: [string, string][] = [
    ['Renglones', String(todos.length)],
    ['Unidades mayores', mayores > 0 ? qty(mayores) : '-'],
    ['Valor a costo', valuados.length ? money(valor) : 'sin medir'],
  ];
  const gap = 10;
  const bw = (W - 2 * M - gap * (cajas.length - 1)) / cajas.length;
  cajas.forEach(([t, v], i) => dibujarRecuadro(doc, M + i * (bw + gap), y, bw, 40, t, v));
  y += 52;
  // Lo que entra va como línea completa: en un recuadro se cortaba («Agotado, Bajo»).
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text(`Incluye: ${d.posiciones.join(', ') || 'nada'}`, M, y);
  y += 12;

  if (g.aviso) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(146, 64, 14);
    const l = doc.splitTextToSize(g.aviso, W - 2 * M);
    doc.text(l, M, y); y += l.length * 10 + 4;
  }

  // ── Una tabla por lista de surtido ──────────────────────────────────────────────────────
  const COLS = 8;
  for (const lista of g.listas) {
    if (!lista.renglones.length) continue;
    const suma = lista.renglones.reduce((s, r) => s + r.cantidad, 0);
    const val = lista.renglones.filter((r) => r.valor != null);
    autoTable(doc, {
      ...tablaBase,
      startY: y,
      head: [
        [{ content: `ORDEN DE ${CLASE_UNIDAD_LABEL[lista.clase].toUpperCase()}  ·  ${AYUDA_LISTA[lista.clase]}  ·  ${lista.renglones.length} renglón(es)`,
          colSpan: COLS, styles: { fillColor: [231, 229, 228], textColor: INK, fontStyle: 'bold', fontSize: 8 } }],
        // Orden de captura (Francisco, 2026-10-13): código, cuánto y en qué unidad primero, luego el
        // contexto. Es hoja de transcripción y análisis: «Aviso» reemplaza a la columna en blanco.
        ['SKU', 'Pedir', 'Unidad', 'Producto', 'Exist. (cj)', 'Vta 30 d (cj)', 'Valor', 'Aviso'],
      ],
      body: lista.renglones.map((r) => [
        r.sku,
        qty(r.cantidad),
        r.unidad ?? 'sin unidad',
        r.nombre,
        qty(r.existencia),
        r.venta_30d == null ? '-' : qty(r.venta_30d),
        r.valor == null ? 'sin medir' : money(r.valor),
        r.nota,
      ]),
      foot: [['', lista.clase === 'mayor' ? qty(suma) : '', '', 'Total', '', '',
        val.length ? money(val.reduce((s, r) => s + (r.valor as number), 0)) : 'sin medir', '']],
      showFoot: 'lastPage',
      footStyles: { fillColor: [245, 245, 244], textColor: INK, fontStyle: 'bold' },
      // Interlineado compacto (Francisco, 2026-10-13: 40 renglones por hoja). Medido con 120
      // renglones de nombres reales: con letra 8 y relleno 3.5 entraban 30 por hoja.
      margin: { left: M, right: M, top: 30, bottom: 34 },
      styles: { ...tablaBase.styles, fontSize: 7.5, cellPadding: { top: 1.6, bottom: 1.6, left: 3, right: 3 } },
      headStyles: { ...tablaBase.headStyles, fontSize: 7, cellPadding: { top: 2, bottom: 2, left: 3, right: 3 } },
      columnStyles: {
        // Producto se queda con el ancho sobrante (~190 pt): que los nombres no se partan en dos
        // líneas es lo que más renglones mete por hoja.
        0: { cellWidth: 34 },
        1: { halign: 'right', cellWidth: 30, fontStyle: 'bold', fontSize: 8.5 },
        2: { cellWidth: 30 },
        3: { cellWidth: 'auto' },
        4: { halign: 'right', cellWidth: 36 },
        5: { halign: 'right', cellWidth: 42 },
        6: { halign: 'right', cellWidth: 50 },
        7: { cellWidth: 128, fontSize: 6.5 },
      },
      didParseCell: alinearTitulos([1, 4, 5, 6]),
    });
    y = lastY(doc, y) + 12;
  }

  // ── Notas y firmas ──────────────────────────────────────────────────────────────────────
  y = dibujarNotas(doc, y + 4, [
    'Pedir: la cantidad a capturar en Kepler, en la unidad de la columna Unidad. Existencia y venta de 30 días van en cajas.',
    'Ya se descontó lo pedido a la matriz en los últimos 7 días. Lo que va en unidad menor y vale menos de $200 no se incluye, salvo que esté agotado.',
    'Documento para captura manual: no es un pedido registrado en Kepler hasta que se captura allá.',
  ]);
  if (y > H - 90) { doc.addPage(); y = M; }
  const fy = Math.max(y + 34, H - 78);
  const fw = (W - 2 * M - 40) / 3;
  firmas(g.tipo, d.elaboro).forEach((f, i) => {
    const fx = M + i * (fw + 20);
    doc.setDrawColor(...HEAD); doc.line(fx, fy, fx + fw, fy);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(doc.splitTextToSize(f, fw)[0], fx, fy + 11);
  });
}

/**
 * Arma el PDF de uno o varios orígenes (cada uno en su hoja) y lo descarga. Devuelve el nombre del
 * archivo, o `null` si no había nada que imprimir.
 */
export async function descargarPdfMiPedido(d: MiPedidoPdfDatos): Promise<string | null> {
  const grupos = d.grupos.filter((g) => g.listas.some((l) => l.renglones.length));
  if (!grupos.length) return null;
  const [{ jsPDF, autoTable }, logo] = await Promise.all([loadLibs(), loadLogo()]);
  const doc: jsPDFType = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter', compress: true });
  grupos.forEach((g, i) => {
    if (i > 0) doc.addPage();
    dibujarGrupo(doc, autoTable, logo, d, g);
  });
  dibujarPies(doc, `Pedido de ${d.almacen.name} · ${fechaLarga(d.fecha_mx)} ${d.hora_mx}`, null, 'Almacén > Abasto > Autoabasto');
  const quien = grupos.length === 1 ? textoParaArchivo(grupos[0].origen, 24) : 'TODOS';
  const archivo = `PEDIDO-${textoParaArchivo(d.almacen.code)}-${quien}-${d.fecha_mx}-${d.hora_mx.replace(':', '-')}.pdf`;
  doc.save(archivo);
  return archivo;
}
