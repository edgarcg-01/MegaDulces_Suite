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
  sell_daily?: number | null;      // venta diaria (cajas/día) — la columna "Vta" de la interfaz
  days_cover?: number | null;      // cobertura actual (días) — la "Señal" de compra
  deficit?: number | null;         // déficit de la sucursal (cajas) — la "Señal" de traspaso
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
  by_supplier?: boolean;                  // XLSX por proveedor: una hoja por proveedor
  lines: PedidoExportLine[];
}

/** RA-PRO.32.5 — Workbook del comprador: réplica columnar (una HOJA por proveedor). */
export interface WorkbookExportTerritory { code: string; name: string; }
export interface WorkbookExportRow {
  supplier_id?: string | null;
  supplier_name?: string | null;
  sku?: string | null;
  nombre?: string | null;
  uxc?: number | null;
  caja_cost?: number | null;
  xyz_class?: string | null;       // clase XYZ de red (peor-caso entre sucursales)
  reorder_cajas?: number | null;   // punto de reorden de red, en cajas
  max_cajas?: number | null;       // máximo de red, en cajas
  // U.2 — `rung`/`nat`/`natu` sólo vienen cuando el peldaño de unidad de ese almacén NO está
  // verificado; entonces `exis` no es confiable y se exporta `nat` + `natu` (la cantidad y el
  // rótulo de la unidad que el ERP realmente guarda). Ver analytics.v_unit_rung_audit.
  cells?: Record<string, {
    vta?: number; exis?: number; ped?: number;
    rung?: string; nat?: number; natu?: string;
  }> | null;
  suma_pedido_cajas?: number | null;
  pedido_valor?: number | null;
  valor_venta?: number | null;
  valor_exis?: number | null;
}
/** RA — renglón de traspaso sugerido (déficit de sucursal ← stock del CEDIS que la surte). */
export interface TransferExportRow {
  sku?: string | null;
  nombre?: string | null;
  uxc?: number | null;
  from_code?: string | null;      // CEDIS origen
  to_code?: string | null;        // sucursal destino
  to_name?: string | null;
  supplier_name?: string | null;
  deficit_cajas?: number | null;
  transfer_cajas?: number | null;
  transfer_pieces?: number | null;
  shortfall_pieces?: number | null; // déficit que el CEDIS NO cubre → se compra
  unit_cost?: number | null;
  transfer_value?: number | null;
}
export interface WorkbookExport {
  coverage_days: number;
  territories: WorkbookExportTerritory[];
  rows: WorkbookExportRow[];
  transfers?: TransferExportRow[]; // RA — hoja "Traspasos" del workbook global (opcional)
}

/**
 * RA — Export XLSX con diseño de Existencia Crítica. Mismo lenguaje visual que
 * los otros reportes (Sell-Out/Salidas): título, encabezado estilizado, congelado,
 * autofiltro, formato condicional por estado (agotado/bajo → rojo, reorden → ámbar,
 * sobrestock → azul), fila de totales con SUBTOTAL que respeta el filtro.
 */
