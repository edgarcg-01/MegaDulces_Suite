import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as ExcelJS from 'exceljs';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * CB.2 — Conciliación bancaria (ADR-033). Servicio de lectura + reclasificación
 * sobre `finance.bank_*`. Reemplaza el workbook Excel: cuentas, catálogo de
 * categorías, estados de cuenta por periodo, movimientos (filtrables) y el
 * tablero CONCENTRADO (pivote cuenta × grupo). NO escribe a Kepler.
 *
 * finance.* tiene RLS forzado → todo va por TenantKnexService.run() (el tenant
 * lo pone el contexto; los WHERE no repiten tenant_id).
 */

const n = (v: any) => Number(v) || 0;
const normKey = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const money = (v: any): number => {
  if (typeof v === 'number') return v;
  const t = String(v ?? '').replace(/[$,\s]/g, '').trim();
  const num = Number(t);
  return Number.isFinite(num) ? num : 0;
};
function cellVal(row: ExcelJS.Row, i?: number): any {
  if (!i) return null;
  const v = row.getCell(i).value as any;
  return v && typeof v === 'object' && v.result !== undefined ? v.result : v;
}
function excelDate(v: any): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // dd/mm/yyyy
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/** Traduce (M, C, concepto) del Excel → código de categoría limpia. Idéntico al CLI CB.1. */
function classify(M: any, C: any, concept: any): string {
  const m = normKey(M), c = normKey(C), t = normKey(concept);
  if (m === 'TE' || m === 'TI' || c === '-') return 'traspaso_entre_cuentas';
  if (m === 'CF') return 'compra_factoraje';
  if (m === 'PF') return 'pago_factoraje';
  if (m === 'DS') return 'devolucion_spei';
  if (m === 'ID') return 'ingreso_devolucion';
  if (m === 'I') return /\bDEV|DEVOLUC/.test(t) ? 'ingreso_devolucion' : 'cobranza';
  if (c === '102') return 'cobranza';
  if (m === 'C' || c === '510' || c === '501') return 'compra_mercancia';
  if (c === '610') return 'nomina';
  if (c === '147') return 'iva_acreditable';
  if (c === '631') return 'pension_alimenticia';
  if (c === '621') return 'gasto_admin';
  if (c === '612') {
    if (/SUA|IMSS/.test(t)) return 'imss_sua';
    if (/COMISI|MEMBRES|COBRO/.test(t)) return 'comision_bancaria';
    if (/CAPITAL|CREDITO|CRÉDITO|PRESTAMO|PRÉSTAMO/.test(t)) return 'pago_credito';
    if (/ARRENDA/.test(t)) return 'renta';
    if (/PAN AMERICANO|TRASLADO|VALORES/.test(t)) return 'traslado_valores';
    return 'sin_clasificar';
  }
  if (c === '613') {
    if (/CAJA DE AHORRO|CAJA AHORRO/.test(t)) return 'caja_ahorro';
    if (/NOMINA|NÓMINA|\bNOM\b/.test(t)) return 'nomina';
    return 'sin_clasificar';
  }
  return 'sin_clasificar';
}

