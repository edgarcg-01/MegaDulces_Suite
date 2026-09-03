import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';

export interface ExcelArticuloMes {
  sucursal: string;         // nombre de sucursal (ej. "Morelia Abastos")
  clave:    string;
  desc:     string;
  unidad:   string;
  meses:    Record<string, number>; // 'YYYY-MM' → importe
  total:    number;
  fuente:   'excel';
}

// Meses en español → número (1-based) — se mantiene para archivos .xlsx legacy
const MES_NUM: Record<string, number> = {
  enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
  julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
};

// ─── Caché en memoria ───────────────────────────────────────────────────────
interface CacheEntry {
  data: ExcelArticuloMes[];
  loadedAt: number;       // timestamp ms
  fileMtime: number;      // mtime del JSON en disco
}

let _cache: CacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // re-leer si el archivo cambió + máx 5 min

// ─── Interface del JSON pre-agregado ────────────────────────────────────────
interface CacheJson {
  generado:  string;
  total:     number;
  articulos: Array<{
    sucursal: string;
    clave:    string;
    desc:     string;
    unidad:   string;
    meses:    Record<string, number>;
    total:    number;
    fuente:   string;
  }>;
}

@Injectable()
export class KpExcelService {
  private readonly logger = new Logger(KpExcelService.name);

  /** Directorio con los archivos de datos (CSV / Excel / JSON cache). */
  private get folder(): string {
    return (
      process.env.KP_EXCEL_FOLDER ||
      'C:\\Users\\Administrador\\DataCenter\\DataBases Sucursales\\MES GLOBAL'
    );
  }

