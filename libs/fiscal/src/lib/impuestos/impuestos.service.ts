import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { DiotService } from '../diot/diot.service';

export interface ProvisionalOpts {
  coeficiente_utilidad: number;   // del ejercicio anterior (utilidad fiscal / ingresos nominales) — INPUT
  tasa_isr?: number;              // persona moral 0.30 (default)
  ptu_pagada?: number;           // PTU pagada en el ejercicio (deducible desde mayo)
  perdidas_pendientes?: number;  // pérdidas fiscales de ejercicios anteriores por amortizar
  pagos_provisionales_previos?: number; // ISR provisional ya pagado en meses anteriores del ejercicio
  isr_retenido?: number;         // ISR retenido (bancos/intereses)
}

/**
 * FISCAL.18 — Pago provisional mensual (ISR + IVA).
 *
 * ⚠️ CÁLCULO DE APOYO — VALIDAR CON CONTADOR antes de declarar. El ISR provisional
 * (Art. 14 LISR) depende del **coeficiente de utilidad del ejercicio anterior**,
 * que NO se puede derivar de la contabilidad corriente → es un input obligatorio.
 * Los ingresos nominales salen de la balanza (familia 4). El IVA reusa el cálculo
 * de flujo de FISCAL.8.1 (efectivamente cobrado/pagado). Determinista, sin LLM.
 */
@Injectable()
export class ImpuestosService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly diot: DiotService,
  ) {}

  async pagoProvisional(period: string, opts: ProvisionalOpts) {
    const p = this.normPeriod(period);
    const cu = Number(opts?.coeficiente_utilidad);
    if (!Number.isFinite(cu) || cu < 0) throw new BadRequestException('coeficiente_utilidad requerido (del ejercicio anterior, p.ej. 0.05)');
    const tid = this.tenantCtx.requireTenantId();
    const tasa = Number(opts.tasa_isr) > 0 ? Number(opts.tasa_isr) : 0.30;
    const ys = `${p.slice(0, 4)}-01`;

    // Ingresos nominales acumulados del ejercicio (familia 4 = ingresos, naturaleza acreedora → abonos−cargos).
    const ingresos = await this.tk.run(async (trx) => {
      const [r] = await trx('analytics.ledger_monthly')
        .where({ tenant_id: tid, familia: '4' }).andWhere('anio_mes', '>=', ys).andWhere('anio_mes', '<=', p)
        .select(trx.raw('COALESCE(SUM(abonos - cargos),0) as ingresos'));
      return Number(r?.ingresos || 0);
    });

    const ptu = Number(opts.ptu_pagada) || 0;
    const perdidas = Number(opts.perdidas_pendientes) || 0;
    const pagosPrevios = Number(opts.pagos_provisionales_previos) || 0;
    const retenido = Number(opts.isr_retenido) || 0;

    const utilidadEstimada = ingresos * cu;
    const base = Math.max(0, utilidadEstimada - ptu - perdidas);
    const isrCausado = base * tasa;
    const isrAPagar = Math.max(0, isrCausado - pagosPrevios - retenido);

    const iva = await this.diot.ivaResumen(p);

    return {
      period: p,
      isr: {
        ingresos_nominales_acumulados: this.r(ingresos),
        coeficiente_utilidad: cu,
        utilidad_estimada: this.r(utilidadEstimada),
        ptu_pagada: this.r(ptu),
        perdidas_pendientes: this.r(perdidas),
        base_gravable: this.r(base),
        tasa_isr: tasa,
        isr_causado: this.r(isrCausado),
        pagos_provisionales_previos: this.r(pagosPrevios),
        isr_retenido: this.r(retenido),
        isr_a_pagar: this.r(isrAPagar),
      },
      iva: {
        iva_trasladado: this.r(iva.iva_trasladado),
        iva_acreditable: this.r(iva.iva_acreditable),
        iva_retenido: this.r(iva.iva_retenido),
        iva_a_cargo: this.r(iva.iva_a_cargo),
        iva_a_favor: this.r(iva.iva_a_favor),
      },
      total_a_pagar: this.r(isrAPagar + iva.iva_a_cargo),
      nota: 'Cálculo de apoyo — VALIDAR CON CONTADOR. El coeficiente de utilidad proviene de la declaración anual del ejercicio anterior. Ingresos desde balanza (familia 4); IVA con flujo efectivo (PUE/PPD).',
    };
  }

  private r(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }
  private normPeriod(period: string): string {
    const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) throw new BadRequestException(`period inválido (esperado YYYY-MM): ${period}`);
    return `${m[1]}-${m[2]}`;
  }
}
