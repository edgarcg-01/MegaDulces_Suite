import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

export interface BiExportColumn {
  key: string;
  label: string;
  /** Si falta, se trata como texto. Sólo importa para XLSX (celda numérica real, no texto) y
   * SQLite (columna REAL en vez de TEXT — para que sí sea una base de datos "de verdad", no un
   * CSV disfrazado con extensión .sqlite). */
  numeric?: true;
}

/**
 * WMS-BI.5 (2026-09-15) — Constructor de archivos de exportación para Análisis BI de Almacén:
 * CSV, Excel (ExcelJS, ya dependencia del repo) y **SQLite** (nuevo — el equivalente moderno al
 * `.mdb` del sistema anterior, a pedido explícito del usuario: "una forma de exportar como base
 * de datos para no depender de la capacidad de los csv").
 *
 * ⚠️ **Por qué SQLite vía `sql.js` y no `better-sqlite3`**: se probó primero `better-sqlite3`
 * (más rápido, API más simple) y se descartó con evidencia, no por gusto — `better-sqlite3@13`
 * exige Node ≥22 (este repo está fijado a Node 20 en `package.json`/`Dockerfile`); bajando a la
 * v12 (sí soporta Node 20.x), `npm install` en esta misma máquina intentó compilar con
 * `node-gyp` y falló por falta de Visual Studio Build Tools — cualquier dev sin esas
 * herramientas instaladas no podría ni `npm ci`. `sql.js` es SQLite compilado a WebAssembly:
 * cero compilación nativa, mismo comportamiento en Windows/Mac/Linux y en la imagen Docker
 * (`node:20-bookworm-slim`) sin tocar nada. Verificado con un smoke test real (crear → insertar
 * → serializar a Buffer → releer) antes de escribir este archivo.
 */
@Injectable()
export class CommercialBiAlmacenExportService {
  private static sqlJsPromise: ReturnType<typeof initSqlJs> | null = null;
  private static loadSqlJs(): ReturnType<typeof initSqlJs> {
    if (!this.sqlJsPromise) this.sqlJsPromise = initSqlJs();
    return this.sqlJsPromise;
  }

  private cellValue(v: unknown, numeric: boolean | undefined): unknown {
    if (v === null || v === undefined) return null;
    if (numeric) { const n = Number(v); return Number.isFinite(n) ? n : null; }
    if (v instanceof Date) return v.toISOString();
    return typeof v === 'boolean' ? (v ? 'Sí' : 'No') : v;
  }

  /** BOM UTF-8 para que Excel abra acentos/ñ sin ensuciarlos al abrir el .csv directo. */
  buildCsv(columns: BiExportColumn[], rows: Array<Record<string, unknown>>): Buffer {
    const esc = (v: unknown): string => {
      const val = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
    };
    const lines = [columns.map((c) => esc(c.label)).join(',')];
    for (const r of rows) lines.push(columns.map((c) => esc(this.cellValue(r[c.key], c.numeric))).join(','));
    return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
  }

  async buildXlsx(columns: BiExportColumn[], rows: Array<Record<string, unknown>>, sheetName = 'Datos'): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(10, Math.min(38, c.label.length + 4)) }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      const out: Record<string, unknown> = {};
      for (const c of columns) out[c.key] = this.cellValue(r[c.key], c.numeric);
      ws.addRow(out);
    }
    if (columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /**
   * Escribe un `.sqlite` real: tabla `datos` (tipos preservados, no todo texto) + tabla
   * `_export_meta` con la cobertura (declarada, no oculta si el tope de filas se alcanzó) —
   * quien abra el archivo en DB Browser for SQLite (u otra herramienta libre) puede consultar
   * ambas con SQL normal, sin depender de este servicio ni de la app.
   */
  async buildSqlite(
    tableName: string,
    columns: BiExportColumn[],
    rows: Array<Record<string, unknown>>,
    meta: { total_disponible: number; exportado: number; truncado: boolean },
  ): Promise<Buffer> {
    const SQL = await CommercialBiAlmacenExportService.loadSqlJs();
    const db: SqlJsDatabase = new SQL.Database();
    const safeCol = (k: string) => `"${k.replace(/"/g, '')}"`;
    const colDefs = columns.map((c) => `${safeCol(c.key)} ${c.numeric ? 'REAL' : 'TEXT'}`).join(', ');
    db.run(`CREATE TABLE ${safeCol(tableName)} (${colDefs})`);
    const placeholders = columns.map(() => '?').join(',');
    const stmt = db.prepare(`INSERT INTO ${safeCol(tableName)} VALUES (${placeholders})`);
    db.run('BEGIN');
    for (const r of rows) {
      stmt.run(columns.map((c) => {
        const v = this.cellValue(r[c.key], c.numeric);
        return v === null || v === undefined ? null : c.numeric ? Number(v) : String(v);
      }));
    }
    db.run('COMMIT');
    stmt.free();
    db.run('CREATE TABLE "_export_meta" (generado_en TEXT, total_disponible INTEGER, exportado INTEGER, truncado INTEGER)');
    db.run('INSERT INTO "_export_meta" VALUES (?,?,?,?)', [
      new Date().toISOString(), meta.total_disponible, meta.exportado, meta.truncado ? 1 : 0,
    ]);
    const buf = Buffer.from(db.export());
    db.close();
    return buf;
  }

  fileName(prefix: string, from: string, to: string, ext: string): string {
    return `${prefix} ${from} a ${to}.${ext}`;
  }
}
