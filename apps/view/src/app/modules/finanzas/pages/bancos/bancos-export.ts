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
}

/** Formato por tipo. `text` no lleva: Excel lo deja como cadena. */
const FMT: Record<Exclude<XlsxColType, 'text'>, string> = {
  money: '$#,##0.00',   // sin redondear: los centavos son justo lo que se anda buscando
  int: '#,##0',
  decimal: '#,##0.00',
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
  /** Línea de contexto sobre el encabezado: periodo, filtros aplicados, etc. */
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
    let head = 1;

    if (sh.subtitle) {
      ws.mergeCells(1, 1, 1, Math.max(1, sh.cols.length));
      const c = ws.getCell(1, 1);
      c.value = sh.subtitle;
      c.font = { italic: true, size: 9, color: { argb: 'FF5E564B' } };
      head = 2;
    }

    const hr = ws.getRow(head);
    sh.cols.forEach((col, i) => (hr.getCell(i + 1).value = col.header));
    hr.eachCell((c) => {
      c.font = { bold: true, size: 10 };
      c.alignment = { vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFD8D5CE' } } };
    });
    hr.height = 22;

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
      });
    });

    // Autofiltro + panel congelado: la hoja llega lista para trabajarse.
    ws.autoFilter = {
      from: { row: head, column: 1 },
      to: { row: head + sh.rows.length, column: Math.max(1, sh.cols.length) },
    };
    ws.views = [{ state: 'frozen', ySplit: head }];
    sh.cols.forEach((col, i) => (ws.getColumn(i + 1).width = col.width ?? (col.type === 'text' ? 28 : 15)));
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
