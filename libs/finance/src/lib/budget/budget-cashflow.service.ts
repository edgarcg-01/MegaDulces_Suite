import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService, evalInput, composeFreshness } from '@megadulces/platform-core';
import type { Coverage } from '@megadulces/contracts';
import { cobranzaPrevista } from '../customer-ledger/cobranza-prevista';
import { deudaPrevista } from '../creditor-statements/deuda-prevista';

/**
 * Fase PU.3 — Presupuestos: flujo de efectivo previsto (ADR-066 / ADR-056).
 *
 * Cierra "tener presupuesto ≠ tener liquidez" (spec §1). Proyección semanal:
 *   saldo_proyectado(t) = saldo_inicial + Σ(cobros − pagos) hasta t     (spec §10)
 *
 * Fuentes (lectura/vista, cero importers):
 *   - Saldo inicial  → `finance.bank_movements.running_balance` (última por cuenta, Fase CB).
 *   - Cobros previstos → `analytics.customer_receivables.saldo_documento` por `vencimiento` (Fase CXC, kdue).
 *   - Pagos previstos  → pendiente (original − pagado) de las 3 tablas de obligación (Fase TP), por
 *                        `negotiated_date ?? original_due_date` — el mismo pendiente que consume el
 *                        Calendario de Pagos, sin doble-conteo (se usa la obligación, no la allocation).
 *
 * ⚠️ «Sin datos» ≠ cero (ADR-056): si bancos no tiene movimientos, el **saldo inicial se DECLARA
 * no disponible** (`available:false`, `null`) y el `saldo_proyectado` absoluto queda en `null` — se
 * sigue mostrando el NETO por semana (cobros − pagos), que sí es real. Una semana sin obligaciones es
 * 0 real (no "sin datos"): la ausencia de fuente y el cero de negocio son distintos.
 */

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export interface CashflowOpts { from?: string; to?: string }

