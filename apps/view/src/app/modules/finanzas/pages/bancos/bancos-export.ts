/**
 * CB — Export a Excel del tablero de bancos.
 *
 * Genera un .xlsx REAL (no un CSV renombrado): los importes van como NÚMERO con
 * formato de moneda, así que en Excel se suman y se filtran sin pelearse con el
 * separador decimal de es-MX. Las fechas van como fecha, no como texto.
 *
 * `exceljs` se carga BAJO DEMANDA (`await import`) — no entra al bundle inicial;
 * sólo se descarga cuando alguien realmente exporta.
 *
 * Contrato: se exporta **lo que se está viendo** — con los filtros y el orden que
 * el usuario dejó puestos. Quien llama pasa las filas ya filtradas/ordenadas.
 */

export type XlsxColType = 'text' | 'money' | 'int' | 'decimal' | 'date';

export interface XlsxCol<T> {
  header: string;
  /** Valor crudo de la celda. Devolver el NÚMERO, no el string formateado. */
  get: (row: T) => unknown;
  type?: XlsxColType;
  width?: number;
  /** Suma esta columna en la fila de totales al pie. */
  total?: boolean;
}

/** ¿La columna es numérica? Decide alineación y ancho por default. */
function numeric<T>(col: XlsxCol<T>): boolean {
  const t = col.type ?? 'text';
  return t === 'money' || t === 'int' || t === 'decimal';
}

