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
const BASIS_LABEL: Record<string, string> = { min: 'Mínimo', reorder: 'Punto de reorden', max: 'Máximo' };

export interface CriticalStockExport {
  target_basis: string;
  rows: any[];
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
}