export interface ListMovementsQuery {
  period?: string;
  account_id?: string;
  category_id?: string;
  group_key?: string;
  uncategorized?: string;   // 'true' → solo sin categoría
  recon_status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class FinanceBankService {
  private readonly logger = new Logger(FinanceBankService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Cuentas de banco/caja/factoraje. */
  async accounts() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      return trx('finance.bank_accounts')
        .select('id', 'bank', 'account_label', 'alias', 'kind', 'kepler_link', 'active')
        .orderBy([{ column: 'kind' }, { column: 'bank' }, { column: 'account_label' }]);
    });
  }

  /** Catálogo de categorías limpias (alineado a Kepler). */
  async categories() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      return trx('finance.movement_categories')
        .select('id', 'code', 'name', 'flow', 'kepler_account', 'group_key', 'kepler_note', 'sort_order', 'active')
        .orderBy('sort_order');
    });
  }

  /** Periodos con estados de cuenta cargados (más reciente primero). */
  async periods(): Promise<string[]> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_statements').distinct('period').orderBy('period', 'desc');
      return rows.map((r: any) => r.period);
    });
  }

  /** Estados de cuenta de un periodo (por cuenta) con totales. */
  async statements(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_statements as st')
        .join('finance.bank_accounts as ba', 'ba.id', 'st.bank_account_id')
        .where('st.period', period)
        .select('st.id', 'st.bank_account_id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind',
          'st.opening_balance', 'st.closing_balance', 'st.total_in', 'st.total_out',
          'st.source_file', 'st.status', 'st.imported_at')
        .orderBy([{ column: 'ba.kind' }, { column: 'ba.bank' }, { column: 'ba.account_label' }]);
      return rows.map((r: any) => ({
        ...r,
        opening_balance: n(r.opening_balance), closing_balance: n(r.closing_balance),
        total_in: n(r.total_in), total_out: n(r.total_out),
      }));
    });
  }

  /** Movimientos filtrados (grid). Pagina; devuelve total para el contador. */
  async movements(q: ListMovementsQuery) {
    this.tenantCtx.requireTenantId();
    if (!q.period && !q.account_id) throw new BadRequestException('period o account_id requerido');
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 200));
    const offset = Math.max(0, Number(q.offset) || 0);
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('finance.bank_movements as bm')
          .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
          .leftJoin('finance.bank_statements as st', 'st.id', 'bm.statement_id');
        if (q.period) b.where('st.period', q.period);
        if (q.account_id) b.where('bm.bank_account_id', q.account_id);
        if (q.category_id) b.where('bm.category_id', q.category_id);
        if (q.group_key) b.where('mc.group_key', q.group_key);
        if (q.uncategorized === 'true') b.whereNull('bm.category_id');
        if (q.recon_status) b.where('bm.recon_status', q.recon_status);
        if (q.search) {
          const s = `%${q.search.trim()}%`;
          b.where((w) => w.whereILike('bm.concept', s).orWhereILike('bm.raw_code', s).orWhereILike('bm.sucursal', s));
        }
        return b;
      };
      const [{ count }] = await base().count({ count: '*' });
      const rows = await base()
        .select('bm.id', 'bm.movement_date', 'ba.bank', 'ba.account_label', 'bm.bank_account_id',
          'bm.category_id', 'mc.code as category_code', 'mc.name as category_name', 'mc.group_key',
          'mc.kepler_account', 'bm.raw_type', 'bm.raw_code', 'bm.sucursal', 'bm.concept',
          'bm.amount_in', 'bm.amount_out', 'bm.running_balance', 'bm.recon_status')
        .orderBy([{ column: 'bm.movement_date' }, { column: 'bm.id' }])
        .limit(limit).offset(offset);
      return {
        total: Number(count),
        rows: rows.map((r: any) => ({
          ...r,
          amount_in: n(r.amount_in), amount_out: n(r.amount_out),
          running_balance: r.running_balance === null ? null : n(r.running_balance),
        })),
      };
    });
  }

  /**
   * Tablero CONCENTRADO: pivote cuenta × grupo (ingreso/compra/gasto/factoraje/
   * financiero/traspaso/devolucion/sin_clasificar) con depósitos/retiros, más
   * fila de totales. Es la vista que reemplaza la hoja CONCENTRADO del Excel.
   */
  async concentrado(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_movements as bm')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period)
        .groupBy('ba.id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind')
        .groupByRaw('COALESCE(mc.group_key, ?)', ['sin_clasificar'])
        .select('ba.id as account_id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind',
          trx.raw(`COALESCE(mc.group_key, 'sin_clasificar') AS group_key`),
          trx.raw('SUM(bm.amount_in)::numeric AS deposits'),
          trx.raw('SUM(bm.amount_out)::numeric AS withdrawals'),
          trx.raw('COUNT(*)::int AS movs'));

      const byAccount = new Map<string, any>();
      const groupTotals: Record<string, { deposits: number; withdrawals: number; movs: number }> = {};
      for (const r of rows as any[]) {
        const acc = byAccount.get(r.account_id) || {
          account_id: r.account_id, bank: r.bank, account_label: r.account_label, alias: r.alias, kind: r.kind,
          groups: {}, deposits: 0, withdrawals: 0, movs: 0,
        };
        const dep = n(r.deposits), wd = n(r.withdrawals), mv = Number(r.movs) || 0;
        acc.groups[r.group_key] = { deposits: dep, withdrawals: wd, movs: mv };
        acc.deposits += dep; acc.withdrawals += wd; acc.movs += mv;
        byAccount.set(r.account_id, acc);
        const g = groupTotals[r.group_key] || { deposits: 0, withdrawals: 0, movs: 0 };
        g.deposits += dep; g.withdrawals += wd; g.movs += mv;
        groupTotals[r.group_key] = g;
      }
      const accounts = [...byAccount.values()].sort((a, b) =>
        a.kind.localeCompare(b.kind) || a.bank.localeCompare(b.bank) || a.account_label.localeCompare(b.account_label));
      const grand = {
        deposits: accounts.reduce((s, a) => s + a.deposits, 0),
        withdrawals: accounts.reduce((s, a) => s + a.withdrawals, 0),
        movs: accounts.reduce((s, a) => s + a.movs, 0),
      };
      return { period, accounts, groupTotals, grand };
    });
  }

  /** Reclasifica un movimiento (asigna categoría). null/'' → deja sin clasificar. */
  async reclassify(id: string, categoryId: string | null, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      let catId: string | null = null;
      if (categoryId) {
        const cat = await trx('finance.movement_categories').where({ id: categoryId }).first('id');
        if (!cat) throw new BadRequestException('categoría inválida');
        catId = cat.id;
      }
      const [row] = await trx('finance.bank_movements').where({ id })
        .update({ category_id: catId, updated_at: trx.fn.now() })
        .returning(['id', 'category_id']);
      if (!row) throw new BadRequestException('movimiento no encontrado');
      this.logger.log(`movimiento ${id} reclasificado → ${catId || 'sin_clasificar'} por ${actor || '?'}`);
      return row;
    });
  }

  /**
   * CB.4 — Conciliación banco ↔ Kepler (control-total). El estado de cuenta ES el
   * movimiento del 102 (caja/bancos) de Kepler. Dos niveles:
   *  - CAJA: depósitos/retiros del banco (excl. traspasos internos) vs 102 cargos/abonos.
   *  - P&L: cada categoría de gasto vs su cuenta Kepler (cargos del mayor en la balanza).
   * Lee analytics.ledger_monthly (sin RLS → filtro tenant explícito). Diferencias
   * ≠ 0 son esperadas (timing, caja general, factoraje, scope) — es lo que se investiga.
   */
  async reconciliation(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const mayorOf = (acc: string | null) => String(acc || '').split(/[-/]/)[0].trim();

    return this.tk.run(async (trx) => {
      // Lado banco: por categoría (grupo + cuenta Kepler).
      const bank = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period)
        .groupBy('mc.group_key', 'mc.kepler_account', 'mc.name')
        .select(trx.raw(`COALESCE(mc.group_key,'sin_clasificar') AS group_key`),
          'mc.kepler_account', 'mc.name',
          trx.raw('SUM(bm.amount_in)::numeric AS deposits'),
          trx.raw('SUM(bm.amount_out)::numeric AS withdrawals'));

      // Lado libro: balanza del periodo por cuenta mayor (analytics.* → tenant explícito).
      const book = await trx('analytics.ledger_monthly')
        .where({ tenant_id: tenantId, anio_mes: period })
        .groupBy('cuenta_mayor')
        .select('cuenta_mayor', trx.raw('SUM(cargos)::numeric AS cargos'), trx.raw('SUM(abonos)::numeric AS abonos'));
      const bookBy: Record<string, { cargos: number; abonos: number }> = {};
      for (const r of book as any[]) bookBy[r.cuenta_mayor] = { cargos: n(r.cargos), abonos: n(r.abonos) };

      // CAJA: banco (excl. traspasos internos) vs 102.
      const EXCLUDE = new Set(['traspaso']);
      let bankIn = 0, bankOut = 0;
      for (const r of bank as any[]) {
        if (EXCLUDE.has(r.group_key)) continue;
        bankIn += n(r.deposits); bankOut += n(r.withdrawals);
      }
      const k102 = bookBy['102'] || { cargos: 0, abonos: 0 };
      const cash = {
        bank_in: bankIn, kepler_102_cargos: k102.cargos, delta_in: bankIn - k102.cargos,
        bank_out: bankOut, kepler_102_abonos: k102.abonos, delta_out: bankOut - k102.abonos,
      };

      // P&L: categorías de gasto/compra/financiero → cuenta Kepler; banco retiros vs cargos del mayor.
      const PNL_GROUPS = new Set(['gasto', 'compra', 'financiero']);
      const byMayor: Record<string, { concepts: Set<string>; bank: number }> = {};
      for (const r of bank as any[]) {
        if (!PNL_GROUPS.has(r.group_key) || !r.kepler_account) continue;
        const may = mayorOf(r.kepler_account);
        (byMayor[may] ||= { concepts: new Set(), bank: 0 });
        byMayor[may].concepts.add(r.name);
        byMayor[may].bank += n(r.withdrawals);
      }
      const accounts = Object.entries(byMayor).map(([may, v]) => {
        const book = (bookBy[may]?.cargos) || 0;
        return { kepler_account: may, concept: [...v.concepts].join(', '), bank: v.bank, book, delta: v.bank - book };
      }).sort((a, b) => b.bank - a.bank);

      // Cobranza (ingreso) como memo: depósitos vs 102 cargos (ya en cash).
      const cobranza = (bank as any[]).filter((r) => r.group_key === 'ingreso').reduce((s, r) => s + n(r.deposits), 0);

      return { period, cash, accounts, cobranza,
        sin_clasificar: (bank as any[]).filter((r) => r.group_key === 'sin_clasificar').reduce((s, r) => s + n(r.deposits) + n(r.withdrawals), 0) };
    });
  }

  /**
   * CB.2.1 — Import web del workbook Excel (mismo parse+clasificación que el CLI CB.1).
   * Recibe el .xlsx en base64 + periodo; puebla bank_statements + bank_movements
   * (UPSERT por client_uuid, no DELETE). Devuelve resumen por cuenta + grupos.
   */
  async importWorkbook(fileBase64: string, period: string, sourceFile?: string, actor?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!fileBase64) throw new BadRequestException('archivo requerido');
    if (!/^\d{4}-\d{2}$/.test(period || '')) throw new BadRequestException('periodo inválido (YYYY-MM)');
    const b64 = fileBase64.includes(',') ? fileBase64.split(',').pop()! : fileBase64;
    const buf = Buffer.from(b64, 'base64');

    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf as any); } catch { throw new BadRequestException('no se pudo leer el Excel'); }
    const sheets = wb.worksheets.filter((s) => !/TOTAL MOV|CONCENTRADO|FilterDatabase/i.test(s.name));

    return this.tk.run(async (trx) => {
      const catMap = new Map<string, { id: string; group: string }>(
        (await trx('finance.movement_categories').select('id', 'code', 'group_key'))
          .map((r: any) => [r.code, { id: r.id, group: r.group_key }]));
      const acctMap = new Map<string, any>(
        (await trx('finance.bank_accounts').select('id', 'alias', 'account_label'))
          .map((r: any) => [normKey(r.alias), r]));

      const perAccount: any[] = [];
      const byGroup: Record<string, { in: number; out: number; n: number }> = {};
      let grandIn = 0, grandOut = 0, grandUncat = 0, grandRows = 0;

      for (const ws of sheets) {
        let hRow = 0; const col: Record<string, number> = {};
        for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
          const u = (ws.getRow(r).values as any[]).map((v) => normKey(v));
          if (u.some((v) => v === 'FECHA')) { hRow = r; u.forEach((v, i) => { if (v) col[v] = i; }); break; }
        }
        const acct = acctMap.get(normKey(ws.name));
        if (!hRow || !col['FECHA'] || (!col['RETIRO'] && !col['DEPOSITO'])) { perAccount.push({ sheet: ws.name, note: 'layout no estándar — omitido' }); continue; }
        if (!acct) { perAccount.push({ sheet: ws.name, note: 'cuenta no registrada — omitido' }); continue; }
        const ci = { fecha: col['FECHA'], m: col['M'], s: col['S'], c: col['C'], prov: col['PROVEEDOR'], ret: col['RETIRO'], dep: col['DEPOSITO'], saldo: col['SALDO'] };

        const rows: any[] = []; const seen = new Map<string, number>();
        let tin = 0, tout = 0, uncat = 0, lastBal: number | null = null;
        for (let r = hRow + 1; r <= ws.rowCount; r++) {
          const row = ws.getRow(r);
          const date = excelDate(cellVal(row, ci.fecha));
          if (!date) continue;
          const amtIn = money(cellVal(row, ci.dep)), amtOut = money(cellVal(row, ci.ret));
          if (amtIn === 0 && amtOut === 0) continue;
          const M = String(cellVal(row, ci.m) ?? '').trim(), C = String(cellVal(row, ci.c) ?? '').trim(), S = String(cellVal(row, ci.s) ?? '').trim();
          const concept = String(cellVal(row, ci.prov) ?? '').replace(/\s+/g, ' ').trim();
          const bal = ci.saldo ? money(cellVal(row, ci.saldo)) : null;
          const catCode = classify(M, C, concept);
          const cat = catMap.get(catCode);
          const catId = catCode === 'sin_clasificar' ? null : (cat ? cat.id : null);
          const group = catCode === 'sin_clasificar' ? 'sin_clasificar' : (cat ? cat.group : 'sin_clasificar');
          if (!catId) uncat++;
          (byGroup[group] ||= { in: 0, out: 0, n: 0 }); byGroup[group].in += amtIn; byGroup[group].out += amtOut; byGroup[group].n++;
          tin += amtIn; tout += amtOut; if (bal !== null) lastBal = bal;
          const contentKey = `${acct.account_label}|${period}|${date}|${M}|${C}|${concept}|${amtIn}|${amtOut}`;
          const occ = (seen.get(contentKey) || 0) + 1; seen.set(contentKey, occ);
          const clientUuid = crypto.createHash('sha1').update(`${contentKey}|${occ}`).digest('hex');
          rows.push({ tenant_id: tenantId, bank_account_id: acct.id, movement_date: date, category_id: catId,
            raw_type: M || null, raw_code: C || null, sucursal: S || null, concept: concept || null,
            amount_in: amtIn, amount_out: amtOut, running_balance: bal, client_uuid: clientUuid, source_file: sourceFile || null });
        }

        const [st] = await trx('finance.bank_statements')
          .insert({ tenant_id: tenantId, bank_account_id: acct.id, period,
            closing_balance: lastBal ?? 0, total_in: Math.round(tin * 100) / 100, total_out: Math.round(tout * 100) / 100,
            source_file: sourceFile || null, status: 'imported', imported_at: trx.fn.now(), imported_by: actor || null })
          .onConflict(['tenant_id', 'bank_account_id', 'period'])
          .merge(['closing_balance', 'total_in', 'total_out', 'source_file', 'imported_at', 'updated_at'])
          .returning('id');
        const statementId = (st as any).id;
        for (const r of rows) r.statement_id = statementId;
        for (let i = 0; i < rows.length; i += 500) {
          await trx('finance.bank_movements').insert(rows.slice(i, i + 500))
            .onConflict(['tenant_id', 'client_uuid'])
            .merge(['statement_id', 'bank_account_id', 'movement_date', 'category_id', 'raw_type', 'raw_code',
              'sucursal', 'concept', 'amount_in', 'amount_out', 'running_balance', 'source_file', 'updated_at']);
        }

        grandIn += tin; grandOut += tout; grandUncat += uncat; grandRows += rows.length;
        perAccount.push({ sheet: ws.name, movs: rows.length, deposits: Math.round(tin), withdrawals: Math.round(tout), sin_clasificar: uncat });
      }

      this.logger.log(`import banco periodo ${period}: ${grandRows} movs, ${grandUncat} sin_clasificar, por ${actor || '?'}`);
      return { period, accounts: perAccount, byGroup, total: grandRows, deposits: grandIn, withdrawals: grandOut, sin_clasificar: grandUncat };
    });
  }
}