/** 1 → 'A', 27 → 'AA'. Para armar la fórmula de totales. */
function colLetter(n: number): string {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Paleta del sistema (DESIGN.md / libs/design-tokens). Excel pide ARGB, así que
 * los tokens se transcriben acá una sola vez — es el único lugar del proyecto
 * donde un hex es legítimo: un .xlsx no entiende CSS custom properties.
 */
const C = {
  ink: 'FF100D09',      // stone-950 — texto principal
  muted: 'FF5E564B',    // stone-600 — texto secundario
  hairline: 'FFE8E2D7',  // stone-200 — separador de fila
  headBg: 'FF2B2620',   // stone-800 — encabezado sólido
  headInk: 'FFFBF9F6',  // stone-50  — texto sobre el encabezado
  totalBg: 'FFF5F1EA',  // stone-100 — fila de totales
  action: 'FFF05A28',   // sunset    — regla de marca bajo el título
} as const;

/**
 * Formato por tipo. `text` no lleva: Excel lo deja como cadena.
 * El dinero pinta los NEGATIVOS EN ROJO: en una conciliación el signo es la
 * mitad de la lectura y en una columna de deltas se pierde de vista.
 */
const FMT: Record<Exclude<XlsxColType, 'text'>, string> = {
  money: '$#,##0.00;[Red]-$#,##0.00',
  int: '#,##0;[Red]-#,##0',
  decimal: '#,##0.00;[Red]-#,##0.00',
  date: 'dd/mm/yyyy',
};

/** 'YYYY-MM-DD…' → Date local (sin voltear a UTC, que corre la fecha un día). */
function toDate(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

export interface XlsxSheet<T> {
  /** Nombre de la pestaña (Excel corta a 31 caracteres y prohíbe : \ / ? * [ ]). */
  name: string;
  cols: XlsxCol<T>[];
  rows: T[];
  /** Título de la hoja. Por default = `name`; `null` lo omite. */
  title?: string | null;
  /** Línea de contexto bajo el título: periodo, filtros aplicados, etc. */
  subtitle?: string;
}

/**
 * Escribe una o varias hojas y dispara la descarga.
 * Varias hojas = un solo archivo con el contexto completo de la vista.
 */
export async function exportXlsx(fileName: string, sheets: XlsxSheet<any>[]): Promise<void> {
  // exceljs es CommonJS: con `import()` dinámico el módulo llega envuelto y sus
  // exports quedan bajo `.default` según el interop del bundler. Sin este desempaque
  // `ExcelJS.Workbook` es undefined en runtime (el build compila igual — sólo truena
  // al hacer clic en Exportar).
  const mod = (await import('exceljs')) as unknown as Record<string, any>;
  const ExcelJS = mod['default'] ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mega Dulces';

  for (const sh of sheets) {
    // Excel: máx 31 chars y sin caracteres reservados en el nombre de hoja.
    const ws = wb.addWorksheet(sh.name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31));
    const last = Math.max(1, sh.cols.length);
    let head = 1;

    // ── Título: nombre de la hoja + regla sunset debajo. Es toda la marca que
    //    lleva el archivo: una hoja de conciliación se abre para trabajarla, y el
    //    estilo pesado estorba al copiar el rango a otro lado.
    if (sh.title !== null) {
      ws.mergeCells(head, 1, head, last);
      const t = ws.getCell(head, 1);
      t.value = sh.title ?? sh.name;
      t.font = { bold: true, size: 14, color: { argb: C.ink } };
      t.alignment = { vertical: 'middle' };
      t.border = { bottom: { style: 'medium', color: { argb: C.action } } };
      ws.getRow(head).height = 26;
      head++;
    }

    if (sh.subtitle) {
      ws.mergeCells(head, 1, head, last);
      const c = ws.getCell(head, 1);
      c.value = sh.subtitle;
      c.font = { italic: true, size: 9, color: { argb: C.muted } };
      ws.getRow(head).height = 16;
      head++;
    }

    // ── Encabezado sólido (stone-800 / texto claro): ancla la tabla y sobrevive
    //    al panel congelado sin depender de que el usuario vea el borde.
    const hr = ws.getRow(head);
    sh.cols.forEach((col, i) => {
      const c = hr.getCell(i + 1);
      c.value = col.header;
      c.font = { bold: true, size: 10, color: { argb: C.headInk } };
      c.alignment = { vertical: 'middle', wrapText: true, horizontal: numeric(col) ? 'right' : 'left' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headBg } };
    });
    hr.height = 24;

    sh.rows.forEach((row, ri) => {
      const r = ws.getRow(head + 1 + ri);
      sh.cols.forEach((col, ci) => {
        const cell = r.getCell(ci + 1);
        const raw = col.get(row);
        const t = col.type ?? 'text';
        if (t === 'date') {
          const d = toDate(raw);
          // Fecha ilegible → se escribe tal cual en vez de perderla.
          if (d) { cell.value = d; cell.numFmt = FMT.date; } else { cell.value = raw == null ? '' : String(raw); }
        } else if (t === 'text') {
          cell.value = raw == null ? '' : String(raw);
        } else {
          const n = toNumber(raw);
          cell.value = n;                 // número de verdad: Excel lo suma
          if (n !== null) cell.numFmt = FMT[t];
        }
        // Hairline por fila, como las tablas de la app. Sin zebra: la directiva
        // quiet-luxury la prohíbe y en Excel además estorba al filtrar.
        cell.border = { bottom: { style: 'thin', color: { argb: C.hairline } } };
        cell.font = { size: 10, color: { argb: C.ink } };
      });
    });

    // ── Fila de totales para las columnas marcadas. Fórmula SUM real (no un
    //    número calculado acá): si el usuario filtra o borra filas, cuadra solo.
    const totalCols = sh.cols.filter((c) => c.total);
    if (totalCols.length && sh.rows.length) {
      const tr = ws.getRow(head + 1 + sh.rows.length);
      tr.getCell(1).value = 'TOTAL';
      sh.cols.forEach((col, i) => {
        const cell = tr.getCell(i + 1);
        if (col.total) {
          const L = colLetter(i + 1);
          cell.value = { formula: `SUBTOTAL(109,${L}${head + 1}:${L}${head + sh.rows.length})` };
          cell.numFmt = FMT[(col.type ?? 'decimal') as Exclude<XlsxColType, 'text' | 'date'>];
        }
        cell.font = { bold: true, size: 10, color: { argb: C.ink } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.totalBg } };
        cell.border = { top: { style: 'medium', color: { argb: C.ink } } };
      });
      tr.height = 20;
    }

    // Autofiltro + panel congelado: la hoja llega lista para trabajarse.
    ws.autoFilter = { from: { row: head, column: 1 }, to: { row: head + sh.rows.length, column: last } };
    ws.views = [{ state: 'frozen', ySplit: head }];
    sh.cols.forEach((col, i) => (ws.getColumn(i + 1).width = col.width ?? (numeric(col) ? 15 : 28)));
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