  private get cacheJsonPath(): string {
    return path.join(this.folder, 'kp_concentrada_cache.json');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // API pública
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Punto de entrada principal.
   * 1. Intenta leer kp_concentrada_cache.json (generado por el script Python).
   * 2. Si no existe, cae al lector de archivos .xlsx/.xls (legacy).
   */
  async readAll(): Promise<ExcelArticuloMes[]> {
    // ── Prioridad 1: JSON pre-agregado ───────────────────────────────────
    if (fs.existsSync(this.cacheJsonPath)) {
      return this.readFromJson();
    }

    // ── Prioridad 2: archivos .xlsx / .xls (legacy) ──────────────────────
    this.logger.warn(
      `KP: no se encontró kp_concentrada_cache.json en ${this.folder}. ` +
      `Buscando archivos Excel…`,
    );
    return this.readFromXlsx();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lectura desde JSON pre-agregado
  // ─────────────────────────────────────────────────────────────────────────

  private readFromJson(): ExcelArticuloMes[] {
    try {
      const stat = fs.statSync(this.cacheJsonPath);
      const now  = Date.now();

      // Usar caché en memoria si está vigente y el archivo no cambió
      if (
        _cache &&
        _cache.fileMtime === stat.mtimeMs &&
        now - _cache.loadedAt < CACHE_TTL_MS
      ) {
        this.logger.debug(`KP JSON: usando caché en memoria (${_cache.data.length} registros)`);
        return _cache.data;
      }

      this.logger.log(`KP JSON: leyendo ${this.cacheJsonPath}…`);
      const raw: CacheJson = JSON.parse(
        fs.readFileSync(this.cacheJsonPath, 'utf8'),
      );

      const items: ExcelArticuloMes[] = raw.articulos.map(a => ({
        sucursal: a.sucursal,
        clave:    a.clave,
        desc:     a.desc,
        unidad:   a.unidad ?? '',
        meses:    a.meses,
        total:    a.total,
        fuente:   'excel' as const,
      }));

      _cache = { data: items, loadedAt: now, fileMtime: stat.mtimeMs };
      this.logger.log(`KP JSON: ${items.length} registros cargados (${raw.generado})`);

      // Log resumen por sucursal
      const porSuc = new Map<string, number>();
      for (const it of items) {
        porSuc.set(it.sucursal, (porSuc.get(it.sucursal) ?? 0) + 1);
      }
      for (const [suc, n] of [...porSuc.entries()].sort((a, b) => b[1] - a[1])) {
        this.logger.log(`  ${suc}: ${n} artículos`);
      }

      return items;
    } catch (e: any) {
      this.logger.error(`KP JSON: error leyendo cache — ${e.message}`);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lectura legacy desde archivos .xlsx / .xls
  // ─────────────────────────────────────────────────────────────────────────

  private async readFromXlsx(): Promise<ExcelArticuloMes[]> {
    const dir = this.folder;

    if (!fs.existsSync(dir)) {
      this.logger.warn(`KP Excel: directorio no encontrado → ${dir}`);
      return [];
    }

    const files = fs
      .readdirSync(dir)
      .filter(f => /\.(xlsx|xls)$/i.test(f));

    if (files.length === 0) {
      this.logger.warn(`KP Excel: sin archivos .xlsx/.xls en ${dir}`);
      return [];
    }

    const results: ExcelArticuloMes[] = [];

    for (const file of files) {
      try {
        const parsed = await this.parseXlsxFile(path.join(dir, file), file);
        results.push(...parsed);
        this.logger.log(`KP Excel: ${file} → ${parsed.length} artículos`);
      } catch (e: any) {
        this.logger.error(`KP Excel: error en ${file} — ${e.message}`);
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Parser .xlsx (lógica original conservada, motor exceljs)
  // ─────────────────────────────────────────────────────────────────────────

  private async parseXlsxFile(filePath: string, fileName: string): Promise<ExcelArticuloMes[]> {
    const sucursal = this.inferSucursal(fileName);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];

    const matrix: any[][] = this.worksheetToMatrix(ws);

    if (matrix.length === 0) return [];

    const { headerRowIdx, mesColumns } = this.findHeaderRow(matrix);
    if (headerRowIdx < 0 || mesColumns.length === 0) {
      this.logger.warn(`KP Excel: no se encontró cabecera de meses en ${fileName}`);
      return [];
    }

    const year = this.inferYear(matrix, headerRowIdx);
    return this.extractArticulos(matrix, headerRowIdx, mesColumns, sucursal, year);
  }

  /** Misma forma que XLSX.utils.sheet_to_json(ws, {header:1, defval:null, blankrows:true}): filas 0-index, mismo ancho (max columnas de la hoja), huecos en null. */
  private worksheetToMatrix(ws: ExcelJS.Worksheet | undefined): any[][] {
    if (!ws) return [];
    const numCols = ws.columnCount || 0;
    const matrix: any[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const arr: any[] = new Array(numCols).fill(null);
      for (let c = 1; c <= numCols; c++) {
        arr[c - 1] = this.cellValue(row.getCell(c).value);
      }
      matrix.push(arr);
    });
    return matrix;
  }

  private cellValue(v: ExcelJS.CellValue): any {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') {
      if (v instanceof Date) return v;
      if ('result' in v) return this.cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
      if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map(rt => rt.text).join('');
      if ('text' in v) return (v as ExcelJS.CellHyperlinkValue).text;
    }
    return v;
  }

  private findHeaderRow(matrix: any[][]): {
    headerRowIdx: number;
    mesColumns: Array<{ col: number; mesKey: string }>;
  } {
    for (let r = 0; r < Math.min(matrix.length, 20); r++) {
      const row = matrix[r];
      if (!row) continue;
      const found: Array<{ col: number; mesKey: string }> = [];
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] ?? '').trim().toLowerCase();
        if (MES_NUM[cell]) found.push({ col: c, mesKey: cell });
      }
      if (found.length >= 3) return { headerRowIdx: r, mesColumns: found };
    }
    return { headerRowIdx: -1, mesColumns: [] };
  }

  private inferYear(matrix: any[][], headerRowIdx: number): number {
    const currentYear = new Date().getFullYear();
    for (let r = 0; r <= headerRowIdx; r++) {
      const row = matrix[r];
      if (!row) continue;
      for (const cell of row) {
        const m = String(cell ?? '').match(/\b(20\d{2})\b/);
        if (m) return Number(m[1]);
      }
    }
    return currentYear;
  }

  private extractArticulos(
    matrix:      any[][],
    headerRowIdx: number,
    mesColumns:  Array<{ col: number; mesKey: string }>,
    sucursal:    string,
    year:        number,
  ): ExcelArticuloMes[] {
    const results: ExcelArticuloMes[] = [];
    let i = headerRowIdx + 1;
    while (i < matrix.length) {
      const row = matrix[i];
      if (!row) { i++; continue; }
      const clave = String(row[0] ?? '').trim();
      if (!clave || /^\d{4}[-/]?\d{2}/.test(clave)) { i++; continue; }
      const desc   = this.firstNonEmpty(row, [8, 7, 6, 9, 10]) ?? '';
      const unidad = this.firstNonEmpty(row, [22, 23, 21, 20]) ?? '';
      const nextRow = matrix[i + 1] ?? [];
      const meses: Record<string, number> = {};
      let total = 0;
      for (const { col, mesKey } of mesColumns) {
        const val = this.toNum(nextRow[col]) ?? this.toNum(row[col]) ?? 0;
        const mesNum = MES_NUM[mesKey];
        const key = `${year}-${String(mesNum).padStart(2, '0')}`;
        if (val !== 0) { meses[key] = val; total += val; }
      }
      const lastMesCol = mesColumns[mesColumns.length - 1]?.col ?? 0;
      const posibleTotal = this.toNum(nextRow[lastMesCol + 3]) ?? this.toNum(nextRow[lastMesCol + 5]);
      if (posibleTotal && posibleTotal > total * 0.8) total = posibleTotal;
      if (total !== 0) results.push({ sucursal, clave, desc, unidad, meses, total, fuente: 'excel' });
      i += 2;
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private inferSucursal(fileName: string): string {
    const base  = path.basename(fileName, path.extname(fileName));
    const lower = base.toLowerCase();
    if (/global|todos|all/i.test(lower)) return 'GLOBAL';
    const m = base.match(/^(\d{2})|_(\d{2})_|[-_](\d{2})$/);
    if (m) return (m[1] || m[2] || m[3]).padStart(2, '0');
    return base.toUpperCase().substring(0, 6);
  }

  private firstNonEmpty(row: any[], cols: number[]): string | null {
    for (const c of cols) {
      const v = String(row[c] ?? '').trim();
      if (v) return v;
    }
    return null;
  }

  private toNum(val: any): number | null {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(String(val).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }
}
