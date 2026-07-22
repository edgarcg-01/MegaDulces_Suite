import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

/** Etiqueta legible del bucket + color semántico para el formato condicional. */
const BUCKET_LABEL: Record<string, string> = {
  agotado: 'Agotado',
  bajo_minimo: 'Bajo mínimo',
  bajo_reorden: 'Bajo reorden',
  sano: 'Sano',
  sobrestock: 'Sobrestock',
};
const BASIS_LABEL: Record<string, string> = { cadence: 'Ciclo (cadencia)', min: 'Mínimo', reorder: 'Punto de reorden', max: 'Máximo' };

export interface CriticalStockExport {
  target_basis: string;
  rows: any[];
}

/** RA — Línea de un PEDIDO exportable (cockpit / consolidado / requisición / OC). Todos los
 * campos son opcionales: `buildPedido` incluye una columna solo si alguna línea la trae, de modo
 * que el cockpit sale rico (ranking, venta/mes, ABC/XYZ, cajas) y la requisición/OC salen limpias. */
export interface PedidoExportLine {
  warehouse_code?: string | null;
  supplier_name?: string | null;  // se muestra como columna solo si el pedido abarca varios proveedores (consolidado por categoría)
  sku?: string | null;
  nombre?: string | null;
  abc_class?: string | null;
  xyz_class?: string | null;
  sales_rank?: number | null;      // #1 = el que más vende en la sucursal
  monthly_revenue?: number | null; // venta mensual estimada ($) — cuánto representa en venta
  on_hand?: number | null;
  in_transit?: number | null;
  hub_on_hand?: number | null;     // existencia en el hub (solo traspaso)
  reorder_point?: number | null;
  max_stock?: number | null;
  suggested_qty?: number | null;   // piezas que sugiere el motor
  uxc?: number | null;             // piezas por caja
  cajas?: number | null;           // cajas a pedir (lo que edita el usuario)
  piezas?: number | null;          // piezas finales a pedir (cajas × uxc)
  received_qty?: number | null;
  unit_cost?: number | null;
  line_cost?: number | null;       // importe de la línea
  hub_short?: boolean;             // el hub no alcanza a surtir lo pedido
}

/** RA — Encabezado + líneas de un PEDIDO para exportar a XLSX. */
export interface PedidoExport {
  title?: string | null;
  supplier_name?: string | null;
  warehouse_label?: string | null;
  via?: 'purchase' | 'transfer' | null;
  basis?: string | null;
  source_warehouse_code?: string | null; // hub origen (traspaso)
  folio?: string | null;
  estado?: string | null;
  multi_warehouse?: boolean;              // consolidado → muestra columna Almacén
  lines: PedidoExportLine[];
}

/**
 * RA — Export XLSX con diseño de Existencia Crítica. Mismo lenguaje visual que
 * los otros reportes (Sell-Out/Salidas): título, encabezado estilizado, congelado,
 * autofiltro, formato condicional por estado (agotado/bajo → rojo, reorden → ámbar,
 * sobrestock → azul), fila de totales con SUBTOTAL que respeta el filtro.
 */
@Injectable()
export class ReplenishmentExportService {
  private thin(): Partial<ExcelJS.Borders> {
    const s = { style: 'thin' as const, color: { argb: 'FFD8D5CE' } };
    return { top: s, left: s, bottom: s, right: s };
  }

  fileName(report: CriticalStockExport): string {
    const d = new Date().toISOString().slice(0, 10);
    return `Existencia_Critica_${report.target_basis}_${d}.xlsx`;
  }