@Injectable()
export class BudgetCashflowService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async projection(opts: CashflowOpts = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const from = opts.from ?? new Date().toISOString().slice(0, 10);
    const to = opts.to ?? this.addDays(from, 56); // 8 semanas por default
    if (!DATE_RX.test(from) || !DATE_RX.test(to)) throw new BadRequestException('Fechas inválidas (YYYY-MM-DD)');
    if (to < from) throw new BadRequestException('`to` no puede ser anterior a `from`');

    return this.tk.run(async (trx) => {
      // ── Saldo inicial (bancos) — DECLARADO, no asumido ────────────────────────
      // [TES.3] El saldo se ancla a la ÚLTIMA fila por cuenta, así que una sola fila con fecha
      // imposible lo secuestra. Medido en prod el 2026-10-08: 17 filas fechadas 2027-08-06 y 6
      // en el año 0206 (un 2026 mal tecleado). De las 20 cuentas, UNA quedaba anclada al futuro
      // y el saldo publicado era $3,105,321.19 contra $2,588,183.56 reales: **$517,137.63 de
      // aire, +19.98%**.
      //
      // ⛔ Y el daño mayor no era el saldo: `as_of` salía del mismo `max(movement_date)`, o sea
      // **2027-08-06**. Una fecha futura nunca tiene más de 30 días, así que `evalInput` la
      // califica fresca SIEMPRE. El detector de rancidez de bancos estaba ciego: si el feed se
      // cortara hoy, la píldora seguiría diciendo "fresco" hasta agosto de 2027.
      //
      // ⚠️ `movement_date <= current_date` NO alcanza: las filas del año 0206 pasan ese filtro.
      // Va acotado por los dos lados. Las anómalas NO se borran — se declaran para que
      // contabilidad las reclasifique.
      const PISO_BANCOS = '2015-01-01';
      const sano = (qb: any) => qb.where({ tenant_id: tenantId }).whereNull('deleted_at')
        .whereRaw('movement_date BETWEEN ?::date AND current_date', [PISO_BANCOS]);

      const [bank] = await sano(trx('finance.bank_movements'))
        .select(trx.raw('count(*)::int AS n'), trx.raw('max(movement_date) AS as_of'));
      const [anom] = await trx('finance.bank_movements')
        .where({ tenant_id: tenantId }).whereNull('deleted_at')
        .whereRaw('movement_date NOT BETWEEN ?::date AND current_date', [PISO_BANCOS])
        .select(
          trx.raw('count(*)::int AS n'),
          trx.raw('count(*) FILTER (WHERE movement_date > current_date)::int AS futuras'),
          trx.raw('count(*) FILTER (WHERE movement_date < ?::date)::int AS absurdas', [PISO_BANCOS]),
          trx.raw('min(movement_date) AS min'), trx.raw('max(movement_date) AS max'),
        );

      let opening: {
        available: boolean; amount: number | null; as_of: string | null; source: string;
        reason?: string; anomalias?: Record<string, unknown>;
      };
      if (Number(bank.n) > 0) {
        // última running_balance por cuenta activa, sumada — sólo sobre filas con fecha posible
        const [agg] = await trx
          .with('ult', (qb) => sano(qb.distinctOn('bank_account_id').from('finance.bank_movements'))
            .select('bank_account_id', 'running_balance')
            .orderBy([{ column: 'bank_account_id' }, { column: 'movement_date', order: 'desc' }, { column: 'created_at', order: 'desc' }]))
          .from('ult').select(trx.raw('coalesce(sum(running_balance),0) AS saldo'));
        opening = { available: true, amount: round2(Number(agg.saldo)), as_of: bank.as_of, source: 'finance.bank_movements' };
      } else {
        opening = { available: false, amount: null, as_of: null, source: 'finance.bank_movements', reason: 'Sin movimientos bancarios cargados (Fase CB) para este tenant' };
      }
      if (Number(anom.n) > 0) {
        opening.anomalias = {
          filas: Number(anom.n), futuras: Number(anom.futuras), absurdas: Number(anom.absurdas),
          rango: { min: anom.min, max: anom.max },
          efecto: 'Excluidas del saldo y de la frescura. No se borran: son del dominio de contabilidad.',
        };
      }

      // ── Cobros previstos (cartera CXC) por semana ─────────────────────────────
      // [CXC.22] Un solo resolvedor, compartido con `budget-capacity`. Suma `saldo_ajustado`
      // (no `saldo_documento`, que cuenta dos veces los abonos ya entrados) y devuelve la
      // COBERTURA: la ventana hacia adelante ve el 13.5% de la cartera cobrable.
      const prevista = await cobranzaPrevista(trx, tenantId, from, to);
      const cobros = prevista.porSemana.map((b) => ({ bucket: b.bucket, monto: b.monto }));
      const cobrosMeta = { as_of: prevista.as_of };

      // ── Pagos previstos (3 obligaciones) por semana ───────────────────────────
      // ⛔ [TES.10] El ejercicio de PRUEBA duplica las obligaciones. Medido en prod el
      // 2026-10-08: de las 312 de `budget.expense_obligations`, **156 cuelgan del FY2027 real y
      // 156 del duplicado marcado `is_test`**, por $74,809,091.57 cada mitad. Hoy no muerde
      // porque las 312 están en `propuesta` y el filtro de abajo las excluye — pero el día que
      // alguien autorice una, esta curva **contaría el doble** sin que nadie lo note.
      //
      // Se excluye por NOT EXISTS y no por JOIN a propósito: un JOIN descartaría también las
      // obligaciones **sin partida** (`budget_line_id IS NULL`), que no son de prueba, sólo no
      // están ligadas. La regla es «fuera sólo lo que PRUEBA que cuelga de un ejercicio de
      // prueba», nunca «fuera lo que no prueba que es real».
      // ⚠️ Sólo `budget.expense_obligations` cuelga de una partida: las otras dos **no tienen
      // `budget_line_id`** (verificado contra el catálogo de prod). Aplicarles el filtro
      // reventaría su consulta con «column does not exist» en runtime, no en compilación.
      const CUELGA_DE_PARTIDA = 'budget.expense_obligations';
      const sinDuplicado = (qb: any, table: string) => (table !== CUELGA_DE_PARTIDA ? qb
        : qb.whereNotExists((s: any) => s
          .select(s.client.raw('1')).from('budget.budget_lines AS bl')
          .join('budget.budgets AS bb', 'bb.id', 'bl.budget_id')
          .whereRaw('bl.id = budget_line_id').andWhere('bb.is_test', true)));

      const pagoSql = (table: string) => sinDuplicado(trx(table), table)
        .where({ tenant_id: tenantId }).whereNotIn('status', ['cancelled', 'propuesta'])
        .whereRaw('original_amount > paid_amount')
        .whereRaw('coalesce(negotiated_date, original_due_date) BETWEEN ? AND ?', [from, to])
        .select(
          trx.raw("date_trunc('week', coalesce(negotiated_date, original_due_date))::date AS bucket"),
          trx.raw('(original_amount - paid_amount) AS pending'),
        );
      const pagosUnion = pagoSql('budget.expense_obligations')
        .unionAll([pagoSql('commercial.supplier_payment_obligations'), pagoSql('finance.financial_commitments')]);
      const pagos = await trx.from(pagosUnion.as('u')).groupBy('bucket')
        .select('bucket', trx.raw('coalesce(sum(pending),0) AS monto'));

      // ── [TES.2] Deuda DERIVADA del ERP — el lado del pago dejaba de existir ──────
      // Medido en prod el 2026-10-08: las tres tablas de arriba no tienen ni una obligación
      // vigente (312 filas, las 312 'propuesta' y venciendo en 2027; 0 y 0 las otras dos), así
      // que esta curva publicaba $0 de pago en 8 semanas y se leía como liquidez excelente.
      // Lo que de verdad vence en la ventana, derivado de Kepler: $30,905,393.63.
      //
      // ⛔ NO se suma a `pagos`. Son DOS universos y su traslape NO está resuelto: una
      // obligación autorizada presumiblemente corresponde a una factura que ya está en el ERP,
      // y sumarlas contaría el mismo peso dos veces. La proyección usa la deuda del ERP (el
      // universo completo, sin captura humana de por medio) y las obligaciones autorizadas
      // viajan declaradas aparte. El día que alguien capture obligaciones, el traslape es un
      // hueco con nombre, no una suma silenciosa (ADR-056).
      const deuda = await deudaPrevista(trx, tenantId, from, to);

      // ── Ensamble semanal (semanas vacías = 0 real, no "sin datos") ────────────
      const cobMap = new Map(cobros.map((r: any) => [this.iso(r.bucket), Number(r.monto)]));
      const autMap = new Map(pagos.map((r: any) => [this.iso(r.bucket), Number(r.monto)]));
      const pagMap = new Map(deuda.porSemana.map((r) => [r.bucket, r.monto]));
      const weeks = this.weekBuckets(from, to);
      let acumNeto = 0;
      let saldo = opening.available ? (opening.amount as number) : null;
      let saldoMin: number | null = saldo;
      const buckets = weeks.map((wk) => {
        const c = round2(cobMap.get(wk) ?? 0);
        const p = round2(pagMap.get(wk) ?? 0);
        // Las obligaciones AUTORIZADAS viajan en su propia columna: no se suman a `p` (ver el
        // bloque [TES.2] arriba — el traslape con la deuda del ERP no está resuelto).
        const aut = round2(autMap.get(wk) ?? 0);
        const neto = round2(c - p);
        acumNeto = round2(acumNeto + neto);
        const saldoProy = opening.available ? round2((opening.amount as number) + acumNeto) : null;
        if (saldoProy != null) { saldo = saldoProy; if (saldoMin == null || saldoProy < saldoMin) saldoMin = saldoProy; }
        return {
          week: wk, cobros: c, pagos: p, pagos_autorizados: aut,
          neto, neto_acumulado: acumNeto, saldo_proyectado: saldoProy,
        };
      });

      // ── Alerta de insuficiencia — solo si hay saldo inicial (si no, se DECLARA) ─
      const alerts = opening.available
        ? buckets.filter((b) => (b.saldo_proyectado as number) < 0)
            .map((b) => ({ week: b.week, saldo_proyectado: b.saldo_proyectado, tipo: 'falta_liquidez' as const }))
        : [];

      return {
        period: { from, to, bucket: 'week' },
        opening_balance: opening,
        totals: {
          cobros: round2(buckets.reduce((s, b) => s + b.cobros, 0)),
          pagos: round2(buckets.reduce((s, b) => s + b.pagos, 0)),
          // Declarado, NO sumado a `pagos`: ver [TES.2]. Hoy es 0 en prod y eso es un hecho
          // de captura, no de negocio — la empresa sí paga (~$50.6M/mes medidos en Fase PP).
          pagos_autorizados: round2(buckets.reduce((s, b) => s + b.pagos_autorizados, 0)),
          neto: round2(acumNeto),
        },
        // [TES.2] La deuda que la curva NO dibuja, con su monto. Simétrico a la cobranza: lo ya
        // vencido es exigible y no tiene fecha comprometida, así que viaja aparte en vez de
        // caer en la semana 1 (que afirmaría que se paga el lunes).
        deuda_erp: {
          base: deuda.base,
          por_tipo: deuda.porTipo,
          cobertura: deuda.cobertura,
          // [TES.11] De cuántos proveedores depende lo que la curva dibuja. Medido: los 5
          // mayores son el 44.7% de la deuda y los 20 el 68.3%, sobre 397 — más concentrado
          // que la cartera. Dos curvas con el mismo total no son el mismo riesgo.
          concentracion: deuda.concentracion,
          as_of: deuda.as_of,
          as_of_reason: deuda.as_of_reason,
          fuente: 'analytics.v_supplier_payables (derivada de kepler_ods.kdxe/kdxf/kdxd)',
          clasificador: 'clasificarAcreedor() — creditor-statements.engine.ts',
        },
        saldo_minimo_proyectado: opening.available ? saldoMin : null,
        buckets,
        alerts,
        // [PU-VP] Procedencia declarada por el SERVER (ADR-056): frescura del peor eslabón + cobertura.
        freshness: composeFreshness([
          evalInput('cartera_cxc', 'Cartera / cobranza (kdue, CXC)', cobrosMeta?.as_of ?? null, 30),
          evalInput('bancos_cb', 'Bancos (Fase CB)', bank?.as_of ?? null, 30),
          // [TES.2] El ODS no publica marca de frescura en `kdxe`: entra con `null`, que
          // `evalInput` resuelve como `unknown`. Es el tercer estado de ADR-056 — ni fresco ni
          // rancio: NO MEDIDO. Fabricarle un `now()` diría "recién medido" sin haberlo medido.
          evalInput('deuda_erp', 'Deuda con proveedor (kdxe, ERP)', deuda.as_of, 30),
        ]),
        // [CXC.22] La cobertura ya no mide sólo si hay saldo inicial: mide **qué porción de la
        // cartera cobrable dibuja esta curva**. Con 86.5% de la cartera ya vencida, una curva
        // muda se lee como "esto es toda la cobranza que viene".
        coverage: {
          measured: opening.available && prevista.cobertura.pct_en_ventana != null,
          pct: prevista.cobertura.pct_en_ventana,
          note: [
            opening.available ? 'Saldo inicial de bancos disponible.'
              : 'Sin saldo inicial de bancos (Fase CB): el saldo proyectado va en null; el neto por semana sí es real.',
            prevista.cobertura.pct_en_ventana == null
              ? 'Sin cartera cobrable: la cobertura queda SIN MEDIR, no en cero.'
              : `La curva dibuja ${prevista.cobertura.pct_en_ventana}% de la cartera cobrable `
                + `($${prevista.cobertura.en_ventana.toLocaleString('en-US')} de `
                + `$${prevista.cobertura.total.toLocaleString('en-US')}). Quedan fuera `
                + `$${prevista.cobertura.vencido_fuera.toLocaleString('en-US')} ya vencidos: son `
                + 'exigibles HOY y no tienen fecha comprometida, por eso no se agendan en una semana.',
            // [TES.2] La cobertura del PAGO, simétrica. Sin esta línea la curva dibujaba una
            // fracción del pago sin decirlo, que es el mismo defecto que [CXC.22] corrigió del
            // lado del cobro — y en el lado del pago era peor, porque la fracción era CERO.
            deuda.cobertura.pct_en_ventana == null
              ? 'Sin deuda con proveedor derivable: la cobertura del pago queda SIN MEDIR, no en cero.'
              : `Del lado del pago la curva dibuja ${deuda.cobertura.pct_en_ventana}% de la deuda `
                + `($${deuda.cobertura.en_ventana.toLocaleString('en-US')} de `
                + `$${deuda.cobertura.total.toLocaleString('en-US')}). Quedan fuera `
                + `$${deuda.cobertura.vencido_fuera.toLocaleString('en-US')} ya vencidos, exigibles `
                + 'sin fecha comprometida. '
                + `Excluidos por no ser deuda con terceros: $${deuda.cobertura.interno_excluido.toLocaleString('en-US')} de traspasos internos.`,
          ].join(' '),
        } as Coverage,
        // [CXC.22] Lo vencido viaja APARTE, con su monto. Meterlo en la primera semana
        // afirmaría que se cobra completo el lunes, que es inventar una fecha.
        cobranza_cobertura: prevista.cobertura,
        // [TES.11] ⭐ Y la corrección que la medición impuso: el riesgo de concentración NO está
        // en el pronóstico. En la ventana los 5 mayores son el **15.7%** sobre 217 clientes; en
        // la masa VENCIDA son el **48.2%** sobre 1,095. El riesgo vive en lo que la curva
        // declara que no puede fechar, no en lo que dibuja — así que viajan las dos cifras.
        cobranza_concentracion: prevista.concentracion,
        sources: {
          cobros: { source: 'analytics.customer_receivables', base: prevista.base,
            as_of: cobrosMeta?.as_of ?? null },
          // [TES.2] `pagos` dejó de salir de las tres tablas de obligación (vacías de vigentes
          // en prod) y sale de la deuda derivada del ERP. Las obligaciones autorizadas siguen
          // publicándose, en `pagos_autorizados`, sin sumarse: el traslape no está resuelto.
          pagos: { source: 'analytics.v_supplier_payables', base: deuda.base, as_of: deuda.as_of },
          pagos_autorizados: { source: 'budget.expense_obligations + commercial.supplier_payment_obligations + finance.financial_commitments' },
          saldo_inicial: opening,
        },
        notes: {
          saldo_proyectado: opening.available
            ? 'saldo_proyectado = saldo_inicial + Σ(cobros − pagos) acumulado.'
            : 'Sin saldo inicial de bancos (Fase CB): el saldo_proyectado y la alerta de insuficiencia van en null. El NETO por semana sí es real.',
          no_doble_conteo: 'Pagos = pendiente (original − pagado) de la obligación, NO las allocations del Calendario (evita doble-conteo).',
          cobros_base: 'Cobros = `saldo_ajustado` (lo que hay que SALIR a cobrar), no '
            + '`saldo_documento`: ése incluye $3.06M de abonos que ya entraron y ningún '
            + 'documento absorbió, o sea dinero que ya está en el banco.',
          cobranza_fuera_de_ventana: 'La curva agenda por fecha de vencimiento. Lo que ya venció '
            + 'no cabe en una semana futura sin inventarle fecha, así que va en '
            + '`cobranza_cobertura.vencido_fuera`.',
        },
      };
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────
  private iso(d: any): string { return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10); }
  private addDays(d: string, n: number): string { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  /** Lunes (date_trunc('week') de Postgres = lunes) de cada semana en el rango. */
  private weekBuckets(from: string, to: string): string[] {
    const monday = (d: string) => { const x = new Date(d + 'T00:00:00Z'); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x; };
    const out: string[] = [];
    let cur = monday(from); const end = monday(to);
    while (cur <= end) { out.push(cur.toISOString().slice(0, 10)); cur = new Date(cur); cur.setUTCDate(cur.getUTCDate() + 7); }
    return out;
  }
}
