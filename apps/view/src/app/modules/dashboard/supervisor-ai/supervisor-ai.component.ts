import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import {
  SupervisorAiService,
  BriefingResponse,
  Execution360Row,
  FindingRow,
  ActionRow,
  TaskRow,
  CoachingNoteRow,
  VisionRow,
  VisionCoverage,
  SalesExecRow,
  SalesExecResponse,
  ReviewStatus,
  RuleStatRow,
  BaselineRow,
  RuleOverride,
} from './supervisor-ai.service';

const FINDING_LABELS: Record<string, string> = {
  score_drop: 'caída de score',
  low_score: 'score bajo',
  competitor_dominance: 'competencia domina el exhibidor',
  store_at_risk: 'tienda sin visita',
  self_anomaly: 'cae vs su propio normal',
  weak_concept: 'concepto flojo (ejecuta peor un tipo de exhibidor)',
  weak_position: 'posiciones débiles (anaquel/detrás)',
  idle_anomaly: 'tiempo muerto alto entre visitas',
  planogram_gap: 'poco planograma vs pares',
  vision_stockout: 'quiebre de stock (foto)',
  vision_mismatch: 'declarado ≠ observado (foto)',
  vision_invalid: 'fotos inválidas',
  fraud_impossible_speed: 'salto imposible entre capturas',
  fraud_overlap: 'capturas solapadas en el tiempo',
  fraud_gps_mismatch: 'captura lejos de la tienda',
  fraud_fast_visit: 'visita demasiado corta',
  fraud_recycled_photo: 'foto reciclada',
  sales_execution_gap: 'ejecuta bien pero sin venta',
};

const QUADRANT_LABELS: Record<string, string> = {
  ejecuta_y_vende: 'ejecuta y vende',
  ejecuta_sin_venta: 'ejecuta · sin venta',
  vende_sin_ejecutar: 'vende · poca ejecución',
  ambos_bajos: 'ambos bajos',
};

