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

  /** Catálogo de Cuentas XML del periodo. FE.11: usa el mapeo cuenta mayor → CodAgrupador SAT. */
  async catalogoXml(period: string, rfcParam?: string): Promise<string> {
    const p = this.normPeriod(period);
    const tid = this.tenantCtx.requireTenantId();
    const rfc = await this.resolveRfc(rfcParam);

    const { rows, map } = await this.tk.run(async (trx) => {
      const r = await trx.raw(
        `SELECT cuenta, MAX(cuenta_nombre) nombre, MAX(cuenta_mayor) mayor, MAX(familia) familia
           FROM analytics.ledger_monthly
          WHERE tenant_id = :tid AND anio_mes <= :period
          GROUP BY cuenta
          ORDER BY cuenta`,
        { tid, period: p },
      );
      // Mapeo CodAgrupador (RLS activa en el session de tk.run).
      const mm = await trx('fiscal.cod_agrupador_map').select('cuenta_mayor', 'cod_agrupador', 'natur');
      const map = new Map<string, { cod: string; natur: string | null }>(
        mm.map((x: any) => [String(x.cuenta_mayor), { cod: x.cod_agrupador, natur: x.natur }]),
      );
      return { rows: r.rows as any[], map };
    });

    const [anio, mes] = p.split('-');
    const ctas = rows.map((r) => {
      const nivel = String(r.cuenta).includes('-') ? 2 : 1;
      const mayor = String(r.mayor || String(r.cuenta).split('-')[0]);
      const subCtaDe = nivel === 2 ? ` SubCtaDe="${this.esc(mayor)}"` : '';
      const mapped = map.get(mayor);
      // CodAgrupador del catálogo SAT; si el mayor no está mapeado, cae al placeholder (mayor).
      const codAgrup = this.esc(mapped?.cod || mayor);
      const natur = (mapped?.natur as 'D' | 'A' | null) || this.natur(r.familia);
      return `  <catalogocuentas:Ctas CodAgrupador="${codAgrup}" NumCta="${this.esc(r.cuenta)}" Desc="${this.esc(r.nombre || r.cuenta)}"${subCtaDe} Nivel="${nivel}" Natur="${natur}"/>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<catalogocuentas:Catalogo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="${this.NS_CAT} ${this.NS_CAT}/CatalogoCuentas_1_3.xsd" ` +
      `xmlns:catalogocuentas="${this.NS_CAT}" Version="1.3" RFC="${this.esc(rfc)}" Mes="${mes}" Anio="${anio}">\n${ctas}\n</catalogocuentas:Catalogo>\n`;
  }

  // ── FE.11: mapeo cuenta mayor → código agrupador SAT ────────────────────────

  /**
   * Lista todas las cuentas mayor que aparecen en la balanza, con su mapeo SAT
   * (o null si aún no mapeada). Es la vista que edita el contador. `en_uso` = la
   * cuenta mayor tiene movimientos en la balanza (siempre true aquí, útil si a
   * futuro se listan cuentas del mapeo sin uso).
   */
  async listCodAgrupador(): Promise<Array<{
    cuenta_mayor: string; nombre: string | null; familia: string | null;
    cod_agrupador: string | null; natur: string | null; source: string | null;
    natur_default: 'D' | 'A';
  }>> {
    const tid = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(
        `WITH mayores AS (
           SELECT cuenta_mayor,
                  MAX(cuenta_mayor_nombre) AS nombre,
                  MAX(familia) AS familia
             FROM analytics.ledger_monthly
            WHERE tenant_id = :tid AND cuenta_mayor IS NOT NULL AND btrim(cuenta_mayor) <> ''
            GROUP BY cuenta_mayor)
         SELECT x.cuenta_mayor, x.nombre, x.familia,
                m.cod_agrupador, m.natur, m.source
           FROM mayores x
           LEFT JOIN fiscal.cod_agrupador_map m
             ON m.cuenta_mayor = x.cuenta_mayor AND m.tenant_id = :tid
          ORDER BY x.cuenta_mayor`,
        { tid },
      );
      return (r.rows as any[]).map((row) => ({
        cuenta_mayor: row.cuenta_mayor,
        nombre: row.nombre,
        familia: row.familia,
        cod_agrupador: row.cod_agrupador,
        natur: row.natur,
        source: row.source,
        natur_default: this.natur(row.familia),
      }));
    });
  }

  /**
   * Auto-sugerencia: siembra un mapeo `source='auto'` para cada cuenta mayor de la
   * balanza que aún no tenga mapeo, usando la propia cuenta mayor como código
   * (muchos catálogos MX ya numeran el mayor alineado al agrupador SAT). Es un
   * PUNTO DE PARTIDA que el contador debe revisar/corregir. Idempotente: no pisa
   * los ya mapeados (manual ni auto). Devuelve cuántos sembró.
   */
  async suggestCodAgrupador(): Promise<{ inserted: number }> {
    const tid = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(
        `INSERT INTO fiscal.cod_agrupador_map (tenant_id, cuenta_mayor, cod_agrupador, source)
         SELECT :tid, x.cuenta_mayor, x.cuenta_mayor, 'auto'
           FROM (SELECT DISTINCT cuenta_mayor FROM analytics.ledger_monthly
                  WHERE tenant_id = :tid AND cuenta_mayor IS NOT NULL AND btrim(cuenta_mayor) <> '') x
           LEFT JOIN fiscal.cod_agrupador_map m
             ON m.cuenta_mayor = x.cuenta_mayor AND m.tenant_id = :tid
          WHERE m.cuenta_mayor IS NULL
          ON CONFLICT (tenant_id, cuenta_mayor) DO NOTHING`,
        { tid },
      );
      return { inserted: r.rowCount ?? 0 };
    });
  }

  /** Set/override manual de un mapeo (source='manual'). */
  async upsertCodAgrupador(input: { cuenta_mayor: string; cod_agrupador: string; natur?: string | null }) {
    const tid = this.tenantCtx.requireTenantId();
    const mayor = String(input?.cuenta_mayor || '').trim();
    const cod = String(input?.cod_agrupador || '').trim();
    if (!mayor) throw new BadRequestException('cuenta_mayor requerida');
    if (!/^[0-9]{3}(\.[0-9]{1,3})?$/.test(cod)) {
      throw new BadRequestException('cod_agrupador inválido: formato SAT esperado NNN o NNN.NN (ej. 105.01).');
    }
    const natur = input?.natur ? String(input.natur).toUpperCase() : null;
    if (natur && natur !== 'D' && natur !== 'A') throw new BadRequestException('natur inválida (D|A).');
    return this.tk.run(async (trx) => {
      const [row] = await trx('fiscal.cod_agrupador_map')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          cuenta_mayor: mayor,
          cod_agrupador: cod,
          natur,
          source: 'manual',
          updated_at: trx.fn.now(),
        })
        .onConflict(['tenant_id', 'cuenta_mayor'])
        .merge({ cod_agrupador: cod, natur, source: 'manual', updated_at: trx.fn.now() })
        .returning('*');
      return row;
    });
  }

  /** Elimina un mapeo (la cuenta vuelve a caer al placeholder). */
  async deleteCodAgrupador(cuentaMayor: string) {
    const mayor = String(cuentaMayor || '').trim();
    if (!mayor) throw new BadRequestException('cuenta_mayor requerida');
    return this.tk.run(async (trx) => {
      const n = await trx('fiscal.cod_agrupador_map').where({ cuenta_mayor: mayor }).del();
      return { deleted: n };
    });
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
