import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { Execution360Service } from '../execution-360.service';
import { FindingsEngineService } from '../findings-engine.service';
import { DiagnosisEngineService } from '../diagnosis-engine.service';
import { SupervisorActionsService } from '../supervisor-actions.service';
import { PhotoAuditService } from '../photo-audit.service';
import { BaselineLearnerService } from '../baseline-learner.service';
import { RuleCalibrationService } from '../rule-calibration.service';
import { OutcomeVerifierService } from '../outcome-verifier.service';
import { SalesExecutionService } from '../sales-execution.service';
import { buildHorusSystemPrompt } from './horus-semantic';

/**
 * HIQ.0 — Tool registry de "Pregúntale a Horus" (patrón ADR-026 sobre Trade).
 *
 * Todas las tools son READ-ONLY y delegan en los servicios deterministas del
 * módulo (tenant explícito vía `user`, mismo patrón que el controller). El LLM
 * nunca ve SQL ni schema; recibe JSON ya filtrado. Los errores vuelven como
 * { error } accionable para self-correction, nunca lanzan.
 */

export interface HorusToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

const MAX_ROWS = 60; // token-diet: las listas se capan y se marca truncated

const cap = (rows: any[]) =>
  rows.length > MAX_ROWS ? { rows: rows.slice(0, MAX_ROWS), truncated: true, total: rows.length } : { rows };

/** Fila de execution_360 adelgazada para el LLM (fuera JSONBs pesados). */
const slim360 = (r: any) => ({
  subject_type: r.subject_type,
  subject_id: r.subject_id,
  label: r.label,
  window_days: r.window_days,
  visits: r.visits_done,
  avg_score: r.avg_score,
  score_trend: r.score_trend,
  own_share_pct: r.own_share_pct,
  photo_coverage_pct: r.photo_coverage_pct,
  days_since_visit: r.days_since_last_visit,
  exec_score: r.exec_score,
  weakest: Array.isArray(r.exec_score_breakdown) ? r.exec_score_breakdown[0] : undefined,
  exec_level_score: r.exec_level_score,
  avg_visit_min: r.avg_visit_min,
  avg_skus: r.avg_skus,
  idle_min_avg: r.idle_min_avg,
});

const slimFinding = (f: any) => ({
  id: f.id,
  finding_type: f.finding_type,
  severity: f.severity,
  status: f.status,
  source: f.source,
  subject_type: f.subject_type,
  subject_id: f.subject_id,
  label: f.label,
  score: f.score,
  evidence: f.evidence,
  explanation: f.explanation,
  created_at: f.created_at,
});

@Injectable()
export class HorusToolsService {
  private readonly logger = new Logger(HorusToolsService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly exec360: Execution360Service,
    private readonly findings: FindingsEngineService,
    private readonly diagnosis: DiagnosisEngineService,
    private readonly actions: SupervisorActionsService,
    private readonly photoAudit: PhotoAuditService,
    private readonly baselines: BaselineLearnerService,
    private readonly ruleCalibration: RuleCalibrationService,
    private readonly outcomes: OutcomeVerifierService,
    private readonly salesExec: SalesExecutionService,
  ) {}

  systemPrompt(ctx: { today: string; userName?: string }): string {
    return buildHorusSystemPrompt(ctx);
  }

