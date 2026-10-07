import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  classifyByRules, learnConceptFromHistory, pickBest, buildProvenance,
  type ClassifyRule, type HistoryRow, type Proposal, type ConceptPair,
} from './caja-autofill.engine';

/**
 * CG.17 — Autorrelleno de Caja General: los SELECT (ADR-070 §8).
 *
 * Este servicio SOLO consulta y le pasa las filas al motor puro
 * (`caja-autofill.engine.ts`), que es donde vive la decisión y donde está la suite unitaria.
 * Acá no hay reglas de negocio: si algo decide, está mal puesto.
 *
 * ⛔ Nada de lo que devuelve este servicio se guarda solo. Devuelve PROPUESTAS con su
 * procedencia; el humano confirma (§8.5 regla 1). Y lo que no se puede proponer sale con
 * `value: null` + `reason` — nunca un default (regla 3).
 */

export interface AutofillInput {
  tipo?: 'ingreso' | 'gasto' | 'deposito';
  sucursal?: string;
  glosa?: string;
  beneficiario?: string;
  beneficiario_rfc?: string;
  /** Cuenta del Access `Control`, si el movimiento viene de ese mundo durante el traslape. */
  legacy_cuenta?: string;
}

export interface AutofillResult {
  concepto: Proposal<ConceptPair>;
  documento: Proposal<Record<string, unknown>>;
  /** Lo que iría a `cash_ledger.autofill`: procedencia por campo. */
  provenance: Record<string, unknown>;
  /** Qué niveles se pudieron consultar. Un nivel caído NO puede verse como "no propuso". */
  niveles: Record<string, 'consultado' | 'sin_fuente'>;
}

/** Ventana de historia del nivel `aprendido`. Más atrás, la contabilidad ya cambió de criterio. */
const HISTORY_MONTHS = 24;

@Injectable()
export class CajaAutofillService {
  private readonly log = new Logger(CajaAutofillService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async suggest(input: AutofillInput): Promise<AutofillResult> {
    const tenantId = this.tenantCtx.requireTenantId();
    const niveles: AutofillResult['niveles'] = {};

    return this.tk.run(async (trx) => {
      // ── Nivel 1: el documento que ya existe. Se LIGA, no se teclea. ──────────────────
      let documento: Proposal<Record<string, unknown>> = {
        value: null, source: null, confidence: null, reason: 'sin_documento',
      };
      if (input.beneficiario_rfc) {
        try {
          const cfdi = await trx('fiscal.cfdis')
            .where({ tenant_id: tenantId, emisor_rfc: input.beneficiario_rfc })
            .orderBy('fecha', 'desc')
            .first('uuid', 'emisor_nombre', 'emisor_rfc', 'total', 'fecha', 'serie', 'folio');
          niveles['documento'] = 'consultado';
          if (cfdi) {
            documento = {
              value: {
                origen_tipo: 'cfdi', origen_uuid: cfdi.uuid,
                origen_ref: [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || null,
                beneficiario: cfdi.emisor_nombre, beneficiario_rfc: cfdi.emisor_rfc,
                monto: Number(cfdi.total),
              },
              source: 'documento', confidence: 1, originId: cfdi.uuid,
            };
          }
        } catch (e) {
          // Una fuente caída NO es "no propuso": se declara (§8.5 regla 3 / ADR-056).
          niveles['documento'] = 'sin_fuente';
          this.log.warn(`nivel documento no consultable: ${(e as Error).message}`);
        }
      } else {
        niveles['documento'] = 'sin_fuente';
      }

      // ── Nivel 2: lo que contabilidad YA posteó para este sujeto ─────────────────────
      let aprendido: Proposal<ConceptPair> = {
        value: null, source: null, confidence: null, reason: 'sin_historia',
      };
      const sujeto = input.beneficiario_rfc || input.beneficiario;
      if (sujeto) {
        try {
          const desde = new Date();
          desde.setMonth(desde.getMonth() - HISTORY_MONTHS);
          const rows: HistoryRow[] = await trx('analytics.expense_entries')
            .where('tenant_id', tenantId)
            .whereNotNull('concepto')
            .where('fecha', '>=', desde.toISOString().slice(0, 10))
            .where((b: any) => b
              .whereILike('beneficiario', `%${sujeto}%`)
              .orWhereILike('beneficiario_doc', `%${sujeto}%`))
            .groupBy('cuenta', 'concepto')
            .select(
              trx.raw('cuenta AS kepler_cuenta'),
              trx.raw('concepto AS kepler_concepto'),
              trx.raw('count(*)::int AS n'),
            );
          niveles['aprendido'] = 'consultado';
          aprendido = learnConceptFromHistory(rows);
        } catch (e) {
          niveles['aprendido'] = 'sin_fuente';
          this.log.warn(`nivel aprendido no consultable: ${(e as Error).message}`);
        }
      } else {
        niveles['aprendido'] = 'sin_fuente';
      }

      // ── Nivel 3: reglas explícitas, editables sin redeploy ──────────────────────────
      let porRegla: Proposal<ConceptPair> = {
        value: null, source: null, confidence: null, reason: 'sin_regla',
      };
      try {
        const rules: ClassifyRule[] = await trx('finance.caja_classify_rules')
          .where('tenant_id', tenantId)
          .select('id', 'priority', 'match_tipo', 'match_glosa', 'match_beneficiario',
            'kepler_cuenta', 'kepler_concepto', 'centro_costo', 'active', 'suppressed_at',
            'applied_count', 'corrected_count');
        niveles['regla'] = 'consultado';
        porRegla = classifyByRules(rules, {
          tipo: input.tipo, glosa: input.glosa, beneficiario: input.beneficiario,
        });
      } catch (e) {
        niveles['regla'] = 'sin_fuente';
        this.log.warn(`nivel regla no consultable: ${(e as Error).message}`);
      }

      // ── Nivel extra: el mapa HITL de la cuenta del Access, durante el traslape ──────
      let porMapa: Proposal<ConceptPair> = {
        value: null, source: null, confidence: null, reason: 'sin_historia',
      };
      if (input.legacy_cuenta) {
        const m = await trx('finance.caja_kepler_concept_map')
          .where({ tenant_id: tenantId, legacy_cuenta: input.legacy_cuenta })
          .whereNotNull('kepler_cuenta')
          .first('kepler_cuenta', 'kepler_concepto', 'support', 'support_ratio', 'confirmed_at', 'id');
        if (m) {
          porMapa = {
            value: { kepler_cuenta: m.kepler_cuenta, kepler_concepto: m.kepler_concepto },
            source: m.confirmed_at ? 'aprendido' : 'regla',
            // Un mapa CONFIRMADO por un humano vale más que uno sólo derivado.
            confidence: m.confirmed_at ? 0.95 : Number(m.support_ratio ?? 0.5),
            support: m.support ?? undefined,
            supportRatio: m.support_ratio ? Number(m.support_ratio) : undefined,
            originId: m.id,
          };
        }
      }

      // Cascada: gana el nivel de más certeza que haya producido un valor.
      const concepto = pickBest<ConceptPair>(porMapa, aprendido, porRegla);
      const provenance = buildProvenance({ kepler_concepto: concepto, documento });

      return { concepto, documento, provenance, niveles };
    });
  }
}