  async build(report: CriticalStockExport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    const ws = wb.addWorksheet('Existencia Crítica', {
      views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }],
    });

    const MONEY = '$#,##0.00';
    const NUM = '#,##0';

    // total: se suma en la fila de totales. kind: para formato condicional.
    type Col = {
      h: string;
      v: (r: any, i: number) => string | number;
      fmt?: string;
      total?: boolean;
      kind?: 'estado';
      width?: number;
    };
    const cols: Col[] = [
      { h: '#', v: (_r, i) => i + 1, width: 5 },
      { h: 'Sucursal', v: (r) => r.warehouse_code ?? '', width: 10 },
      { h: 'SKU', v: (r) => r.sku ?? '', width: 12 },
      { h: 'Producto', v: (r) => r.nombre ?? '', width: 40 },
      { h: 'Estado', v: (r) => BUCKET_LABEL[r.bucket] ?? r.bucket ?? '', kind: 'estado', width: 14 },
      { h: 'ABC', v: (r) => r.abc_class ?? '', width: 6 },
      { h: 'XYZ', v: (r) => r.xyz_class ?? '', width: 6 },
      { h: 'Rank vta', v: (r) => (r.sales_rank != null ? Number(r.sales_rank) : ''), fmt: NUM, width: 8 },
      { h: 'Existencia', v: (r) => Number(r.on_hand) || 0, fmt: NUM, width: 11 },
      { h: 'Mínimo', v: (r) => Number(r.min_stock) || 0, fmt: NUM, width: 9 },
      { h: 'Reorden', v: (r) => Number(r.reorder_point) || 0, fmt: NUM, width: 9 },
      { h: 'Máximo', v: (r) => Number(r.max_stock) || 0, fmt: NUM, width: 9 },
      { h: 'Colchón', v: (r) => (r.safety_stock != null ? Number(r.safety_stock) : ''), fmt: NUM, width: 9 },
      { h: 'En tránsito', v: (r) => Number(r.in_transit) || 0, fmt: NUM, total: true, width: 11 },
      { h: 'Sugerido', v: (r) => Number(r.suggested_qty) || 0, fmt: NUM, total: true, width: 11 },
      { h: 'Costo unit.', v: (r) => Number(r.unit_cost) || 0, fmt: MONEY, width: 12 },
      { h: 'Costo sugerido', v: (r) => Number(r.suggested_cost) || 0, fmt: MONEY, total: true, width: 15 },
      { h: 'Proveedor', v: (r) => r.supplier_name ?? '', width: 28 },
    ];
    const lastCol = cols.length;
    const lastColL = ws.getColumn(lastCol).letter;

    // Fila 1 — título
    ws.mergeCells(1, 1, 1, lastCol);
    const title = ws.getCell(1, 1);
    const fecha = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
    title.value = `EXISTENCIA CRÍTICA  ·  objetivo: ${BASIS_LABEL[report.target_basis] ?? report.target_basis}  ·  ${fecha}`;
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    // Fila 2 — resumen (conteos por estado + costo sugerido total)
    const count = (b: string) => report.rows.filter((r) => r.bucket === b).length;
    const sugCosto = report.rows.reduce((s, r) => s + (Number(r.suggested_cost) || 0), 0);
    ws.mergeCells(2, 1, 2, lastCol);
    const sub = ws.getCell(2, 1);
    sub.value =
      `${report.rows.length} productos  ·  Agotado ${count('agotado')}  ·  Bajo mínimo ${count('bajo_minimo')}  ·  ` +
      `Bajo reorden ${count('bajo_reorden')}  ·  Sobrestock ${count('sobrestock')}  ·  ` +
      `Costo sugerido total ${sugCosto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`;
    sub.font = { size: 9, color: { argb: 'FF52525B' } };
    sub.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 18;

    // Fila 3 — encabezado
    const hr = ws.addRow(cols.map((c) => c.h)); // se agrega como fila 3
    hr.eachCell((c) => {
      c.font = { bold: true, size: 9, color: { argb: 'FF3F3F46' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
      c.border = this.thin();
    });
    hr.height = 26;

    // Filas de datos
    report.rows.forEach((r, i) => {
      const added = ws.addRow(cols.map((c) => c.v(r, i)));
      cols.forEach((c, ci) => {
        const cell = added.getCell(ci + 1);
        if (c.fmt) cell.numFmt = c.fmt;
      });
      // Costo sugerido en negrita (la cifra que manda)
      added.getCell(lastCol - 1).font = { bold: true };
    });

    const n = report.rows.length;
    const first = 4; // primera fila de datos
    const last = 3 + n;

    if (n > 0) {
      ws.autoFilter = `A3:${lastColL}3`;

      // Fila de totales — SUBTOTAL(109) respeta el filtro activo.
      const totalRow = ws.addRow(
        cols.map((c, ci) => {
          if (ci === 0) return 'TOTAL';
          if (!c.total) return '';
          const L = ws.getColumn(ci + 1).letter;
          return { formula: `SUBTOTAL(109,${L}${first}:${L}${last})` } as any;
        }),
      );
      totalRow.eachCell((cell, ci) => {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
        cell.border = { top: { style: 'thin', color: { argb: 'FFB8B4AC' } } };
        if (cols[ci - 1]?.fmt) cell.numFmt = cols[ci - 1].fmt!;
      });

      const dataRange = `A${first}:${lastColL}${last}`;
      // Renglones alternados.
      ws.addConditionalFormatting({
        ref: dataRange,
        rules: [
          { type: 'expression', priority: 5, formulae: ['MOD(ROW(),2)=0'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFAFAF9' } } } } as any,
        ],
      });

      // Estado (columna E) — color por severidad.
      const estIdx = cols.findIndex((c) => c.kind === 'estado');
      if (estIdx >= 0) {
        const L = ws.getColumn(estIdx + 1).letter;
        const ref = `${L}${first}:${L}${last}`;
        ws.addConditionalFormatting({
          ref,
          rules: [
            { type: 'containsText', operator: 'containsText', text: 'Agotado', priority: 1, style: { font: { bold: true, color: { argb: 'FFB91C1C' } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFEE2E2' } } } } as any,
            { type: 'containsText', operator: 'containsText', text: 'Bajo mínimo', priority: 2, style: { font: { bold: true, color: { argb: 'FFB91C1C' } } } } as any,
            { type: 'containsText', operator: 'containsText', text: 'Bajo reorden', priority: 3, style: { font: { color: { argb: 'FFA16207' } } } } as any,
            { type: 'containsText', operator: 'containsText', text: 'Sobrestock', priority: 4, style: { font: { color: { argb: 'FF1D4ED8' } } } } as any,
          ],
        });
      }
    }

    // Anchos
    cols.forEach((c, ci) => { if (c.width) ws.getColumn(ci + 1).width = c.width; });

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf as ArrayBuffer);
  }

  fileNamePedido(order: PedidoExport): string {
    const d = new Date().toISOString().slice(0, 10);
    const tag = (order.folio || order.supplier_name || 'pedido')
      .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'pedido';
    return `Pedido_${tag}_${d}.xlsx`;
  }

  /**
   * RA — Export XLSX de un PEDIDO/requisición con el mismo lenguaje visual que Existencia
   * Crítica: título, resumen con totales, encabezado estilizado, congelado, autofiltro, fila de
   * TOTAL con SUBTOTAL (respeta el filtro) y renglones alternados. Las columnas son dinámicas:
   * ranking / venta-mes / ABC-XYZ / cajas aparecen solo si las líneas las traen. Solo se colorean
   * los problemas (existencia agotada, hub corto) — quiet-luxury.
   */
  async buildPedido(order: PedidoExport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    const ws = wb.addWorksheet('Pedido');

    const MONEY = '$#,##0.00';
    const NUM = '#,##0';
    const rows = order.lines || [];
    const isTransfer = order.via === 'transfer';
    const any = (f: (r: PedidoExportLine) => boolean) => rows.some(f);
    const pzOf = (r: PedidoExportLine) => Number(r.piezas ?? Number(r.cajas || 0) * Number(r.uxc || 1)) || 0;
    const lineCostOf = (r: PedidoExportLine) => Number(r.line_cost ?? pzOf(r) * Number(r.unit_cost || 0)) || 0;

    // Columna presente solo si alguna línea aporta el dato.
    const has = {
      wh: !!order.multi_warehouse || any((r) => !!r.warehouse_code),
      // Proveedor solo si el pedido abarca >1 (consolidado por categoría). Con un solo proveedor va en el encabezado.
      sup: new Set(rows.map((r) => r.supplier_name).filter(Boolean)).size > 1,
      abc: any((r) => !!r.abc_class),
      xyz: any((r) => !!r.xyz_class),
      rank: any((r) => r.sales_rank != null),
      rev: any((r) => r.monthly_revenue != null && Number(r.monthly_revenue) > 0),
      oh: any((r) => r.on_hand != null),
      transit: any((r) => Number(r.in_transit) > 0),
      hub: isTransfer && any((r) => r.hub_on_hand != null),
      reorder: any((r) => r.reorder_point != null),
      max: any((r) => r.max_stock != null),
      suggested: any((r) => r.suggested_qty != null),
      uxc: any((r) => Number(r.uxc) > 1),
      cajas: any((r) => r.cajas != null),
      received: any((r) => r.received_qty != null),
    };

    type Col = {
      h: string;
      v: (r: PedidoExportLine, i: number) => string | number;
      fmt?: string;
      total?: boolean;
      kind?: 'oh' | 'hub' | 'cajas' | 'importe';
      width?: number;
    };
    const cols: Col[] = [{ h: '#', v: (_r, i) => i + 1, width: 5 }];
    if (has.wh) cols.push({ h: 'Almacén', v: (r) => r.warehouse_code ?? '', width: 10 });
    if (has.sup) cols.push({ h: 'Proveedor', v: (r) => r.supplier_name ?? '', width: 26 });
    cols.push({ h: 'SKU', v: (r) => r.sku ?? '', width: 12 });
    cols.push({ h: 'Producto', v: (r) => r.nombre ?? '', width: 42 });
    if (has.abc) cols.push({ h: 'ABC', v: (r) => r.abc_class ?? '', width: 6 });
    if (has.xyz) cols.push({ h: 'XYZ', v: (r) => r.xyz_class ?? '', width: 6 });
    if (has.rank) cols.push({ h: 'Rank vta', v: (r) => (r.sales_rank != null ? Number(r.sales_rank) : ''), fmt: NUM, width: 8 });
    if (has.rev) cols.push({ h: 'Venta/mes', v: (r) => Number(r.monthly_revenue) || 0, fmt: MONEY, total: true, width: 13 });
    if (has.oh) cols.push({ h: 'Existencia', v: (r) => Number(r.on_hand) || 0, fmt: NUM, kind: 'oh', width: 11 });
    if (has.transit) cols.push({ h: 'En tránsito', v: (r) => Number(r.in_transit) || 0, fmt: NUM, width: 11 });
    if (has.hub) cols.push({ h: 'En hub', v: (r) => (r.hub_on_hand != null ? Number(r.hub_on_hand) : ''), fmt: NUM, kind: 'hub', width: 10 });
    if (has.reorder) cols.push({ h: 'Reorden', v: (r) => Number(r.reorder_point) || 0, fmt: NUM, width: 9 });
    if (has.max) cols.push({ h: 'Máximo', v: (r) => Number(r.max_stock) || 0, fmt: NUM, width: 9 });
    if (has.suggested) cols.push({ h: 'Sugerido', v: (r) => Number(r.suggested_qty) || 0, fmt: NUM, width: 10 });
    if (has.uxc) cols.push({ h: 'Pz/caja', v: (r) => Number(r.uxc) || 1, fmt: NUM, width: 8 });
    if (has.cajas) cols.push({ h: 'Pedir (cajas)', v: (r) => (r.cajas != null ? Number(r.cajas) : ''), fmt: NUM, total: true, kind: 'cajas', width: 12 });
    cols.push({ h: 'Piezas', v: (r) => pzOf(r), fmt: NUM, total: true, width: 10 });
    if (has.received) cols.push({ h: 'Recibido', v: (r) => (r.received_qty != null ? Number(r.received_qty) : ''), fmt: NUM, width: 10 });
    cols.push({ h: 'Costo unit.', v: (r) => Number(r.unit_cost) || 0, fmt: MONEY, width: 12 });
    cols.push({ h: 'Importe', v: (r) => lineCostOf(r), fmt: MONEY, total: true, kind: 'importe', width: 14 });

    const lastCol = cols.length;
    const lastColL = ws.getColumn(lastCol).letter;
    // Congelar la identidad (#, [Almacén], [Proveedor], SKU, Producto) + las 3 filas de encabezado.
    const xSplit = 1 + (has.wh ? 1 : 0) + (has.sup ? 1 : 0) + 2;
    ws.views = [{ state: 'frozen', xSplit, ySplit: 3 }];

    // Fila 1 — título
    ws.mergeCells(1, 1, 1, lastCol);
    const title = ws.getCell(1, 1);
    const fecha = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
    const head = (order.title || `PEDIDO · ${order.supplier_name || ''}`).trim();
    title.value = `${head}  ·  ${fecha}`;
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    // Fila 2 — resumen (canal + contexto + totales)
    ws.mergeCells(2, 1, 2, lastCol);
    const sub = ws.getCell(2, 1);
    const nCajas = rows.reduce((s, r) => s + (Number(r.cajas) || 0), 0);
    const nPz = rows.reduce((s, r) => s + pzOf(r), 0);
    const importe = rows.reduce((s, r) => s + lineCostOf(r), 0);
    const ctx: string[] = [isTransfer ? `Traspaso${order.source_warehouse_code ? ' ← ' + order.source_warehouse_code : ''}` : 'Compra'];
    if (order.warehouse_label) ctx.push(order.warehouse_label);
    if (order.basis) ctx.push(`objetivo ${BASIS_LABEL[order.basis] ?? order.basis}`);
    if (order.estado) ctx.push(order.estado);
    const totals =
      `${rows.length} líneas` +
      (has.cajas ? ` · ${nCajas.toLocaleString('es-MX')} cajas` : '') +
      ` · ${nPz.toLocaleString('es-MX')} pz · ${importe.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`;
    sub.value = `${ctx.join('  ·  ')}   —   ${totals}`;
    sub.font = { size: 9, color: { argb: 'FF52525B' } };
    sub.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 18;

    // Fila 3 — encabezado
    const hr = ws.addRow(cols.map((c) => c.h));
    hr.eachCell((c) => {
      c.font = { bold: true, size: 9, color: { argb: 'FF3F3F46' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
      c.border = this.thin();
    });
    hr.height = 26;

    // Filas de datos — colorea solo los problemas (agotado / hub corto), negrita en cajas e importe.
    rows.forEach((r, i) => {
      const added = ws.addRow(cols.map((c) => c.v(r, i)));
      cols.forEach((c, ci) => {
        const cell = added.getCell(ci + 1);
        if (c.fmt) cell.numFmt = c.fmt;
        if (c.kind === 'importe' || c.kind === 'cajas') cell.font = { bold: true };
        if (c.kind === 'oh' && Number(r.on_hand) <= 0) cell.font = { bold: true, color: { argb: 'FFB91C1C' } };
        if (c.kind === 'hub' && r.hub_short) cell.font = { bold: true, color: { argb: 'FFB91C1C' } };
      });
    });

    const n = rows.length;
    const first = 4;
    const last = 3 + n;
    if (n > 0) {
      ws.autoFilter = `A3:${lastColL}3`;

      const totalRow = ws.addRow(
        cols.map((c, ci) => {
          if (ci === 0) return 'TOTAL';
          if (!c.total) return '';
          const L = ws.getColumn(ci + 1).letter;
          return { formula: `SUBTOTAL(109,${L}${first}:${L}${last})` } as any;
        }),
      );
      totalRow.eachCell((cell, ci) => {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
        cell.border = { top: { style: 'thin', color: { argb: 'FFB8B4AC' } } };
        if (cols[ci - 1]?.fmt) cell.numFmt = cols[ci - 1].fmt!;
      });

      ws.addConditionalFormatting({
        ref: `A${first}:${lastColL}${last}`,
        rules: [
          { type: 'expression', priority: 5, formulae: ['MOD(ROW(),2)=0'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFAFAF9' } } } } as any,
        ],
      });
    }

    cols.forEach((c, ci) => { if (c.width) ws.getColumn(ci + 1).width = c.width; });

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf as ArrayBuffer);
  }
}
