import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantKnexService } from '@megadulces/platform-core';
import { listaConfig, RFC_REGEX, SatListConfig } from './sat-lists.config';

export interface SatListIngestResult {
  lista: string;
  listHash: string;
  total: number;
  altas: number;
  cambios: number;
  source: string;
  skipped?: boolean;
}

/**
 * FISCAL — Ingesta de una lista SAT (69-B, 69, …) a fiscal.sat_list_rfcs.
 *
 * Dato público e igual para todos los tenants → tablas globales, sin RLS.
 * Sin BullMQ: descarga vía fetch + parse en memoria (~miles de filas) + merge
 * SQL con detección de delta. Idempotente por hash del contenido.
 */
@Injectable()
export class SatListIngestService {
  private readonly logger = new Logger(SatListIngestService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** Descarga todas las URLs configuradas de una lista y las ingesta como un solo lote. */
  async refreshFromSat(lista: string): Promise<SatListIngestResult> {
    const cfg = listaConfig(lista);
    if (!cfg.urls.length) {
      throw new Error(`Lista ${lista} sin URLs configuradas (ver env). Usá ingestCsv() con archivo.`);
    }
    const parts: string[] = [];
    for (const url of cfg.urls) {
      this.logger.log(`Descargando lista ${lista} de ${url}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`SAT devolvió ${res.status} al descargar ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      parts.push(new TextDecoder('latin1').decode(buf)); // el SAT sirve Latin1
    }
    return this.ingestCsv(lista, parts.join('\n'), cfg.urls.join(' + '));
  }

  /** Ingesta un CSV ya obtenido (refreshFromSat o importer CLI on-prem). */
  async ingestCsv(lista: string, csvText: string, source = 'file'): Promise<SatListIngestResult> {
    const cfg = listaConfig(lista);
    const listHash = createHash('sha256').update(`${lista}:${csvText}`).digest('hex').slice(0, 32);
    const knex = this.tk.global;

    const already = await knex('fiscal.sat_list_versions').where({ list_hash: listHash }).first();
    if (already) {
      this.logger.log(`Lista ${lista}/${listHash} ya procesada (${already.total_rfcs} RFCs) — skip.`);
      return { lista, listHash, total: already.total_rfcs, altas: 0, cambios: 0, source, skipped: true };
    }

    const rows = this.parseCsv(cfg, csvText).map((r) => ({ ...r, lista }));
    if (!rows.length) throw new Error(`CSV de lista ${lista} sin filas parseables (¿formato cambió?)`);

    await knex('fiscal.sat_list_staging').where({ lista }).del();
    for (let i = 0; i < rows.length; i += 1000) {
      await knex('fiscal.sat_list_staging').insert(rows.slice(i, i + 1000));
    }

    const merged = await knex.raw(
      `INSERT INTO fiscal.sat_list_rfcs (lista, rfc, nombre, situacion, fecha_publicacion, oficio, list_hash, updated_at)
       SELECT DISTINCT ON (lista, rfc) lista, rfc, nombre, situacion, fecha_publicacion, oficio, ?, now()
         FROM fiscal.sat_list_staging
        WHERE lista = ? AND rfc IS NOT NULL AND rfc <> '' AND situacion IS NOT NULL
        ORDER BY lista, rfc
       ON CONFLICT (lista, rfc) DO UPDATE
         SET nombre = EXCLUDED.nombre,
             situacion = EXCLUDED.situacion,
             fecha_publicacion = EXCLUDED.fecha_publicacion,
             oficio = EXCLUDED.oficio,
             list_hash = EXCLUDED.list_hash,
             updated_at = now()
         WHERE fiscal.sat_list_rfcs.situacion IS DISTINCT FROM EXCLUDED.situacion
       RETURNING (xmax = 0) AS es_alta`,
      [listHash, lista],
    );
    const deltaRows: Array<{ es_alta: boolean }> = merged.rows ?? [];
    const altas = deltaRows.filter((r) => r.es_alta).length;
    const cambios = deltaRows.length - altas;
    const total = rows.length;

    await knex('fiscal.sat_list_versions')
      .insert({ list_hash: listHash, lista, source, total_rfcs: total, altas, cambios })
      .onConflict('list_hash').ignore();
    await knex('fiscal.sat_list_staging').where({ lista }).del();

    this.logger.log(`Lista ${lista}/${listHash}: ${total} RFCs · ${altas} altas · ${cambios} cambios.`);
    return { lista, listHash, total, altas, cambios, source };
  }

  // ── Parser CSV del SAT (quote-aware, header por nombre de columna) ────────
  private parseCsv(cfg: SatListConfig, text: string): Array<Record<string, string | null>> {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
    const find = (cands: string[], header: string[]) =>
      header.findIndex((h) => cands.some((c) => h.includes(c)));

    let headerIdx = -1;
    let header: string[] = [];
    for (let i = 0; i < Math.min(lines.length, 12); i++) {
      const cells = this.splitCsvLine(lines[i]).map((h) => this.strip(h));
      if (find(cfg.cols.rfc, cells) >= 0 && find(cfg.cols.situacion, cells) >= 0) {
        headerIdx = i; header = cells; break;
      }
    }
    if (headerIdx === -1) throw new Error(`No se encontró encabezado del CSV (lista ${cfg.key})`);

    const iRfc = find(cfg.cols.rfc, header);
    const iNombre = find(cfg.cols.nombre, header);
    const iSituacion = find(cfg.cols.situacion, header);
    const iOficio = header.findIndex((h) => h.includes('oficio'));

    const out: Array<Record<string, string | null>> = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const cells = this.splitCsvLine(lines[i]);
      const rfc = (cells[iRfc] ?? '').trim().toUpperCase();
      if (!RFC_REGEX.test(rfc)) continue;
      out.push({
        rfc,
        nombre: iNombre >= 0 ? (cells[iNombre] ?? '').trim() || null : null,
        situacion: (cells[iSituacion] ?? '').trim() || null,
        fecha_publicacion: this.firstDate(cells),
        oficio: iOficio >= 0 ? (cells[iOficio] ?? '').trim() || null : null,
      });
    }
    return out;
  }

  private firstDate(cells: string[]): string | null {
    for (const c of cells) {
      const m = (c ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    }
    return null;
  }

  private splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
      } else if (ch === ',' && !inQ) { out.push(cur); cur = ''; } else { cur += ch; }
    }
    out.push(cur);
    return out;
  }

  private strip(s: string): string {
    // ̀-ͯ = marcas diacríticas combinantes (acentos) tras NFD.
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }
}