@Injectable()
export class ReplenishmentExportService {
  /**
   * U.2 — rótulo de la unidad NATIVA para el XLSX. Kepler a veces guarda ahí un NÚMERO (el gramaje
   * de la bolsa: '500', '250') en vez del nombre de la unidad; concatenarlo daba "298 500", que no
   * se lee como nada. En ese caso se dice completo. Misma regla que `natUnitOf()` en
   * compras-pedido-real.component.ts — si cambia una, cambia la otra.
   */
  private natLabel(natu?: string): string {
    const raw = (natu || '').trim();
    if (!raw) return 'u';
    return /^[\d.]+$/.test(raw) ? `u. de ${raw}` : raw.toLowerCase();
  }

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
      { h: 'Existencia (cajas)', v: (r) => Number(r.on_hand) || 0, fmt: NUM, width: 13 },
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
    this.writePedidoSheet(wb, 'Pedido', order);
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }

  /**
   * RA-PRO.32.5 — Pedido con UNA HOJA por proveedor, mismas columnas/estilo que buildPedido.
   * Se alimenta con las MISMAS líneas que muestra la interfaz (motor de reorden) → el Excel
   * refleja idéntico lo que ve el comprador en pantalla, con sus filtros ya aplicados.
   */
  async buildPedidoBySupplier(order: PedidoExport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    const bySup = new Map<string, PedidoExportLine[]>();
    for (const r of order.lines || []) {
      const k = (r.supplier_name == null ? '' : String(r.supplier_name).trim()) || 'Sin proveedor';
      (bySup.get(k) ?? bySup.set(k, []).get(k)!).push(r);
    }
    // Array.from (NO spread [...]): webpack downlevela [...map.keys()] en el bundle del API → .sort revienta. Ver feedback_webpack_set_spread_downlevel.
    const suppliers = Array.from(bySup.keys()).sort((a, b) => a.localeCompare(b, 'es'));
    if (!suppliers.length) { this.writePedidoSheet(wb, 'Pedido', order); }
    const used = new Set<string>();
    for (const sup of suppliers) {
      // Excel: nombre de hoja ≤31 chars, sin : \ / ? * [ ], único.
      const base = (sup.replace(/[:\\/?*[\]]/g, ' ').trim() || 'Proveedor').slice(0, 28);
      let name = base, n = 2;
      while (used.has(name.toLowerCase())) name = `${base.slice(0, 25)} ${n++}`;
      used.add(name.toLowerCase());
      this.writePedidoSheet(wb, name, { ...order, supplier_name: sup, lines: bySup.get(sup)! });
    }
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }

  /** Escribe UNA hoja de pedido (columnas dinámicas + resumen + total + zebra) en el wb dado. */
  private writePedidoSheet(wb: ExcelJS.Workbook, sheetName: string, order: PedidoExport): void {
    const ws = wb.addWorksheet(sheetName);

    const MONEY = '$#,##0.00';
    const NUM = '#,##0';
    const N1 = '#,##0.0';
    // Paleta Mercado (Stone) → ARGB. Tinta espresso, banda de encabezado stone-800,
    // hairlines stone-200, acento sunset reservado para la cifra que manda (Importe).
    const INK = 'FF1C1917', MUTED = 'FF78716C', BAND = 'FF292524', BAND_TXT = 'FFFFFFFF';
    const HAIR = 'FFE7E5E4', TOTAL_BG = 'FFF5F5F4', TOTAL_LINE = 'FFA8A29E';
    const ACCENT = 'FFC2410C', BAD = 'FFB91C1C', FONT = 'Calibri';
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
      sell: any((r) => r.sell_daily != null && Number(r.sell_daily) > 0),
      cover: any((r) => r.days_cover != null),
      deficit: any((r) => r.deficit != null && Number(r.deficit) > 0),
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
      align?: 'left' | 'center' | 'right';
      width?: number;
    };
    const cols: Col[] = [{ h: '#', v: (_r, i) => i + 1, align: 'center', width: 5 }];
    if (has.wh) cols.push({ h: 'Almacén', v: (r) => r.warehouse_code ?? '', align: 'left', width: 10 });
    if (has.sup) cols.push({ h: 'Proveedor', v: (r) => r.supplier_name ?? '', align: 'left', width: 26 });
    cols.push({ h: 'SKU', v: (r) => r.sku ?? '', align: 'left', width: 12 });
    cols.push({ h: 'Producto', v: (r) => r.nombre ?? '', align: 'left', width: 42 });
    if (has.abc) cols.push({ h: 'ABC', v: (r) => r.abc_class ?? '', align: 'center', width: 6 });
    if (has.xyz) cols.push({ h: 'XYZ', v: (r) => r.xyz_class ?? '', align: 'center', width: 6 });
    if (has.rank) cols.push({ h: 'Rank vta', v: (r) => (r.sales_rank != null ? Number(r.sales_rank) : ''), fmt: NUM, width: 8 });
    if (has.rev) cols.push({ h: 'Venta/mes', v: (r) => Number(r.monthly_revenue) || 0, fmt: MONEY, total: true, width: 13 });
    if (has.sell) cols.push({ h: 'Venta/día', v: (r) => (r.sell_daily != null ? Number(r.sell_daily) : ''), fmt: N1, width: 10 });
    if (has.oh) cols.push({ h: 'Existencia', v: (r) => Number(r.on_hand) || 0, fmt: NUM, kind: 'oh', width: 11 });
    if (has.transit) cols.push({ h: 'En tránsito', v: (r) => Number(r.in_transit) || 0, fmt: NUM, width: 11 });
    if (has.hub) cols.push({ h: 'En hub', v: (r) => (r.hub_on_hand != null ? Number(r.hub_on_hand) : ''), fmt: NUM, kind: 'hub', width: 10 });
    if (has.cover) cols.push({ h: 'Cobertura (d)', v: (r) => (r.days_cover != null ? Number(r.days_cover) : ''), fmt: NUM, width: 11 });
    if (has.deficit) cols.push({ h: 'Déficit', v: (r) => (r.deficit != null ? Number(r.deficit) : ''), fmt: N1, width: 9 });
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

    const alignOf = (c: Col): 'left' | 'center' | 'right' => c.align ?? (c.fmt ? 'right' : 'left');

    // Fila 1 — título (jerarquía editorial, alineado a la izquierda, tinta espresso).
    ws.mergeCells(1, 1, 1, lastCol);
    const title = ws.getCell(1, 1);
    const fecha = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
    const head = (order.title || `PEDIDO · ${order.supplier_name || ''}`).trim();
    title.value = head;
    title.font = { name: FONT, bold: true, size: 16, color: { argb: INK } };
    title.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.getRow(1).height = 28;

    // Fila 2 — resumen (contexto + totales); acento sunset en la fecha para anclar.
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
    sub.value = {
      richText: [
        { text: `${ctx.join('  ·  ')}   —   ${totals}`, font: { name: FONT, size: 9, color: { argb: MUTED } } },
        { text: `      ${fecha}`, font: { name: FONT, size: 9, italic: true, color: { argb: ACCENT } } },
      ],
    };
    sub.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.getRow(2).height = 18;

    // Fila 3 — banda de encabezado (stone-800, texto blanco, borde inferior acento).
    const hr = ws.addRow(cols.map((c) => c.h));
    hr.eachCell((c, ci) => {
      c.font = { name: FONT, bold: true, size: 9, color: { argb: BAND_TXT } };
      c.alignment = { horizontal: alignOf(cols[ci - 1]), vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
      c.border = { bottom: { style: 'medium', color: { argb: ACCENT } } };
    });
    hr.height = 24;

    // Filas de datos — hairline stone-200 como separador (sin zebra), alineación por tipo,
    // colorea solo los problemas (agotado / hub corto), negrita en cajas e importe.
    rows.forEach((r, i) => {
      const added = ws.addRow(cols.map((c) => c.v(r, i)));
      added.height = 16;
      cols.forEach((c, ci) => {
        const cell = added.getCell(ci + 1);
        cell.font = { name: FONT, size: 10, color: { argb: INK } };
        cell.alignment = { horizontal: alignOf(c), vertical: 'middle' };
        cell.border = { bottom: { style: 'hair', color: { argb: HAIR } } };
        if (c.fmt) cell.numFmt = c.fmt;
        if (c.kind === 'importe' || c.kind === 'cajas') cell.font = { name: FONT, size: 10, bold: true, color: { argb: INK } };
        if (c.kind === 'oh' && Number(r.on_hand) <= 0) cell.font = { name: FONT, size: 10, bold: true, color: { argb: BAD } };
        if (c.kind === 'hub' && r.hub_short) cell.font = { name: FONT, size: 10, bold: true, color: { argb: BAD } };
      });
    });

    const n = rows.length;
    const first = 4;
    const last = 3 + n;
    if (n > 0) {
      ws.autoFilter = `A3:${lastColL}3`;

      // Fila de TOTAL — fill stone-100, línea superior stone-400; Importe en acento (la cifra que manda).
      const totalRow = ws.addRow(
        cols.map((c, ci) => {
          if (ci === 0) return 'TOTAL';
          if (!c.total) return '';
          const L = ws.getColumn(ci + 1).letter;
          return { formula: `SUBTOTAL(109,${L}${first}:${L}${last})` } as any;
        }),
      );
      totalRow.height = 20;
      totalRow.eachCell((cell, ci) => {
        const col = cols[ci - 1];
        const isImporte = col?.kind === 'importe';
        cell.font = { name: FONT, bold: true, size: isImporte ? 11 : 10, color: { argb: isImporte ? ACCENT : INK } };
        cell.alignment = { horizontal: ci === 1 ? 'left' : alignOf(col), vertical: 'middle', indent: ci === 1 ? 1 : 0 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_BG } };
        cell.border = { top: { style: 'medium', color: { argb: TOTAL_LINE } } };
        if (col?.fmt) cell.numFmt = col.fmt;
      });
    }

    cols.forEach((c, ci) => { if (c.width) ws.getColumn(ci + 1).width = c.width; });

    // Impresión / PDF — apaisado, ajustar a un ancho de página, repetir título+encabezado,
    // pie con paginado y marca. Que un pedido impreso salga presentable de una.
    ws.pageSetup = {
      orientation: 'landscape',
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
      printTitlesRow: '1:3',
    };
    ws.headerFooter = {
      oddFooter: `&L&9&"${FONT}"&K808080Mega Dulces&C&9&K808080Página &P de &N&R&9&K808080${head}`,
    };
  }

  fileNameWorkbook(_coverage: number): string {
    const d = new Date().toISOString().slice(0, 10);
    return `Pedido_por_proveedor_${d}.xlsx`;
  }

  /** Agrupa filas por proveedor (orden alfabético); vacío → una entrada "Sin proveedor". */
  private groupBySupplier(rows: WorkbookExportRow[]): Array<{ name: string; rows: WorkbookExportRow[] }> {
    const bySup = new Map<string, WorkbookExportRow[]>();
    for (const r of rows || []) {
      const nm = r.supplier_name == null ? '' : String(r.supplier_name).trim();
      const k = nm || 'Sin proveedor';
      (bySup.get(k) ?? bySup.set(k, []).get(k)!).push(r);
    }
    // Array.from (NO spread [...]): webpack downlevela [...map.keys()] en el bundle del API → .sort revienta. Ver feedback_webpack_set_spread_downlevel.
    const names = Array.from(bySup.keys()).sort((a, b) => a.localeCompare(b, 'es'));
    if (!names.length) return [{ name: 'Sin proveedor', rows: [] }];
    return names.map((n) => ({ name: n, rows: bySup.get(n)! }));
  }

  /** Nombre de hoja Excel válido (≤31, sin : \ / ? * [ ]) y único dentro de `used`. */
  private uniqueSheetName(raw: string, used: Set<string>): string {
    const base = (String(raw).replace(/[:\\/?*[\]]/g, ' ').trim() || 'Proveedor').slice(0, 28);
    let name = base, n = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 25)} ${n++}`;
    used.add(name.toLowerCase());
    return name;
  }

  /**
   * RA — Workbook UNIFICADO (el export canónico de /compras/pedido): un solo archivo con la hoja
   * "Todos" (plano, columna Proveedor) + UNA hoja por proveedor. Mismos datos/columnas/filtros que
   * la tabla en pantalla (desglosar/englobar). Reemplaza los dos exports separados.
   */
  async buildWorkbookUnified(data: WorkbookExport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    const terrs = data.territories || [];
    this.writeFlatSheet(wb, 'Todos', data.rows || [], terrs, data.coverage_days);
    const used = new Set<string>(['todos']);
    for (const g of this.groupBySupplier(data.rows || [])) {
      this.writeSupplierSheet(wb, this.uniqueSheetName(g.name, used), g.name, g.rows, terrs, data.coverage_days);
    }
    if (data.transfers && data.transfers.length) this.writeTransfersSheet(wb, data.transfers, data.coverage_days);
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }

  /** RA — una HOJA por proveedor (columnar). */
  async buildWorkbook(data: WorkbookExport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    const terrs = data.territories || [];
    const used = new Set<string>();
    for (const g of this.groupBySupplier(data.rows || [])) {
      this.writeSupplierSheet(wb, this.uniqueSheetName(g.name, used), g.name, g.rows, terrs, data.coverage_days);
    }
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }

  /** RA — UNA sola hoja plana (todos los proveedores, columna Proveedor). */
  async buildWorkbookFlat(data: WorkbookExport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    this.writeFlatSheet(wb, 'Pedido (plano)', data.rows || [], data.territories || [], data.coverage_days);
    if (data.transfers && data.transfers.length) this.writeTransfersSheet(wb, data.transfers, data.coverage_days);
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }

  /** Escribe UNA hoja por-proveedor (layout columnar Vta/Exist/Pedido por territorio) en `wb`. */
  private writeSupplierSheet(wb: ExcelJS.Workbook, name: string, supTitle: string, rows: WorkbookExportRow[], terrs: WorkbookExportTerritory[], coverage: number): void {
    rows = rows ?? [];
    terrs = terrs ?? [];
    const MONEY = '$#,##0.00', N1 = '#,##0.0', N0 = '#,##0';
    const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
    const leftH = ['Producto', 'SKU', 'UXC', 'Costo/Cja', 'XYZ', 'Reorden', 'Máx'];
    const rightH = ['Σ Pedido (cajas)', 'Σ Piezas', '$ Pedido', 'Valor venta', 'Valor exist.'];
    const nLeft = leftH.length, nRight = rightH.length;
    const totalCols = nLeft + terrs.length * 3 + nRight;
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: nLeft, ySplit: 4 }] });

    // Fila 1 — título
    ws.mergeCells(1, 1, 1, totalCols);
    const title = ws.getCell(1, 1);
    title.value = `PEDIDO — ${supTitle}  ·  cobertura ${coverage} días`;
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    // Fila 2 — resumen
    const totPed = rows.reduce((s, r) => s + (Number(r.pedido_valor) || 0), 0);
    const totCj = rows.reduce((s, r) => s + (Number(r.suma_pedido_cajas) || 0), 0);
    ws.mergeCells(2, 1, 2, totalCols);
    const sub = ws.getCell(2, 1);
    sub.value = `${rows.length} productos  ·  ${totCj.toLocaleString('es-MX', { maximumFractionDigits: 1 })} cajas  ·  $ Pedido ${totPed.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`;
    sub.font = { size: 9, color: { argb: 'FF52525B' } };
    sub.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 18;

    // Filas 3-4 — encabezado (grupo por punto de compra sobre Vta/Exist/Pedido)
    let c = 1;
    for (const h of leftH) { ws.mergeCells(3, c, 4, c); ws.getCell(3, c).value = h; c++; }
    for (const t of terrs) {
      ws.mergeCells(3, c, 3, c + 2); ws.getCell(3, c).value = t.name;
      ws.getCell(4, c).value = 'Vta'; ws.getCell(4, c + 1).value = 'Exist'; ws.getCell(4, c + 2).value = 'Pedido';
      c += 3;
    }
    for (const h of rightH) { ws.mergeCells(3, c, 4, c); ws.getCell(3, c).value = h; c++; }
    for (const rn of [3, 4]) {
      for (let i = 1; i <= totalCols; i++) {
        const cell = ws.getCell(rn, i);
        cell.font = { bold: true, size: 9, color: { argb: 'FF3F3F46' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = HEAD_FILL;
        cell.border = this.thin();
      }
    }
    ws.getRow(3).height = 20; ws.getRow(4).height = 16;

    // Datos (desde fila 5)
    const pedFirstCol = nLeft + terrs.length * 3 + 1; // Σ cajas
    rows.forEach((r) => {
      const uxc = Number(r.uxc) || 1;
      const vals: (string | number)[] = [r.nombre || '', r.sku || '', Number(r.uxc) || 0, Number(r.caja_cost) || 0,
        r.xyz_class || '', Number(r.reorder_cajas) || 0, Number(r.max_cajas) || 0];
      for (const t of terrs) {
        const cel = (r.cells && r.cells[t.code]) || {};
        // U.2 — si el peldaño de ese almacén no está verificado, la existencia en cajas no es
        // confiable: va la cantidad SUELTA con su rótulo, no una cifra de cajas inventada.
        const exisCel: string | number = cel.rung
          ? `${Math.round(Number(cel.nat) || 0).toLocaleString('es-MX')} ${this.natLabel(cel.natu)} (sin convertir)`
          : (Number(cel.exis) || 0);
        // U.2 — el PEDIDO de ese almacén sale de restar esa misma existencia: si el peldaño está
        // contradicho, la resta mezcla peldaños y pide de más. Un 0 en el XLSX se leería
        // "no pedir nada" (otra mentira), así que va el motivo en texto.
        const pedCel: string | number = cel.rung ? 'sin calcular' : (Number(cel.ped) || 0);
        vals.push(Number(cel.vta) || 0, exisCel, pedCel);
      }
      // ⚠️ U.2 — `valor_exis` puede venir NULL (ningún almacén verificado). Va CADENA VACÍA, no 0:
      // un cero en el XLSX se lee como "no hay inventario", que es la mentira opuesta a la que
      // estamos quitando. Ver UNIDADES_DE_MEDIDA 8quater y GOTCHAS "fuente vacía ≠ cero".
      vals.push(Number(r.suma_pedido_cajas) || 0, (Number(r.suma_pedido_cajas) || 0) * uxc,
        Number(r.pedido_valor) || 0, Number(r.valor_venta) || 0,
        r.valor_exis == null ? 'sin valuar' : Number(r.valor_exis));
      const added = ws.addRow(vals);
      added.eachCell((cell, col) => {
        cell.border = this.thin();
        cell.alignment = { horizontal: col === 1 || col === 2 ? 'left' : col === 5 ? 'center' : 'right' };
        if (col === 3) cell.numFmt = N0;
        else if (col === 4) cell.numFmt = MONEY;
        else if (col === 6 || col === 7) cell.numFmt = N1;   // Reorden / Máx (cajas)
        else if (col > nLeft && col <= nLeft + terrs.length * 3) cell.numFmt = N1;
        else if (col === pedFirstCol) cell.numFmt = N1;
        else if (col === pedFirstCol + 1) cell.numFmt = N0;
        else if (col >= pedFirstCol + 2) cell.numFmt = MONEY;
      });
    });

    // Anchos
    ws.getColumn(1).width = 38; ws.getColumn(2).width = 12; ws.getColumn(3).width = 7; ws.getColumn(4).width = 11;
    ws.getColumn(5).width = 6; ws.getColumn(6).width = 9; ws.getColumn(7).width = 9;
    for (let i = nLeft + 1; i <= nLeft + terrs.length * 3; i++) ws.getColumn(i).width = 8;
    for (let i = pedFirstCol; i <= totalCols; i++) ws.getColumn(i).width = 13;

    // Totales (SUBTOTAL respeta autofiltro)
    const firstData = 5, lastData = 4 + rows.length;
    if (rows.length) {
      ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: lastData, column: totalCols } };
      const totalRow = ws.addRow([]);
      const tr = totalRow.number;
      const tCell = ws.getCell(tr, 1); tCell.value = 'TOTAL'; tCell.font = { bold: true }; tCell.border = this.thin();
      for (let sc = pedFirstCol; sc <= totalCols; sc++) {
        const L = ws.getColumn(sc).letter;
        const cell = ws.getCell(tr, sc);
        cell.value = { formula: `SUBTOTAL(9,${L}${firstData}:${L}${lastData})` };
        cell.font = { bold: true };
        cell.numFmt = sc === pedFirstCol ? N1 : sc === pedFirstCol + 1 ? N0 : MONEY;
        cell.border = { top: { style: 'thin', color: { argb: 'FFB8B4AC' } } };
      }
    }
  }

  /**
   * RA — Hoja "Traspasos" del workbook global: un renglón por (producto × sucursal destino),
   * con el CEDIS origen, el déficit, cuánto se cubre por traspaso vs cuánto queda por comprar,
   * y el valor. Complementa la hoja "Todos" (que muestra el pedido bruto, sin separar canal).
   */
  private writeTransfersSheet(wb: ExcelJS.Workbook, rows: TransferExportRow[], coverage: number): void {
    rows = rows ?? [];
    const MONEY = '$#,##0.00', N1 = '#,##0.0', N0 = '#,##0';
    type Col = { h: string; v: (r: TransferExportRow, i: number) => string | number; fmt?: string; total?: boolean; left?: boolean; width: number };
    const cajas = (pz?: number | null, uxc?: number | null) => { const u = Number(uxc) || 1; return u > 0 ? Math.round((Number(pz) || 0) / u * 10) / 10 : 0; };
    const cols: Col[] = [
      { h: '#', v: (_r, i) => i + 1, width: 5 },
      { h: 'Producto', v: (r) => r.nombre ?? '', left: true, width: 40 },
      { h: 'SKU', v: (r) => r.sku ?? '', left: true, width: 12 },
      { h: 'UXC', v: (r) => Number(r.uxc) || 0, fmt: N0, width: 7 },
      { h: 'Origen (CEDIS)', v: (r) => r.from_code ?? '', width: 13 },
      { h: 'Destino (sucursal)', v: (r) => [r.to_code, r.to_name].filter(Boolean).join(' · '), left: true, width: 24 },
      { h: 'Déficit (cajas)', v: (r) => Number(r.deficit_cajas) || 0, fmt: N1, width: 12 },
      { h: 'Traspaso (cajas)', v: (r) => Number(r.transfer_cajas) || 0, fmt: N1, total: true, width: 13 },
      { h: 'Traspaso (piezas)', v: (r) => Number(r.transfer_pieces) || 0, fmt: N0, total: true, width: 13 },
      { h: 'Falta comprar (cajas)', v: (r) => cajas(r.shortfall_pieces, r.uxc), fmt: N1, width: 14 },
      { h: 'Costo/Cja', v: (r) => Number(r.unit_cost) || 0, fmt: MONEY, width: 11 },
      { h: 'Valor traspaso', v: (r) => Number(r.transfer_value) || 0, fmt: MONEY, total: true, width: 14 },
      { h: 'Proveedor', v: (r) => r.supplier_name ?? '', left: true, width: 26 },
    ];
    const lastCol = cols.length;
    const ws = wb.addWorksheet('Traspasos', { views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }] });

    // Fila 1 — título
    ws.mergeCells(1, 1, 1, lastCol);
    const title = ws.getCell(1, 1);
    title.value = `TRASPASOS SUGERIDOS  ·  CEDIS → sucursal  ·  cobertura ${coverage} días`;
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    // Fila 2 — resumen
    const totCj = rows.reduce((s, r) => s + (Number(r.transfer_cajas) || 0), 0);
    const totVal = rows.reduce((s, r) => s + (Number(r.transfer_value) || 0), 0);
    ws.mergeCells(2, 1, 2, lastCol);
    const sub = ws.getCell(2, 1);
    sub.value = `${rows.length} traspasos  ·  ${totCj.toLocaleString('es-MX', { maximumFractionDigits: 1 })} cajas  ·  Valor ${totVal.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`;
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

    // Datos (desde fila 4)
    rows.forEach((r, i) => {
      const added = ws.addRow(cols.map((c) => c.v(r, i)));
      cols.forEach((c, ci) => {
        const cell = added.getCell(ci + 1);
        cell.border = this.thin();
        cell.alignment = { horizontal: c.left ? 'left' : ci === 0 ? 'center' : 'right' };
        if (c.fmt) cell.numFmt = c.fmt;
      });
      added.getCell(8).font = { bold: true }; // Traspaso (cajas) = lo accionable
    });

    // Anchos + totales (SUBTOTAL respeta autofiltro)
    cols.forEach((c, ci) => { ws.getColumn(ci + 1).width = c.width; });
    const firstData = 4, lastData = 3 + rows.length;
    if (rows.length) {
      ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: lastData, column: lastCol } };
      const totalRow = ws.addRow([]);
      const tr = totalRow.number;
      const tCell = ws.getCell(tr, 1); tCell.value = 'TOTAL'; tCell.font = { bold: true }; tCell.border = this.thin();
      cols.forEach((c, ci) => {
        if (!c.total) return;
        const L = ws.getColumn(ci + 1).letter;
        const cell = ws.getCell(tr, ci + 1);
        cell.value = { formula: `SUBTOTAL(9,${L}${firstData}:${L}${lastData})` };
        cell.font = { bold: true };
        cell.numFmt = c.fmt ?? MONEY;   // toda columna 'total' trae fmt; fallback satisface el tipo
        cell.border = { top: { style: 'thin', color: { argb: 'FFB8B4AC' } } };
      });
    }
  }

  /**
   * Escribe la hoja PLANA (todos los proveedores, columna Proveedor) en `wb`. Layout columnar
   * (Vta/Exist/Pedido por territorio) + totales. Respeta desglosar/englobar (territories) y refleja
   * la tabla en pantalla. Formato editorial Mercado/Stone.
   */
  private writeFlatSheet(wb: ExcelJS.Workbook, sheetName: string, rowsIn: WorkbookExportRow[], terrs: WorkbookExportTerritory[], coverage: number): void {
    rowsIn = rowsIn ?? [];
    terrs = terrs ?? [];
    const MONEY = '$#,##0.00', N1 = '#,##0.0', N0 = '#,##0';
    const INK = 'FF1C1917', MUTED = 'FF78716C', BAND = 'FF292524', BAND_TXT = 'FFFFFFFF';
    const HAIR = 'FFE7E5E4', TOTAL_BG = 'FFF5F5F4', TOTAL_LINE = 'FFA8A29E', ACCENT = 'FFC2410C', FONT = 'Calibri';

    // Orden: por proveedor, luego venta desc (agrupa visualmente sin perder el ranking).
    const rows = [...(rowsIn || [])].sort((a, b) => {
      const s = String(a.supplier_name ?? '').localeCompare(String(b.supplier_name ?? ''), 'es');
      return s !== 0 ? s : (Number(b.valor_venta) || 0) - (Number(a.valor_venta) || 0);
    });

    const ws = wb.addWorksheet(sheetName);
    const nLeft = 8;                       // Proveedor · Producto · SKU · UXC · Costo/Cja · XYZ · Reorden · Máx
    const nRight = 5;                       // Σ cajas · Σ pz · $ Pedido · Valor venta · Valor exist.
    const totalCols = nLeft + terrs.length * 3 + nRight;
    ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 4 }];

    // Fila 1 — título
    ws.mergeCells(1, 1, 1, totalCols);
    const title = ws.getCell(1, 1);
    const fecha = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
    const grouped = terrs.length === 1 && terrs[0].code === 'GENERAL';
    title.value = `PEDIDO — ${grouped ? 'red (englobado)' : 'por sucursal'}  ·  cobertura ${coverage} días`;
    title.font = { name: FONT, bold: true, size: 16, color: { argb: INK } };
    title.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.getRow(1).height = 28;

    // Fila 2 — resumen
    ws.mergeCells(2, 1, 2, totalCols);
    const sub = ws.getCell(2, 1);
    const totPed = rows.reduce((s, r) => s + (Number(r.pedido_valor) || 0), 0);
    const totCj = rows.reduce((s, r) => s + (Number(r.suma_pedido_cajas) || 0), 0);
    const nSup = new Set(rows.map((r) => r.supplier_name ?? '—')).size;
    sub.value = {
      richText: [
        { text: `${rows.length} productos · ${nSup} proveedores · ${totCj.toLocaleString('es-MX', { maximumFractionDigits: 1 })} cajas · ${totPed.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} pedido`, font: { name: FONT, size: 9, color: { argb: MUTED } } },
        { text: `      ${fecha}`, font: { name: FONT, size: 9, italic: true, color: { argb: ACCENT } } },
      ],
    };
    sub.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.getRow(2).height = 18;

    // Filas 3-4 — encabezado (banda stone-800 + grupo por territorio)
    const leftH = ['Proveedor', 'Producto', 'SKU', 'UXC', 'Costo/Cja', 'XYZ', 'Reorden', 'Máx'];
    const rightH = ['Σ Pedido (cajas)', 'Σ Piezas', '$ Pedido', 'Valor venta', 'Valor exist.'];
    let c = 1;
    for (const h of leftH) { ws.mergeCells(3, c, 4, c); ws.getCell(3, c).value = h; c++; }
    for (const t of terrs) {
      ws.mergeCells(3, c, 3, c + 2); ws.getCell(3, c).value = t.name;
      ws.getCell(4, c).value = 'Vta'; ws.getCell(4, c + 1).value = 'Exist'; ws.getCell(4, c + 2).value = 'Pedido';
      c += 3;
    }
    for (const h of rightH) { ws.mergeCells(3, c, 4, c); ws.getCell(3, c).value = h; c++; }
    for (const rn of [3, 4]) {
      for (let i = 1; i <= totalCols; i++) {
        const cell = ws.getCell(rn, i);
        cell.font = { name: FONT, bold: true, size: 9, color: { argb: BAND_TXT } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
        cell.border = { bottom: { style: 'medium', color: { argb: ACCENT } } };
      }
    }
    ws.getRow(3).height = 22; ws.getRow(4).height = 16;

    // Datos (desde fila 5) — hairline por fila, alineación por tipo.
    const pedFirstCol = nLeft + terrs.length * 3 + 1;
    rows.forEach((r) => {
      const uxc = Number(r.uxc) || 1;
      const vals: (string | number)[] = [r.supplier_name || '—', r.nombre || '', r.sku || '', Number(r.uxc) || 0, Number(r.caja_cost) || 0,
        r.xyz_class || '', Number(r.reorder_cajas) || 0, Number(r.max_cajas) || 0];
      for (const t of terrs) {
        const cel = (r.cells && r.cells[t.code]) || {};
        // U.2 — si el peldaño de ese almacén no está verificado, la existencia en cajas no es
        // confiable: va la cantidad SUELTA con su rótulo, no una cifra de cajas inventada.
        const exisCel: string | number = cel.rung
          ? `${Math.round(Number(cel.nat) || 0).toLocaleString('es-MX')} ${this.natLabel(cel.natu)} (sin convertir)`
          : (Number(cel.exis) || 0);
        // U.2 — el PEDIDO de ese almacén sale de restar esa misma existencia: si el peldaño está
        // contradicho, la resta mezcla peldaños y pide de más. Un 0 en el XLSX se leería
        // "no pedir nada" (otra mentira), así que va el motivo en texto.
        const pedCel: string | number = cel.rung ? 'sin calcular' : (Number(cel.ped) || 0);
        vals.push(Number(cel.vta) || 0, exisCel, pedCel);
      }
      // ⚠️ U.2 — `valor_exis` puede venir NULL (ningún almacén verificado). Va CADENA VACÍA, no 0:
      // un cero en el XLSX se lee como "no hay inventario", que es la mentira opuesta a la que
      // estamos quitando. Ver UNIDADES_DE_MEDIDA 8quater y GOTCHAS "fuente vacía ≠ cero".
      vals.push(Number(r.suma_pedido_cajas) || 0, (Number(r.suma_pedido_cajas) || 0) * uxc,
        Number(r.pedido_valor) || 0, Number(r.valor_venta) || 0,
        r.valor_exis == null ? 'sin valuar' : Number(r.valor_exis));
      const added = ws.addRow(vals);
      added.height = 16;
      added.eachCell((cell, col) => {
        cell.font = { name: FONT, size: 10, color: { argb: INK } };
        cell.border = { bottom: { style: 'hair', color: { argb: HAIR } } };
        cell.alignment = { horizontal: col <= 3 ? 'left' : col === 6 ? 'center' : 'right', vertical: 'middle' };
        if (col === 4) cell.numFmt = N0;
        else if (col === 5) cell.numFmt = MONEY;
        else if (col === 7 || col === 8) cell.numFmt = N1;   // Reorden / Máx (cajas)
        else if (col > nLeft && col <= nLeft + terrs.length * 3) cell.numFmt = N1;
        else if (col === pedFirstCol) { cell.numFmt = N1; cell.font = { name: FONT, size: 10, bold: true, color: { argb: INK } }; }
        else if (col === pedFirstCol + 1) cell.numFmt = N0;
        else if (col >= pedFirstCol + 2) cell.numFmt = MONEY;
      });
    });

    // Anchos
    ws.getColumn(1).width = 24; ws.getColumn(2).width = 38; ws.getColumn(3).width = 12;
    ws.getColumn(4).width = 7; ws.getColumn(5).width = 11;
    ws.getColumn(6).width = 6; ws.getColumn(7).width = 9; ws.getColumn(8).width = 9;
    for (let i = nLeft + 1; i <= nLeft + terrs.length * 3; i++) ws.getColumn(i).width = 8;
    for (let i = pedFirstCol; i <= totalCols; i++) ws.getColumn(i).width = 13;

    // Totales (SUBTOTAL respeta autofiltro) + acento en $ Pedido.
    const firstData = 5, lastData = 4 + rows.length;
    if (rows.length) {
      ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: lastData, column: totalCols } };
      const totalRow = ws.addRow([]);
      const tr = totalRow.number;
      totalRow.height = 20;
      const tCell = ws.getCell(tr, 1);
      tCell.value = 'TOTAL'; tCell.font = { name: FONT, bold: true, color: { argb: INK } };
      for (let i = 1; i <= totalCols; i++) {
        const cell = ws.getCell(tr, i);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_BG } };
        cell.border = { top: { style: 'medium', color: { argb: TOTAL_LINE } } };
      }
      for (let sc = pedFirstCol; sc <= totalCols; sc++) {
        const L = ws.getColumn(sc).letter;
        const cell = ws.getCell(tr, sc);
        cell.value = { formula: `SUBTOTAL(9,${L}${firstData}:${L}${lastData})` };
        const isPed = sc === pedFirstCol + 2;
        cell.font = { name: FONT, bold: true, size: isPed ? 11 : 10, color: { argb: isPed ? ACCENT : INK } };
        cell.numFmt = sc === pedFirstCol ? N1 : sc === pedFirstCol + 1 ? N0 : MONEY;
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      }
    }

    // Impresión / PDF
    ws.pageSetup = {
      orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true, printTitlesRow: '1:4',
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    };
    ws.headerFooter = { oddFooter: `&L&9&K808080Mega Dulces&C&9&K808080Página &P de &N&R&9&K808080${sheetName}` };
  }
}
