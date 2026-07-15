import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * FISCAL.9 — Contabilidad Electrónica (XMLs que exige el SAT).
 *
 * Genera desde analytics.ledger_monthly (balanza consolidada por todas las
 * sucursales del tenant), determinista:
 *   - Balanza de Comprobación (BCE 1.3): SaldoIni/Debe/Haber/SaldoFin por cuenta.
 *     SaldoIni = Σ neto de los meses previos del mismo ejercicio; SaldoFin =
 *     SaldoIni + Debe − Haber.
 *   - Catálogo de Cuentas (catalogocuentas 1.3): NumCta/Desc/Nivel/Natur.
 *
 * ⚠️ `CodAgrupador` (código agrupador del SAT) NO existe en Kepler: se usa el mayor
 * como placeholder. Para XML 100% válido ante el SAT hace falta el mapeo
 * cuenta_mayor → código agrupador SAT (tabla a proveer). Marcado como pendiente.
 *
 * `analytics.ledger_monthly` no tiene RLS → filtro de tenant explícito.
 */
@Injectable()
export class ContabilidadElectronicaService {
  private readonly NS_BCE = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion';
  private readonly NS_CAT = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas';

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Balanza de Comprobación XML del periodo. tipoEnvio: 'N' normal · 'C' complementaria. */
  async balanzaXml(period: string, tipoEnvio: 'N' | 'C' = 'N', rfcParam?: string): Promise<string> {
    const p = this.normPeriod(period);
    const tid = this.tenantCtx.requireTenantId();
    const rfc = await this.resolveRfc(rfcParam);
    const yearStart = `${p.slice(0, 4)}-01`;

    const rows = await this.tk.run(async (trx) => {
      const r = await trx.raw(
        `WITH mes AS (
           SELECT cuenta, MAX(cuenta_nombre) nombre, SUM(cargos) debe, SUM(abonos) haber, SUM(neto) neto_mes
             FROM analytics.ledger_monthly
            WHERE tenant_id = :tid AND anio_mes = :period
            GROUP BY cuenta),
         ini AS (
           SELECT cuenta, MAX(cuenta_nombre) nombre, SUM(neto) saldo_ini
             FROM analytics.ledger_monthly
            WHERE tenant_id = :tid AND anio_mes >= :yearStart AND anio_mes < :period
            GROUP BY cuenta)
         SELECT COALESCE(m.cuenta, i.cuenta) AS cuenta,
                COALESCE(m.nombre, i.nombre) AS nombre,
                COALESCE(i.saldo_ini,0) AS saldo_ini,
                COALESCE(m.debe,0) AS debe, COALESCE(m.haber,0) AS haber,
                COALESCE(i.saldo_ini,0) + COALESCE(m.neto_mes,0) AS saldo_fin
           FROM mes m FULL OUTER JOIN ini i ON m.cuenta = i.cuenta
          ORDER BY 1`,
        { tid, period: p, yearStart },
      );
      return r.rows as any[];
    });

    const [anio, mes] = p.split('-');
    const ctas = rows.map((r) =>
      `  <BCE:Ctas NumCta="${this.esc(r.cuenta)}" SaldoIni="${this.n(r.saldo_ini)}" Debe="${this.n(r.debe)}" Haber="${this.n(r.haber)}" SaldoFin="${this.n(r.saldo_fin)}"/>`,
    ).join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<BCE:Balanza xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="${this.NS_BCE} ${this.NS_BCE}/BalanzaComprobacion_1_3.xsd" ` +
      `xmlns:BCE="${this.NS_BCE}" Version="1.3" RFC="${this.esc(rfc)}" Mes="${mes}" Anio="${anio}" ` +
      `TipoEnvio="${tipoEnvio}" FechaModBal="${this.finDeMes(p)}">\n${ctas}\n</BCE:Balanza>\n`;
  }

  /** Catálogo de Cuentas XML del periodo. */
  async catalogoXml(period: string, rfcParam?: string): Promise<string> {
    const p = this.normPeriod(period);
    const tid = this.tenantCtx.requireTenantId();
    const rfc = await this.resolveRfc(rfcParam);

    const rows = await this.tk.run(async (trx) => {
      const r = await trx.raw(
        `SELECT cuenta, MAX(cuenta_nombre) nombre, MAX(cuenta_mayor) mayor, MAX(familia) familia
           FROM analytics.ledger_monthly
          WHERE tenant_id = :tid AND anio_mes <= :period
          GROUP BY cuenta
          ORDER BY cuenta`,
        { tid, period: p },
      );
      return r.rows as any[];
    });

    const [anio, mes] = p.split('-');
    const ctas = rows.map((r) => {
      const nivel = String(r.cuenta).includes('-') ? 2 : 1;
      const subCtaDe = nivel === 2 ? ` SubCtaDe="${this.esc(r.mayor || String(r.cuenta).split('-')[0])}"` : '';
      const codAgrup = this.esc(r.mayor || String(r.cuenta).split('-')[0]); // ⚠️ placeholder (falta mapeo SAT)
      return `  <catalogocuentas:Ctas CodAgrupador="${codAgrup}" NumCta="${this.esc(r.cuenta)}" Desc="${this.esc(r.nombre || r.cuenta)}"${subCtaDe} Nivel="${nivel}" Natur="${this.natur(r.familia)}"/>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<catalogocuentas:Catalogo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="${this.NS_CAT} ${this.NS_CAT}/CatalogoCuentas_1_3.xsd" ` +
      `xmlns:catalogocuentas="${this.NS_CAT}" Version="1.3" RFC="${this.esc(rfc)}" Mes="${mes}" Anio="${anio}">\n${ctas}\n</catalogocuentas:Catalogo>\n`;
  }

  /** RFC del contribuyente: param explícito o la e.firma activa del tenant. */
  private async resolveRfc(rfcParam?: string): Promise<string> {
    if (rfcParam && /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(rfcParam.toUpperCase())) return rfcParam.toUpperCase();
    const row = await this.tk.run(async (trx) => trx('fiscal.sat_credentials').where({ active: true }).orderBy('updated_at', 'desc').first('rfc'));
    if (!row?.rfc) throw new BadRequestException('Sin RFC: pasa ?rfc= o registra la e.firma del contribuyente (FISCAL.2).');
    return String(row.rfc).toUpperCase();
  }

  /** Naturaleza contable por familia (primer dígito): D deudora · A acreedora. */
  private natur(familia: string | null): 'D' | 'A' {
    const f = String(familia || '').charAt(0);
    return (f === '1' || f === '5' || f === '6' || f === '7') ? 'D' : 'A'; // 1 activo, 5/6/7 costos/gastos = D; 2 pasivo, 3 capital, 4 ingresos = A
  }

  private n(v: unknown): string { const x = Number(v); return (Number.isFinite(x) ? x : 0).toFixed(2); }
  private esc(s: unknown): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  private normPeriod(period: string): string {
    const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) throw new BadRequestException(`period inválido (esperado YYYY-MM): ${period}`);
    return `${m[1]}-${m[2]}`;
  }
  private finDeMes(p: string): string {
    const [y, m] = p.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${p}-${String(last).padStart(2, '0')}`;
  }
}
