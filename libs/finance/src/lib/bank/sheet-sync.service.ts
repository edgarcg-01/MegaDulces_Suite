import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import * as crypto from 'node:crypto';
import { KNEX_NEW_DB, TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FinanceBankService } from './finance-bank.service';

/**
 * CB.23 — Sync del workbook maestro (Google Sheet vía export público, ADR-033).
 *
 * Sin webhook ni cuenta de servicio: baja el `.xlsx` de la URL de export del Sheet
 * (compartido "cualquiera con el enlace") y lo procesa con el MISMO parser del upload
 * web (`FinanceBankService.importFromBuffer`, origen 'sheet' → barrido soft-delete).
 * Compara el sha1 del archivo contra `last_hash` para no reprocesar sin cambios.
 *
 * Disparo: cron cada 3 min (solo tenants con config.active + env SHEET_SYNC_ENABLED)
 * y botón "Sincronizar ahora" desde la UI. El webhook (push) es CB.25 diferido: se
 * enchufa encima llamando a syncCurrent(), sin rehacer nada.
 */
@Injectable()
export class SheetSyncService {
  private readonly logger = new Logger(SheetSyncService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly bank: FinanceBankService,
  ) {}

  private static exportUrl(sheetId: string): string {
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
  }

  /** Config del sync del tenant actual (o null si no existe). */
  async config() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) =>
      trx('finance.sheet_sync_config').first(
        'id', 'sheet_id', 'period', 'active', 'last_hash', 'last_synced_at', 'last_rows', 'last_changed', 'last_error'));
  }

  /** Edita/crea la config del tenant actual (period/active/sheet_id). */
  async updateConfig(body: { sheet_id?: string; period?: string; active?: boolean }) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const patch: any = { updated_at: trx.fn.now() };
      if (body?.sheet_id !== undefined) patch.sheet_id = String(body.sheet_id).trim();
      if (body?.period !== undefined) {
        if (!/^\d{4}-\d{2}$/.test(body.period)) throw new BadRequestException('periodo inválido (YYYY-MM)');
        patch.period = body.period;
      }
      if (body?.active !== undefined) patch.active = !!body.active;
      const existing = await trx('finance.sheet_sync_config').first('id');
      if (existing) {
        const [row] = await trx('finance.sheet_sync_config').where({ id: existing.id }).update(patch).returning('*');
        return row;
      }
      if (!patch.sheet_id || !patch.period) throw new BadRequestException('sheet_id y period requeridos para crear la config');
      const [row] = await trx('finance.sheet_sync_config').insert({ ...patch, active: patch.active ?? false }).returning('*');
      return row;
    });
  }

  /** Descarga el .xlsx del Sheet por su URL de export público. */
  private async download(sheetId: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(SheetSyncService.exportUrl(sheetId), { redirect: 'follow' });
    } catch (e: any) {
      throw new BadRequestException(`no se pudo alcanzar el Sheet: ${e?.message || e}`);
    }
    if (!res.ok) throw new BadRequestException(`no se pudo bajar el Sheet (HTTP ${res.status}) — ¿sigue compartido "cualquiera con el enlace"?`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Google devuelve HTML (login) cuando el Sheet ya no es público → NO es un xlsx (PK..).
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new BadRequestException('la descarga no es un .xlsx (el Sheet dejó de ser público o el id es inválido)');
    }
    return buf;
  }

  /**
   * Corre el sync del tenant ACTUAL (debe correr dentro de tenantCtx). `force` ignora
   * el hash (reprocesa aunque el archivo no haya cambiado). Devuelve el resumen del
   * import o `{ skipped: true }` si no hubo cambios.
   */
  async syncCurrent(opts: { force?: boolean } = {}) {
    const cfg = await this.config();
    if (!cfg) throw new BadRequestException('no hay config de sync para este tenant');
    if (!cfg.sheet_id || !cfg.period) throw new BadRequestException('config incompleta (falta sheet_id o period)');

    let buf: Buffer;
    try { buf = await this.download(cfg.sheet_id); }
    catch (e: any) { await this.setError(cfg.id, e?.message || String(e)); throw e; }

    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    if (!opts.force && hash === cfg.last_hash) {
      return { skipped: true, reason: 'sin cambios', period: cfg.period };
    }

    let res: any;
    try {
      res = await this.bank.importFromBuffer(buf, cfg.period, `sheet:${cfg.sheet_id}`, 'sheet-sync', 'sheet');
    } catch (e: any) { await this.setError(cfg.id, e?.message || String(e)); throw e; }

    const changed = (res.total || 0) + (res.swept || 0);
    await this.tk.run(async (trx) => trx('finance.sheet_sync_config').where({ id: cfg.id }).update({
      last_hash: hash, last_synced_at: trx.fn.now(), last_rows: res.total, last_changed: changed,
      last_error: null, updated_at: trx.fn.now(),
    }));
    this.logger.log(`sheet-sync ${cfg.period}: ${res.total} filas, ${res.swept} borrados, ${res.sin_clasificar} sin clasificar`);
    return { skipped: false, ...res };
  }

  private async setError(id: string, msg: string) {
    try {
      await this.tk.run(async (trx) => trx('finance.sheet_sync_config').where({ id }).update({ last_error: String(msg).slice(0, 500), updated_at: trx.fn.now() }));
    } catch { /* best-effort */ }
  }

  /**
   * Cron cada 3 min. Solo corre si SHEET_SYNC_ENABLED=true. Itera los tenants activos
   * (KNEX_NEW_DB, sin RLS) y sincroniza los que tengan config.active dentro de su scope.
   * Guard anti-solape. timeZone MX explícito (el contenedor corre en MX).
   */
  @Cron('0 */3 * * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.SHEET_SYNC_ENABLED !== 'true') return;
    if (this.running) { this.logger.warn('skip: sync previo aún corriendo'); return; }
    this.running = true;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try {
          await this.tenantCtx.run({ tenantId: t.id }, async () => {
            const cfg = await this.config();
            if (cfg?.active) await this.syncCurrent();
          });
        } catch (e: any) { this.logger.warn(`sheet-sync tenant ${t.id} falló: ${e?.message || e}`); }
      }
    } finally { this.running = false; }
  }
}
