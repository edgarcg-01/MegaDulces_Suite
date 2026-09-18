import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import {
  FINANCE_FINDINGS_SINK_PORT,
  FinanceFindingsSinkPort,
  FinanceFindingInput,
  FinanceRuleInput,
  FINANCE_NOTIFIER_PORT,
  FinanceNotifierPort,
} from '@megadulces/contracts';
import { PolizaTypeAuditService, DoctypeVerdict, CrossGapRow } from './poliza-type-audit.service';

/**
 * PV.4 — Puente del Auditor de tipo de poliza hacia la bandeja unificada de
 * hallazgos (finance.findings, de Maat) y hacia la campana del header.
 *
 * Por que NO una bandeja propia (ADR-056): la bandeja ya existe con triage,
 * evidencia, confirmar/descartar y auto-supresion L2 por precision. Ya van ocho
 * bandejas inventadas en el proyecto; esta es la novena que no se hace. Mismo
 * patron que FiscalFindingsBridgeService y PurchaseAdjustmentsFindingsBridgeService.
 *
 * Por que el aviso va por notify() con tipo PROPIO y no por notifyCritical():
 * notifyCritical emite alertas 'finance_finding', y la campana las descarta en la
 * puerta porque FINANCE_NOTIF_ENABLED esta en false (se apago a proposito: el badge
 * traia cientos de hallazgos sin triar). Un aviso que entra por ahi hoy no le llega
 * a nadie. El tipo propio 'polizas_tipo' no pasa por ese flag y la campana lo rutea
 * por permiso de Contabilidad, que es de quien es este trabajo.
 */
@Injectable()
export class PolizaTypeFindingsBridgeService {
  private readonly logger = new Logger(PolizaTypeFindingsBridgeService.name);

  /** Un doctype dormido no es trabajo: solo van a la bandeja los que tienen uso. */
  private readonly MIN_DOCS = 1;
  /** Brecha de modelo por periodo: abajo de esto es redondeo entre sistemas, no senal. */
  private readonly MIN_BRECHA = 100_000;
  /** Antirepeticion del aviso en la campana (el hallazgo igual queda en la bandeja). */
  private static readonly SILENCIO_MS = 12 * 60 * 60 * 1000;
  private readonly ultimoAviso = new Map<string, number>();
  private isRunning = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly audit: PolizaTypeAuditService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /** Sync del tenant en contexto (boton de la pantalla). */
  syncCurrent() {
    return this.syncForTenant(this.tenantCtx.requireTenantId());
  }