@Component({
  selector: 'app-supervisor-ai',
  standalone: true,
  imports: [CommonModule, ButtonModule, SkeletonModule, ToastModule, TooltipModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="horus">
      <header class="horus__head">
        <div>
          <h1 class="horus__title">Supervisor IA</h1>
          <p class="horus__sub">Parte diario de ejecución en campo — el motor decide, el agente comunica</p>
        </div>
        <button
          pButton
          type="button"
          [disabled]="recomputing()"
          (click)="recompute()"
          class="p-button-sm"
          [label]="recomputing() ? 'Recalculando…' : 'Recalcular'"
          icon="pi pi-refresh"
        ></button>
      </header>

      @if (loading()) {
        <p-skeleton height="9rem" styleClass="mb-3" />
        <p-skeleton height="14rem" />
      } @else {
        <!-- Parte diario -->
        @if (briefing(); as b) {
          <section class="card brief">
            <div class="brief__top">
              <span class="brief__headline">{{ b.headline }}</span>
              <span
                class="src"
                [class.src--agent]="b.source === 'agent'"
                [pTooltip]="b.source === 'agent' ? 'Redactado por el agente (Claude)' : 'Redacción determinista (sin LLM)'"
              >{{ b.source === 'agent' ? 'IA' : 'motor' }}</span>
            </div>
            <p class="brief__summary">{{ b.summary }}</p>
            <div class="chips">
              <span class="chip">{{ b.stats.collaborators }} colaboradores</span>
              <span class="chip">{{ b.stats.findings_total }} hallazgos</span>
              @if (b.stats.critical > 0) {
                <span class="chip chip--bad">{{ b.stats.critical }} críticos</span>
              }
            </div>

            @if (b.attention.length > 0) {
              <ul class="attn">
                @for (a of b.attention; track $index) {
                  <li class="attn__item">
                    <span class="dot" [ngClass]="sevClass(a.severity)"></span>
                    <span class="attn__subj">{{ a.subject }}</span>
                    <span class="attn__why">{{ a.why }}</span>
                  </li>
                }
              </ul>
            }
          </section>
        }

        <!-- Auditoría visual de fotos (visión H2.2) -->
        @if (visionCoverage(); as vc) {
          <section class="card">
            <div class="vision__head">
              <h2 class="card__title">Auditoría visual de fotos</h2>
              <button
                pButton
                type="button"
                [disabled]="scanning() || !vc.has_api_key"
                (click)="scanVision()"
                class="p-button-sm p-button-outlined"
                [label]="scanning() ? 'Analizando…' : 'Escanear fotos'"
                icon="pi pi-eye"
                [pTooltip]="vc.has_api_key ? 'Claude mira las fotos no analizadas (lote acotado)' : 'Falta ANTHROPIC_API_KEY'"
              ></button>
            </div>
            <div class="chips">
              <span class="chip">{{ vc.analyzed }} / {{ vc.photos_total }} fotos analizadas</span>
              @if (vc.out_of_stock > 0) {
                <span class="chip chip--bad">{{ vc.out_of_stock }} con quiebre</span>
              }
              @if (vc.mismatch > 0) {
                <span class="chip chip--bad">{{ vc.mismatch }} declarado≠visto</span>
              }
              @if (vc.unusable > 0) {
                <span class="chip">{{ vc.unusable }} inválidas</span>
              }
            </div>
            @if (!vc.has_api_key) {
              <p class="empty">Configurá <code>ANTHROPIC_API_KEY</code> para que Horus mire las fotos.</p>
            } @else if (vc.analyzed === 0) {
              <p class="empty">Sin fotos analizadas aún. Tocá "Escanear fotos" para que Horus las mire.</p>
            }
            @if (visionFlagged().length > 0) {
              <div class="vgrid">
                @for (v of visionFlagged(); track v.id) {
                  <figure class="vcard">
                    @if (v.foto_url) {
                      <img [src]="v.foto_url" alt="exhibición" loading="lazy" />
                    }
                    <figcaption>
                      <div class="vflags">
                        @if (v.mismatch) {
                          <span class="vflag vflag--bad">declarado≠visto</span>
                        }
                        @if (v.out_of_stock) {
                          <span class="vflag vflag--warn">quiebre</span>
                        }
                        @if (v.is_shelf === false) {
                          <span class="vflag">no es anaquel</span>
                        }
                        @if (v.photo_quality && v.photo_quality !== 'good') {
                          <span class="vflag">{{ v.photo_quality }}</span>
                        }
                      </div>
                      <span class="vmeta">{{ v.store_name || v.captured_by || '—' }}</span>
                    </figcaption>
                  </figure>
                }
              </div>
            }
          </section>
        }

        <!-- Mejoras sugeridas (motor de oportunidades) -->
        @if (opportunities().length > 0) {
          <section class="card">
            <h2 class="card__title">Mejoras sugeridas ({{ opportunities().length }})</h2>
            <ul class="findings">
              @for (a of opportunities(); track a.id) {
                <li class="finding finding--opp">
                  <span class="sev act-ic act-ic--opp"><i [class]="actionPi(a.action_type)"></i></span>
                  <div class="finding__body">
                    <span class="finding__label">{{ a.title }}</span>
                    @if (a.rationale) {
                      <span class="finding__why">{{ a.rationale }}</span>
                    }
                    <span class="finding__type">{{ actionLabel(a.action_type) }}</span>
                  </div>
                  <div class="finding__actions">
                    <button type="button" class="btn-approve" (click)="approve(a, true)">Aplicar</button>
                    <button
                      type="button"
                      class="icon-btn-ghost-bad"
                      pTooltip="Descartar"
                      (click)="reject(a, true)"
                    ><i class="pi pi-times"></i></button>
                  </div>
                </li>
              }
            </ul>
          </section>
        }

        <!-- Acciones sugeridas (co-piloto) -->
        @if (actions().length > 0) {
          <section class="card">
            <h2 class="card__title">Acciones sugeridas ({{ actions().length }})</h2>
            <ul class="findings">
              @for (a of actions(); track a.id) {
                <li class="finding">
                  <span class="sev act-ic"><i [class]="actionPi(a.action_type)"></i></span>
                  <div class="finding__body">
                    <span class="finding__label">{{ a.title }}</span>
                    <span class="finding__type">{{ actionLabel(a.action_type) }}</span>
                  </div>
                  <div class="finding__actions">
                    <button type="button" class="btn-approve" (click)="approve(a)">Aprobar</button>
                    <button
                      type="button"
                      class="icon-btn-ghost-bad"
                      pTooltip="Rechazar"
                      (click)="reject(a)"
                    ><i class="pi pi-times"></i></button>
                  </div>
                </li>
              }
            </ul>
          </section>
        }

        <!-- Hecho por Horus (efecto real de aprobar) -->
        @if (tasks().length > 0 || coachingNotes().length > 0) {
          <section class="card">
            <h2 class="card__title">Hecho por Horus</h2>
            @if (tasks().length > 0) {
              <h3 class="sub">Tareas de campo ({{ tasks().length }})</h3>
              <ul class="findings">
                @for (t of tasks(); track t.id) {
                  <li class="finding">
                    <span class="sev act-ic"><i [class]="taskPi(t.task_type)"></i></span>
                    <div class="finding__body">
                      <span class="finding__label">{{ t.title }}</span>
                      <span class="finding__type">{{ taskTypeLabel(t.task_type) }}@if (t.due_date) { · vence {{ t.due_date }}}</span>
                    </div>
                    <span class="pill" [class.pill--ok]="t.status === 'done'">{{ t.status }}</span>
                  </li>
                }
              </ul>
            }
            @if (coachingNotes().length > 0) {
              <h3 class="sub">Coaching ({{ coachingNotes().length }})</h3>
              <ul class="findings">
                @for (n of coachingNotes(); track n.id) {
                  <li class="finding">
                    <span class="sev act-ic"><i class="pi pi-comment"></i></span>
                    <div class="finding__body">
                      <span class="finding__label">{{ n.message }}</span>
                      <span class="finding__type">{{ n.category }}</span>
                    </div>
                    <span class="pill">{{ n.status }}</span>
                  </li>
                }
              </ul>
            }
          </section>
        }

        <!-- Bandeja de hallazgos -->
        <section class="card">
          <h2 class="card__title">Hallazgos abiertos ({{ findings().length }})</h2>
          @if (findings().length === 0) {
            <p class="empty">Sin hallazgos abiertos. El equipo está en orden — o falta computar el período.</p>
          } @else {
            <ul class="findings">
              @for (f of findings(); track f.id) {
                <li class="finding">
                  <span class="sev" [ngClass]="sevClass(f.severity)">{{ sevLabel(f.severity) }}</span>
                  <div class="finding__body">
                    <span class="finding__label">
                      {{ f.label || f.subject_type }}
                      @if (subjTag(f.subject_type); as st) {
                        <span class="subjtag">{{ st }}</span>
                      }
                    </span>
                    <span class="finding__type">
                      @if (f.source === 'fraud' || f.source === 'vision') {
                        <span class="srctag" [class.srctag--fraud]="f.source === 'fraud'">{{
                          f.source === 'fraud' ? 'integridad' : 'visión'
                        }}</span>
                      }
                      {{ findingLabel(f.finding_type) }} · {{ evidenceText(f) }}
                    </span>
                  </div>
                  <div class="finding__actions">
                    <button
                      type="button"
                      class="icon-btn-ghost-ok"
                      pTooltip="Confirmar (es real)"
                      (click)="review(f, 'confirmed')"
                    ><i class="pi pi-check"></i></button>
                    <button
                      type="button"
                      class="icon-btn-ghost-bad"
                      pTooltip="Descartar (no aplica)"
                      (click)="review(f, 'dismissed')"
                    ><i class="pi pi-times"></i></button>
                  </div>
                </li>
              }
            </ul>
          }
        </section>

        <!-- Feature store: colaboradores + salud de ejecución (motor multi-señal) -->
        <section class="card">
          <h2 class="card__title">Salud de ejecución · colaboradores (30 días)</h2>
          @if (collaborators().length === 0) {
            <p class="empty">Sin datos de colaboradores en el período.</p>
          } @else {
            <table class="tbl">
              <thead>
                <tr>
                  <th>Colaborador</th>
                  <th class="num">Salud</th>
                  <th class="num">Visitas</th>
                  <th class="num">Score</th>
                  <th class="num">Nivel</th>
                  <th class="num">Min/vis</th>
                  <th class="num">Tendencia</th>
                </tr>
              </thead>
              <tbody>
                @for (c of collaborators(); track c.subject_id) {
                  <tr>
                    <td>
                      {{ c.label || '—' }}
                      @if (weakest(c); as wk) {
                        <span class="weak" [pTooltip]="'Lo que más resta a la salud'">↓ {{ wk }}</span>
                      }
                    </td>
                    <td class="num">
                      <span class="health" [ngClass]="healthClass(c.exec_score)">{{
                        c.exec_score != null ? c.exec_score : '—'
                      }}</span>
                    </td>
                    <td class="num">{{ c.visits_done }}</td>
                    <td class="num">{{ c.avg_score != null ? c.avg_score + '%' : '—' }}</td>
                    <td class="num">{{ c.exec_level_score != null ? c.exec_level_score : '—' }}</td>
                    <td class="num">{{ c.avg_visit_min != null ? c.avg_visit_min : '—' }}</td>
                    <td class="num" [ngClass]="trendClass(c.score_trend)">{{ trendText(c.score_trend) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>

        <!-- Venta vs ejecución (H2.7) + cobertura de registro de venta -->
        @if (salesExec()?.coverage; as cov) {
          <section class="card">
            <h2 class="card__title">Venta vs ejecución</h2>
            <div class="chips">
              <span class="chip" [class.chip--bad]="!cov.sales_data_mature">
                venta registrada: {{ cov.collaborators_with_sales }}/{{ cov.collaborators_total }} vendedores ·
                {{ cov.stores_with_sales }}/{{ cov.stores_total }} tiendas (30 d)
              </span>
            </div>
            @if (!cov.sales_data_mature) {
              <p class="empty">
                Registro de venta inmaduro: el hallazgo "ejecuta pero no vende" se activará con más cierres de
                ruta / capturas de venta. Hoy esto es un diagnóstico de cobertura — el insight accionable es
                impulsar el registro de venta en campo.
              </p>
            }
            @if (salesWithSales().length > 0) {
              <table class="tbl">
                <thead>
                  <tr>
                    <th>Vendedor</th>
                    <th class="num">Salud</th>
                    <th class="num">Venta 30d</th>
                    <th class="num">Unidades</th>
                    <th>Cuadrante</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of salesWithSales(); track r.subject_id) {
                    <tr>
                      <td>{{ r.label || '—' }}</td>
                      <td class="num">
                        <span class="health" [ngClass]="healthClass(r.exec_score)">{{
                          r.exec_score != null ? r.exec_score : '—'
                        }}</span>
                      </td>
                      <td class="num">{{ r.revenue_30d ? '$' + r.revenue_30d : '—' }}</td>
                      <td class="num">{{ r.units_30d || '—' }}</td>
                      <td><span class="qtag" [ngClass]="quadrantClass(r.quadrant)">{{ quadrantLabel(r.quadrant) }}</span></td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>
        }

        <!-- Lo que Horus aprendió (Aprendizaje L1 + L2, ADR-021) -->
        <section class="card">
          <div class="vision__head">
            <h2 class="card__title">Lo que Horus aprendió</h2>
            <span class="src" pTooltip="El motor aprende de tu feedback; el LLM queda fuera del lazo (ADR-021)">aprendizaje</span>
          </div>

          <h3 class="sub">Precisión de las reglas (aprende de tus confirmaciones y descartes)</h3>
          @if (ruleStats().length === 0) {
            <p class="empty">Sin estadística de reglas todavía. Confirmá o descartá hallazgos y Horus aprenderá cuáles sirven.</p>
          } @else {
            <table class="tbl">
              <thead>
                <tr>
                  <th>Regla</th>
                  <th class="num">Juicios</th>
                  <th class="num">Precisión</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (r of ruleStats(); track r.finding_type + r.source) {
                  <tr>
                    <td>
                      {{ findingLabel(r.finding_type) }}
                      @if (r.source !== 'engine') {
                        <span class="srctag" [class.srctag--fraud]="r.source === 'fraud'">{{ r.source }}</span>
                      }
                    </td>
                    <td class="num">{{ r.reviewed_total }}</td>
                    <td class="num">{{ r.precision != null ? (r.precision * 100 | number: '1.0-0') + '%' : '—' }}</td>
                    <td><span class="rstate" [ngClass]="ruleStateClass(r)">{{ ruleStateLabel(r) }}</span></td>
                    <td class="num">
                      @if (r.effective_suppressed) {
                        <button type="button" class="rbtn" (click)="setRuleOverride(r, 'enabled')" pTooltip="Reactivar esta regla">Reactivar</button>
                      } @else {
                        <button type="button" class="rbtn rbtn--mute" (click)="setRuleOverride(r, 'suppressed')" pTooltip="Silenciar esta regla">Silenciar</button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }

          <h3 class="sub">Lo "normal" por colaborador (línea base aprendida)</h3>
          @if (baselineFloorMet().length === 0) {
            <p class="empty">
              Aprendiendo la normalidad… se necesitan ≥7 días de histórico por colaborador.
              {{ baselines().length }} en formación.
            </p>
          } @else {
            <ul class="findings">
              @for (b of baselineFloorMet(); track b.subject_id) {
                <li class="finding">
                  <span class="sev act-ic"><i class="pi pi-chart-line"></i></span>
                  <div class="finding__body">
                    <span class="finding__label">{{ baselineLabel(b) }}</span>
                    <span class="finding__type">score normal ≈ {{ b.mean }} ± {{ b.stddev }} ({{ b.n_obs }} días)</span>
                  </div>
                </li>
              }
            </ul>
          }
        </section>
      }

      <p-toast />
    </div>
  `,
  styles: [
    `
      .horus { padding: 1.25rem; max-width: 1100px; margin: 0 auto; color: var(--text, #1c1917); }
      .horus__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
      .horus__title { font-size: 1.5rem; font-weight: 700; margin: 0; }
      .horus__sub { margin: .25rem 0 0; color: var(--text-soft, #78716c); font-size: .85rem; }
      .card { background: var(--card-bg, #fff); border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius, 12px); padding: 1rem 1.1rem; margin-bottom: 1rem; }
      .card__title { font-size: .95rem; font-weight: 600; margin: 0 0 .75rem; }
      .brief__top { display: flex; align-items: center; gap: .6rem; }
      .brief__headline { font-size: 1.05rem; font-weight: 700; }
      .src { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: .12rem .4rem; border-radius: 999px; background: var(--layout-bg, #f5f5f4); color: var(--text-soft, #78716c); }
      .src--agent { background: color-mix(in srgb, var(--action, #ea580c) 14%, transparent); color: var(--action, #ea580c); }
      .brief__summary { margin: .5rem 0 .75rem; line-height: 1.45; color: var(--text, #44403c); }
      .chips { display: flex; flex-wrap: wrap; gap: .4rem; }
      .chip { font-size: .75rem; padding: .2rem .55rem; border-radius: 999px; background: var(--layout-bg, #f5f5f4); color: var(--text-soft, #57534e); }
      .chip--bad { background: color-mix(in srgb, var(--bad, #dc2626) 12%, transparent); color: var(--bad, #dc2626); font-weight: 600; }
      .attn { list-style: none; margin: .9rem 0 0; padding: .75rem 0 0; border-top: 1px solid var(--border, #e7e5e4); display: flex; flex-direction: column; gap: .5rem; }
      .attn__item { display: flex; align-items: baseline; gap: .55rem; font-size: .86rem; }
      .attn__subj { font-weight: 600; }
      .attn__why { color: var(--text-soft, #78716c); }
      .dot { width: .55rem; height: .55rem; border-radius: 50%; flex: 0 0 auto; align-self: center; }
      .sev { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .15rem .45rem; border-radius: 6px; flex: 0 0 auto; }
      .sev--critical, .dot.sev--critical { background: color-mix(in srgb, var(--bad, #dc2626) 14%, transparent); color: var(--bad, #dc2626); }
      .sev--warn, .dot.sev--warn { background: color-mix(in srgb, var(--warn, #d97706) 16%, transparent); color: var(--warn, #b45309); }
      .sev--info, .dot.sev--info { background: var(--layout-bg, #f5f5f4); color: var(--text-soft, #78716c); }
      .dot.sev--critical { background: var(--bad, #dc2626); }
      .dot.sev--warn { background: var(--warn, #d97706); }
      .dot.sev--info { background: var(--text-soft, #a8a29e); }
      .findings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
      .finding { display: flex; align-items: center; gap: .7rem; padding: .55rem 0; border-bottom: 1px solid var(--border, #f0efed); }
      .finding:last-child { border-bottom: none; }
      .finding__body { display: flex; flex-direction: column; gap: .1rem; flex: 1 1 auto; min-width: 0; }
      .finding__label { font-weight: 600; font-size: .9rem; }
      .finding__type { font-size: .8rem; color: var(--text-soft, #78716c); }
      .finding__actions { display: flex; gap: .25rem; flex: 0 0 auto; }
      .empty { color: var(--text-soft, #78716c); font-size: .88rem; margin: .25rem 0; }
      .tbl { width: 100%; border-collapse: collapse; font-size: .86rem; }
      .tbl th { text-align: left; font-weight: 600; color: var(--text-soft, #78716c); padding: .4rem .5rem; border-bottom: 1px solid var(--border, #e7e5e4); }
      .tbl td { padding: .4rem .5rem; border-bottom: 1px solid var(--border, #f0efed); }
      .tbl .num { text-align: right; font-variant-numeric: tabular-nums; }
      .trend-up { color: var(--ok, #16a34a); font-weight: 600; }
      .trend-down { color: var(--bad, #dc2626); font-weight: 600; }
      .mb-3 { margin-bottom: .75rem; }
      .act-ic { background: color-mix(in srgb, var(--action, #ea580c) 12%, transparent); color: var(--action, #ea580c); display: inline-flex; align-items: center; justify-content: center; }
      .btn-approve { font-size: .78rem; font-weight: 600; padding: .3rem .75rem; border-radius: 8px; border: 1px solid var(--action, #ea580c); background: var(--action, #ea580c); color: #fff; cursor: pointer; }
      .btn-approve:hover { filter: brightness(1.06); }
      .finding--opp { align-items: flex-start; }
      .finding__why { font-size: .82rem; color: var(--text, #57534e); line-height: 1.4; margin: .12rem 0; }
      .act-ic--opp { background: color-mix(in srgb, var(--ok, #16a34a) 14%, transparent); color: var(--ok, #15803d); }
      .sub { font-size: .76rem; font-weight: 600; color: var(--text-soft, #78716c); margin: .85rem 0 .35rem; text-transform: uppercase; letter-spacing: .03em; }
      .sub:first-of-type { margin-top: 0; }
      .pill { font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; padding: .15rem .45rem; border-radius: 6px; background: var(--layout-bg, #f5f5f4); color: var(--text-soft, #78716c); flex: 0 0 auto; align-self: center; }
      .pill--ok { background: color-mix(in srgb, var(--ok, #16a34a) 14%, transparent); color: var(--ok, #15803d); }
      .vision__head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .75rem; }
      .vision__head .card__title { margin: 0; }
      .vgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: .6rem; margin-top: .8rem; }
      .vcard { margin: 0; border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius, 12px); overflow: hidden; background: var(--layout-bg, #f5f5f4); }
      .vcard img { width: 100%; height: 110px; object-fit: cover; display: block; }
      .vcard figcaption { padding: .4rem .5rem; display: flex; flex-direction: column; gap: .3rem; }
      .vflags { display: flex; flex-wrap: wrap; gap: .25rem; }
      .vflag { font-size: .62rem; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; padding: .1rem .35rem; border-radius: 5px; background: var(--card-bg, #fff); color: var(--text-soft, #78716c); border: 1px solid var(--border, #e7e5e4); }
      .vflag--bad { background: color-mix(in srgb, var(--bad, #dc2626) 12%, transparent); color: var(--bad, #dc2626); border-color: transparent; }
      .vflag--warn { background: color-mix(in srgb, var(--warn, #d97706) 14%, transparent); color: var(--warn, #b45309); border-color: transparent; }
      .vmeta { font-size: .72rem; color: var(--text-soft, #78716c); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      code { font-family: var(--font-mono, monospace); background: var(--layout-bg, #f5f5f4); padding: .05rem .3rem; border-radius: 4px; font-size: .85em; }
      .srctag { font-size: .6rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .05rem .3rem; border-radius: 4px; margin-right: .35rem; background: color-mix(in srgb, var(--action, #ea580c) 12%, transparent); color: var(--action, #c2410c); }
      .srctag--fraud { background: color-mix(in srgb, var(--bad, #dc2626) 14%, transparent); color: var(--bad, #dc2626); }
      .subjtag { font-size: .6rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .05rem .3rem; border-radius: 4px; margin-left: .35rem; background: color-mix(in srgb, var(--ember-grad, #6366f1) 12%, transparent); color: var(--text-soft, #57534e); vertical-align: middle; }
      .health { display: inline-block; min-width: 2.1rem; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; padding: .1rem .4rem; border-radius: 6px; background: var(--layout-bg, #f5f5f4); color: var(--text-soft, #78716c); }
      .health--ok { background: color-mix(in srgb, var(--ok, #16a34a) 14%, transparent); color: var(--ok, #15803d); }
      .health--warn { background: color-mix(in srgb, var(--warn, #d97706) 16%, transparent); color: var(--warn, #b45309); }
      .health--bad { background: color-mix(in srgb, var(--bad, #dc2626) 14%, transparent); color: var(--bad, #dc2626); }
      .weak { display: inline-block; margin-left: .4rem; font-size: .7rem; color: var(--text-soft, #a8a29e); }
      .qtag { font-size: .68rem; font-weight: 600; padding: .12rem .45rem; border-radius: 6px; background: var(--layout-bg, #f5f5f4); color: var(--text-soft, #78716c); }
      .qtag--gap { background: color-mix(in srgb, var(--warn, #d97706) 16%, transparent); color: var(--warn, #b45309); }
      .qtag--ok { background: color-mix(in srgb, var(--ok, #16a34a) 14%, transparent); color: var(--ok, #15803d); }
      .rstate { font-size: .68rem; font-weight: 600; padding: .12rem .45rem; border-radius: 6px; background: var(--layout-bg, #f5f5f4); color: var(--text-soft, #78716c); }
      .rstate--ok { background: color-mix(in srgb, var(--ok, #16a34a) 14%, transparent); color: var(--ok, #15803d); }
      .rstate--warn { background: color-mix(in srgb, var(--warn, #d97706) 16%, transparent); color: var(--warn, #b45309); }
      .rstate--off { background: color-mix(in srgb, var(--bad, #dc2626) 12%, transparent); color: var(--bad, #dc2626); }
      .rstate--learn { background: var(--layout-bg, #f5f5f4); color: var(--text-soft, #a8a29e); }
      .rbtn { font-size: .72rem; font-weight: 600; padding: .2rem .5rem; border-radius: 6px; border: 1px solid var(--border, #e7e5e4); background: var(--card-bg, #fff); color: var(--text-soft, #57534e); cursor: pointer; }
      .rbtn:hover { border-color: var(--action, #ea580c); color: var(--action, #ea580c); }
      .rbtn--mute:hover { border-color: var(--bad, #dc2626); color: var(--bad, #dc2626); }
    `,
  ],
})
export class SupervisorAiComponent implements OnInit {
  private readonly api = inject(SupervisorAiService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly recomputing = signal(false);
  readonly briefing = signal<BriefingResponse | null>(null);
  readonly findings = signal<FindingRow[]>([]);
  readonly actions = signal<ActionRow[]>([]);
  readonly opportunities = signal<ActionRow[]>([]);
  readonly tasks = signal<TaskRow[]>([]);
  readonly coachingNotes = signal<CoachingNoteRow[]>([]);
  readonly collaborators = signal<Execution360Row[]>([]);
  readonly visionCoverage = signal<VisionCoverage | null>(null);
  readonly visionFlagged = signal<VisionRow[]>([]);
  readonly scanning = signal(false);
  readonly salesExec = signal<SalesExecResponse | null>(null);
  readonly ruleStats = signal<RuleStatRow[]>([]);
  readonly baselines = signal<BaselineRow[]>([]);

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    forkJoin({
      brief: this.api.briefing().pipe(catchError(() => of(null))),
      finds: this.api.findings({ status: 'open' }).pipe(catchError(() => of({ rows: [], total: 0 }))),
      acts: this.api.actions('pending_approval').pipe(catchError(() => of({ rows: [], total: 0 }))),
      opps: this.api.opportunities('pending_approval').pipe(catchError(() => of({ rows: [], total: 0 }))),
      tasks: this.api.tasks().pipe(catchError(() => of({ rows: [], total: 0 }))),
      notes: this.api.coachingNotes().pipe(catchError(() => of({ rows: [], total: 0 }))),
      cov: this.api.visionCoverage().pipe(catchError(() => of(null))),
      vis: this.api.vision(true).pipe(catchError(() => of({ rows: [], total: 0 }))),
      salesEx: this.api.salesExecution().pipe(catchError(() => of(null))),
      exec: this.api
        .execution360({ subject_type: 'collaborator', window_days: 30 })
        .pipe(catchError(() => of({ rows: [], total: 0, computed_at: null }))),
      rules: this.api.learningRules().pipe(catchError(() => of({ rows: [], total: 0, computed_at: null }))),
      bases: this.api
        .learningBaselines({ subject_type: 'collaborator', metric: 'avg_score' })
        .pipe(catchError(() => of({ rows: [], total: 0, computed_at: null }))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ brief, finds, acts, opps, tasks, notes, cov, vis, salesEx, exec, rules, bases }) => {
        this.briefing.set(brief);
        this.findings.set(finds.rows ?? []);
        this.actions.set(acts.rows ?? []);
        this.opportunities.set(opps.rows ?? []);
        this.tasks.set(tasks.rows ?? []);
        this.coachingNotes.set(notes.rows ?? []);
        this.visionCoverage.set(cov);
        this.visionFlagged.set(vis.rows ?? []);
        this.salesExec.set(salesEx);
        this.ruleStats.set(rules.rows ?? []);
        this.baselines.set(bases.rows ?? []);
        // Peor salud primero: el supervisor ve arriba a quién atender.
        this.collaborators.set(
          (exec.rows ?? []).slice().sort((a, b) => {
            const sa = a.exec_score == null ? 999 : a.exec_score;
            const sb = b.exec_score == null ? 999 : b.exec_score;
            return sa - sb;
          }),
        );
        this.loading.set(false);
      });
  }

  recompute(): void {
    this.recomputing.set(true);
    this.api
      .compute()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.add({ severity: 'success', summary: 'Recalculado', detail: 'Parte y hallazgos actualizados' });
          this.recomputing.set(false);
          this.load();
        },
        error: () => {
          this.toast.add({ severity: 'error', summary: 'No se pudo recalcular' });
          this.recomputing.set(false);
        },
      });
  }

  scanVision(): void {
    this.scanning.set(true);
    this.api
      .visionScan()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          const a = r?.scan?.analyzed ?? 0;
          this.toast.add({
            severity: a > 0 ? 'success' : 'info',
            summary: a > 0 ? `${a} fotos analizadas` : 'Sin fotos nuevas para analizar',
            detail: r?.scan?.reason === 'no_api_key' ? 'Falta ANTHROPIC_API_KEY en el backend' : undefined,
          });
          this.scanning.set(false);
          this.load();
        },
        error: () => {
          this.toast.add({ severity: 'error', summary: 'No se pudo escanear las fotos' });
          this.scanning.set(false);
        },
      });
  }

  review(f: FindingRow, status: ReviewStatus): void {
    this.api
      .review(f.id, status)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.findings.update((list) => list.filter((x) => x.id !== f.id));
          this.toast.add({
            severity: 'success',
            summary: status === 'dismissed' ? 'Descartado' : 'Confirmado',
            detail: f.label || this.findingLabel(f.finding_type),
          });
        },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudo actualizar el hallazgo' }),
      });
  }

  approve(a: ActionRow, isOpp = false): void {
    this.api
      .approveAction(a.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.actions.update((l) => l.filter((x) => x.id !== a.id));
          this.opportunities.update((l) => l.filter((x) => x.id !== a.id));
          this.toast.add({
            severity: 'success',
            summary: isOpp ? 'Mejora aplicada' : 'Acción aprobada',
            detail: a.title,
          });
          this.load(); // refresca el panel "Hecho por Horus" (tarea/coaching recién creados)
        },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudo aprobar' }),
      });
  }

  reject(a: ActionRow, isOpp = false): void {
    this.api
      .rejectAction(a.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.actions.update((l) => l.filter((x) => x.id !== a.id));
          this.opportunities.update((l) => l.filter((x) => x.id !== a.id));
          this.toast.add({ severity: 'info', summary: isOpp ? 'Mejora descartada' : 'Acción rechazada' });
        },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudo rechazar' }),
      });
  }

  // ── Helpers de presentación ──
  sevClass(s: string): string {
    return s === 'critical' ? 'sev--critical' : s === 'warn' ? 'sev--warn' : 'sev--info';
  }
  sevLabel(s: string): string {
    return s === 'critical' ? 'Crítico' : s === 'warn' ? 'Alerta' : 'Info';
  }
  subjTag(t: string): string {
    return t === 'zone' ? 'zona' : t === 'supervisor' ? 'equipo' : '';
  }
  findingLabel(type: string): string {
    return FINDING_LABELS[type] || type;
  }
  evidenceText(f: FindingRow): string {
    const e = f.evidence || {};
    switch (f.finding_type) {
      case 'score_drop':
        return `bajó ${Math.abs(Number(e['score_trend'] ?? 0))} pts en 7d`;
      case 'low_score':
        return `score ${e['avg_score'] ?? '?'}% (mínimo ${e['threshold'] ?? '?'}%)`;
      case 'competitor_dominance':
        return `competencia ${e['competitor_share_pct'] ?? '?'}% del exhibidor`;
      case 'store_at_risk':
        return `${e['days_since_last_visit'] ?? '?'} días sin visita`;
      case 'self_anomaly':
        return `score ${e['current'] ?? '?'} vs su normal ${e['baseline_mean'] ?? '?'} (${e['baseline_n_obs'] ?? '?'} días)`;
      case 'weak_concept':
        return `${e['concept'] ?? 'concepto'} a ${e['concept_level'] ?? '?'} vs su nivel ${e['overall_level'] ?? '?'} (${e['exhibiciones'] ?? '?'} exh.)`;
      case 'weak_position':
        return `calidad de posición ${e['position_quality'] ?? '?'}/100 (umbral ${e['threshold'] ?? '?'})`;
      case 'idle_anomaly':
        return `${e['idle_min_avg'] ?? '?'} min promedio entre visitas (umbral ${e['threshold'] ?? '?'})`;
      case 'planogram_gap':
        return `exhibe ${e['planogram_present'] ?? '?'} SKUs del planograma vs ${e['peer_median'] ?? '?'} de sus pares`;
      case 'vision_stockout':
        return `quiebre de stock en ${e['stockout_photos'] ?? '?'} foto(s)`;
      case 'vision_mismatch':
        return `${e['mismatch_photos'] ?? '?'} foto(s) declaradas propio muestran competencia`;
      case 'vision_invalid':
        return `${e['pct'] ?? '?'}% de fotos inválidas / sin anaquel`;
      case 'fraud_impossible_speed':
        return `${e['events'] ?? '?'} salto(s), hasta ${e['max_speed_kmh'] ?? '?'} km/h`;
      case 'fraud_overlap':
        return `${e['events'] ?? '?'} captura(s) solapada(s)`;
      case 'fraud_gps_mismatch':
        return `${e['events'] ?? '?'} captura(s) lejos de la tienda (máx ${e['max_distance_m'] ?? '?'} m)`;
      case 'fraud_fast_visit':
        return `${e['events'] ?? '?'} visita(s) muy cortas (mín ${e['min_duration_sec'] ?? '?'}s)`;
      case 'fraud_recycled_photo':
        return `${e['events'] ?? '?'} foto(s) reutilizada(s)`;
      case 'sales_execution_gap':
        return `salud ${e['exec_score'] ?? '?'} y 0 venta en 30d`;
      default:
        return '';
    }
  }
  trendText(t: number | null): string {
    if (t == null || t === 0) return '—';
    return t > 0 ? `▲ +${t}` : `▼ ${t}`;
  }
  trendClass(t: number | null): string {
    if (t == null || t === 0) return '';
    return t > 0 ? 'trend-up' : 'trend-down';
  }
  healthClass(score: number | null | undefined): string {
    if (score == null) return '';
    return score < 40 ? 'health--bad' : score < 65 ? 'health--warn' : 'health--ok';
  }
  weakest(c: Execution360Row): string | null {
    const sigs = c.exec_score_breakdown?.signals;
    if (c.exec_score == null || !sigs?.length) return null;
    const min = sigs.reduce((a, b) => (b.value < a.value ? b : a));
    return min.value < 0.6 ? min.label : null;
  }
  salesWithSales(): SalesExecRow[] {
    return (this.salesExec()?.collaborators ?? []).filter((c) => c.has_sales);
  }
  quadrantLabel(q: string | null): string {
    return q ? QUADRANT_LABELS[q] || q : '—';
  }
  quadrantClass(q: string | null): string {
    return q === 'ejecuta_sin_venta' ? 'qtag--gap' : q === 'ejecuta_y_vende' ? 'qtag--ok' : '';
  }
  actionLabel(t: string): string {
    const m: Record<string, string> = {
      coaching: 'Coaching al colaborador',
      coaching_focus: 'Coaching enfocado',
      visit: 'Visita a tienda',
      recover_shelf: 'Recuperar anaquel',
      reprioritize_route: 'Repriorizar ruta',
      replicate_best: 'Reconocer y replicar',
      schedule_visit: 'Agendar visita',
      flag_recapture: 'Re-auditar',
      set_target: 'Fijar objetivo',
      flag_review: 'Revisión',
    };
    return m[t] || 'Acción';
  }
  actionPi(t: string): string {
    const m: Record<string, string> = {
      coaching: 'pi pi-comment',
      coaching_focus: 'pi pi-comment',
      visit: 'pi pi-map-marker',
      schedule_visit: 'pi pi-calendar',
      recover_shelf: 'pi pi-shopping-cart',
      reprioritize_route: 'pi pi-sort-alt-slash',
      replicate_best: 'pi pi-star',
      flag_recapture: 'pi pi-camera',
      set_target: 'pi pi-flag',
    };
    return m[t] || 'pi pi-bolt';
  }
  taskTypeLabel(t: string): string {
    return t === 'visit'
      ? 'Visita'
      : t === 'recover'
        ? 'Recuperar anaquel'
        : t === 'reprioritize'
          ? 'Repriorización'
          : 'Re-auditar';
  }
  taskPi(t: string): string {
    return t === 'visit'
      ? 'pi pi-map-marker'
      : t === 'recover'
        ? 'pi pi-shopping-cart'
        : t === 'reprioritize'
          ? 'pi pi-sort-alt-slash'
          : 'pi pi-camera';
  }

  // ── Aprendizaje (L1 + L2) ──
  ruleStateLabel(r: RuleStatRow): string {
    if (r.manual_override === 'suppressed') return 'silenciada (manual)';
    if (r.manual_override === 'enabled') return 'forzada activa';
    if (!r.floor_met) return 'aprendiendo';
    if (r.auto_suppressed) return 'auto-suprimida';
    if (r.severity_cap) return 'severidad capada';
    return 'activa';
  }
  ruleStateClass(r: RuleStatRow): string {
    if (r.effective_suppressed) return 'rstate--off';
    if (!r.floor_met) return 'rstate--learn';
    if (r.severity_cap) return 'rstate--warn';
    return 'rstate--ok';
  }
  setRuleOverride(r: RuleStatRow, override: RuleOverride): void {
    this.api
      .learningOverride(r.finding_type, override, r.source)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.ruleStats.update((list) =>
            list.map((x) =>
              x.finding_type === r.finding_type && x.source === r.source
                ? {
                    ...x,
                    manual_override: override,
                    effective_suppressed:
                      override === 'suppressed' ? true : override === 'enabled' ? false : x.auto_suppressed,
                  }
                : x,
            ),
          );
          this.toast.add({
            severity: 'success',
            summary: override === 'suppressed' ? 'Regla silenciada' : 'Regla reactivada',
            detail: this.findingLabel(r.finding_type),
          });
        },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudo cambiar la regla' }),
      });
  }
  baselineFloorMet(): BaselineRow[] {
    return this.baselines().filter((b) => b.floor_met && b.metric === 'avg_score');
  }
  baselineLabel(b: BaselineRow): string {
    return this.collaborators().find((c) => c.subject_id === b.subject_id)?.label || 'Colaborador';
  }
}
