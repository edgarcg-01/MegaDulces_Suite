import { Injectable, BadRequestException, Logger, Inject, Optional } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as ExcelJS from 'exceljs';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, FinanceFindingsSinkPort, FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';

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

// Tokens significativos de un nombre de beneficiario (para el 3er pase del matcher
// por nombre). Quita ruido societario (SA/DE/CV/SAPI…), acentos y palabras cortas.
// Ruido societario + palabras operativas GENÉRICAS: un concepto que solo tiene estas
// (p.ej. "Nomina 01", "Gasto", "Abono") NO debe casar por nombre — no identifica una
// contraparte. Solo casan conceptos con un nombre propio (proveedor/persona) real.
const STOP_TOKENS = new Set(['SA', 'DE', 'CV', 'SAPI', 'SAB', 'SC', 'SRL', 'RL', 'SOFOM', 'ENR', 'SOF', 'THE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'PAGO', 'SPEI', 'TRANSFERENCIA',
  'NOMINA', 'GASTO', 'GASTOS', 'ABONO', 'PRESTAMO', 'RETIRO', 'DEPOSITO', 'COMPRA', 'VENTA', 'COMISION', 'CONSUMO', 'CONSUMOS', 'REEMBOLSO', 'ANTICIPO', 'VIATICOS', 'TRASPASO', 'INTERES', 'INTERESES', 'CAPITAL', 'SUELDO', 'FINIQUITO', 'FACTURA', 'DOMICILIACION', 'SERVICIO', 'SERVICIOS']);
const nameTokens = (s: any): Set<string> => {
  const t = normKey(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ');
  return new Set(t.split(/\s+/).filter((w) => w.length >= 4 && !STOP_TOKENS.has(w)));
};
const nameScore = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
};
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
// Meses en español (abreviado o completo) → número. Banorte teclea "05/Ago./2026".
const ES_MONTH: Record<string, string> = {
  ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06',
  JUL: '07', AGO: '08', SEP: '09', SET: '09', OCT: '10', NOV: '11', DIC: '12',
};
function excelDate(v: any): string | null {
  let iso: string | null = null;
  if (v instanceof Date && !isNaN(v.getTime())) iso = v.toISOString().slice(0, 10);
  else {
    const s = String(v ?? '').trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // dd/mm/yyyy
    if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    else {
      // CB.23.1 — dd/Mmm./yyyy con mes en español (p.ej. "05/Ago./2026", cuentas Banorte).
      // El parser viejo solo aceptaba dd/mm/yyyy numérico → perdía silenciosamente estas filas.
      m = s.match(/^(\d{1,2})\/([A-Za-z]{3,})\.?\/(\d{4})$/);
      if (m) { const mm = ES_MONTH[m[2].slice(0, 3).toUpperCase()]; if (mm) iso = `${m[3]}-${mm}-${m[1].padStart(2, '0')}`; }
    }
  }
  if (!iso) return null;
  // Guard contra fechas basura capturadas en el Sheet (visto: año 0206 en vez de 2026).
  const yr = Number(iso.slice(0, 4));
  return yr >= 2000 && yr <= 2100 ? iso : null;
}

/**
 * CB.6 — Motor de clasificación desde DB (finance.bank_classify_rules).
 * Reglas ordenadas por priority; una aplica si TODOS sus matchers no-nulos
 * (regex sobre M/C/concepto) hacen match. La primera que aplica gana.
 * Reemplaza la función classify() hardcodeada (ahora las reglas viven en DB,
 * editables desde la vista Admin). Patrones inválidos se ignoran (best-effort).
 */
export interface ClassifyRuleRow {
  priority: number; match_type: string | null; match_code: string | null;
  match_concept: string | null; category_code: string;
}
interface CompiledRule { reType: RegExp | null; reCode: RegExp | null; reConcept: RegExp | null; category: string; }

function compileRules(rules: ClassifyRuleRow[]): CompiledRule[] {
  const safe = (p: string | null): RegExp | null => {
    if (!p) return null;
    try { return new RegExp(p, 'i'); } catch { return null; }
  };
  return [...rules]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => ({ reType: safe(r.match_type), reCode: safe(r.match_code), reConcept: safe(r.match_concept), category: r.category_code }));
}