  definitions(): HorusToolDef[] {
    return [
      {
        name: 'horus_resolve_entity',
        description:
          'Resuelve un nombre difuso a su id. Buscá acá PRIMERO cuando el usuario mencione un colaborador, tienda o zona por nombre.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Nombre o parte del nombre' },
            type: { type: 'string', enum: ['colaborador', 'tienda', 'zona'], description: 'Opcional: limita el tipo' },
          },
          required: ['query'],
        },
      },
      {
        name: 'horus_execution_360',
        description:
          'Feature store de ejecución: visitas, score promedio, tendencia, share propio, salud (exec_score) con su señal más débil, nivel, minutos por visita — por colaborador/tienda/zona/supervisor en ventana 7 o 30 días. Filtrá con subject_id si ya lo resolviste.',
        input_schema: {
          type: 'object',
          properties: {
            subject_type: { type: 'string', enum: ['collaborator', 'store', 'zone', 'supervisor'] },
            window_days: { type: 'integer', enum: [7, 30], description: 'Default 30' },
            subject_id: { type: 'string', description: 'Opcional: un sujeto concreto (uuid de horus_resolve_entity)' },
          },
        },
      },
      {
        name: 'horus_findings',
        description:
          'Hallazgos del motor (alertas): caídas de score, tiendas en riesgo, dominancia de competencia, anomalías, integridad/fraude (fraud_*), visión (vision_*). Default status=open.',
        input_schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'reviewed', 'dismissed', 'confirmed', 'resolved'] },
            severity: { type: 'string', enum: ['info', 'warn', 'critical'] },
            subject_type: { type: 'string', enum: ['collaborator', 'route', 'store'] },
          },
        },
      },
      {
        name: 'horus_colaborador_timeline',
        description:
          'Actividad día a día de UN colaborador: capturas, score promedio y tiendas distintas por día. Para "¿cómo viene X?", "¿qué hizo esta semana?".',
        input_schema: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: 'uuid del colaborador (de horus_resolve_entity)' },
            days: { type: 'integer', description: 'Ventana hacia atrás, default 30, máx 90' },
          },
          required: ['user_id'],
        },
      },
      {
        name: 'horus_tienda_detalle',
        description:
          'Historial de capturas de UNA tienda: fecha, colaborador, score, # exhibiciones. Para "¿quién visitó X?", "¿cómo está la tienda Y?".',
        input_schema: {
          type: 'object',
          properties: {
            store_id: { type: 'string', description: 'uuid de la tienda (de horus_resolve_entity)' },
            days: { type: 'integer', description: 'Ventana hacia atrás, default 60, máx 120' },
          },
          required: ['store_id'],
        },
      },
      {
        name: 'horus_diagnoses',
        description: 'Diagnósticos de causa raíz (correlación de ≥2 hallazgos del mismo sujeto). Default open.',
        input_schema: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['open', 'reviewed', 'dismissed', 'confirmed'] } },
        },
      },
      {
        name: 'horus_actions',
        description:
          'Acciones del co-piloto (coaching/visitas propuestas). kind=opportunity son mejoras proactivas. Default pending_approval.',
        input_schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending_approval', 'approved', 'rejected'] },
            kind: { type: 'string', enum: ['finding', 'opportunity'] },
          },
        },
      },
      {
        name: 'horus_tasks_coaching',
        description: 'Tareas de campo y notas de coaching YA creadas (efecto real de aprobar) con su estado/ack.',
        input_schema: { type: 'object', properties: { status: { type: 'string' } } },
      },
      {
        name: 'horus_vision',
        description:
          'Auditoría visual de fotos con IA: cobertura (analizadas vs totales) y veredictos por foto (agotado, competencia, foto inválida). ?flagged=true para solo las problemáticas.',
        input_schema: {
          type: 'object',
          properties: {
            flagged: { type: 'boolean', description: 'Solo fotos con bandera' },
            capture_id: { type: 'string', description: 'Fotos de una captura concreta' },
          },
        },
      },
      {
        name: 'horus_baselines',
        description:
          'Lo "normal" aprendido por sujeto (media ± desviación por métrica). Para saber si un valor es anómalo o es su comportamiento habitual.',
        input_schema: {
          type: 'object',
          properties: {
            subject_type: { type: 'string', enum: ['collaborator', 'store', 'zone', 'supervisor'] },
            metric: { type: 'string' },
          },
        },
      },
      {
        name: 'horus_learning',
        description:
          'Qué aprendió Horus: precisión por regla (cuáles hallazgos sirven según el feedback del supervisor) + efectividad de las acciones (qué coaching movió la aguja).',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'horus_sales_execution',
        description: 'Correlación venta↔ejecución y cobertura de registro de venta de campo (cuadrantes).',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'horus_briefing_history',
        description:
          'Partes diarios previos (titular + resumen por día). Para "¿qué me dijiste ayer/esta semana?" y para dar continuidad narrativa.',
        input_schema: {
          type: 'object',
          properties: { days: { type: 'integer', description: 'Cuántos días hacia atrás, default 7, máx 30' } },
        },
      },
    ];
  }

  /** Ejecuta una tool con el scope del usuario (tenant explícito). Nunca lanza. */
  async execute(name: string, input: any, user: any): Promise<any> {
    try {
      switch (name) {
        case 'horus_resolve_entity':
          return await this.resolveEntity(input, user);
        case 'horus_execution_360': {
          const res: any = await this.exec360.list(
            { subject_type: input?.subject_type, window_days: input?.window_days || 30 } as any,
            user,
          );
          const all: any[] = res?.rows || [];
          const rows = input?.subject_id ? all.filter((r: any) => r.subject_id === input.subject_id) : all;
          return cap(rows.map(slim360));
        }
        case 'horus_findings': {
          const res: any = await this.findings.listFindings(
            { status: input?.status, severity: input?.severity, subject_type: input?.subject_type } as any,
            user,
          );
          return cap(((res?.rows as any[]) || []).map(slimFinding));
        }
        case 'horus_colaborador_timeline':
          return await this.collaboratorTimeline(input, user);
        case 'horus_tienda_detalle':
          return await this.storeDetail(input, user);
        case 'horus_diagnoses': {
          const res: any = await this.diagnosis.list({ status: input?.status }, user);
          return cap((res?.rows as any[]) || []);
        }
        case 'horus_actions': {
          const res: any = await this.actions.listActions({ status: input?.status, kind: input?.kind }, user);
          return cap((res?.rows as any[]) || []);
        }
        case 'horus_tasks_coaching': {
          const [tasks, coaching]: any[] = await Promise.all([
            this.actions.listTasks({ status: input?.status }, user),
            this.actions.listCoachingNotes({ status: input?.status }, user),
          ]);
          return { tasks: cap(tasks?.rows || []), coaching: cap(coaching?.rows || []) };
        }
        case 'horus_vision': {
          const [coverage, verdicts]: any[] = await Promise.all([
            this.photoAudit.coverage(user),
            this.photoAudit.listVision({ flagged: !!input?.flagged, capture_id: input?.capture_id }, user),
          ]);
          const slimV = ((verdicts?.rows as any[]) || []).map((v: any) => ({
            capture_id: v.capture_id,
            captured_by: v.captured_by,
            store_name: v.store_name,
            is_shelf: v.is_shelf,
            own_brand_visible: v.own_brand_visible,
            competitor_visible: v.competitor_visible,
            shelf_quality: v.shelf_quality,
            out_of_stock: v.out_of_stock,
            photo_quality: v.photo_quality,
            mismatch: v.mismatch,
            analyzed_at: v.analyzed_at,
          }));
          return { coverage, verdicts: cap(slimV) };
        }
        case 'horus_baselines': {
          const res: any = await this.baselines.list(
            { subject_type: input?.subject_type, metric: input?.metric },
            user,
          );
          return cap((res?.rows as any[]) || []);
        }
        case 'horus_learning': {
          const [rules, effectiveness] = await Promise.all([
            this.ruleCalibration.list(user),
            this.outcomes.getEffectiveness(user),
          ]);
          return { rules, effectiveness };
        }
        case 'horus_sales_execution':
          return await this.salesExec.getCorrelation(user);
        case 'horus_briefing_history': {
          const tenantId = this.tenantId(user);
          if (!tenantId) return { error: 'sin tenant' };
          const days = Math.min(Math.max(Number(input?.days) || 7, 1), 30);
          const rows = await this.knex('commercial.briefing_history')
            .where('tenant_id', tenantId)
            .whereRaw(
              `briefing_date >= (now() AT TIME ZONE 'America/Mexico_City')::date - ?::int`,
              [days],
            )
            .orderBy('briefing_date', 'desc')
            .select('briefing_date', 'headline', 'summary', 'source');
          return cap(rows);
        }
        default:
          return { error: `Tool desconocida: ${name}` };
      }
    } catch (e: any) {
      this.logger.warn(`Tool ${name} falló: ${e?.message || e}`);
      return { error: `La tool ${name} falló: ${e?.message || 'error interno'}. Probá con otros parámetros u otra tool.` };
    }
  }

  private tenantId(user: any): string | undefined {
    return user?.tenant_id;
  }

  private async resolveEntity(input: any, user: any) {
    const tenantId = this.tenantId(user);
    const q = `%${String(input?.query || '').trim()}%`;
    if (!tenantId || q === '%%') return { error: 'query vacío' };
    const type = input?.type as string | undefined;

    const [colaboradores, tiendas, zonas] = await Promise.all([
      !type || type === 'colaborador'
        ? this.knex('users')
            .where('tenant_id', tenantId)
            .where((b) => b.whereILike('nombre', q).orWhereILike('username', q))
            .select('id', 'nombre', 'username', 'zona_id')
            .limit(5)
        : [],
      !type || type === 'tienda'
        ? this.knex('stores')
            .where('tenant_id', tenantId)
            .whereNull('deleted_at')
            .whereILike('nombre', q)
            .select('id', 'nombre', 'direccion')
            .limit(5)
        : [],
      !type || type === 'zona'
        ? this.knex('zones').where('tenant_id', tenantId).whereILike('name', q).select('id', 'name').limit(5)
        : [],
    ]);
    return { colaboradores, tiendas, zonas };
  }

  private async collaboratorTimeline(input: any, user: any) {
    const tenantId = this.tenantId(user);
    if (!tenantId || !input?.user_id) return { error: 'user_id requerido' };
    const days = Math.min(Math.max(Number(input?.days) || 30, 1), 90);
    const rows = await this.knex('daily_captures as dc')
      .where('dc.tenant_id', tenantId)
      .where('dc.user_id', input.user_id)
      .whereRaw('dc.hora_inicio >= now() - make_interval(days => ?)', [days])
      .groupByRaw(`(dc.hora_inicio AT TIME ZONE 'America/Mexico_City')::date`)
      .orderByRaw(`(dc.hora_inicio AT TIME ZONE 'America/Mexico_City')::date desc`)
      .select(
        this.knex.raw(`(dc.hora_inicio AT TIME ZONE 'America/Mexico_City')::date as day`),
        this.knex.raw('count(*)::int as captures'),
        this.knex.raw('round(avg(dc.score_final_pct)::numeric, 1) as score_avg'),
        this.knex.raw('count(distinct dc.store_id)::int as stores'),
      );
    const summary = {
      window_days: days,
      active_days: rows.length,
      total_captures: rows.reduce((a: number, r: any) => a + Number(r.captures || 0), 0),
    };
    return { summary, ...cap(rows) };
  }

  private async storeDetail(input: any, user: any) {
    const tenantId = this.tenantId(user);
    if (!tenantId || !input?.store_id) return { error: 'store_id requerido' };
    const days = Math.min(Math.max(Number(input?.days) || 60, 1), 120);
    const rows = await this.knex('daily_captures as dc')
      .where('dc.tenant_id', tenantId)
      .where('dc.store_id', input.store_id)
      .whereRaw('dc.hora_inicio >= now() - make_interval(days => ?)', [days])
      .orderBy('dc.hora_inicio', 'desc')
      .limit(30)
      .select(
        this.knex.raw(`(dc.hora_inicio AT TIME ZONE 'America/Mexico_City')::date as day`),
        'dc.captured_by_username as colaborador',
        'dc.score_final_pct as score',
        this.knex.raw(
          `case when jsonb_typeof(dc.exhibiciones) = 'array' then jsonb_array_length(dc.exhibiciones) else 0 end as exhibiciones`,
        ),
      );
    return { window_days: days, ...cap(rows) };
  }
}