  @Cron('0 45 0 * * *', { timeZone: 'America/Mexico_City' })
  async scheduledSync(): Promise<void> {
    if (process.env.ENABLE_POLIZA_TYPE_SCAN === 'false') return;
    if (!this.sink) {
      this.logger.debug('FINANCE_FINDINGS_SINK_PORT no ligado — sync no-op.');
      return;
    }
    if (this.isRunning) {
      this.logger.warn('Skip: sync anterior aun corriendo');
      return;
    }
    this.isRunning = true;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      let pushed = 0;
      for (const t of tenants) pushed += (await this.syncForTenant(t.id)).pushed;
      this.logger.log(`poliza-type scan: ${tenants.length} tenants, ${pushed} hallazgos`);
    } finally {
      this.isRunning = false;
    }
  }

  async syncForTenant(tenantId: string): Promise<{ pushed: number; inserted: number; skipped: number }> {
    if (!this.sink) return { pushed: 0, inserted: 0, skipped: 0 };

    const findings: FinanceFindingInput[] = [];
    const rules: FinanceRuleInput[] = [];

    // (A) Catalogo de Kepler.
    const catalogo = await this.audit.catalogAudit(undefined, this.knex);
    if (catalogo.state === 'not_measured') {
      findings.push(this.noMedido('catalogo', catalogo.reason));
      rules.push(this.NO_MEDIDO_RULE);
    } else {
      const vivos = catalogo.data.incongruentes.filter((i) => i.docs >= this.MIN_DOCS);
      if (vivos.length) {
        findings.push(...vivos.map((v) => this.catalogFinding(v)));
        rules.push(this.CATALOGO_RULE);
      }
    }

    // (B) Cruce Kepler vs ContPAQi.
    const cruce = await this.audit.crossAudit(6, tenantId, this.knex);
    if (cruce.state === 'not_measured') {
      // Clave: esto NO es "0 hallazgos". Es "el control no esta corriendo", y tiene
      // que verse, porque una pantalla en cero y una pantalla ciega se leen igual.
      findings.push(this.noMedido('cruce', cruce.reason));
      if (!rules.some((r) => r.rule_key === this.NO_MEDIDO_RULE.rule_key)) rules.push(this.NO_MEDIDO_RULE);
    } else {
      const materiales = cruce.data.filter((r) => Math.abs(r.brecha) >= this.MIN_BRECHA);
      if (materiales.length) {
        findings.push(...materiales.map((r) => this.crossFinding(r)));
        rules.push(this.CRUCE_RULE);
      }
    }

    if (!findings.length) return { pushed: 0, inserted: 0, skipped: 0 };

    const res = await this.sink.pushFindings(tenantId, findings, rules);
    this.logger.log(
      `tenant ${tenantId}: ${findings.length} hallazgos de tipo de poliza → Maat (${res.inserted} nuevas, ${res.skipped} omitidas).`,
    );

    // Solo si hubo NUEVAS: evita re-avisar lo mismo cada noche.
    if (res.inserted > 0) await this.avisar(tenantId, findings);
    return { pushed: findings.length, ...res };
  }

  /* ------------------------------ reglas ------------------------------ */

  private readonly CATALOGO_RULE: FinanceRuleInput = {
    rule_key: 'poliza_tipo_incongruente',
    nombre: 'Tipo de poliza incongruente con las cuentas que mueve',
    descripcion:
      'Doctype de Kepler cuyo tipo de poliza declarado (kdmm.c18) no concuerda con las cuentas que mueve: si toca efectivo o equivalentes (102/111 bancos, 110 caja) deberia ser Egresos o Ingresos; si no los toca, Diario. HITL: el humano confirma, porque el catalogo puede tener excepciones legitimas.',
    clase: 'error_captura',
    params: { familias_efectivo: ['102', '110', '111'], min_docs: 1 },
  };

  private readonly CRUCE_RULE: FinanceRuleInput = {
    rule_key: 'poliza_brecha_modelo_contpaqi',
    nombre: 'Brecha de clasificacion Kepler vs ContPAQi',
    descripcion:
      'Monto que un sistema clasifico en un tipo de poliza y el otro no, en el mismo mes. Refleja que Kepler registra el gasto en dos tiempos (devengo contra proveedores, luego pago contra banco) y ContPAQi en uno solo. No afirma correspondencia 1:1 entre polizas: no existe liga entre los dos sistemas.',
    clase: 'riesgo',
    params: { min_brecha: 100000, ventana_meses: 6 },
  };

  private readonly NO_MEDIDO_RULE: FinanceRuleInput = {
    rule_key: 'poliza_tipo_no_medido',
    nombre: 'El control de tipo de poliza no se pudo correr',
    descripcion:
      'La fuente que necesita el auditor de tipo de poliza no tiene filas, asi que el control no corrio. Se emite como hallazgo a proposito (ADR-056): una pantalla en cero y una pantalla ciega se leen igual y significan lo contrario.',
    clase: 'riesgo',
  };

  /* ---------------------------- constructores ---------------------------- */

  private catalogFinding(v: DoctypeVerdict): FinanceFindingInput {
    const severity = v.importe >= 500_000 ? 'critical' : v.importe >= 50_000 ? 'warn' : 'info';
    return {
      rule_key: 'poliza_tipo_incongruente',
      clase: 'error_captura',
      severity,
      score: Math.min(0.9, 0.55 + (v.importe >= 500_000 ? 0.25 : v.importe >= 50_000 ? 0.15 : 0)),
      titulo: `${v.doc} "${v.descripcion}" esta declarado ${v.tipo_declarado} y deberia ser ${v.tipo_esperado}`,
      resumen: `${v.veredicto}. Cargo ${v.cargo || 'sin declarar'} / abono ${v.abono || 'sin declarar'}. ${v.docs} documento(s) capturados este ano por ${this.money(v.importe)}.`,
      entity: { doctype: v.doc, descripcion: v.descripcion },
      periodo: String(new Date().getFullYear()),
      importe: v.importe,
      evidencia: {
        fuente: 'kepler_ods.kdmm + kepler_ods.kdm1',
        tipo_declarado: v.tipo_declarado,
        tipo_esperado: v.tipo_esperado,
        cuenta_cargo: v.cargo,
        cuenta_abono: v.abono,
        veredicto: v.veredicto,
        docs: v.docs,
        importe: v.importe,
      },
      dedup_key: `poliza_tipo:${v.doc}`,
    };
  }

  private crossFinding(r: CrossGapRow): FinanceFindingInput {
    const abs = Math.abs(r.brecha);
    const quien = r.brecha > 0 ? 'Kepler' : 'ContPAQi';
    return {
      rule_key: 'poliza_brecha_modelo_contpaqi',
      clase: 'riesgo',
      severity: abs >= 1_000_000 ? 'critical' : 'warn',
      score: abs >= 1_000_000 ? 0.75 : 0.6,
      titulo: `${r.anio_mes} tipo ${r.tipo_pol}: ${quien} clasifico ${this.money(abs)} de mas`,
      resumen: `Kepler ${r.kepler_polizas} poliza(s) por ${this.money(r.kepler_monto)} contra ContPAQi ${r.contpaqi_polizas} por ${this.money(r.contpaqi_monto)}. Es brecha de FORMA, no descuadre contable: los dos sistemas modelan el gasto distinto.`,
      entity: { anio_mes: r.anio_mes, tipo_pol: r.tipo_pol },
      periodo: r.anio_mes,
      importe: abs,
      evidencia: { fuente: 'analytics.gl_polizas', ...r },
      dedup_key: `poliza_brecha:${r.anio_mes}:${r.tipo_pol}`,
    };
  }

  private noMedido(bloque: 'catalogo' | 'cruce', reason: string | null): FinanceFindingInput {
    return {
      rule_key: 'poliza_tipo_no_medido',
      clase: 'riesgo',
      severity: 'warn',
      score: 0.5,
      titulo: `El auditor de tipo de poliza no pudo medir el bloque "${bloque}"`,
      resumen: `${reason || 'fuente no disponible'}. Mientras siga asi, la pantalla no puede afirmar que no haya problemas: no los esta buscando.`,
      entity: { bloque },
      periodo: null,
      importe: 0,
      evidencia: { bloque, motivo: reason, medido: false },
      dedup_key: `poliza_tipo_no_medido:${bloque}`,
    };
  }

  /* ---------------------------- notificacion ---------------------------- */

  private async avisar(tenantId: string, findings: FinanceFindingInput[]): Promise<void> {
    if (!this.notifier?.notify) return;
    const llave = `${tenantId}:polizas_tipo`;
    const ahora = Date.now();
    if (ahora - (this.ultimoAviso.get(llave) ?? 0) < PolizaTypeFindingsBridgeService.SILENCIO_MS) return;

    const ciegos = findings.filter((f) => f.rule_key === 'poliza_tipo_no_medido');
    const reales = findings.filter((f) => f.rule_key !== 'poliza_tipo_no_medido');
    const monto = reales.reduce((a, f) => a + (Number(f.importe) || 0), 0);

    // Un control que no corre pesa mas que un hallazgo: primero se avisa la ceguera.
    const title = ciegos.length
      ? `El control de tipo de poliza corrio a ciegas (${ciegos.length} bloque/s sin fuente)`
      : `${reales.length} poliza(s) con tipo incongruente`;
    const message = ciegos.length
      ? `${ciegos.map((c) => c.resumen).join(' · ')}`
      : `${reales.length} caso(s) por ${this.money(monto)}. Revisar antes de generar el TXT para ContPAQi.`;

    await this.notifier
      .notify(tenantId, {
        key: 'polizas_tipo',
        // Tipo propio: esto NO es un aviso de Finanzas ni pasa por el flag apagado
        // de finance_finding. Lo atiende Contabilidad, que es quien sube las polizas.
        type: 'polizas_tipo',
        // warn y no critical: es captura por corregir, no dinero perdido. Guardar el
        // rojo para lo que no tiene vuelta atras es lo que hace que el rojo signifique.
        severity: 'warn',
        title,
        message,
        route: '/contabilidad/polizas',
        data: { incongruentes: reales.length, ciegos: ciegos.length, monto },
      })
      .then(() => this.ultimoAviso.set(llave, ahora))
      .catch((e) => this.logger.warn(`notify fallo: ${e?.message || e}`));
  }

  private money(n: number): string {
    return '$' + Math.round(Number(n) || 0).toLocaleString('es-MX');
  }
}