function classifyWith(compiled: CompiledRule[], M: any, C: any, concept: any): string {
  const m = normKey(M), c = normKey(C), t = normKey(concept);
  for (const r of compiled) {
    if (r.reType && !r.reType.test(m)) continue;
    if (r.reCode && !r.reCode.test(c)) continue;
    if (r.reConcept && !r.reConcept.test(t)) continue;
    return r.category;
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
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly findingsSink?: FinanceFindingsSinkPort,
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

  // ── CP.2 (Fase CP, ADR-040) — Enlace + comparación con la contabilidad ContPAQi ──

  /** Patrón de nombre de banco en ContPAQi por código de cuenta CB. */
  private static readonly CPQ_BANK_RX: Record<string, RegExp> = {
    SANTANDER: /santander|stder|stdr/i,
    BBVA: /bbva|bancomer/i,
    BANORTE: /banorte/i,
    BBAJIO: /bajio/i,
    BANAMEX: /banamex/i,
  };

  /**
   * Auto-enlaza cada cuenta de banco (finance.bank_accounts) con su cuenta contable de
   * ContPAQi `102xxxxxxx` (analytics.contpaqi_bank_movements) — por familia de banco +
   * account_label contenido en el nombre. Persiste contpaqi_cuenta. Idempotente. GESTIONAR.
   */
  async linkContpaqi() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // Solo cuentas BANCARIAS son enlazables al 102xxx de ContPAQi (CAJA/FACTORAJE no aplican).
      const accounts = await trx('finance.bank_accounts').where('kind', 'bank')
        .select('id', 'bank', 'account_label', 'kind', 'contpaqi_cuenta', 'contpaqi_cuenta_nombre');
      const cpq = await trx('analytics.contpaqi_bank_movements')
        .where('tenant_id', tenantId)
        .select('cuenta', 'cuenta_nombre').count('* as movs')
        .groupBy('cuenta', 'cuenta_nombre');
      const results: any[] = [];
      for (const a of accounts) {
        const rx = FinanceBankService.CPQ_BANK_RX[a.bank];
        let best: any = null;
        if (rx && a.kind === 'bank') {
          const label = String(a.account_label).trim();
          best = cpq
            .filter((c: any) => rx.test(c.cuenta_nombre || '') && String(c.cuenta_nombre).replace(/\D/g, '').includes(label))
            .sort((x: any, y: any) => Number(y.movs) - Number(x.movs))[0] || null;
        }
        // Solo ESCRIBE cuando el auto-match encuentra cuenta. Nunca pone en NULL un
        // enlace existente — así los enlaces MANUALES (p.ej. Santander 1604↔CH 50730160,
        // que no comparten número) sobreviven a re-correr el auto-enlace. Idempotente.
        if (best) {
          await trx('finance.bank_accounts').where('id', a.id).update({
            contpaqi_cuenta: best.cuenta,
            contpaqi_cuenta_nombre: String(best.cuenta_nombre).trim(),
            updated_at: trx.fn.now(),
          });
          results.push({ bank: a.bank, account_label: a.account_label, contpaqi_cuenta: best.cuenta, contpaqi_cuenta_nombre: String(best.cuenta_nombre).trim() });
        } else {
          results.push({ bank: a.bank, account_label: a.account_label, contpaqi_cuenta: a.contpaqi_cuenta ?? null, contpaqi_cuenta_nombre: a.contpaqi_cuenta_nombre ?? null });
        }
      }
      const linked = results.filter((r) => r.contpaqi_cuenta).length;
      this.logger.log(`ContPAQi link: ${linked}/${accounts.length} cuentas enlazadas`);
      return { linked, total: accounts.length, results };
    });
  }

  /**
   * Catálogo de cuentas contables de banco en ContPAQi (102xxx) para el selector de enlace
   * manual. Marca `taken` la que ya está enlazada a alguna cuenta y por quién. GESTIONAR.
   */
  async contpaqiBankAccounts() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const cpq = await trx('analytics.contpaqi_bank_movements')
        .where('tenant_id', tenantId)
        .select('cuenta', 'cuenta_nombre').count('* as movs')
        .groupBy('cuenta', 'cuenta_nombre').orderBy('cuenta_nombre');
      const links = await trx('finance.bank_accounts').whereNotNull('contpaqi_cuenta')
        .select('bank', 'account_label', 'contpaqi_cuenta');
      const takenBy = new Map(links.map((l: any) => [l.contpaqi_cuenta, `${l.bank} ${l.account_label}`]));
      return cpq.map((c: any) => ({
        cuenta: c.cuenta, cuenta_nombre: String(c.cuenta_nombre).trim(), movs: Number(c.movs),
        taken: takenBy.has(c.cuenta), taken_by: takenBy.get(c.cuenta) ?? null,
      }));
    });
  }

  /**
   * Enlace manual de una cuenta de banco a una cuenta contable ContPAQi (cuando el auto-match
   * no la casa por distinta convención de número, p.ej. Santander 1604 ↔ CH 50730160). Pasar
   * `contpaqi_cuenta=null` desenlaza. GESTIONAR.
   */
  async manualLinkContpaqi(bankAccountId: string, contpaqiCuenta: string | null) {
    if (!bankAccountId) throw new BadRequestException('bank_account_id requerido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const acct = await trx('finance.bank_accounts').where('id', bankAccountId).first();
      if (!acct) throw new BadRequestException('cuenta de banco no encontrada');
      let nombre: string | null = null;
      if (contpaqiCuenta) {
        const row = await trx('analytics.contpaqi_bank_movements')
          .where('tenant_id', tenantId).andWhere('cuenta', contpaqiCuenta)
          .select('cuenta_nombre').first();
        if (!row) throw new BadRequestException(`cuenta ContPAQi ${contpaqiCuenta} no existe`);
        nombre = String(row.cuenta_nombre).trim();
      }
      await trx('finance.bank_accounts').where('id', bankAccountId).update({
        contpaqi_cuenta: contpaqiCuenta, contpaqi_cuenta_nombre: nombre, updated_at: trx.fn.now(),
      });
      this.logger.log(`ContPAQi manual link: ${acct.bank} ${acct.account_label} -> ${contpaqiCuenta ?? 'NULL'}`);
      return { bank_account_id: bankAccountId, contpaqi_cuenta: contpaqiCuenta, contpaqi_cuenta_nombre: nombre };
    });
  }

  /**
   * Comparación por cuenta: el estado de cuenta del periodo (Excel/finance) vs los LIBROS de
   * ContPAQi (analytics.contpaqi_bank_movements) — la 3ª columna de verdad (contabilidad, no
   * proxy). Ancla en todas las cuentas; Excel = 0 si no hay estado de cuenta. Requiere linkContpaqi.
   */
  async contpaqiCompare(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      // Solo cuentas BANCARIAS: el ledger ContPAQi (contpaqi_bank_movements) solo tiene 102xxx.
      // CAJA (efectivo, ~101) y FACTORAJE (financiamiento, ~210) no viven ahí → incluirlas
      // metía un Δ fantasma igual a todo su monto Excel. Se concilian en sus propios flujos.
      const accounts = await trx('finance.bank_accounts')
        .where('kind', 'bank')
        .select('id', 'bank', 'account_label', 'alias', 'kind', 'contpaqi_cuenta', 'contpaqi_cuenta_nombre');
      const stmts = await trx('finance.bank_statements').where('period', period)
        .select('bank_account_id', 'total_in', 'total_out');
      const stByAcct = new Map(stmts.map((s: any) => [s.bank_account_id, s]));
      const cpq = await trx('analytics.contpaqi_bank_movements')
        .where('tenant_id', tenantId).andWhere('anio_mes', period).select('cuenta')
        .select(trx.raw(`SUM(importe) FILTER (WHERE flujo='deposito') AS dep`))
        .select(trx.raw(`SUM(importe) FILTER (WHERE flujo='retiro') AS ret`))
        .count('* as movs').groupBy('cuenta');
      const cpqByCuenta = new Map(cpq.map((c: any) => [c.cuenta, c]));
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const rows = accounts.map((a: any) => {
        const st: any = stByAcct.get(a.id);
        const c: any = a.contpaqi_cuenta ? cpqByCuenta.get(a.contpaqi_cuenta) : null;
        const exIn = n(st?.total_in), exOut = n(st?.total_out);
        const cpIn = c ? n(c.dep) : 0, cpOut = c ? n(c.ret) : 0;
        return {
          id: a.id, bank: a.bank, account_label: a.account_label, alias: a.alias, kind: a.kind,
          contpaqi_cuenta: a.contpaqi_cuenta, contpaqi_cuenta_nombre: a.contpaqi_cuenta_nombre, linked: !!a.contpaqi_cuenta,
          excel_in: exIn, excel_out: exOut, contpaqi_in: cpIn, contpaqi_out: cpOut,
          delta_in: r2(exIn - cpIn), delta_out: r2(exOut - cpOut), contpaqi_movs: c ? Number(c.movs) : 0,
        };
      });
      const tot = rows.reduce((s: any, r: any) => ({
        excel_in: s.excel_in + r.excel_in, excel_out: s.excel_out + r.excel_out,
        contpaqi_in: s.contpaqi_in + r.contpaqi_in, contpaqi_out: s.contpaqi_out + r.contpaqi_out,
      }), { excel_in: 0, excel_out: 0, contpaqi_in: 0, contpaqi_out: 0 });
      return {
        period, linked: rows.filter((r: any) => r.linked).length, rows,
        totals: { ...tot, delta_in: r2(tot.excel_in - tot.contpaqi_in), delta_out: r2(tot.excel_out - tot.contpaqi_out) },
      };
    });
  }

  /**
   * CP.2 drill — ¿DÓNDE está el descuadre de una cuenta? Enfrenta movimiento a movimiento el
   * estado de cuenta del banco (finance.bank_movements) contra las pólizas de ContPAQi
   * (analytics.contpaqi_bank_movements) para el periodo, casa por importe exacto dentro de cada
   * dirección (depósito/retiro) y devuelve los HUÉRFANOS de cada lado:
   *   • banco sin póliza  → la contabilidad no registró ese movimiento (o va en otra cuenta).
   *   • póliza sin banco   → la contabilidad registró algo que el banco no movió (o mes distinto).
   * La suma de huérfanos explica el Δ. Requiere la cuenta enlazada (contpaqi_cuenta).
   */
  async contpaqiAccountDetail(period?: string, accountId?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    if (!accountId) throw new BadRequestException('account_id requerido');
    return this.tk.run(async (trx) => {
      const acct = await trx('finance.bank_accounts').where('id', accountId).first();
      if (!acct) throw new BadRequestException('cuenta de banco no encontrada');

      const bankRows = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).andWhere('bm.bank_account_id', accountId).whereNull('bm.deleted_at')
        .select('bm.id', 'bm.movement_date', 'bm.amount_in', 'bm.amount_out', 'bm.concept',
          'bm.raw_type', 'bm.raw_code', 'mc.name as category_name')
        .orderBy([{ column: 'bm.movement_date' }, { column: 'bm.id' }]);

      const cpqRows = acct.contpaqi_cuenta
        ? await trx('analytics.contpaqi_bank_movements')
            .where({ tenant_id: tenantId, anio_mes: period, cuenta: acct.contpaqi_cuenta })
            .select('id_movimiento', 'fecha', 'flujo', 'importe', 'poliza_tipo', 'poliza_folio', 'concepto')
            .orderBy([{ column: 'fecha' }, { column: 'poliza_folio' }])
        : [];

      const r2 = (v: number) => Math.round(v * 100) / 100;
      const key = (v: any) => String(Math.round(n(v) * 100)); // centavos → clave de casado exacto

      // Reconciliación greedy por importe exacto dentro de una dirección.
      const reconcile = (
        bankSide: any[], cpqSide: any[],
        bankAmt: (r: any) => number,
      ) => {
        const cpqByAmt = new Map<string, any[]>();
        for (const c of cpqSide) {
          const k = key(c.importe);
          (cpqByAmt.get(k) ?? cpqByAmt.set(k, []).get(k)!).push(c);
        }
        const bankOnly: any[] = []; let matched = 0, matchedAmt = 0;
        for (const b of bankSide) {
          const k = key(bankAmt(b));
          const bucket = cpqByAmt.get(k);
          if (bucket && bucket.length) {
            bucket.shift(); matched++; matchedAmt += bankAmt(b);
          } else {
            bankOnly.push({
              id: b.id, fecha: b.movement_date, importe: r2(bankAmt(b)),
              concepto: b.concept || null, tipo: b.raw_type || null, codigo: b.raw_code || null, categoria: b.category_name || null,
            });
          }
        }
        const cpqOnly: any[] = [];
        for (const arr of cpqByAmt.values()) for (const c of arr) cpqOnly.push({
          id: c.id_movimiento, fecha: c.fecha, importe: r2(n(c.importe)),
          concepto: c.concepto || null, poliza_tipo: c.poliza_tipo, poliza_folio: c.poliza_folio,
        });
        cpqOnly.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
        const bankTotal = r2(bankSide.reduce((s, r) => s + bankAmt(r), 0));
        const cpqTotal = r2(cpqSide.reduce((s, r) => s + n(r.importe), 0));
        return {
          bank_total: bankTotal, contpaqi_total: cpqTotal, delta: r2(bankTotal - cpqTotal),
          matched_count: matched, matched_amount: r2(matchedAmt),
          bank_only: bankOnly, contpaqi_only: cpqOnly,
          bank_only_amount: r2(bankOnly.reduce((s, r) => s + r.importe, 0)),
          contpaqi_only_amount: r2(cpqOnly.reduce((s, r) => s + r.importe, 0)),
        };
      };

      const depBank = bankRows.filter((b: any) => n(b.amount_in) > 0);
      const retBank = bankRows.filter((b: any) => n(b.amount_out) > 0);
      const depCpq = cpqRows.filter((c: any) => c.flujo === 'deposito');
      const retCpq = cpqRows.filter((c: any) => c.flujo === 'retiro');

      const deposits = reconcile(depBank, depCpq, (r) => n(r.amount_in));
      const withdrawals = reconcile(retBank, retCpq, (r) => n(r.amount_out));

      return {
        period,
        account: {
          id: acct.id, bank: acct.bank, account_label: acct.account_label, alias: acct.alias,
          contpaqi_cuenta: acct.contpaqi_cuenta, contpaqi_cuenta_nombre: acct.contpaqi_cuenta_nombre,
          linked: !!acct.contpaqi_cuenta,
        },
        deposits, withdrawals,
      };
    });
  }

  /**
   * CP.2 factoraje — El "FACTORAJE" del Excel NO es una cuenta de banco 102 ni un préstamo SOFOM:
   * son "compras con factoraje" a PROVEEDORES (factoraje a proveedores / reverse factoring). Por eso
   * se cuadra por PROVEEDOR, no contra una cuenta: agrupa las compras factoradas del Excel por
   * proveedor y las contrasta contra ese proveedor en ContPAQi — su CxP (212xxx) y su costo (50xxx),
   * casando por nombre. Es CONTEXTO honesto ("¿la compra factorada está en libros?"), no un cuadre
   * $0: los montos difieren por IVA/bruto-neto/timing. Requiere movimientos en la cuenta kind=factoraje.
   */
  async factorajeCompare(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const r2 = (v: number) => Math.round(v * 100) / 100;

      // Excel: movimientos de la cuenta de factoraje, agrupados por proveedor (concepto).
      const excelRows = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .where('st.period', period).andWhere('ba.kind', 'factoraje').whereNull('bm.deleted_at')
        .select('bm.concept', 'bm.amount_in', 'bm.amount_out');
      const byProv = new Map<string, { proveedor: string; excel_in: number; excel_out: number; movs: number }>();
      for (const r of excelRows as any[]) {
        const nombre = String(r.concept || '(sin proveedor)').trim();
        const k = normKey(nombre);
        const acc = byProv.get(k) ?? { proveedor: nombre, excel_in: 0, excel_out: 0, movs: 0 };
        acc.excel_in += n(r.amount_in); acc.excel_out += n(r.amount_out); acc.movs++;
        byProv.set(k, acc);
      }

      // Identidad de las CxP de proveedor (212x) — de TODOS los periodos, para identificar al
      // proveedor aunque su CxP no tenga movimiento en el mes (p.ej. Bolsas empieza a mover en mayo).
      const cxpIdent = await trx('analytics.contpaqi_ledger_monthly')
        .where('tenant_id', tenantId).andWhere('cuenta', 'like', '212%')
        .distinct('cuenta', 'cuenta_nombre');
      const cxpRich = (cxpIdent as any[]).map((c) => ({ cuenta: c.cuenta, nombre: String(c.cuenta_nombre).trim(), tokens: nameTokens(c.cuenta_nombre) }));

      // Movimiento del periodo (CxP 212x + costo 50x) para poblar los montos.
      const periodMov = await trx('analytics.contpaqi_ledger_monthly')
        .where({ tenant_id: tenantId, anio_mes: period })
        .andWhere((q: any) => q.where('cuenta', 'like', '212%').orWhere('cuenta', 'like', '50%'))
        .select('cuenta', 'cuenta_nombre', 'saldo_ini', 'cargos', 'abonos');
      const movByCuenta = new Map<string, any>((periodMov as any[]).map((m) => [m.cuenta, m]));
      const costoRich = (periodMov as any[]).filter((m) => String(m.cuenta).startsWith('50')).map((m) => ({ ...m, tokens: nameTokens(m.cuenta_nombre) }));

      const rows = [...byProv.values()].map((p) => {
        const tk = nameTokens(p.proveedor);
        let cxp: any = null, cxpScore = 0;
        for (const c of cxpRich) { const sc = nameScore(tk, c.tokens); if (sc >= 0.6 && sc > cxpScore) { cxpScore = sc; cxp = c; } }
        const mov = cxp ? movByCuenta.get(cxp.cuenta) : null;
        let costoCargos = 0, costoCtas = 0;
        for (const c of costoRich) { if (nameScore(tk, c.tokens) >= 0.6) { costoCargos += n(c.cargos); costoCtas++; } }
        return {
          proveedor: p.proveedor, excel_in: r2(p.excel_in), excel_out: r2(p.excel_out), movs: p.movs,
          cxp_cuenta: cxp?.cuenta ?? null, cxp_nombre: cxp ? cxp.nombre : null,
          cxp_saldo_ini: mov ? r2(n(mov.saldo_ini)) : 0, cxp_cargos: mov ? r2(n(mov.cargos)) : 0, cxp_abonos: mov ? r2(n(mov.abonos)) : 0,
          costo_cargos: r2(costoCargos), costo_cuentas: costoCtas,
          match_score: r2(cxpScore), matched: !!cxp || costoCtas > 0,
        };
      }).sort((a, b) => b.excel_out - a.excel_out);

      const tot = rows.reduce((s, r) => ({
        excel_in: s.excel_in + r.excel_in, excel_out: s.excel_out + r.excel_out,
        costo_cargos: s.costo_cargos + r.costo_cargos,
      }), { excel_in: 0, excel_out: 0, costo_cargos: 0 });

      return {
        period, proveedores: rows.length, matched: rows.filter((r) => r.matched).length, rows,
        totals: { excel_in: r2(tot.excel_in), excel_out: r2(tot.excel_out), costo_cargos: r2(tot.costo_cargos) },
      };
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
        b.whereNull('bm.deleted_at'); // CB.23.3 — oculta filas barridas del Sheet
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
      // El folio REAL conciliado (leftJoin solo en las filas, no en el count: runMatch
      // parea 1:1, así que a lo más hay un match por movimiento). Esto distingue la
      // "regla contable" (mc.kepler_account) del cruce verificado (rm.kepler_doc_folio).
      const rows = await base()
        // CB.27 — un movimiento puede tener N matches (pase agrupado 1:N); DISTINCT ON deja
        // uno representativo (el de mayor monto) para no duplicar filas del grid.
        .leftJoin(trx.raw(`(SELECT DISTINCT ON (bank_movement_id) bank_movement_id, kepler_doc_tipo, kepler_doc_folio
             FROM finance.bank_recon_matches ORDER BY bank_movement_id, kepler_amount DESC NULLS LAST) as rm`),
          'rm.bank_movement_id', 'bm.id')
        .select('bm.id', 'bm.movement_date', 'ba.bank', 'ba.account_label', 'bm.bank_account_id',
          'bm.category_id', 'mc.code as category_code', 'mc.name as category_name', 'mc.group_key',
          'mc.kepler_account', 'bm.raw_type', 'bm.raw_code', 'bm.sucursal', 'bm.concept',
          'bm.amount_in', 'bm.amount_out', 'bm.running_balance', 'bm.recon_status',
          'rm.kepler_doc_tipo', 'rm.kepler_doc_folio')
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
   * CB.15.2 — Flujo de UN movimiento ("de dónde viene"). Para un PAGO: su cadena
   * compra→recepción→factura→pago (analytics.expense_doc_chain) + mini-cuadre banco
   * vs Kepler 102 de ese proveedor en el mes. Para un DEPÓSITO (cobranza): cómo lo
   * tiene Kepler (partido en pólizas UA0501). El match por beneficiario reusa el mismo
   * scoring de nombres del matcher (tokens significativos ≥0.5) → contexto honesto, NO
   * un cruce 1:1 exacto (eso se declara en la nota).
   */
  async movementFlow(id: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!id) throw new BadRequestException('id requerido');
    return this.tk.run(async (trx) => {
      const m = await trx('finance.bank_movements as bm')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .leftJoin('finance.bank_recon_matches as rm', 'rm.bank_movement_id', 'bm.id')
        .where('bm.id', id).whereNull('bm.deleted_at')
        .select('bm.id', 'bm.movement_date', 'ba.bank', 'ba.account_label', 'bm.concept',
          'bm.raw_type', 'bm.raw_code', 'bm.sucursal', 'bm.amount_in', 'bm.amount_out', 'bm.recon_status',
          'mc.name as category_name', 'mc.group_key', 'mc.kepler_account',
          'rm.kepler_doc_tipo', 'rm.kepler_doc_folio', 'st.period')
        .first();
      if (!m) throw new BadRequestException('movimiento no encontrado');

      const period: string = m.period;
      const fmt = (v: number) => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
      const esRetiro = n(m.amount_out) > 0;
      const movement = {
        id: m.id, fecha: m.movement_date, bank: m.bank, account_label: m.account_label,
        concept: m.concept, raw_type: m.raw_type, raw_code: m.raw_code, sucursal: m.sucursal,
        categoria: m.category_name, grupo: m.group_key, kepler_account: m.kepler_account,
        es_retiro: esRetiro, monto: esRetiro ? n(m.amount_out) : n(m.amount_in),
        recon_status: m.recon_status,
        kepler_folio: m.kepler_doc_folio ? `${m.kepler_doc_tipo || ''} ${m.kepler_doc_folio}`.trim() : null,
      };

      const tok = nameTokens(m.concept);
      const strongest = tok.size ? [...tok].sort((a, b) => b.length - a.length)[0] : null;
      // Match por SOLAPAMIENTO de tokens como substring (no set-equality): exige ≥2
      // tokens del movimiento presentes en la contraparte (o ≥1 si solo hay 1 token
      // significativo). Cacha "Tlmk"⊂"TLMKT" y plaza (Morelia) juntos → incluye "TLMKT
      // Morelia", excluye "RD Morelia" (solo comparte plaza). Más preciso que nameScore
      // para el cross-naming banco(vendedor)↔Kepler(plaza), y preserva proveedores (Mondelez).
      const normCp = (s: any) => normKey(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
      const need = Math.min(2, tok.size);
      const matchCp = (contraparte: any): boolean => {
        if (!tok.size) return false;
        const c = normCp(contraparte);
        let hits = 0;
        for (const t of tok) if (c.includes(t)) hits++;
        return hits >= need;
      };
      const [yy, mm] = period.split('-').map(Number);
      const ini = `${period}-01`;
      const fin = mm >= 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;

      // DEPÓSITO (cobranza): cómo Kepler lo tiene (repartido por venta).
      if (!esRetiro) {
        let cobranza = { kepler_movs: 0, kepler_suma: 0 };
        let docs: any[] = [];
        if (strongest) {
          const rows = await trx('analytics.bank_postings')
            .where({ tenant_id: tenantId, anio_mes: period, cargo_abono: 'C' })
            .whereILike('contraparte', `%${strongest}%`)
            .select('doc_tipo', 'folio', 'fecha', 'importe', 'contraparte', 'forma')
            .orderBy([{ column: 'fecha' }, { column: 'folio' }]);
          const match = (rows as any[]).filter((r) => matchCp(r.contraparte));
          cobranza = { kepler_movs: match.length, kepler_suma: Math.round(match.reduce((s, r) => s + n(r.importe), 0) * 100) / 100 };
          docs = match.slice(0, 500).map((r) => ({ doc_tipo: r.doc_tipo, folio: r.folio, fecha: r.fecha, importe: n(r.importe), contraparte: r.contraparte, forma: r.forma }));
        }
        return { period, movement, tipo: 'deposito', proveedor: null, cadena: [], cobranza, docs,
          nota: cobranza.kepler_movs
            ? `Es cobranza. El banco lo registra como UN depósito; en Kepler está repartido en ${cobranza.kepler_movs} pólizas de cobranza (ventas cobradas) este mes (suman ${fmt(cobranza.kepler_suma)}). Abajo están los folios individuales. Por eso no hay una línea con este monto exacto en Kepler — se cuadra por total, no 1 a 1.`
            : 'Es cobranza (un depósito). Los depósitos no se concilian 1 a 1 contra el 102: el banco los agrupa distinto que Kepler. Se cuadran por total.' };
      }

      // PAGO: cadena del proveedor en el mes + mini-cuadre banco vs Kepler.
      let cadena: any[] = [];
      let proveedor: any = null;
      let docs: any[] = [];
      if (strongest) {
        const chainRows = await trx('analytics.expense_doc_chain')
          .where('tenant_id', tenantId)
          .whereILike('beneficiario', `%${strongest}%`)
          .whereRaw('factura_fecha >= ? AND factura_fecha < ?', [ini, fin])
          .select('factura_folio', 'factura_fecha', 'orden_folio', 'recepcion_folio', 'pago_folio', 'pago_fecha', 'beneficiario', 'total', 'lead_days', 'pago_days', 'match_confidence')
          .orderBy('total', 'desc').limit(20);
        cadena = (chainRows as any[]).filter((r) => nameScore(tok, nameTokens(r.beneficiario)) >= 0.5)
          .slice(0, 12).map((r) => ({ ...r, total: n(r.total) }));

        const bankRows = await trx('finance.bank_movements as bm')
          .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
          .where('st.period', period).where('bm.amount_out', '>', 0).whereNull('bm.deleted_at')
          .whereILike('bm.concept', `%${strongest}%`)
          .select('bm.concept', 'bm.amount_out');
        const bankMatch = (bankRows as any[]).filter((r) => matchCp(r.concept));
        const keplerRows = await trx('analytics.bank_postings')
          .where({ tenant_id: tenantId, anio_mes: period, cargo_abono: 'A' })
          .whereILike('contraparte', `%${strongest}%`)
          .select('doc_tipo', 'folio', 'fecha', 'contraparte', 'importe', 'forma')
          .orderBy([{ column: 'fecha' }, { column: 'folio' }]);
        const keplerMatch = (keplerRows as any[]).filter((r) => matchCp(r.contraparte));
        proveedor = {
          nombre: cadena[0]?.beneficiario || keplerMatch[0]?.contraparte || m.concept,
          banco_total_mes: Math.round(bankMatch.reduce((s, r) => s + n(r.amount_out), 0) * 100) / 100,
          banco_movs: bankMatch.length,
          kepler_total_mes: Math.round(keplerMatch.reduce((s, r) => s + n(r.importe), 0) * 100) / 100,
          kepler_movs: keplerMatch.length,
        };
        docs = keplerMatch.slice(0, 500).map((r) => ({ doc_tipo: r.doc_tipo, folio: r.folio, fecha: r.fecha, importe: n(r.importe), contraparte: r.contraparte, forma: r.forma }));
      }
      return { period, movement, tipo: 'pago', proveedor, cadena, cobranza: null, docs,
        nota: cadena.length
          ? 'La cadena de abajo son las compras a este proveedor en el mes (orden → recepción → factura → pago) según Kepler: de ahí viene el pago. Abajo también están los folios de pago del 102. Es el contexto del proveedor, no un cruce 1 a 1 exacto con este retiro.'
          : 'No se encontró cadena de compra para este beneficiario en el mes. Puede ser un gasto o servicio (no compra de mercancía), o el nombre no coincide con el catálogo de proveedores. Abajo, si hay, los folios de pago del 102.' };
    });
  }

  /**
   * CB.16 — Comparador lado a lado Excel ↔ Kepler. Devuelve las dos listas del
   * periodo (movimientos del banco / pólizas del 102) con una `match_key` común
   * (`doc_tipo|folio`) para enlazar la selección en el frontend: al elegir un
   * movimiento de un lado se resalta y salta su contraparte en el otro. Los que no
   * casaron traen match_key null (Excel) o sin fila espejo (Kepler) → "sin contraparte".
   */
  async sideBySide(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const excel = await trx('finance.bank_movements as bm')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .leftJoin('finance.bank_recon_matches as rm', 'rm.bank_movement_id', 'bm.id')
        .where('st.period', period).whereNull('bm.deleted_at')
        // CB.21 — CAJA GENERAL no es fiscal → fuera del comparador contra el 102 (que es fiscal).
        .whereNot('ba.kind', 'cash')
        .select('bm.id', 'bm.movement_date', 'ba.bank', 'ba.account_label', 'ba.id as account_id', 'bm.concept',
          'bm.raw_type', 'bm.raw_code', 'bm.sucursal', 'mc.group_key', 'mc.name as category_name', 'mc.kepler_account',
          'bm.amount_in', 'bm.amount_out', 'bm.recon_status',
          'rm.kepler_doc_tipo', 'rm.kepler_doc_folio')
        .orderBy([{ column: 'bm.movement_date' }, { column: 'bm.id' }]);

      const kepler = await trx('analytics.bank_postings as p')
        .leftJoin('finance.bank_recon_matches as rm', function () {
          this.on('rm.kepler_doc_tipo', 'p.doc_tipo').andOn('rm.kepler_doc_folio', 'p.folio');
        })
        .where({ 'p.tenant_id': tenantId, 'p.anio_mes': period })
        .select('p.doc_tipo', 'p.folio', 'p.fecha', 'p.cargo_abono', 'p.importe', 'p.contraparte', 'p.forma', 'rm.bank_movement_id')
        .orderBy([{ column: 'p.fecha' }, { column: 'p.folio' }]);

      return {
        period,
        excel: (excel as any[]).map((r) => ({
          id: r.id, fecha: r.movement_date, cuenta: `${r.bank} ${r.account_label}`.trim(), account_id: r.account_id,
          concepto: r.concept, tipo: r.raw_type, codigo: r.raw_code, sucursal: r.sucursal,
          grupo: r.group_key, categoria: r.category_name, kepler_account: r.kepler_account,
          entra: n(r.amount_in), sale: n(r.amount_out), recon_status: r.recon_status,
          match_key: r.kepler_doc_folio ? `${r.kepler_doc_tipo || ''}|${r.kepler_doc_folio}` : null,
        })),
        kepler: (kepler as any[]).map((r) => ({
          doc_tipo: r.doc_tipo, folio: r.folio, fecha: r.fecha, cargo_abono: r.cargo_abono,
          importe: n(r.importe), contraparte: r.contraparte, forma: r.forma,
          bank_movement_id: r.bank_movement_id || null,
          match_key: `${r.doc_tipo || ''}|${r.folio}`,
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
        .where('st.period', period).whereNull('bm.deleted_at')
        // Agrupa por la columna cruda (nullable); el COALESCE del SELECT deriva de
        // ella y Postgres lo acepta. NO agrupar por el COALESCE con binding: el
        // literal del SELECT y el $ del GROUP BY no matchean → 42803 (visto en prod).
        .groupBy('ba.id', 'ba.bank', 'ba.account_label', 'ba.alias', 'ba.kind', 'mc.group_key')
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
        .update({ category_id: catId, classified_by: 'manual', updated_at: trx.fn.now() })
        .returning(['id', 'category_id']);
      if (!row) throw new BadRequestException('movimiento no encontrado');
      this.logger.log(`movimiento ${id} reclasificado → ${catId || 'sin_clasificar'} por ${actor || '?'}`);
      return row;
    });
  }

  // ── CB.6 — Admin: catálogo (cuentas + categorías) y reglas de clasificación ──

  /** Alta de cuenta de banco/caja/factoraje. */
  async createAccount(body: any, actor?: string) {
    this.tenantCtx.requireTenantId();
    const bank = String(body?.bank || '').trim();
    const account_label = String(body?.account_label || '').trim();
    if (!bank || !account_label) throw new BadRequestException('bank y account_label requeridos');
    const kind = ['bank', 'cash', 'factoraje'].includes(body?.kind) ? body.kind : 'bank';
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.bank_accounts')
        .insert({ bank, account_label, alias: body?.alias?.trim() || null, kind, kepler_link: body?.kepler_link?.trim() || null })
        .onConflict(['tenant_id', 'bank', 'account_label']).merge(['alias', 'kind', 'kepler_link', 'updated_at'])
        .returning('*');
      this.logger.log(`cuenta ${bank} ${account_label} guardada por ${actor || '?'}`);
      return row;
    });
  }

  /** Edita una cuenta (alias/kepler_link/kind/active). */
  async updateAccount(id: string, body: any) {
    this.tenantCtx.requireTenantId();
    const patch: any = { updated_at: undefined };
    if (body?.alias !== undefined) patch.alias = body.alias?.trim() || null;
    if (body?.kepler_link !== undefined) patch.kepler_link = body.kepler_link?.trim() || null;
    if (body?.kind !== undefined && ['bank', 'cash', 'factoraje'].includes(body.kind)) patch.kind = body.kind;
    if (body?.active !== undefined) patch.active = !!body.active;
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.bank_accounts').where({ id })
        .update({ ...patch, updated_at: trx.fn.now() }).returning('*');
      if (!row) throw new BadRequestException('cuenta no encontrada');
      return row;
    });
  }

  /** Alta de categoría del catálogo limpio. */
  async createCategory(body: any, actor?: string) {
    this.tenantCtx.requireTenantId();
    const code = String(body?.code || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const name = String(body?.name || '').trim();
    const group_key = String(body?.group_key || '').trim();
    const flow = ['in', 'out', 'both', 'none'].includes(body?.flow) ? body.flow : 'out';
    if (!code || !name || !group_key) throw new BadRequestException('code, name y group_key requeridos');
    return this.tk.run(async (trx) => {
      const maxSort = Number((await trx('finance.movement_categories').max('sort_order as m').first())?.m || 0);
      const [row] = await trx('finance.movement_categories')
        .insert({ code, name, flow, group_key, kepler_account: body?.kepler_account?.trim() || null,
          kepler_note: body?.kepler_note?.trim() || null, sort_order: maxSort + 10 })
        .onConflict(['tenant_id', 'code'])
        .merge(['name', 'flow', 'group_key', 'kepler_account', 'kepler_note', 'updated_at'])
        .returning('*');
      this.logger.log(`categoría ${code} guardada por ${actor || '?'}`);
      return row;
    });
  }

  /** Edita una categoría (name/kepler_account/group_key/flow/active). */
  async updateCategory(id: string, body: any) {
    this.tenantCtx.requireTenantId();
    const patch: any = {};
    if (body?.name !== undefined) patch.name = String(body.name).trim();
    if (body?.kepler_account !== undefined) patch.kepler_account = body.kepler_account?.trim() || null;
    if (body?.kepler_note !== undefined) patch.kepler_note = body.kepler_note?.trim() || null;
    if (body?.group_key !== undefined) patch.group_key = String(body.group_key).trim();
    if (body?.flow !== undefined && ['in', 'out', 'both', 'none'].includes(body.flow)) patch.flow = body.flow;
    if (body?.active !== undefined) patch.active = !!body.active;
    if (!Object.keys(patch).length) throw new BadRequestException('nada que actualizar');
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.movement_categories').where({ id })
        .update({ ...patch, updated_at: trx.fn.now() }).returning('*');
      if (!row) throw new BadRequestException('categoría no encontrada');
      return row;
    });
  }

  /** Lista las reglas de clasificación (por prioridad). */
  async rules() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      return trx('finance.bank_classify_rules as r')
        .leftJoin('finance.movement_categories as mc', function () {
          this.on('mc.code', 'r.category_code');
        })
        .select('r.id', 'r.priority', 'r.match_type', 'r.match_code', 'r.match_concept',
          'r.category_code', 'mc.name as category_name', 'mc.group_key', 'r.note', 'r.active')
        .orderBy('r.priority');
    });
  }

  /** Valida que los patrones sean regex legales y la categoría exista. */
  private async validateRule(trx: any, body: any) {
    for (const key of ['match_type', 'match_code', 'match_concept']) {
      const p = body?.[key];
      if (p) { try { new RegExp(p, 'i'); } catch { throw new BadRequestException(`regex inválida en ${key}`); } }
    }
    const category_code = String(body?.category_code || '').trim();
    if (!category_code) throw new BadRequestException('category_code requerido');
    const cat = await trx('finance.movement_categories').where({ code: category_code }).first('code');
    if (!cat) throw new BadRequestException(`categoría "${category_code}" no existe`);
    if (!body?.match_type && !body?.match_code && !body?.match_concept)
      throw new BadRequestException('al menos un matcher (tipo/código/concepto) requerido');
    return category_code;
  }

  /** Alta de regla de clasificación. */
  async createRule(body: any, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const category_code = await this.validateRule(trx, body);
      let priority = Number(body?.priority);
      if (!Number.isFinite(priority)) priority = Number((await trx('finance.bank_classify_rules').max('priority as m').first())?.m || 0) + 10;
      const [row] = await trx('finance.bank_classify_rules')
        .insert({ priority, match_type: body?.match_type?.trim() || null, match_code: body?.match_code?.trim() || null,
          match_concept: body?.match_concept?.trim() || null, category_code, note: body?.note?.trim() || null })
        .onConflict(['tenant_id', 'priority'])
        .merge(['match_type', 'match_code', 'match_concept', 'category_code', 'note', 'active', 'updated_at'])
        .returning('*');
      this.logger.log(`regla p${priority} → ${category_code} guardada por ${actor || '?'}`);
      return row;
    });
  }

  /** Edita una regla. */
  async updateRule(id: string, body: any) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const patch: any = {};
      if (body?.category_code !== undefined || body?.match_type !== undefined || body?.match_code !== undefined || body?.match_concept !== undefined) {
        const current = await trx('finance.bank_classify_rules').where({ id }).first();
        if (!current) throw new BadRequestException('regla no encontrada');
        const merged = { ...current, ...body };
        patch.category_code = await this.validateRule(trx, merged);
        patch.match_type = merged.match_type?.trim() || null;
        patch.match_code = merged.match_code?.trim() || null;
        patch.match_concept = merged.match_concept?.trim() || null;
      }
      if (body?.priority !== undefined && Number.isFinite(Number(body.priority))) patch.priority = Number(body.priority);
      if (body?.note !== undefined) patch.note = body.note?.trim() || null;
      if (body?.active !== undefined) patch.active = !!body.active;
      if (!Object.keys(patch).length) throw new BadRequestException('nada que actualizar');
      const [row] = await trx('finance.bank_classify_rules').where({ id })
        .update({ ...patch, updated_at: trx.fn.now() }).returning('*');
      if (!row) throw new BadRequestException('regla no encontrada');
      return row;
    });
  }

  /** Elimina una regla. */
  async deleteRule(id: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const n = await trx('finance.bank_classify_rules').where({ id }).del();
      if (!n) throw new BadRequestException('regla no encontrada');
      return { deleted: n };
    });
  }

  /**
   * CB.6 — Re-aplica las reglas a los movimientos ya importados (tras editarlas).
   * Respeta el override manual: NO toca filas con classified_by='manual'. Opcional
   * `period` para acotar. Devuelve cuántas cambiaron de categoría.
   */
  async reclassifyAll(period?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const compiled = compileRules(
        await trx('finance.bank_classify_rules').where({ active: true })
          .select('priority', 'match_type', 'match_code', 'match_concept', 'category_code'));
      const catMap = new Map<string, string>(
        (await trx('finance.movement_categories').select('id', 'code')).map((r: any) => [r.code, r.id]));

      const q = trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('bm.classified_by', 'rule').whereNull('bm.deleted_at');
      if (period) q.where('st.period', period);
      const movs = await q.select('bm.id', 'bm.raw_type', 'bm.raw_code', 'bm.concept', 'bm.category_id');

      let changed = 0; const updates: Record<string, string[]> = {};
      for (const m of movs as any[]) {
        const code = classifyWith(compiled, m.raw_type, m.raw_code, m.concept);
        const newCat = code === 'sin_clasificar' ? null : (catMap.get(code) || null);
        if ((newCat || null) !== (m.category_id || null)) {
          const key = newCat || '__null__';
          (updates[key] ||= []).push(m.id);
          changed++;
        }
      }
      for (const [key, ids] of Object.entries(updates)) {
        const catId = key === '__null__' ? null : key;
        for (let i = 0; i < ids.length; i += 500)
          await trx('finance.bank_movements').whereIn('id', ids.slice(i, i + 500))
            .update({ category_id: catId, updated_at: trx.fn.now() });
      }
      this.logger.log(`reclassifyAll ${period || 'todos'}: ${changed}/${movs.length} recategorizados`);
      return { scanned: movs.length, changed };
    });
  }

  /**
   * CB.4.2 — Diferencias de conciliación: lo que NO casó, rankeado por monto (accionable).
   * Requiere haber corrido runMatch (usa recon_status + bank_recon_matches).
   */
  async differences(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      // Retiros del banco sin casar (TODOS, con su categoría) — rankeados por monto.
      const bank = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).where('bm.amount_out', '>', 0).where('bm.recon_status', 'unmatched').whereNull('bm.deleted_at')
        .select('bm.id', 'bm.movement_date', 'bm.amount_out', 'bm.concept', 'bm.raw_code', 'bm.raw_type',
          'mc.name as category_name', 'mc.group_key', 'mc.kepler_account')
        .orderBy('bm.amount_out', 'desc');

      // Pagos del 102 en Kepler sin casar (TODOS, no referenciados por ningún match).
      const kepler = await trx('analytics.bank_postings as p')
        .where({ 'p.tenant_id': tenantId, 'p.anio_mes': period, 'p.cargo_abono': 'A' })
        .whereNotExists(function () {
          this.select(trx.raw('1')).from('finance.bank_recon_matches as m')
            .whereRaw('m.kepler_doc_tipo = p.doc_tipo AND m.kepler_doc_folio = p.folio');
        })
        .select('p.doc_tipo', 'p.folio', 'p.fecha', 'p.importe', 'p.contraparte')
        .orderBy('p.importe', 'desc');

      const bankRows = bank.map((r: any) => ({ ...r, amount_out: n(r.amount_out) }));
      const keplerRows = kepler.map((r: any) => ({ ...r, importe: n(r.importe) }));
      return {
        period,
        bank_unmatched: bankRows,
        kepler_unmatched: keplerRows,
        bank_total: { count: bankRows.length, amount: bankRows.reduce((s: number, r: any) => s + r.amount_out, 0) },
        kepler_total: { count: keplerRows.length, amount: keplerRows.reduce((s: number, r: any) => s + r.importe, 0) },
      };
    });
  }

  /**
   * CB.8 — Cuadre de saldos: el chequeo de integridad más fuerte del estado de
   * cuenta. Por cuenta: saldo_inicial + depósitos − retiros == saldo_final.
   * Δ ≠ 0 ⇒ falta capturar un movimiento o el saldo está mal tecleado. Más el
   * check TI=TE (traspasos internos: lo que sale de una cuenta entra en otra →
   * depósitos de traspaso ≈ retiros de traspaso en la red).
   */
  async balances(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_statements as st')
        .join('finance.bank_accounts as ba', 'ba.id', 'st.bank_account_id')
        .where('st.period', period)
        .select('st.id', 'ba.bank', 'ba.account_label', 'ba.kind',
          'st.opening_balance', 'st.closing_balance', 'st.total_in', 'st.total_out')
        .orderBy([{ column: 'ba.kind' }, { column: 'ba.bank' }, { column: 'ba.account_label' }]);

      const accounts = (rows as any[]).map((r) => {
        const opening = n(r.opening_balance), closing = n(r.closing_balance);
        const computed = Math.round((opening + n(r.total_in) - n(r.total_out)) * 100) / 100;
        const delta = Math.round((computed - closing) * 100) / 100;
        return {
          statement_id: r.id, bank: r.bank, account_label: r.account_label, kind: r.kind,
          opening, total_in: n(r.total_in), total_out: n(r.total_out),
          computed_closing: computed, closing, delta,
          cuadra: Math.abs(delta) < 1 && (opening !== 0 || closing !== 0),
          sin_saldo: opening === 0 && closing === 0,
        };
      });

      // TI=TE: traspasos internos deben netear en la red (depósitos ≈ retiros). CB.13.1 —
      // el cuadre se mide SOLO sobre los marcadores reales de traspaso interno (raw_type
      // TI/TE), no sobre toda la categoría 'traspaso': movimientos S (Spei) o G que caen
      // mal clasificados ahí contaminaban el neto con un descuadre falso (era misclasificación,
      // no un lado faltante — los TI/TE reales netean exacto a 0).
      const tr = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).whereIn('bm.raw_type', ['TI', 'TE']).whereNull('bm.deleted_at')
        .select(trx.raw('SUM(bm.amount_in)::numeric AS entra'), trx.raw('SUM(bm.amount_out)::numeric AS sale'))
        .first();
      const traspasos = { entra: n((tr as any)?.entra), sale: n((tr as any)?.sale), delta: Math.round((n((tr as any)?.entra) - n((tr as any)?.sale)) * 100) / 100 };

      const totals = accounts.reduce((t, a) => ({
        opening: t.opening + a.opening, total_in: t.total_in + a.total_in, total_out: t.total_out + a.total_out,
        closing: t.closing + a.closing, descuadre: t.descuadre + (a.cuadra || a.sin_saldo ? 0 : Math.abs(a.delta)),
      }), { opening: 0, total_in: 0, total_out: 0, closing: 0, descuadre: 0 });

      return { period, accounts, traspasos, totals,
        cuentas_descuadradas: accounts.filter((a) => !a.cuadra && !a.sin_saldo).length,
        cuentas_sin_saldo: accounts.filter((a) => a.sin_saldo).length };
    });
  }

  /**
   * CB.9 — Diagnóstico "¿por qué no cuadra y qué falta?". Agregador legible que
   * consolida todas las fuentes de descuadre en una lista accionable (cada ítem:
   * qué es, monto, y qué falta hacer). Reúsa balances + reconciliation + conteos;
   * no lee data nueva. Es la pestaña que traduce lo técnico a "esto te falta".
   */
  /** Fecha (Date o 'YYYY-MM-DD') → 'DD/MM' con componentes locales (sin voltear a UTC). */
  private dm(v: any): string {
    if (v instanceof Date && !isNaN(v.getTime())) return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}`;
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}` : String(v ?? '');
  }

  async diagnostico(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const money = (v: number) => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

    // Totales de la tabla (ingresos/egresos) + sin_clasificar + cuentas sin estado de cuenta.
    const { totales, sinClas, sinClasBuckets, cuentasSinEstado, matchedCount, keplerPostingsCount } = await this.tk.run(async (trx) => {
      const t = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).whereNull('bm.deleted_at')
        .select(trx.raw('SUM(bm.amount_in)::numeric AS ingresos'), trx.raw('SUM(bm.amount_out)::numeric AS egresos'), trx.raw('COUNT(*)::int AS movs'))
        .first();
      const sc = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).whereNull('bm.category_id').whereNull('bm.deleted_at')
        .select(trx.raw('COUNT(*)::int AS n'), trx.raw('SUM(bm.amount_in + bm.amount_out)::numeric AS monto')).first();
      // Los grupos que más pesan del sin_clasificar (código + concepto) → qué regla agregar.
      const scb = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).whereNull('bm.category_id').whereNull('bm.deleted_at')
        .groupByRaw(`COALESCE(NULLIF(bm.raw_code,''),'—'), LEFT(UPPER(COALESCE(bm.concept,'')), 28)`)
        .select(trx.raw(`COALESCE(NULLIF(bm.raw_code,''),'—') AS code`),
          trx.raw(`LEFT(UPPER(COALESCE(bm.concept,'')), 28) AS concepto`),
          trx.raw('COUNT(*)::int AS n'), trx.raw('SUM(bm.amount_in + bm.amount_out)::numeric AS monto'))
        .orderByRaw('SUM(bm.amount_in + bm.amount_out) DESC').limit(6);
      // Cuentas activas sin estado de cuenta cargado este periodo (p.ej. CAJA GENERAL no importable).
      const missing = await trx('finance.bank_accounts as ba')
        .where('ba.active', true)
        .whereNotExists(function () { this.select(trx.raw('1')).from('finance.bank_statements as st').whereRaw('st.bank_account_id = ba.id AND st.period = ?', [period]); })
        .select('ba.bank', 'ba.account_label', 'ba.kind');
      // ¿Ya corrió la conciliación por-transacción? Si 0 casados, la evidencia dirá
      // "sin casar en Kepler" en TODO → engañoso (parece que falta en Kepler cuando
      // en realidad no se ha pareado). Avisamos que corra "Conciliar" primero.
      const mc = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).where('bm.recon_status', 'matched').whereNull('bm.deleted_at')
        .count({ n: '*' }).first();
      // ¿Hay pólizas del 102 de Kepler cargadas para el periodo? (feed analytics.bank_postings,
      // sin RLS → tenant explícito). Sin ellas el matching NO puede correr en absoluto.
      const kp = await trx('analytics.bank_postings')
        .where({ tenant_id: tenantId, anio_mes: period }).count({ n: '*' }).first();
      return { totales: t, sinClas: sc, sinClasBuckets: scb, cuentasSinEstado: missing,
        matchedCount: n((mc as any)?.n), keplerPostingsCount: n((kp as any)?.n) };
    });

    const bal = await this.balances(period);
    let recon: any = null;
    try { recon = await this.reconciliation(period); } catch { recon = null; }

    const ingresos = n((totales as any)?.ingresos), egresos = n((totales as any)?.egresos);
    const items: any[] = [];

    // 1. Movimientos sin clasificar (+ evidencia: los grupos que más pesan = qué regla agregar).
    if (n((sinClas as any)?.n) > 0) {
      const evidencia = (sinClasBuckets as any[]).map((b) => ({
        label: `Cód ${b.code} · "${String(b.concepto || '').trim() || '(sin concepto)'}…"`,
        count: Number(b.n), monto: n(b.monto),
      }));
      items.push({ tipo: 'sin_clasificar', severidad: 'warn', importe: n((sinClas as any)?.monto),
        titulo: `${(sinClas as any).n} movimientos sin clasificar`,
        detalle: `Hay ${money(n((sinClas as any)?.monto))} sin categoría asignada. No entran a ningún grupo del cuadre. Los grupos de abajo son los que más pesan.`,
        accion: 'Por ahora la clasificación no se edita aquí. En Kepler, busca cada movimiento por monto + fecha en el auxiliar del 102: la contracuenta te dice su naturaleza. Si no está registrado, captúralo en la cuenta correcta.',
        evidencia });
    }
    // 2. Cuentas cuyo saldo no cuadra (+ evidencia: el renglón donde el saldo salta).
    for (const a of bal.accounts.filter((x: any) => !x.cuadra && !x.sin_saldo)) {
      items.push({ tipo: 'saldo_no_cuadra', severidad: Math.abs(a.delta) >= 100000 ? 'bad' : 'warn', importe: Math.abs(a.delta),
        titulo: `${a.bank} ${a.account_label}: el saldo no cierra`,
        detalle: `Inicial ${money(a.opening)} + ingresos ${money(a.total_in)} − egresos ${money(a.total_out)} = ${money(a.computed_closing)}, pero el saldo final es ${money(a.closing)} (Δ ${money(a.delta)}).`,
        accion: 'Falta capturar un movimiento en esta cuenta, o el saldo está mal tecleado. Revisa el/los renglón(es) de abajo: ahí el saldo del estado de cuenta salta más de lo que explica el movimiento.',
        _statementId: a.statement_id, _opening: a.opening });
    }
    // 3. Cuentas sin estado de cuenta cargado (CAJA GENERAL, etc.).
    for (const c of cuentasSinEstado as any[]) {
      items.push({ tipo: 'cuenta_sin_cargar', severidad: 'warn', importe: 0,
        titulo: `${c.bank} ${c.account_label}: sin cargar`,
        detalle: `La cuenta existe en el catálogo pero no tiene estado de cuenta en ${period}.${c.kind === 'cash' ? ' (CAJA GENERAL tiene un layout de columnas distinto — pendiente de soportar.)' : ''}`,
        accion: 'Sube su estado de cuenta del periodo, o desactívala en Admin si ya no aplica.' });
    }
    // 4. Traspasos internos que no netean (TI=TE).
    if (Math.abs(bal.traspasos.delta) >= 1000) {
      items.push({ tipo: 'traspaso_descuadre', severidad: 'warn', importe: Math.abs(bal.traspasos.delta),
        titulo: 'Los traspasos internos no netean',
        detalle: `Entra ${money(bal.traspasos.entra)} vs sale ${money(bal.traspasos.sale)} en traspasos entre cuentas propias (Δ ${money(bal.traspasos.delta)}). Deberían ser iguales.`,
        accion: 'Falta el otro lado de un traspaso (la cuenta destino o la de origen). Revisa los movimientos tipo TI/TE.' });
    }
    // 5. Diferencias vs Kepler (P&L) — solo si hay balanza. Dirección + causa concreta.
    if (recon?.accounts?.length) {
      for (const a of recon.accounts.filter((x: any) => Math.abs(n(x.delta)) >= 10000)) {
        const delta = n(a.delta), abs = Math.abs(delta);
        const keplerMas = delta < 0; // book (mayor) > banco (pagado)
        const detalle = keplerMas
          ? `Kepler registra ${money(a.book)} de gasto en el mayor ${a.kepler_account} («${a.concept}»), pero por banco solo salieron ${money(a.bank)}: hay ${money(abs)} MÁS reconocido en Kepler que pagado por banco.`
          : `Por banco salieron ${money(a.bank)} en «${a.concept}», pero Kepler solo registra ${money(a.book)} en el mayor ${a.kepler_account}: el banco pagó ${money(abs)} MÁS de lo que Kepler reconoce.`;
        const accion = keplerMas
          ? `Kepler YA reconoció este gasto; el banco todavía no lo paga. Normalmente NO se corrige en Kepler — es cuenta por pagar. Pasos: (1) en Kepler abre el auxiliar del mayor ${a.kepler_account} y saca las facturas SIN pago aplicado (esas explican el Δ); (2) confirma que el proveedor esté en cuentas por pagar; (3) si YA se pagó, busca el pago en otra cuenta de banco o en factoraje. El detalle de facturas por proveedor está en el módulo Egresos.`
          : `Salió dinero del banco que Kepler no reconoce en el mayor ${a.kepler_account}. Cada renglón de abajo con «sin conciliar en Kepler» es un pago SIN póliza en el 102. Pasos en Kepler, uno por uno: (1) busca la póliza de egreso por beneficiario + monto + fecha; (2) si NO existe, captúrala en el mayor correcto; (3) si existe pero en otra cuenta, reclasifícala. Los renglones que ya muestran folio Kepler están conciliados —esos no se tocan.`;
        items.push({ tipo: 'kepler_pnl', severidad: abs >= 100000 ? 'bad' : 'warn', importe: abs,
          titulo: keplerMas ? `Kepler registra más que el banco: ${a.concept}` : `El banco pagó más que Kepler: ${a.concept}`,
          detalle, accion, _mayor: a.kepler_account });
      }
    }

    // Evidencia con folios/renglones concretos (saldo + Kepler). Un solo tk.run.
    const needsEvidence = items.some((it) => it._statementId || it._mayor);
    if (needsEvidence) {
      await this.tk.run(async (trx) => {
        for (const it of items) {
          // Saldo: recorrer el estado de cuenta y ubicar dónde el saldo salta más que el neto.
          if (it._statementId) {
            const movs = await trx('finance.bank_movements')
              .where({ statement_id: it._statementId }).whereNotNull('running_balance').whereNull('deleted_at')
              .select('movement_date', 'concept', 'amount_in', 'amount_out', 'running_balance')
              .orderBy([{ column: 'movement_date' }, { column: 'id' }]);
            let cum = n(it._opening), prevRes = 0; const breaks: any[] = [];
            for (const m of movs as any[]) {
              cum = Math.round((cum + n(m.amount_in) - n(m.amount_out)) * 100) / 100;
              const res = Math.round((n(m.running_balance) - cum) * 100) / 100;
              const step = Math.round((res - prevRes) * 100) / 100;
              if (Math.abs(step) >= 1) breaks.push({ label: `${this.dm(m.movement_date)} · ${(m.concept || '—').slice(0, 40)}`, monto: step });
              prevRes = res;
            }
            breaks.sort((x, y) => Math.abs(y.monto) - Math.abs(x.monto));
            it.evidencia = breaks.slice(0, 3);
          }
          // Kepler: los pagos del banco de ese mayor (con folio Kepler si están casados).
          if (it._mayor) {
            const rows = await trx('finance.bank_movements as bm')
              .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
              .join('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
              .leftJoin('finance.bank_recon_matches as rm', 'rm.bank_movement_id', 'bm.id')
              .where('st.period', period).where('bm.amount_out', '>', 0).whereNull('bm.deleted_at')
              .whereRaw(`(regexp_split_to_array(mc.kepler_account, '[-/]'))[1] = ?`, [it._mayor])
              .select('bm.movement_date', 'bm.concept', 'bm.amount_out', 'rm.kepler_doc_tipo', 'rm.kepler_doc_folio')
              .orderBy('bm.amount_out', 'desc').limit(6);
            it.evidencia = (rows as any[]).map((r) => ({
              label: `${this.dm(r.movement_date)} · ${(r.concept || '—').slice(0, 40)}`,
              monto: n(r.amount_out),
              folio: r.kepler_doc_folio ? `Kepler ${r.kepler_doc_tipo || ''} ${r.kepler_doc_folio}`.trim() : 'sin conciliar en Kepler',
            }));
          }
        }
      });
    }
    for (const it of items) { delete it._statementId; delete it._opening; delete it._mayor; }

    items.sort((x, y) => (y.importe || 0) - (x.importe || 0));
    const cuadra = items.length === 0; // real issues, antes de meter el aviso informativo
    // Aviso al frente: la evidencia "sin casar en Kepler" solo es confiable si (a) están
    // cargadas las pólizas del 102 de Kepler y (b) ya corrió el matching. Si no, todo
    // sale "sin casar" y parecería que falta en Kepler cuando NO es cierto.
    const conciliacionCorrida = n(matchedCount) > 0;
    const sinPostingsKepler = n(keplerPostingsCount) === 0;
    if (sinPostingsKepler && !!recon?.accounts?.length) {
      items.unshift({ tipo: 'aviso_conciliar', severidad: 'info', importe: 0,
        titulo: 'Faltan las pólizas del 102 de Kepler (no se puede conciliar aún)',
        detalle: 'No hay pólizas del 102 (bancos/caja) de Kepler cargadas para este periodo, así que la conciliación por-transacción no puede correr y toda la evidencia dirá «sin conciliar en Kepler». Eso NO significa que falte en Kepler — todavía no hay con qué cruzar.',
        accion: 'Carga el feed de pólizas 102 del periodo (import-bank-postings) y luego presiona «Conciliar» en la pestaña Conciliación. Recién entonces la evidencia mostrará el folio exacto de Kepler de cada pago.' });
    } else if (!conciliacionCorrida && !!recon?.accounts?.length) {
      items.unshift({ tipo: 'aviso_conciliar', severidad: 'info', importe: 0,
        titulo: 'Corre «Conciliar» primero',
        detalle: 'Las pólizas de Kepler están cargadas pero la conciliación por-transacción no se ha ejecutado este periodo, así que la evidencia de abajo marca todo como «sin conciliar en Kepler». Eso NO significa que falte en Kepler — significa que aún no se parean los pagos.',
        accion: 'Ve a la pestaña Conciliación y presiona «Conciliar». Después, cada renglón mostrará su folio de Kepler cuando exista, y solo los que queden «sin conciliar» serán gaps reales que capturar.' });
    }
    const totalDescuadre = bal.totals.descuadre;
    return {
      period,
      ingresos, egresos, neto: Math.round((ingresos - egresos) * 100) / 100,
      movimientos: n((totales as any)?.movs),
      cuadra,
      cuentas_ok: bal.accounts.filter((a: any) => a.cuadra).length,
      cuentas_total: bal.accounts.length,
      total_descuadre: totalDescuadre,
      // CB.13.1 — la balanza está "cargada" si el 102 de Kepler tiene datos (cargos/abonos),
      // NO si recon.accounts tiene filas: ese array se vació a propósito al eliminar el P&L
      // adivinado, así que atarlo ahí dejaba el banner "balanza no cargada" prendido siempre.
      tiene_balanza_kepler: n(recon?.cash?.kepler_102_cargos) > 0 || n(recon?.cash?.kepler_102_abonos) > 0,
      conciliacion_corrida: conciliacionCorrida,
      kepler_postings_cargados: !sinPostingsKepler,
      items,
    };
  }

  /**
   * CB.7 — Empuja las diferencias de conciliación a la bandeja unificada de Maat
   * (finance.findings) vía FINANCE_FINDINGS_SINK_PORT (@Optional, best-effort).
   * Determinista, sin LLM. Tres reglas:
   *  - banco_retiro_sin_kepler (riesgo): retiro material sin pago 102 en Kepler.
   *  - banco_sin_clasificar (error_captura): monto sin categoría en el periodo.
   *  - banco_pnl_descuadre (riesgo): categoría de gasto vs mayor Kepler fuera de tol.
   * Requiere haber corrido runMatch (usa recon_status). El triage/feedback vive en
   * /finanzas/hallazgos (dedup estable → re-sync actualiza, no duplica).
   */
  async syncFindings(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    if (!this.findingsSink) { this.logger.debug('sink de hallazgos no ligado — syncFindings no-op.'); return { pushed: 0, inserted: 0, skipped: 0 }; }

    const RETIRO_MIN = 50000;   // solo retiros materiales sin casar → hallazgo (evita ruido de comisiones)
    const money = (v: number) => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

    // Retiros del banco sin casar, materiales (con su cuenta/categoría).
    const unmatched = await this.tk.run(async (trx) =>
      trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).where('bm.recon_status', 'unmatched').where('bm.amount_out', '>=', RETIRO_MIN).whereNull('bm.deleted_at')
        .whereRaw(`COALESCE(mc.group_key,'sin_clasificar') NOT IN ('traspaso','ingreso','devolucion')`)
        .select('bm.id', 'bm.movement_date', 'bm.amount_out', 'bm.concept',
          'mc.name as category_name', 'ba.bank', 'ba.account_label')
        .orderBy('bm.amount_out', 'desc'));

    const rc = await this.reconciliation(period);

    const rules: FinanceRuleInput[] = [
      { rule_key: 'banco_retiro_sin_kepler', nombre: 'Retiro bancario sin pago en Kepler', clase: 'riesgo',
        descripcion: 'Retiro material del banco que no casó con ningún pago del 102 en Kepler (monto+fecha). Puede ser timing, pago no contabilizado o salida no soportada.' },
      { rule_key: 'banco_sin_clasificar', nombre: 'Movimientos bancarios sin clasificar', clase: 'error_captura',
        descripcion: 'Monto del estado de cuenta sin categoría asignada en el periodo — pendiente de resolver en la vista de Movimientos.' },
      { rule_key: 'banco_saldo_no_cuadra', nombre: 'Saldo de cuenta no cuadra', clase: 'error_captura',
        descripcion: 'saldo_inicial + depósitos − retiros ≠ saldo_final del estado de cuenta: falta capturar un movimiento o el saldo está mal tecleado.' },
    ];

    const findings: FinanceFindingInput[] = [];

    for (const m of unmatched as any[]) {
      const importe = n(m.amount_out);
      findings.push({
        rule_key: 'banco_retiro_sin_kepler', clase: 'riesgo',
        severity: importe >= 500000 ? 'critical' : 'warn', score: importe >= 500000 ? 0.9 : 0.65,
        titulo: `Retiro sin conciliar ${money(importe)} — ${m.concept || m.bank}`,
        resumen: `Retiro de ${money(importe)} el ${m.movement_date} en ${m.bank} ${m.account_label} (${m.category_name || 'sin clasificar'}) no casó con ningún pago del 102 en Kepler.`,
        entity: { bank_movement_id: m.id, bank: m.bank, account_label: m.account_label, categoria: m.category_name },
        periodo: period, importe,
        evidencia: { movement_date: m.movement_date, concept: m.concept, fuente: 'finance.bank_movements' },
        dedup_key: `banco_retiro_sin_kepler|${m.id}`,
      });
    }

    if (rc.sin_clasificar > 0) {
      findings.push({
        rule_key: 'banco_sin_clasificar', clase: 'error_captura', severity: 'warn', score: 0.5,
        titulo: `${money(rc.sin_clasificar)} sin clasificar en ${period}`,
        resumen: `Hay ${money(rc.sin_clasificar)} en movimientos bancarios sin categoría en ${period}. Resuélvelos en Movimientos para afinar el cuadre.`,
        entity: { periodo: period }, periodo: period, importe: rc.sin_clasificar,
        evidencia: { fuente: 'finance.bank_movements', regla: 'sin category_id' },
        dedup_key: `banco_sin_clasificar|${period}`,
      });
    }

    // CB.13 — banco_pnl_descuadre ELIMINADO: se alimentaba del P&L categoría→mayor
    // adivinado (removido). Generaba hallazgos falsos. La conciliación real es el
    // retiro-sin-casar (arriba) del matching por-transacción.

    // Cuadre de saldos (CB.8): una cuenta cuyo saldo no cierra = movimiento faltante o mal tecleado.
    const bal = await this.balances(period);
    for (const a of bal.accounts as any[]) {
      if (a.cuadra || a.sin_saldo) continue;
      findings.push({
        rule_key: 'banco_saldo_no_cuadra', clase: 'error_captura', severity: Math.abs(a.delta) >= 100000 ? 'critical' : 'warn', score: 0.7,
        titulo: `Saldo no cuadra ${a.bank} ${a.account_label} — Δ ${money(a.delta)}`,
        resumen: `${a.bank} ${a.account_label}: inicial ${money(a.opening)} + depósitos ${money(a.total_in)} − retiros ${money(a.total_out)} = ${money(a.computed_closing)}, pero el saldo final es ${money(a.closing)} (Δ ${money(a.delta)}). Falta un movimiento o el saldo está mal capturado.`,
        entity: { bank: a.bank, account_label: a.account_label, statement_id: a.statement_id }, periodo: period, importe: Math.abs(n(a.delta)),
        evidencia: { opening: a.opening, total_in: a.total_in, total_out: a.total_out, computed_closing: a.computed_closing, closing: a.closing, fuente: 'finance.bank_statements' },
        dedup_key: `banco_saldo_no_cuadra|${period}|${a.statement_id}`,
      });
    }

    if (!findings.length) return { pushed: 0, inserted: 0, skipped: 0 };
    const res = await this.findingsSink.pushFindings(tenantId, findings, rules);
    this.logger.log(`syncFindings ${period}: ${findings.length} → Maat (${res.inserted} nuevos, ${res.skipped} omitidos).`);
    return { pushed: findings.length, ...res };
  }

  /**
   * Colapsa las filas de match por la llave única (bank_movement_id, kepler_doc_tipo,
   * kepler_doc_folio) sumando kepler_amount. El pase agrupado (1 pago = N líneas del
   * 102) puede emitir varias líneas del MISMO folio → sin colapsar, duplican la llave
   * única de finance.bank_recon_matches → duplicate key → 500. Aquí quedan en una fila.
   */
  private collapseMatches(matches: any[]): any[] {
    const m = new Map<string, any>();
    for (const r of matches) {
      const k = `${r.bank_movement_id}|${r.kepler_doc_tipo ?? ''}|${r.kepler_doc_folio ?? ''}`;
      const prev = m.get(k);
      if (prev) { prev.kepler_amount = Number(prev.kepler_amount || 0) + Number(r.kepler_amount || 0); }
      else m.set(k, { ...r });
    }
    return [...m.values()];
  }

  /**
   * CB.27 — Matching v2 por banco contra el feed de tesorería (analytics.kepler_bank_movements).
   * Escala per-cuenta (account_label): casa cada movimiento del banco (retiro Y depósito) contra
   * el documento Kepler de LA MISMA cuenta, misma dirección, por monto+fecha. Muy superior al 102
   * lumped: menos candidatos por banco → exacto confiable, y ahora TAMBIÉN casa depósitos/cobranza
   * (pase agrupado 1 depósito = N cobros). Escribe finance.bank_recon_matches + recon_status.
   */
  async runMatchTreasury(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const cents = (x: number) => Math.round((Number(x) || 0) * 100);
    const days = (a: any, b: any) => Math.abs(Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000));
    const [yy, mm] = period.split('-').map(Number);
    const ini = `${period}-01`;
    const fin = mm >= 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;

    const subsetSum = (arr: number[], target: number, maxN: number): number[] | null => {
      let out: number[] | null = null;
      const dfs = (start: number, rem: number, picked: number[]): void => {
        if (out) return;
        if (rem === 0 && picked.length >= 2) { out = picked.slice(); return; }
        if (picked.length === maxN || rem < 0) return;
        for (let i = start; i < arr.length; i++) { if (arr[i] > rem) continue; picked.push(i); dfs(i + 1, rem - arr[i], picked); picked.pop(); if (out) return; }
      };
      dfs(0, target, []);
      return out;
    };

    const result = await this.tk.run(async (trx) => {
      // Lado banco: movimientos del periodo (retiros Y depósitos) con account_label. Excluye
      // factoraje (no vive en tesorería). dir 'out'=retiro / 'in'=depósito.
      const bankMovs = (await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).whereNull('bm.deleted_at')
        .whereRaw(`COALESCE(mc.group_key,'sin_clasificar') <> 'factoraje'`)
        .whereRaw('(bm.amount_in > 0 OR bm.amount_out > 0)')
        .select('bm.id', 'bm.movement_date', 'bm.amount_in', 'bm.amount_out', 'bm.concept', 'ba.account_label'))
        .map((b: any) => ({ id: b.id, date: b.movement_date, concept: b.concept, label: b.account_label,
          dir: n(b.amount_out) > 0 ? 'out' : 'in', amount: n(b.amount_out) > 0 ? n(b.amount_out) : n(b.amount_in) }));

      // Lado Kepler tesorería: por cuenta + dirección (signo>0=entra, signo<0=sale).
      const kep = (await trx('analytics.kepler_bank_movements')
        .where('tenant_id', tenantId).whereNotNull('account_label')
        .andWhere('fecha_valor', '>=', ini).andWhere('fecha_valor', '<', fin).whereRaw('signo <> 0')
        .select('doc_tipo', 'folio', 'clave_banco', 'account_label', 'importe', 'signo', 'fecha_valor', 'beneficiario'))
        .map((p: any) => ({ doc_tipo: p.doc_tipo, folio: p.folio, clave: p.clave_banco, label: p.account_label,
          importe: n(p.importe), fecha: p.fecha_valor, benef: p.beneficiario, dir: Number(p.signo) > 0 ? 'in' : 'out', used: false }));

      // Índice (cuenta|dir) → { byAmt: Map<cents, kep[]>, all: kep[] }
      const pool = new Map<string, { byAmt: Map<number, any[]>; all: any[] }>();
      for (const p of kep) {
        const key = `${p.label}|${p.dir}`;
        let e = pool.get(key); if (!e) { e = { byAmt: new Map(), all: [] }; pool.set(key, e); }
        e.all.push(p); const c = cents(p.importe); (e.byAmt.get(c) || e.byAmt.set(c, []).get(c))!.push(p);
      }
      const AMT_TOL = 100;
      const candsInTol = (byAmt: Map<number, any[]>, target: number) => {
        const out: any[] = [];
        for (let d = -AMT_TOL; d <= AMT_TOL; d++) { const arr = byAmt.get(target + d); if (arr) for (const p of arr) if (!p.used) out.push(p); }
        return out;
      };

      const matches: any[] = []; const matchedSet = new Set<string>();
      const emit = (mv: any, p: any, conf: number, by: string) => {
        p.used = true; matchedSet.add(mv.id);
        matches.push({ tenant_id: tenantId, bank_movement_id: mv.id, kepler_doc_tipo: p.doc_tipo, kepler_doc_folio: p.folio,
          kepler_cuenta: p.clave, kepler_amount: p.importe, match_type: 'inferred', match_confidence: conf, matched_by: by });
      };

      // Pase 1: monto exacto (o ±$1) + fecha ±7d, greedy, por (cuenta,dirección).
      for (const mv of bankMovs) {
        const e = pool.get(`${mv.label}|${mv.dir}`); if (!e) continue;
        const tc = cents(mv.amount);
        let cands = (e.byAmt.get(tc) || []).filter((p) => !p.used);
        const exact = cands.length > 0;
        if (!exact) cands = candsInTol(e.byAmt, tc);
        if (!cands.length) continue;
        let best: any = null, bestD = 8;
        for (const p of cands) { const d = p.fecha ? days(mv.date, p.fecha) : 99; if (d < bestD) { best = p; bestD = d; } }
        if (best) emit(mv, best, exact ? (bestD === 0 ? 0.95 : 0.8) : 0.7, exact ? 'motor-tes' : 'motor-tes-tol');
      }
      // Pase 2: materiales ≥$5k sin casar, exacto/±$1 SIN tope de fecha.
      let p2 = 0;
      for (const mv of bankMovs) {
        if (matchedSet.has(mv.id) || mv.amount < 5000) continue;
        const e = pool.get(`${mv.label}|${mv.dir}`); if (!e) continue;
        const tc = cents(mv.amount);
        let cands = (e.byAmt.get(tc) || []).filter((p) => !p.used);
        if (!cands.length) cands = candsInTol(e.byAmt, tc);
        if (!cands.length) continue;
        let best: any = null, bestD = Infinity;
        for (const p of cands) { const d = p.fecha ? days(mv.date, p.fecha) : 999; if (d < bestD) { best = p; bestD = d; } }
        if (best) { emit(mv, best, 0.6, 'motor-tes-2p'); p2++; }
      }
      // Pase 3: por NOMBRE (beneficiario) + monto ±max($5,0.5%), misma cuenta+dir.
      let p3 = 0;
      for (const mv of bankMovs) {
        if (matchedSet.has(mv.id) || mv.amount < 3000) continue;
        const e = pool.get(`${mv.label}|${mv.dir}`); if (!e) continue;
        const tok = nameTokens(mv.concept); if (!tok.size) continue;
        const tol = Math.max(5, mv.amount * 0.005);
        let best: any = null, bestScore = 0, bestD = Infinity;
        for (const p of e.all) {
          if (p.used || Math.abs(p.importe - mv.amount) > tol) continue;
          const sc = nameScore(tok, nameTokens(p.benef)); if (sc < 0.5) continue;
          const d = p.fecha ? days(mv.date, p.fecha) : 999;
          if (sc > bestScore || (sc === bestScore && d < bestD)) { best = p; bestScore = sc; bestD = d; }
        }
        if (best) { emit(mv, best, 0.6, 'motor-tes-name'); p3++; }
      }
      // Pase 4 (agrupado): 1 movimiento del banco = N docs Kepler de la MISMA cuenta+dir
      // (cobranza: un depósito = varias UA05; SUA en exhibiciones). Suma exacta ≤5, ventana ±10d.
      let p4 = 0;
      for (const mv of bankMovs) {
        if (matchedSet.has(mv.id) || mv.amount < 5000) continue;
        const e = pool.get(`${mv.label}|${mv.dir}`); if (!e) continue;
        const cands = e.all.filter((p) => !p.used && (p.fecha ? days(mv.date, p.fecha) <= 10 : false))
          .sort((a, b) => b.importe - a.importe).slice(0, 30);
        if (cands.length < 2) continue;
        const idx = subsetSum(cands.map((p) => cents(p.importe)), cents(mv.amount), 5);
        if (!idx) continue;
        p4++;
        for (const i of idx) emit(mv, cands[i], 0.55, 'motor-tes-group');
      }

      // Persistir. Colapsa por (bank_movement_id, doc_tipo, folio): el pase agrupado
      // suma varias LÍNEAS del mismo folio Kepler → si no, dos filas con la misma llave
      // única → duplicate key → 500. Aquí se unen sumando el importe.
      const uniqMatches = this.collapseMatches(matches);
      const periodMovIds = bankMovs.map((m: any) => m.id);
      if (periodMovIds.length) {
        await trx('finance.bank_recon_matches').whereIn('bank_movement_id', periodMovIds).del();
        for (let i = 0; i < uniqMatches.length; i += 500) {
          await trx('finance.bank_recon_matches').insert(uniqMatches.slice(i, i + 500))
            .onConflict(['tenant_id', 'bank_movement_id', 'kepler_doc_tipo', 'kepler_doc_folio']).ignore();
        }
        await trx('finance.bank_movements').whereIn('id', periodMovIds).update({ recon_status: 'unmatched', updated_at: trx.fn.now() });
        const matchedIds = [...matchedSet];
        for (let i = 0; i < matchedIds.length; i += 500) await trx('finance.bank_movements').whereIn('id', matchedIds.slice(i, i + 500)).update({ recon_status: 'matched', updated_at: trx.fn.now() });
      }

      const matchedBank = matchedSet.size;
      const outMovs = bankMovs.filter((m) => m.dir === 'out'), inMovs = bankMovs.filter((m) => m.dir === 'in');
      const matchedAmt = matches.reduce((s, m) => s + n(m.kepler_amount), 0);
      const bankTotal = bankMovs.reduce((s: number, m: any) => s + m.amount, 0);
      this.logger.log(`match-tesoreria ${period}: ${matchedBank}/${bankMovs.length} casados (${p2} 2º, ${p3} nombre, ${p4} agrupado)`);
      return {
        period, engine: 'tesoreria', bank_movements: bankMovs.length, matched: matchedBank,
        second_pass: p2, name_pass: p3, group_pass: p4,
        matched_deposits: inMovs.filter((m) => matchedSet.has(m.id)).length, deposits: inMovs.length,
        matched_withdrawals: outMovs.filter((m) => matchedSet.has(m.id)).length, withdrawals: outMovs.length,
        unmatched_bank: bankMovs.length - matchedBank, kepler_postings: kep.length,
        unmatched_kepler: kep.filter((p) => !p.used).length,
        matched_amount: Math.round(matchedAmt * 100) / 100, bank_amount: Math.round(bankTotal * 100) / 100,
        match_rate: bankMovs.length ? Math.round((matchedBank / bankMovs.length) * 100) : 0,
      };
    });

    try { await this.syncFindings(period); } catch (e: any) { this.logger.warn(`syncFindings tras match-tesoreria falló: ${e?.message || e}`); }
    return result;
  }

  /**
   * CB.4.1 — Matching por-transacción (LEGACY, fallback si no hay feed de tesorería): retiros
   * del banco (pagos) ↔ abonos del 102 de Kepler (`analytics.bank_postings`), por monto exacto
   * + fecha ±7d. Solo lado pago (los depósitos/cobranza quedan a control-total: Kepler agrega
   * por plaza, no casan 1:1). CB.27 lo reemplaza con el matching por banco cuando hay tesorería.
   */
  async runMatch(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    // CB.27 — si el feed de tesorería (kdm1, por banco) tiene el periodo, usar el matching
    // v2 acotado POR CUENTA (mejor que el 102 lumped: casa por banco + ambas direcciones).
    const [ty, tm] = period.split('-').map(Number);
    const tIni = `${period}-01`;
    const tFin = tm >= 12 ? `${ty + 1}-01-01` : `${ty}-${String(tm + 1).padStart(2, '0')}-01`;
    const hasTreasury = await this.tk.run((trx) => trx('analytics.kepler_bank_movements')
      .where('tenant_id', tenantId).whereNotNull('account_label')
      .andWhere('fecha_valor', '>=', tIni).andWhere('fecha_valor', '<', tFin).first('doc_tipo'));
    if (hasTreasury) return this.runMatchTreasury(period);

    const cents = (x: number) => Math.round((Number(x) || 0) * 100);
    const days = (a: any, b: any) => Math.abs(Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000));

    const result = await this.tk.run(async (trx) => {
      // Lado banco: retiros del periodo (excluye traspasos internos, factoraje y sin importe).
      // CB.17 — factoraje fuera: no pega al 102 (CF lo paga el factor; PF no se asienta como
      // abono al 102 con el nombre del factor) → incluirlo solo inflaba "retiros sin conciliar".
      const bankMovs = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).where('bm.amount_out', '>', 0).whereNull('bm.deleted_at')
        .whereRaw(`COALESCE(mc.group_key,'sin_clasificar') NOT IN ('traspaso','factoraje')`)
        .select('bm.id', 'bm.movement_date', 'bm.amount_out', 'bm.concept')
        .orderBy('bm.movement_date');

      // Lado Kepler: abonos del 102 del periodo (pagos que salen).
      const posts = (await trx('analytics.bank_postings')
        .where({ tenant_id: tenantId, anio_mes: period, cargo_abono: 'A' })
        .select('doc_tipo', 'folio', 'fecha', 'importe', 'contraparte'))
        .map((p: any) => ({ ...p, importe: n(p.importe), used: false }));

      // índice por monto en centavos
      const byAmt = new Map<number, any[]>();
      for (const p of posts) { const k = cents(p.importe); (byAmt.get(k) || byAmt.set(k, []).get(k))!.push(p); }

      // CB.22 — margen de conciliación de ±$1.00: Kepler y Excel a veces difieren por
      // redondeo de centavos (ej. Kepler $1.30 vs banco $1.60 = $0.30). Si no hay match
      // EXACTO, se aceptan candidatos dentro de ±100 centavos (rango de 201 claves →
      // lookups directos al índice, barato). El exacto SIEMPRE tiene prioridad.
      const AMT_TOL = 100; // ±$1.00 en centavos
      const candsInTol = (targetCents: number) => {
        const out: any[] = [];
        for (let d = -AMT_TOL; d <= AMT_TOL; d++) {
          const arr = byAmt.get(targetCents + d);
          if (arr) for (const p of arr) if (!p.used) out.push(p);
        }
        return out;
      };

      const matches: any[] = []; const matchedIds: string[] = [];
      const matchedSet = new Set<string>();
      // 1er pase: monto (exacto → o ±$1) + fecha ±7d (greedy por fecha más cercana).
      for (const mv of bankMovs) {
        const tc = cents(n(mv.amount_out));
        let cands = (byAmt.get(tc) || []).filter((p) => !p.used);
        const exact = cands.length > 0;
        if (!exact) cands = candsInTol(tc); // ±$1 solo si no hubo exacto
        if (!cands.length) continue;
        let best: any = null, bestD = 8;
        for (const p of cands) { const d = p.fecha ? days(mv.movement_date, p.fecha) : 99; if (d < bestD) { best = p; bestD = d; } }
        if (!best) continue;
        best.used = true; matchedIds.push(mv.id); matchedSet.add(mv.id);
        matches.push({ tenant_id: tenantId, bank_movement_id: mv.id, kepler_doc_tipo: best.doc_tipo,
          kepler_doc_folio: best.folio, kepler_cuenta: '102', kepler_amount: best.importe,
          match_type: 'inferred', match_confidence: !exact ? 0.7 : (bestD === 0 ? 0.95 : 0.75), matched_by: exact ? 'motor' : 'motor-tol' });
      }
      // 2º pase (CB.8): retiros materiales (≥$10k) aún sin casar, por monto exacto
      // SIN tope de fecha (elige el post de fecha más cercana). Confianza menor.
      // Rescata pagos grandes con desfase de días (p.ej. el $1.03M a la Rosa) sin
      // ensuciar comisiones/nómina chicas (que Kepler agrupa) por el umbral.
      const SECOND_PASS_MIN = 10000;
      let secondPass = 0;
      for (const mv of bankMovs) {
        if (matchedSet.has(mv.id) || n(mv.amount_out) < SECOND_PASS_MIN) continue;
        const tc = cents(n(mv.amount_out));
        let cands = (byAmt.get(tc) || []).filter((p) => !p.used);
        if (!cands.length) cands = candsInTol(tc); // ±$1 (CB.22)
        if (!cands.length) continue;
        let best: any = null, bestD = Infinity;
        for (const p of cands) { const d = p.fecha ? days(mv.movement_date, p.fecha) : 999; if (d < bestD) { best = p; bestD = d; } }
        if (!best) continue;
        best.used = true; matchedIds.push(mv.id); matchedSet.add(mv.id); secondPass++;
        matches.push({ tenant_id: tenantId, bank_movement_id: mv.id, kepler_doc_tipo: best.doc_tipo,
          kepler_doc_folio: best.folio, kepler_cuenta: '102', kepler_amount: best.importe,
          match_type: 'inferred', match_confidence: 0.5, matched_by: 'motor-2p' });
      }
      // 3er pase (CB.10): por NOMBRE del beneficiario + monto aproximado. Rescata los
      // pagos donde los centavos banco ≠ Kepler (redondeos, IVA, comisión embebida) pero
      // el beneficiario coincide. Exige AMBOS: |Δmonto| ≤ max($5, 0.5%) Y score de nombre
      // ≥ 0.5 (tokens significativos compartidos) → no casa por monto solo (seguro).
      const NAME_PASS_MIN = 5000;
      let thirdPass = 0;
      for (const mv of bankMovs) {
        if (matchedSet.has(mv.id) || n(mv.amount_out) < NAME_PASS_MIN) continue;
        const amt = n(mv.amount_out), tol = Math.max(5, amt * 0.005);
        const mvTok = nameTokens(mv.concept);
        if (!mvTok.size) continue;
        let best: any = null, bestScore = 0, bestD = Infinity;
        for (const p of posts) {
          if (p.used || Math.abs(p.importe - amt) > tol) continue;
          const sc = nameScore(mvTok, nameTokens(p.contraparte));
          if (sc < 0.5) continue;
          const d = p.fecha ? days(mv.movement_date, p.fecha) : 999;
          if (sc > bestScore || (sc === bestScore && d < bestD)) { best = p; bestScore = sc; bestD = d; }
        }
        if (!best) continue;
        best.used = true; matchedIds.push(mv.id); matchedSet.add(mv.id); thirdPass++;
        matches.push({ tenant_id: tenantId, bank_movement_id: mv.id, kepler_doc_tipo: best.doc_tipo,
          kepler_doc_folio: best.folio, kepler_cuenta: '102', kepler_amount: best.importe,
          match_type: 'inferred', match_confidence: 0.6, matched_by: 'motor-name' });
      }

      // 4º/5º pase (CB.19): AGRUPADO. Un pago del banco suele ser la SUMA de varias pólizas
      // del 102 (o al revés: SUA en varias exhibiciones). Suma-de-subconjuntos ACOTADA para
      // no casar falso: mismo beneficiario (solapamiento de tokens substring), ventana ±10d,
      // ≤4 sumandos, suma EXACTA en centavos, solo materiales ≥$5k. Confianza 0.55.
      const GROUP_MIN = 5000, GROUP_WINDOW = 10, GROUP_MAXN = 4, POOL = 25;
      const normCp = (s: any) => normKey(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
      const ovl = (tok: Set<string>, cp: string): boolean => {
        if (!tok.size) return false;
        let h = 0; for (const t of tok) if (cp.includes(t)) h++;
        return h >= Math.min(2, tok.size);
      };
      const subsetSum = (arr: number[], target: number, maxN: number): number[] | null => {
        let out: number[] | null = null;
        const dfs = (start: number, rem: number, picked: number[]): void => {
          if (out) return;
          if (rem === 0 && picked.length >= 2) { out = picked.slice(); return; }
          if (picked.length === maxN || rem < 0) return;
          for (let i = start; i < arr.length; i++) {
            if (arr[i] > rem) continue;
            picked.push(i); dfs(i + 1, rem - arr[i], picked); picked.pop();
            if (out) return;
          }
        };
        dfs(0, target, []);
        return out;
      };
      for (const p of posts as any[]) p._cp = normCp(p.contraparte);
      const bankTok = new Map<string, Set<string>>();
      for (const mv of bankMovs as any[]) bankTok.set(mv.id, nameTokens(mv.concept));

      let groupPass = 0;
      // A) 1 retiro del banco = N abonos del 102 (mismo beneficiario, ventana corta).
      for (const mv of bankMovs as any[]) {
        if (matchedSet.has(mv.id) || n(mv.amount_out) < GROUP_MIN) continue;
        const tok = bankTok.get(mv.id)!; if (!tok.size) continue;
        const cands = (posts as any[])
          .filter((p) => !p.used && ovl(tok, p._cp) && (p.fecha ? days(mv.movement_date, p.fecha) <= GROUP_WINDOW : false))
          .sort((a, b) => b.importe - a.importe).slice(0, POOL);
        if (cands.length < 2) continue;
        const idx = subsetSum(cands.map((p) => cents(p.importe)), cents(n(mv.amount_out)), GROUP_MAXN);
        if (!idx) continue;
        matchedIds.push(mv.id); matchedSet.add(mv.id); groupPass++;
        for (const i of idx) {
          const p = cands[i]; p.used = true;
          matches.push({ tenant_id: tenantId, bank_movement_id: mv.id, kepler_doc_tipo: p.doc_tipo,
            kepler_doc_folio: p.folio, kepler_cuenta: '102', kepler_amount: p.importe,
            match_type: 'inferred', match_confidence: 0.55, matched_by: 'motor-group' });
        }
      }
      // B) N retiros del banco = 1 abono del 102 (p.ej. SUA/IMSS pagado en varias exhibiciones).
      for (const p of posts as any[]) {
        if (p.used || p.importe < GROUP_MIN) continue;
        const cands = (bankMovs as any[])
          .filter((mv) => !matchedSet.has(mv.id) && n(mv.amount_out) > 0 && ovl(bankTok.get(mv.id)!, p._cp) && (p.fecha ? days(mv.movement_date, p.fecha) <= GROUP_WINDOW : false))
          .sort((a, b) => n(b.amount_out) - n(a.amount_out)).slice(0, POOL);
        if (cands.length < 2) continue;
        const idx = subsetSum(cands.map((mv) => cents(n(mv.amount_out))), cents(p.importe), GROUP_MAXN);
        if (!idx) continue;
        p.used = true; groupPass++;
        for (const i of idx) {
          const mv = cands[i];
          matchedIds.push(mv.id); matchedSet.add(mv.id);
          matches.push({ tenant_id: tenantId, bank_movement_id: mv.id, kepler_doc_tipo: p.doc_tipo,
            kepler_doc_folio: p.folio, kepler_cuenta: '102', kepler_amount: n(mv.amount_out),
            match_type: 'inferred', match_confidence: 0.55, matched_by: 'motor-groupN1' });
        }
      }

      // Persistir: limpiar matches previos del periodo + reinsertar; marcar recon_status.
      // Colapsa por (bank_movement_id, doc_tipo, folio) — el pase agrupado suma varias
      // líneas del mismo folio → evita duplicate key en la única.
      const uniqMatches = this.collapseMatches(matches);
      const periodMovIds = bankMovs.map((m: any) => m.id);
      if (periodMovIds.length) {
        await trx('finance.bank_recon_matches').whereIn('bank_movement_id', periodMovIds).del();
        for (let i = 0; i < uniqMatches.length; i += 500) {
          await trx('finance.bank_recon_matches').insert(uniqMatches.slice(i, i + 500))
            .onConflict(['tenant_id', 'bank_movement_id', 'kepler_doc_tipo', 'kepler_doc_folio']).ignore();
        }
        await trx('finance.bank_movements').whereIn('id', periodMovIds).update({ recon_status: 'unmatched', updated_at: trx.fn.now() });
        for (let i = 0; i < matchedIds.length; i += 500) {
          await trx('finance.bank_movements').whereIn('id', matchedIds.slice(i, i + 500)).update({ recon_status: 'matched', updated_at: trx.fn.now() });
        }
      }

      // matched = retiros del banco DISTINTOS casados (matchedIds), no filas de match:
      // con el pase agrupado hay varias filas por un mismo retiro (1:N) → contar filas inflaría.
      const matchedBank = matchedIds.length;
      const matchedAmt = matches.reduce((s, m) => s + n(m.kepler_amount), 0);
      const bankTotal = bankMovs.reduce((s: number, m: any) => s + n(m.amount_out), 0);
      this.logger.log(`match ${period}: ${matchedBank}/${bankMovs.length} retiros casados (${secondPass} 2º, ${thirdPass} nombre, ${groupPass} agrupado)`);
      return {
        period, bank_movements: bankMovs.length, matched: matchedBank, second_pass: secondPass, name_pass: thirdPass, group_pass: groupPass,
        unmatched_bank: bankMovs.length - matchedBank,
        kepler_postings: posts.length, unmatched_kepler: posts.filter((p) => !p.used).length,
        matched_amount: matchedAmt, bank_amount: bankTotal,
        match_rate: bankMovs.length ? Math.round((matchedBank / bankMovs.length) * 100) : 0,
      };
    });

    // CB.7 — tras casar, refresca los hallazgos de conciliación (best-effort).
    try { await this.syncFindings(period); } catch (e: any) { this.logger.warn(`syncFindings tras match falló: ${e?.message || e}`); }
    return result;
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

    return this.tk.run(async (trx) => {
      // Lado banco: por categoría (grupo + cuenta Kepler) + kind de la cuenta.
      const bank = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('st.period', period).whereNull('bm.deleted_at')
        .groupBy('ba.kind', 'mc.group_key', 'mc.kepler_account', 'mc.name', 'mc.code')
        .select('ba.kind', trx.raw(`COALESCE(mc.group_key,'sin_clasificar') AS group_key`),
          'mc.kepler_account', 'mc.name', 'mc.code',
          trx.raw('SUM(bm.amount_in)::numeric AS deposits'),
          trx.raw('SUM(bm.amount_out)::numeric AS withdrawals'));

      // Lado libro: balanza del periodo. Base = ALMACÉN 00 (CEDIS): el 100% del 102
      // (pólizas de banco) de Kepler vive ahí; 02/03 son libros locales de tienda que
      // NO salen de estos bancos corporativos. Sumar las 3 sucursales inflaba el 102 (CB.13).
      const book = await trx('analytics.ledger_monthly')
        .where({ tenant_id: tenantId, anio_mes: period, sucursal: '00' })
        .groupBy('cuenta_mayor')
        .select('cuenta_mayor', trx.raw('SUM(cargos)::numeric AS cargos'), trx.raw('SUM(abonos)::numeric AS abonos'));
      const bookBy: Record<string, { cargos: number; abonos: number }> = {};
      for (const r of book as any[]) bookBy[r.cuenta_mayor] = { cargos: n(r.cargos), abonos: n(r.abonos) };

      // CAJA: banco (excl. traspasos internos Y factoraje) vs 102 de almacén 00. ESTA es la
      // conciliación contra Kepler. El detalle exacto (¿qué pago casa con qué póliza?) vive en
      // el matching por-transacción (runMatch). CB.17 — factoraje EXCLUIDO del cuadre Egresos↔102:
      // es financiamiento, no un pago normal del 102. El CF (compra con factoraje) ni siquiera es
      // salida de banco (paga el factor); el PF (pago al factor) sí sale de banco pero Kepler NO lo
      // asienta como abono al 102 con el nombre del factor (verificado: no hay cuenta de factor).
      // Se muestra como línea propia "Financiamiento (factoraje)", igual que los traspasos.
      // CB.21 — CAJA GENERAL (kind='cash') NO ES FISCAL → fuera del cuadre contra el 102.
      // El CONCENTRADO de contabilidad tampoco la incluye (verificado: los tipos I/C/G/TI/TE
      // de solo-bancos cuadran al peso con la hoja). Es efectivo que no pasa por el mayor 102.
      // Se muestra como memo aparte "Caja general (no fiscal)".
      const EXCLUDE = new Set(['traspaso', 'factoraje']);
      let bankIn = 0, bankOut = 0, cajaIn = 0, cajaOut = 0;
      for (const r of bank as any[]) {
        if (r.kind === 'cash') { cajaIn += n(r.deposits); cajaOut += n(r.withdrawals); continue; }
        if (EXCLUDE.has(r.group_key)) continue;
        bankIn += n(r.deposits); bankOut += n(r.withdrawals);
      }
      const k102 = bookBy['102'] || { cargos: 0, abonos: 0 };
      const cash = {
        bank_in: bankIn, kepler_102_cargos: k102.cargos, delta_in: bankIn - k102.cargos,
        bank_out: bankOut, kepler_102_abonos: k102.abonos, delta_out: bankOut - k102.abonos,
      };
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const caja = { ingresos: r2(cajaIn), egresos: r2(cajaOut), total: r2(cajaIn + cajaOut) };

      // CB.17 — Factoraje como línea propia (memo, fuera del cuadre 102). CF = compra que
      // pagó el factor (no sale de banco); PF = pago real al factor desde banco. (Solo cuentas
      // no-caja; la caja ya se separó arriba.)
      let facCF = 0, facPF = 0;
      for (const r of bank as any[]) {
        if (r.kind === 'cash' || r.group_key !== 'factoraje') continue;
        if (r.code === 'compra_factoraje') facCF += n(r.withdrawals);
        else facPF += n(r.withdrawals);
      }
      const factoraje = { compra: r2(facCF), pago: r2(facPF), total: r2(facCF + facPF) };

      // CB.13 — El P&L "categoría banco → mayor Kepler" se ELIMINÓ: los mapeos eran
      // adivinados (602 es vehículos, no traslado; 608 es misc, no tarjeta; 611-003 tiene
      // $600, no todas las comisiones) y generaban deltas falsos. El catálogo real (185
      // cuentas, branch-specific) + el desfase cash/devengado hacen imposible el mapeo 1:N.
      // La conciliación real = matching por-transacción (exacto). accounts queda vacío.
      const accounts: { kepler_account: string; concept: string; bank: number; book: number; delta: number }[] = [];

      // Cobranza (ingreso) como memo: depósitos vs 102 cargos (ya en cash). Solo bancos (sin caja).
      const cobranza = (bank as any[]).filter((r) => r.kind !== 'cash' && r.group_key === 'ingreso').reduce((s, r) => s + n(r.deposits), 0);

      return { period, cash, accounts, cobranza, factoraje, caja,
        sin_clasificar: (bank as any[]).filter((r) => r.kind !== 'cash' && r.group_key === 'sin_clasificar').reduce((s, r) => s + n(r.deposits) + n(r.withdrawals), 0) };
    });
  }

  /**
   * CB.24 — Cuadre 3 vías: Workbook (estado de cuenta) ↔ Kepler 102 ↔ ContPAQi (libros).
   *
   * Nivel 1 (control-total): 2 filas Ingresos/Egresos × 3 fuentes + deltas por par +
   * semáforo. AQUÍ es donde "cuadran las 3". Nivel 2 (por cuenta): Workbook vs ContPAQi
   * (ambas por cuenta). El 102 de Kepler NO se desglosa por banco (es un bulto en el
   * feed), así que Kepler solo aparece en el control-total. Reusa contpaqiCompare
   * (Workbook + ContPAQi, mismo universo kind='bank') + el total del 102 de bank_postings.
   */
  async threeWay(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const TOL = 1000; // ±$1,000 se considera cuadrado (misma tolerancia que el resto del módulo)

    const cpq = await this.contpaqiCompare(period); // Workbook(excel) + ContPAQi + filas por cuenta

    const [yy, mm] = period.split('-').map(Number);
    const ini = `${period}-01`;
    const fin = mm >= 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;

    // CB.26/28 — Kepler POR CUENTA desde el feed de tesorería (kdm1⋈kdb1). El 102
    // contable estaba lumped; la tesorería sí desglosa por banco (c45). deposito=signo>0
    // (entrada/traspaso-destino), retiro=signo<0 (salida/traspaso-origen). account_label
    // = crosswalk a finance.bank_accounts (excluye puente/caja-chica sin cuenta nuestra).
    const kepRows = await this.tk.run(async (trx) =>
      trx('analytics.kepler_bank_movements')
        .where('tenant_id', tenantId).whereNotNull('account_label')
        .andWhere('fecha_valor', '>=', ini).andWhere('fecha_valor', '<', fin)
        .groupBy('account_label')
        .select('account_label',
          trx.raw(`COALESCE(SUM(importe) FILTER (WHERE signo > 0),0) AS dep`),
          trx.raw(`COALESCE(SUM(importe) FILTER (WHERE signo < 0),0) AS ret`),
          trx.raw(`COUNT(*)::int AS movs`)));
    const kmap = new Map<string, { in: number; out: number; movs: number }>(
      (kepRows as any[]).map((r) => [r.account_label, { in: r2(n(r.dep)), out: r2(n(r.ret)), movs: Number(r.movs) || 0 }]));
    const kepHasData = (kepRows as any[]).length > 0;

    // Total Kepler: suma del feed de tesorería si hay datos; si no, fallback al 102 de bank_postings.
    let kep: { in: number; out: number; movs: number };
    if (kepHasData) {
      const agg = [...kmap.values()].reduce((s, v) => ({ in: s.in + v.in, out: s.out + v.out, movs: s.movs + v.movs }), { in: 0, out: 0, movs: 0 });
      kep = { in: r2(agg.in), out: r2(agg.out), movs: agg.movs };
    } else {
      kep = await this.tk.run(async (trx) => {
        const row: any = await trx('analytics.bank_postings')
          .where({ tenant_id: tenantId, anio_mes: period })
          .select(trx.raw(`COALESCE(SUM(importe) FILTER (WHERE cargo_abono='C'),0) AS ingresos`))
          .select(trx.raw(`COALESCE(SUM(importe) FILTER (WHERE cargo_abono='A'),0) AS egresos`))
          .count('* as movs').first();
        return { in: r2(n(row?.ingresos)), out: r2(n(row?.egresos)), movs: Number(row?.movs) || 0 };
      });
    }

    const mkRow = (label: string, w: number, k: number, c: number) => ({
      label, workbook: r2(w), kepler: r2(k), contpaqi: r2(c),
      delta_wk: r2(w - k), delta_wc: r2(w - c), delta_kc: r2(k - c),
      cuadra: Math.abs(w - k) < TOL && Math.abs(w - c) < TOL && Math.abs(k - c) < TOL,
    });
    const total = {
      ingresos: mkRow('Ingresos', cpq.totals.excel_in, kep.in, cpq.totals.contpaqi_in),
      egresos: mkRow('Egresos', cpq.totals.excel_out, kep.out, cpq.totals.contpaqi_out),
    };

    const por_cuenta = cpq.rows.map((r: any) => {
      const k = kmap.get(r.account_label);
      const kin = k ? k.in : 0, kout = k ? k.out : 0;
      return {
        bank: r.bank, account_label: r.account_label, alias: r.alias, linked: r.linked,
        wb_in: r.excel_in, wb_out: r.excel_out, cp_in: r.contpaqi_in, cp_out: r.contpaqi_out,
        kep_in: kin, kep_out: kout, kep_has: !!k,
        delta_in: r.delta_in, delta_out: r.delta_out,               // Workbook − ContPAQi
        delta_wk_in: r2(r.excel_in - kin), delta_wk_out: r2(r.excel_out - kout), // Workbook − Kepler
        cuadra: Math.abs(r.delta_in) < TOL && Math.abs(r.delta_out) < TOL,
      };
    }).sort((a: any, b: any) => (Math.abs(b.delta_in) + Math.abs(b.delta_out)) - (Math.abs(a.delta_in) + Math.abs(a.delta_out)));

    // CB.32 — Cobertura/frescura por fuente: distingue "captura pendiente" de "descuadre real".
    // Cada fuente captura a su ritmo (banco al día > Kepler operativo > ContPAQi fiscal). En el
    // mes en curso una fuente rezagada NO es descuadre; el semáforo no debe leerse como error.
    const curYm = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit' })
      .format(new Date()).slice(0, 7);
    const cov = await this.tk.run(async (trx) => {
      const wb: any = await trx('finance.bank_movements as bm').join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).whereNull('bm.deleted_at')
        .select(trx.raw('COUNT(*)::int AS movs'), trx.raw('MAX(bm.movement_date) AS last')).first();
      const kp: any = await trx('analytics.kepler_bank_movements').where('tenant_id', tenantId).whereNotNull('account_label')
        .andWhere('fecha_valor', '>=', ini).andWhere('fecha_valor', '<', fin)
        .select(trx.raw('COUNT(*)::int AS movs'), trx.raw('MAX(fecha_captura) AS last')).first();
      const cq: any = await trx('analytics.contpaqi_bank_movements').where({ tenant_id: tenantId, anio_mes: period })
        .select(trx.raw('COUNT(*)::int AS movs'), trx.raw('MAX(fecha) AS last')).first();
      return { wb, kp, cq };
    });
    const cw = n(cov.wb?.movs), ck = n(cov.kp?.movs), cc = n(cov.cq?.movs);
    const maxc = Math.max(cw, ck, cc, 1);
    const src = (movs: number, last: any) => ({ movs, pct: Math.round((movs / maxc) * 100), last: last || null, stale: movs > 0 && movs < 0.3 * maxc });
    const coverage = {
      is_current_month: period === curYm,
      workbook: src(cw, cov.wb?.last),
      kepler: { ...src(ck, cov.kp?.last), sin_datos: ck === 0 },
      contpaqi: { ...src(cc, cov.cq?.last), sin_datos: cc === 0 },
    };
    const anyStale = coverage.kepler.stale || coverage.contpaqi.stale || coverage.kepler.sin_datos || coverage.contpaqi.sin_datos;

    return {
      period, tolerance: TOL,
      cuadra: total.ingresos.cuadra && total.egresos.cuadra,
      total, por_cuenta, coverage,
      kepler_movs: kep.movs, kepler_linked: cpq.linked, kepler_por_cuenta: kepHasData,
      nota: anyStale
        ? 'Cobertura despareja este periodo: alguna fuente va rezagada en captura (ver barra de cobertura). Las diferencias grandes contra esa fuente son CAPTURA PENDIENTE, no descuadre real — se cierran cuando esa fuente se pone al día. El banco (Workbook) es el que va al día.'
        : (kepHasData
          ? 'Kepler se desglosa por banco desde tesorería (kdm1), no del 102 contable. Las 3 fuentes se comparan por cuenta. Diferencias esperadas: Kepler registra lo capturado (el banco es la verdad), cheques en tránsito y timing. Semáforo ±$1,000.'
          : 'El feed de tesorería Kepler aún no tiene movimientos para este periodo; Kepler va solo en el control-total (102 contable).'),
    };
  }

  /**
   * CB.30 — Cheques en tránsito. Kepler registra el cheque como SALIDA inmediata (no tiene
   * fecha de cobro/clearing), pero el banco solo lo muestra cuando se cobra. Un cheque emitido
   * en el mes M y cobrado en M+1 explica parte del "Kepler registra más salida que el banco".
   * Este método toma los cheques Kepler del periodo (X-D-25 / metodo 'Che') y busca si YA
   * cobraron en el banco (mismo banco, monto ±$1, fecha ≥ emisión, este periodo o posteriores):
   *   • cobrado    → hay retiro del banco que lo liquidó (con lag de días).
   *   • en tránsito → aún sin cobrar → es el gap de timing (no descuadre).
   */
  async chequesEnTransito(period?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const cents = (x: any) => Math.round((Number(x) || 0) * 100);
    const [yy, mm] = period.split('-').map(Number);
    const ini = `${period}-01`;
    const fin = mm >= 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
    return this.tk.run(async (trx) => {
      const cheques = await trx('analytics.kepler_bank_movements')
        .where('tenant_id', tenantId).whereNotNull('account_label')
        .andWhere('fecha_valor', '>=', ini).andWhere('fecha_valor', '<', fin).where('signo', '<', 0)
        .andWhere((q: any) => q.whereILike('doc_tipo', 'X-D-25%').orWhere('metodo', 'Che'))
        .select('doc_tipo', 'folio', 'account_label', 'banco_nombre', 'importe', 'fecha_valor', 'beneficiario')
        .orderBy('importe', 'desc');
      if (!cheques.length) return { period, total: { cheques_n: 0, en_transito_n: 0, en_transito_monto: 0, cobrado_n: 0, cobrado_monto: 0 }, cheques: [] };

      // Retiros del banco de las mismas cuentas, del periodo EN ADELANTE (el cheque puede cobrar después).
      const labels = [...new Set(cheques.map((c: any) => c.account_label))];
      const bankOut = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .where('bm.amount_out', '>', 0).whereNull('bm.deleted_at')
        .whereIn('ba.account_label', labels as any).andWhere('bm.movement_date', '>=', ini)
        .select('bm.movement_date', 'bm.amount_out', 'ba.account_label');
      const idx = new Map<string, Date[]>();
      for (const b of bankOut as any[]) { const k = `${b.account_label}|${cents(b.amount_out)}`; (idx.get(k) || idx.set(k, []).get(k))!.push(new Date(b.movement_date)); }

      const used = new Set<string>();
      const rows = (cheques as any[]).map((c) => {
        const k = `${c.account_label}|${cents(c.importe)}`;
        const dates = idx.get(k) || [];
        const chDate = new Date(c.fecha_valor);
        let cashed: Date | null = null, ui = -1;
        for (let i = 0; i < dates.length; i++) {
          if (used.has(`${k}|${i}`)) continue;
          if (dates[i].getTime() >= chDate.getTime() && (!cashed || dates[i] < cashed)) { cashed = dates[i]; ui = i; }
        }
        if (cashed) used.add(`${k}|${ui}`);
        return {
          doc_tipo: c.doc_tipo, folio: c.folio, account_label: c.account_label, banco_nombre: c.banco_nombre,
          importe: n(c.importe), fecha: c.fecha_valor, beneficiario: c.beneficiario,
          cobrado: !!cashed, fecha_cobro: cashed ? cashed.toISOString().slice(0, 10) : null,
          lag_dias: cashed ? Math.round((cashed.getTime() - chDate.getTime()) / 86400000) : null,
        };
      });
      const transito = rows.filter((r) => !r.cobrado), cobr = rows.filter((r) => r.cobrado);
      const sum = (a: any[]) => Math.round(a.reduce((s, r) => s + r.importe, 0) * 100) / 100;
      return {
        period,
        total: { cheques_n: rows.length, en_transito_n: transito.length, en_transito_monto: sum(transito), cobrado_n: cobr.length, cobrado_monto: sum(cobr) },
        cheques: rows,
      };
    });
  }

  /**
   * CB.33 — Drill 3 vías a nivel MOVIMIENTO por cuenta. Para una cuenta + periodo enfrenta las
   * tres fuentes movimiento a movimiento (por dirección + monto exacto): el estado de cuenta
   * (Excel), la tesorería Kepler (kdm1) y las pólizas ContPAQi. Cada movimiento del banco marca
   * si Kepler y/o ContPAQi lo tienen; y se listan los huérfanos de Kepler y de ContPAQi (lo que
   * una fuente registró y el banco no movió). Es el "¿dónde está la diferencia?" de las 3 vías.
   */
  async threeWayDetail(period?: string, accountLabel?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    if (!accountLabel) throw new BadRequestException('account_label requerido');
    const cents = (x: any) => Math.round((Number(x) || 0) * 100);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const [yy, mm] = period.split('-').map(Number);
    const ini = `${period}-01`;
    const fin = mm >= 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
    return this.tk.run(async (trx) => {
      const acct = await trx('finance.bank_accounts').where('account_label', accountLabel)
        .first('id', 'bank', 'account_label', 'contpaqi_cuenta', 'contpaqi_cuenta_nombre');
      if (!acct) throw new BadRequestException(`cuenta ${accountLabel} no encontrada`);

      const excel = (await trx('finance.bank_movements as bm').join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).andWhere('bm.bank_account_id', acct.id).whereNull('bm.deleted_at')
        .whereRaw('(bm.amount_in > 0 OR bm.amount_out > 0)')
        .select('bm.id', 'bm.movement_date', 'bm.amount_in', 'bm.amount_out', 'bm.concept', 'bm.raw_code')
        .orderBy('bm.movement_date')).map((b: any) => ({
          id: b.id, fecha: b.movement_date, concepto: b.concept, codigo: b.raw_code,
          dir: n(b.amount_out) > 0 ? 'out' : 'in', importe: n(b.amount_out) > 0 ? n(b.amount_out) : n(b.amount_in),
        }));

      const kepler = (await trx('analytics.kepler_bank_movements')
        .where('tenant_id', tenantId).where('account_label', accountLabel)
        .andWhere('fecha_valor', '>=', ini).andWhere('fecha_valor', '<', fin).whereRaw('signo <> 0')
        .select('doc_tipo', 'folio', 'importe', 'signo', 'fecha_valor', 'beneficiario', 'metodo'))
        .map((p: any) => ({ doc_tipo: p.doc_tipo, folio: p.folio, fecha: p.fecha_valor, concepto: p.beneficiario, metodo: p.metodo,
          dir: Number(p.signo) > 0 ? 'in' : 'out', importe: n(p.importe), used: false }));

      const contpaqi = acct.contpaqi_cuenta ? (await trx('analytics.contpaqi_bank_movements')
        .where({ tenant_id: tenantId, anio_mes: period, cuenta: acct.contpaqi_cuenta })
        .select('id_movimiento', 'fecha', 'flujo', 'importe', 'poliza_tipo', 'poliza_folio', 'concepto'))
        .map((c: any) => ({ id: c.id_movimiento, fecha: c.fecha, poliza: `${c.poliza_tipo || ''} ${c.poliza_folio || ''}`.trim(), concepto: c.concepto,
          dir: c.flujo === 'deposito' ? 'in' : 'out', importe: n(c.importe), used: false })) : [];

      const buildIdx = (arr: any[]) => {
        const m = new Map<string, any[]>();
        for (const x of arr) { const k = `${x.dir}|${cents(x.importe)}`; (m.get(k) || m.set(k, []).get(k))!.push(x); }
        return m;
      };
      const kIdx = buildIdx(kepler), cIdx = buildIdx(contpaqi);
      const take = (idx: Map<string, any[]>, dir: string, imp: number) => {
        const arr = idx.get(`${dir}|${cents(imp)}`); if (!arr) return null;
        const f = arr.find((x) => !x.used); if (f) { f.used = true; return f; } return null;
      };

      const excelRows = excel.map((e: any) => {
        const k = take(kIdx, e.dir, e.importe), c = take(cIdx, e.dir, e.importe);
        return { ...e, kepler: !!k, contpaqi: !!c, kepler_doc: k ? `${k.doc_tipo} ${k.folio}`.trim() : null, contpaqi_poliza: c ? c.poliza : null };
      });
      const keplerOnly = kepler.filter((x) => !x.used).map((x) => ({ doc: `${x.doc_tipo} ${x.folio}`.trim(), fecha: x.fecha, importe: x.importe, dir: x.dir, concepto: x.concepto, metodo: x.metodo }));
      const contpaqiOnly = contpaqi.filter((x) => !x.used).map((x) => ({ poliza: x.poliza, fecha: x.fecha, importe: x.importe, dir: x.dir, concepto: x.concepto }));

      const sum = (a: any[]) => r2(a.reduce((s, r) => s + r.importe, 0));
      return {
        period,
        account: { bank: acct.bank, account_label: acct.account_label, contpaqi_cuenta: acct.contpaqi_cuenta, contpaqi_nombre: acct.contpaqi_cuenta_nombre, linked_cpq: !!acct.contpaqi_cuenta },
        excel: excelRows,
        kepler_only: keplerOnly,
        contpaqi_only: contpaqiOnly,
        totals: {
          excel_n: excel.length, excel_monto: sum(excel),
          excel_en_kepler: excelRows.filter((r) => r.kepler).length, excel_en_contpaqi: excelRows.filter((r) => r.contpaqi).length,
          kepler_only_n: keplerOnly.length, kepler_only_monto: sum(keplerOnly),
          contpaqi_only_n: contpaqiOnly.length, contpaqi_only_monto: sum(contpaqiOnly),
        },
      };
    });
  }

  /**
   * CB.11 — Verifica el PARSEO contra la hoja CONCENTRADO (finance.bank_concentrado_ref):
   * agrega bank_movements por cuenta × tipo-M y compara contra la referencia humana
   * (la verdad que contabilidad ya cuadró). Δ≠0 en cualquier tipo = error de captura
   * NUESTRO, detectado de una vez (no por muestreo). Los tipos S/DS (pares Spei/DevSpei)
   * se reportan aparte: el CONCENTRADO los excluye por lavarse. Candado de regresión.
   */
  async parseCheck(period?: string) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    const CONC_TYPES = ['I', 'ID', 'LEM', 'CI', 'C', 'CF', 'PF', 'P', 'PLEM', 'G', 'TI', 'TE'];
    const digits = (s: any) => String(s || '').replace(/\D/g, '');
    return this.tk.run(async (trx) => {
      const ref = await trx('finance.bank_concentrado_ref').where({ period })
        .select('bank', 'cuenta', 'account_key', 'tipo', 'monto');
      if (!ref.length) return { period, tiene_referencia: false, ok: null,
        mensaje: 'No hay hoja CONCENTRADO cargada para este periodo (corre import-concentrado).' };

      const refByAcct: Record<string, { bank: string; cuenta: string; t: Record<string, number> }> = {};
      for (const r of ref as any[]) { (refByAcct[r.account_key] ||= { bank: r.bank, cuenta: r.cuenta, t: {} }).t[r.tipo] = n(r.monto); }

      const mv = await trx('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .where('st.period', period).whereNull('bm.deleted_at')
        .groupBy('ba.bank', 'ba.account_label', 'ba.alias', 'bm.raw_type')
        .select('ba.account_label as lbl', 'ba.bank', 'ba.alias', trx.raw('UPPER(bm.raw_type) as rt'),
          trx.raw('SUM(bm.amount_in + bm.amount_out)::numeric as monto'));
      const dbByAcct: Record<string, { bank: string; lbl: string; alias: string; t: Record<string, number> }> = {};
      for (const r of mv as any[]) { const k = `${r.bank}|${r.lbl}`;
        (dbByAcct[k] ||= { bank: r.bank, lbl: r.lbl, alias: String(r.alias || '').toUpperCase(), t: {} });
        dbByAcct[k].t[r.rt] = (dbByAcct[k].t[r.rt] || 0) + n(r.monto); }

      const matchRef = (d: any): [string, any] | null => {
        const dd = digits(d.lbl), dbank = String(d.bank).toUpperCase();
        for (const [k, e] of Object.entries(refByAcct)) {
          const kd = digits(k);
          if (kd && dd && (kd === dd || (kd.length >= 3 && dd.endsWith(kd)) || (dd.length >= 3 && kd.endsWith(dd)))) return [k, e];
          const tok = String(k).toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (tok && d.alias.replace(/[^A-Z0-9]/g, '').includes(tok)) return [k, e];
          if (!kd && !dd && (String(e.bank).toUpperCase().startsWith(dbank) || dbank.startsWith(String(e.bank).toUpperCase().slice(0, 4)))) return [k, e];
        }
        return null;
      };

      const cuentas: any[] = []; let totalDelta = 0; const usedRef = new Set<string>();
      for (const d of Object.values(dbByAcct)) {
        const m = matchRef(d);
        if (!m) { cuentas.push({ bank: d.bank, cuenta: d.lbl, matched: false, nota: 'sin fila en CONCENTRADO' }); continue; }
        const [rk, e] = m; usedRef.add(rk);
        const byType: Record<string, number> = {}; const extras: Record<string, number> = {};
        for (const [rt, v] of Object.entries(d.t)) { if (CONC_TYPES.includes(rt)) byType[rt] = (byType[rt] || 0) + v; else extras[rt] = (extras[rt] || 0) + v; }
        const diffs: any[] = [];
        for (const ty of CONC_TYPES) { const ex = e.t[ty] || 0, ob = byType[ty] || 0; const delta = Math.round((ob - ex) * 100) / 100;
          if (Math.abs(delta) >= 1) { diffs.push({ tipo: ty, excel: ex, db: ob, delta }); totalDelta += Math.abs(delta); } }
        cuentas.push({ bank: e.bank, cuenta: e.cuenta, matched: true, diffs,
          extras: Object.entries(extras).filter(([, v]) => Math.abs(v) >= 1).map(([tipo, monto]) => ({ tipo, monto: Math.round(monto) })) });
      }
      const refSinCuenta = Object.entries(refByAcct).filter(([k]) => !usedRef.has(k)).map(([, e]) => ({ bank: e.bank, cuenta: e.cuenta }));
      totalDelta = Math.round(totalDelta * 100) / 100;
      return { period, tiene_referencia: true, ok: totalDelta < 1, total_delta: totalDelta,
        cuentas_ok: cuentas.filter((c) => c.matched && !c.diffs?.length).length,
        cuentas_total: cuentas.length, cuentas, ref_sin_cuenta: refSinCuenta };
    });
  }

  /**
   * CB.13 (Fase 1) — Búsqueda en el catálogo REAL de cuentas de Kepler (finance.kepler_accounts,
   * canónico almacén 00). Por clave o descripción — réplica del "Búsqueda de cuentas" de Kepler.
   * Sirve para mapear/consultar contra el catálogo real en vez de adivinar.
   */
  async keplerAccounts(search?: string, limit = 60) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const q = trx('finance.kepler_accounts')
        .select('cuenta', 'cuenta_nombre', 'cuenta_mayor', 'cuenta_mayor_nombre', 'es_mayor')
        .orderBy('cuenta').limit(Math.min(limit, 200));
      const s = String(search || '').trim();
      if (s) q.where((b) => b.where('cuenta', 'ilike', `%${s}%`).orWhere('cuenta_nombre', 'ilike', `%${s}%`));
      return q;
    });
  }

  /**
   * CB.2.1 — Import web del workbook Excel (mismo parse+clasificación que el CLI CB.1).
   * Recibe el .xlsx en base64 + periodo; puebla bank_statements + bank_movements
   * (UPSERT por client_uuid, no DELETE). Devuelve resumen por cuenta + grupos.
   */
  async importWorkbook(fileBase64: string, period: string, sourceFile?: string, actor?: string) {
    if (!fileBase64) throw new BadRequestException('archivo requerido');
    const b64 = fileBase64.includes(',') ? fileBase64.split(',').pop()! : fileBase64;
    return this.importFromBuffer(Buffer.from(b64, 'base64'), period, sourceFile, actor, 'upload');
  }

  /**
   * CB.23 — Núcleo del import (buffer). Lo reusan el upload web (base64) y el sync
   * del Google Sheet (SheetSyncService baja el .xlsx de la URL de export). `syncSource`
   * marca el origen; cuando es 'sheet' corre el barrido soft-delete (marca deleted_at
   * las filas que ya NO aparecen en el pull, acotado a periodo × cuentas del archivo).
   */
  async importFromBuffer(buf: Buffer, period: string, sourceFile?: string, actor?: string, syncSource: 'upload' | 'sheet' = 'upload') {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!buf?.length) throw new BadRequestException('archivo vacío');
    if (!/^\d{4}-\d{2}$/.test(period || '')) throw new BadRequestException('periodo inválido (YYYY-MM)');

    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf as any); } catch { throw new BadRequestException('no se pudo leer el Excel'); }
    // CB.23.1 — omite hojas resumen/consolidadas: MOVIMIENTOS GENERAL (unión de todas las
    // cuentas → duplicaría todo), RESUMEN DE SALDOS, POR IDENTIFICAR, y las históricas.
    const sheets = wb.worksheets.filter((s) => !/TOTAL MOV|MOVIMIENTOS GENERAL|CONCENTRADO|RESUMEN DE SALDOS|POR IDENTIFICAR|FilterDatabase/i.test(s.name));

    return this.tk.run(async (trx) => {
      // t0 = reloj del servidor al inicio; el barrido marca borrado lo no tocado en este pull
      // (cada upsert bumpea updated_at ≥ t0; lo que quedó < t0 es lo que desapareció del Sheet).
      const t0 = (await trx.select(trx.raw('now() as now')).first() as any)?.now;
      const catMap = new Map<string, { id: string; group: string }>(
        (await trx('finance.movement_categories').select('id', 'code', 'group_key'))
          .map((r: any) => [r.code, { id: r.id, group: r.group_key }]));
      const acctMap = new Map<string, any>(
        (await trx('finance.bank_accounts').select('id', 'alias', 'account_label'))
          .map((r: any) => [normKey(r.alias), r]));
      const compiled = compileRules(
        await trx('finance.bank_classify_rules').where({ active: true })
          .select('priority', 'match_type', 'match_code', 'match_concept', 'category_code'));

      const perAccount: any[] = [];
      const byGroup: Record<string, { in: number; out: number; n: number }> = {};
      let grandIn = 0, grandOut = 0, grandUncat = 0, grandRows = 0;
      const processedAcctIds = new Set<string>();

      for (const ws of sheets) {
        let hRow = 0; const col: Record<string, number> = {};
        for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
          const u = (ws.getRow(r).values as any[]).map((v) => normKey(v));
          const hasFecha = u.some((v) => v === 'FECHA');
          // CB.23.1 — CAJA GENERAL no rotula FECHA (la fecha va en la col antes de M);
          // detectamos su header por CTA/CUENTA + una columna de importe.
          const hasCajaHdr = u.some((v) => v === 'CTA' || v === 'CUENTA') &&
            u.some((v) => v === 'EGRESO' || v === 'INGRESO' || v === 'RETIRO' || v === 'DEPOSITO');
          if (hasFecha || hasCajaHdr) { hRow = r; u.forEach((v, i) => { if (v) col[v] = i; }); break; }
        }
        const acct = acctMap.get(normKey(ws.name));
        // Alias de columnas: hojas de banco (C/PROVEEDOR/RETIRO/DEPOSITO/SALDO) y
        // CAJA GENERAL (CTA/DESCRIPCION/EGRESO/INGRESO, sin SALDO — trae ARQUEO/DIF).
        // Sin header FECHA (CAJA GENERAL) la fecha es la columna justo antes de M.
        const ci = {
          fecha: col['FECHA'] || (col['M'] ? col['M'] - 1 : 0), m: col['M'], s: col['S'],
          c: col['C'] || col['CTA'], prov: col['PROVEEDOR'] || col['DESCRIPCION'],
          ret: col['RETIRO'] || col['EGRESO'], dep: col['DEPOSITO'] || col['INGRESO'],
          saldo: col['SALDO'], folio: col['#'] || col['FOLIO'],
        };
        if (!hRow || !ci.fecha || (!ci.ret && !ci.dep)) { perAccount.push({ sheet: ws.name, note: 'layout no estándar — omitido' }); continue; }
        if (!acct) { perAccount.push({ sheet: ws.name, note: 'cuenta no registrada — omitido' }); continue; }
        processedAcctIds.add(acct.id);

        const rows: any[] = []; const seen = new Map<string, number>();
        let tin = 0, tout = 0, uncat = 0, lastBal: number | null = null, openingBal: number | null = null;
        for (let r = hRow + 1; r <= ws.rowCount; r++) {
          const row = ws.getRow(r);
          const date = excelDate(cellVal(row, ci.fecha));
          if (!date) continue;
          const amtIn = money(cellVal(row, ci.dep)), amtOut = money(cellVal(row, ci.ret));
          if (amtIn === 0 && amtOut === 0) continue;
          const M = String(cellVal(row, ci.m) ?? '').trim(), C = String(cellVal(row, ci.c) ?? '').trim(), S = String(cellVal(row, ci.s) ?? '').trim();
          const concept = String(cellVal(row, ci.prov) ?? '').replace(/\s+/g, ' ').trim();
          const bal = ci.saldo ? money(cellVal(row, ci.saldo)) : null;
          const catCode = classifyWith(compiled, M, C, concept);
          const cat = catMap.get(catCode);
          const catId = catCode === 'sin_clasificar' ? null : (cat ? cat.id : null);
          const group = catCode === 'sin_clasificar' ? 'sin_clasificar' : (cat ? cat.group : 'sin_clasificar');
          if (!catId) uncat++;
          (byGroup[group] ||= { in: 0, out: 0, n: 0 }); byGroup[group].in += amtIn; byGroup[group].out += amtOut; byGroup[group].n++;
          tin += amtIn; tout += amtOut; if (bal !== null) lastBal = bal;
          // Saldo inicial = saldo (running) tras el primer movimiento − su neto. Habilita el cuadre de saldos (CB.8).
          if (openingBal === null && bal !== null) openingBal = Math.round((bal - amtIn + amtOut) * 100) / 100;
          const contentKey = `${acct.account_label}|${period}|${date}|${M}|${C}|${concept}|${amtIn}|${amtOut}`;
          const occ = (seen.get(contentKey) || 0) + 1; seen.set(contentKey, occ);
          const clientUuid = crypto.createHash('sha1').update(`${contentKey}|${occ}`).digest('hex');
          rows.push({ tenant_id: tenantId, bank_account_id: acct.id, movement_date: date, category_id: catId,
            classified_by: 'rule', sync_source: syncSource, deleted_at: null,
            raw_type: M || null, raw_code: C || null, sucursal: S || null, concept: concept || null,
            amount_in: amtIn, amount_out: amtOut, running_balance: bal, client_uuid: clientUuid, source_file: sourceFile || null });
        }

        const [st] = await trx('finance.bank_statements')
          .insert({ tenant_id: tenantId, bank_account_id: acct.id, period,
            opening_balance: openingBal ?? 0, closing_balance: lastBal ?? 0,
            total_in: Math.round(tin * 100) / 100, total_out: Math.round(tout * 100) / 100,
            source_file: sourceFile || null, status: 'imported', imported_at: trx.fn.now(), imported_by: actor || null })
          .onConflict(['tenant_id', 'bank_account_id', 'period'])
          .merge(['opening_balance', 'closing_balance', 'total_in', 'total_out', 'source_file', 'imported_at', 'updated_at'])
          .returning('id');
        const statementId = (st as any).id;
        for (const r of rows) r.statement_id = statementId;
        for (let i = 0; i < rows.length; i += 500) {
          await trx('finance.bank_movements').insert(rows.slice(i, i + 500))
            .onConflict(['tenant_id', 'client_uuid'])
            // No pisa category_id/classified_by en re-import: preserva la reclasificación
            // manual y la clasificación previa. Para re-aplicar reglas → reclassifyAll().
            // `deleted_at`→null revive una fila que volvió a aparecer en el Sheet tras un
            // barrido; `sync_source` refleja que ahora la fuente es el Sheet.
            .merge(['statement_id', 'bank_account_id', 'movement_date', 'raw_type', 'raw_code',
              'sucursal', 'concept', 'amount_in', 'amount_out', 'running_balance', 'source_file',
              'sync_source', 'deleted_at', 'updated_at']);
        }

        grandIn += tin; grandOut += tout; grandUncat += uncat; grandRows += rows.length;
        perAccount.push({ sheet: ws.name, movs: rows.length, deposits: Math.round(tin), withdrawals: Math.round(tout), sin_clasificar: uncat });
      }

      // CB.23.3 — Barrido soft-delete (solo sync del Sheet): marca deleted_at las filas
      // 'sheet' del periodo × cuentas presentes en ESTE pull que ya no fueron tocadas
      // (updated_at < t0 = desaparecieron del Sheet). Nunca toca filas 'upload' (manuales).
      let swept = 0;
      if (syncSource === 'sheet' && processedAcctIds.size && t0) {
        swept = await trx('finance.bank_movements as bm')
          .whereIn('bm.statement_id', trx('finance.bank_statements').where({ period })
            .whereIn('bank_account_id', [...processedAcctIds]).select('id'))
          .where('bm.sync_source', 'sheet').whereNull('bm.deleted_at').where('bm.updated_at', '<', t0)
          .update({ deleted_at: trx.fn.now(), recon_status: 'ignored', updated_at: trx.fn.now() });
      }

      this.logger.log(`import banco periodo ${period} (${syncSource}): ${grandRows} movs, ${grandUncat} sin_clasificar, ${swept} borrados, por ${actor || '?'}`);
      return { period, accounts: perAccount, byGroup, total: grandRows, deposits: grandIn, withdrawals: grandOut, sin_clasificar: grandUncat, swept };
    });
  }
}
