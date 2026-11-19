import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import type { HrCandidatoFichaDto, HrCasilleroDto, HrHoyCandidatoDto, HrHoyDto, HrHoyPendienteId, HrLigaCreadaDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RhReclutamientoMarcoComponent } from '../components/rh-reclutamiento-marco.component';
import { RhCandidatoFichaComponent } from '../components/rh-candidato-ficha.component';
import { ReclutamientoService } from '../reclutamiento.service';
import { rhError } from '../rh.service';
import { etapaLabel, fechaHoraMx, telefono } from '../reclutamiento-formato';
import {
  HORAS_ENTREVISTA, INTENTOS_PARA_PREGUNTAR, MOTIVOS_CIERRE, TEXTO_PENDIENTE, diasParaAgendar, planDe, respuestasDe, resultadoDe,
  type Paso, type Respuesta, type RespuestaId,
} from '../hoy-formato';

type Modo = { tipo: 'lista' } | { tipo: 'tarjeta'; p: HrHoyPendienteId } | { tipo: 'fin'; p: HrHoyPendienteId };
type Pregunta = null | 'agendar' | 'cerrar' | 'tercer';

/** Una respuesta ya contestada que todavía se puede deshacer (se guarda a los 5 s, o antes si se contesta otra). */
interface PorGuardar { c: HrHoyCandidatoDto; p: HrHoyPendienteId; plan: Paso[]; resultado: string; timer: ReturnType<typeof setTimeout> }

const ESPERA_DESHACER_MS = 5000;
/** Tras contestar, los botones se apagan un instante: un doble clic no contesta por la persona siguiente. */
const BLOQUEO_DOBLE_CLIC_MS = 450;

/**
 * Fase RH · `[RH.17.1]` — «Hoy» de Reclutamiento (`/rh/reclutamiento/hoy`, la pestaña a la que lleva el menú).
 *
 * Contesta UNA pregunta: «¿qué tengo que hacer hoy?». Cuatro pendientes con verbo, cada uno con cuántos son, por qué y
 * los primeros nombres; «Empezar» los lleva UNO POR UNO, y cada respuesta guarda con los endpoints que ya existen y
 * pasa sola a la persona siguiente. Validado con RH en el prototipo del 19-nov
 * (`docs/maquetas/RH-reclutamiento-prototipo.html`).
 *
 * Jerarquía: primario = el pendiente y su número; secundario = por qué y a quiénes; terciario = el total y la edad del dato.
 *
 * Lo que NO hace: decidir en qué pendiente cae cada quien (lo decide el servidor, `logic/hoy.ts`) ni recalcular nada.
 * Lo que no se pudo leer se dice con «Reintentar», nunca como cero.
 */
@Component({
  selector: 'app-rh-reclutamiento-hoy',
  standalone: true,
  imports: [FormsModule, RouterLink, ButtonModule, SelectModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SidePeekComponent, RhReclutamientoMarcoComponent, RhCandidatoFichaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="hy-page">
      <app-rh-reclutamiento-marco subtitulo="Lo que tienes que hacer hoy, en orden. Empieza por el primero.">
        <div acciones class="hy-acc">
          <app-freshness-pill measures="fetch" [since]="leidoEn()" label="Leído" />
          <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="volverAHoy()" />
        </div>
      </app-rh-reclutamiento-marco>

      @switch (modo().tipo) {
        @case ('lista') {
          <app-load-state [loading]="loading() && !datos()" [error]="error()" (retry)="cargar()">
            @if (datos(); as d) {
              <!-- El veredicto del día en tres cifras: cuántos para hoy, cuántos ya, y el rezago que NO cuenta como pendiente. -->
              <app-metric-strip [items]="cifras()" density="compact" [instant]="true" ariaLabel="Reclutamiento hoy" />
              @if (conTrabajo().length) {
                <p class="hy-saludo"><b>{{ saludo() }}.</b> Empieza por el primero.</p>
                <section class="hy-tareas" aria-label="Pendientes de hoy">
                  @for (p of conTrabajo(); track p.id; let primero = $first) {
                    <div class="hy-tarea" [class.hy-primera]="primero">
                      <span class="hy-num mono" aria-hidden="true">{{ p.candidatos.length }}</span>
                      <div class="hy-txt">
                        <h2>{{ texto(p.id).titulo }}</h2>
                        <p>{{ texto(p.id).por }}</p>
                        <p class="hy-quien">{{ nombres(p.candidatos) }}</p>
                        @if (p.total > p.candidatos.length) {
                          <p class="hy-total">{{ p.candidatos.length }} para hoy de <b>{{ p.total }}</b> en total. Mañana salen los siguientes.</p>
                        }
                      </div>
                      <p-button [label]="'Empezar'" [severity]="primero ? 'primary' : 'secondary'" [outlined]="!primero" (onClick)="empezar(p.id)"
                                [ariaLabel]="'Empezar: ' + texto(p.id).titulo + ', ' + p.candidatos.length + ' para hoy'" />
                    </div>
                  }
                </section>
              } @else {
                <div class="hy-fin" role="status">
                  <i class="pi pi-check-circle" aria-hidden="true"></i>
                  <h2>No tienes pendientes hoy</h2>
                  <p>Nadie nuevo sin llamar y nadie esperando respuesta. Si buscas a alguien: <a routerLink="/rh/reclutamiento">Candidatos</a>.</p>
                </div>
              }
              <p class="hy-pie">
                ¿Buscas a alguien en particular? <a routerLink="/rh/reclutamiento">Candidatos</a>.
                @if (d.apartados) { Los {{ d.apartados }} sin movimiento en más de {{ d.dias_apartado }} días no cuentan como pendientes. }
              </p>
            }
          </app-load-state>
        }

        @case ('tarjeta') {
          @if (actual(); as c) {
            <section class="hy-modo" [attr.aria-label]="texto(pendiente()).titulo">
              <div class="hy-paso">
                <h2>{{ texto(pendiente()).titulo }}</h2>
                <p-button label="Volver a Hoy" icon="pi pi-arrow-left" [text]="true" severity="secondary" (onClick)="volverAHoy()" />
              </div>
              <div class="hy-barra-l"><span class="mono">{{ hechosDe(pendiente()) + 1 }} de {{ hechosDe(pendiente()) + cola().length }}</span>
                <span class="hy-barra" aria-hidden="true"><i [style.width.%]="avance()"></i></span><span>quedan {{ cola().length }}</span></div>

              <article class="hy-tarjeta">
                <header>
                  <h3>{{ c.full_name || 'Sin nombre' }} @if (pendiente() === 'nuevos') { <span class="pill" data-t="nuevo">Nuevo</span> }</h3>
                  <p>Quiere entrar de <b>{{ c.position_interest || 'puesto sin decir' }}</b>@if (c.city_branch) { en <b>{{ c.city_branch }}</b>}
                    · {{ etapa(c.stage) }} · se postuló {{ fecha(c.created_at) }}{{ c.origin === 'whatsapp' ? ' por WhatsApp' : c.origin === 'web' ? ' por la página' : '' }}</p>
                </header>

                @if (pendiente() === 'nuevos' || pendiente() === 'seguimiento') {
                  <dl class="hy-datos">
                    <div><dt>Puede empezar</dt><dd>{{ c.availability || '—' }}</dd></div>
                    <div><dt>Tarda en llegar</dt><dd>{{ c.commute_time || '—' }}</dd></div>
                    <div><dt>Pide de sueldo</dt><dd>{{ c.desired_salary || '—' }}</dd></div>
                    <div><dt>¿Ya trabajó aquí?</dt><dd>{{ c.rehire_note || '—' }}</dd></div>
                  </dl>
                  <div class="hy-contacto">
                    @if (c.phone) {
                      <a pButton [href]="'tel:' + soloDigitos(c.phone)"><i class="pi pi-phone" aria-hidden="true"></i><span>Llamar · {{ tel(c.phone) }}</span></a>
                      <a pButton class="p-button-secondary p-button-outlined" [href]="whatsapp(c.phone)" target="_blank" rel="noopener"><i class="pi pi-whatsapp" aria-hidden="true"></i><span>WhatsApp</span></a>
                    } @else { <span class="hy-nota">No tiene teléfono registrado: búscalo en su ficha.</span> }
                  </div>
                  @if (pendiente() === 'seguimiento' && c.ultimos.length) {
                    <div class="hy-ultimos"><h4>Lo último con esta persona</h4>
                      <ul>@for (u of c.ultimos; track $index) { <li><span class="mono">{{ fecha(u.cuando) }}</span> {{ u.texto }}@if (u.quien) { <small>· {{ u.quien }}</small> }</li> }</ul>
                    </div>
                  }
                } @else if (pendiente() === 'expediente') {
                  <p class="hy-nota">Ya mandó todos los documentos obligatorios. Revísalos en su ficha antes de contestar.</p>
                  <p-button label="Ver sus documentos" icon="pi pi-folder-open" severity="secondary" [outlined]="true" (onClick)="abrirFicha(c.id)" />
                } @else {
                  <p class="hy-nota">La evaluación de aptitudes la llena el jefe que lo entrevista, no el candidato. Crea su liga y mándasela.</p>
                }

                @if (!gestiona()) {
                  <p class="hy-aviso" role="note">Puedes ver, pero para registrar necesitas el permiso de gestionar reclutamiento.</p>
                }

                @switch (pregunta()) {
                  @case ('agendar') {
                    <div class="hy-caja" role="group" aria-label="Cuándo es la entrevista">
                      <h4>¿Cuándo es la entrevista?</h4>
                      <div class="hy-fila">
                        <p-select [options]="dias" optionLabel="label" optionValue="value" [ngModel]="dia()" (ngModelChange)="dia.set($event)" appendTo="body" ariaLabel="Día" />
                        <p-select [options]="horas" [ngModel]="hora()" (ngModelChange)="hora.set($event)" appendTo="body" ariaLabel="Hora" />
                        <p-button label="Guardar" (onClick)="agendar()" />
                        <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="pregunta.set(null)" />
                      </div>
                    </div>
                  }
                  @case ('cerrar') {
                    <div class="hy-caja" role="group" aria-label="Por qué se cierra">
                      <h4>¿Por qué se cierra? Un clic y queda escrito en su historia.</h4>
                      <div class="hy-fila">
                        @for (m of motivos; track m) { <p-button [label]="m" size="small" severity="secondary" [outlined]="true" (onClick)="cerrar(m)" /> }
                        <p-button label="Cancelar" size="small" [text]="true" severity="secondary" (onClick)="pregunta.set(null)" />
                      </div>
                    </div>
                  }
                  @case ('tercer') {
                    <div class="hy-caja hy-caja-aviso" role="group" aria-label="Tercer intento">
                      <h4>Van {{ c.intentos_sin_respuesta + 1 }} llamadas sin respuesta. ¿Lo cierro?</h4>
                      <div class="hy-fila">
                        <p-button label="Sí, cerrar por «No contestó»" (onClick)="noContestoYCerrar()" />
                        <p-button label="Dejarlo para después" severity="secondary" [outlined]="true" (onClick)="noContesto()" />
                      </div>
                    </div>
                  }
                  @default {
                    @if (liga(); as l) {
                      <div class="hy-caja" role="group" aria-label="Liga para el jefe">
                        <h4>Liga lista (vence {{ fecha(l.expires_at) }}). Mándasela al jefe que entrevista:</h4>
                        <input class="hy-liga" readonly [value]="l.url" aria-label="Liga de la evaluación" />
                        <div class="hy-fila">
                          @if (l.whatsapp_url) { <a pButton [href]="l.whatsapp_url" target="_blank" rel="noopener"><i class="pi pi-whatsapp" aria-hidden="true"></i><span>Mandar por WhatsApp</span></a> }
                          <p-button label="Copiar" icon="pi pi-copy" severity="secondary" [outlined]="true" (onClick)="copiar(l.url)" />
                          <p-button label="Siguiente" icon="pi pi-arrow-right" iconPos="right" severity="secondary" (onClick)="siguienteTrasLiga()" />
                        </div>
                      </div>
                    } @else {
                      <p class="hy-preg">{{ pendiente() === 'expediente' ? '¿Cómo está su expediente?' : pendiente() === 'jefe' ? 'La evaluación' : '¿Cómo te fue?' }}</p>
                      <div class="hy-resp">
                        @for (r of respuestas(); track r.id) {
                          <button type="button" class="hy-r" [disabled]="!gestiona() || bloqueado()" (click)="responder(r)">
                            <span><b>{{ r.titulo }}</b> <kbd>{{ r.tecla }}</kbd></span><small>{{ r.ayuda }}</small>
                          </button>
                        }
                      </div>
                    }
                  }
                }

                <footer class="hy-paso">
                  <p-button label="Saltar a la siguiente" [text]="true" severity="secondary" (onClick)="saltar()" />
                  <p-button label="Ver ficha completa" [text]="true" severity="secondary" (onClick)="abrirFicha(c.id)" />
                </footer>
              </article>
              <p class="hy-teclas"><kbd>1</kbd>–<kbd>{{ respuestas().length }}</kbd> contestar · <kbd>→</kbd> saltar · <kbd>Esc</kbd> volver a Hoy</p>
            </section>
          }
        }

        @case ('fin') {
          <div class="hy-fin" role="status">
            <i class="pi pi-check-circle" aria-hidden="true"></i>
            <h2>Listo: {{ texto(pendiente()).fin.toLowerCase() }} ({{ hechosDe(pendiente()) }})</h2>
            <ul>@for (r of resumen(); track r.texto) { <li>{{ r.texto }}: <b class="mono">{{ r.n }}</b></li> }</ul>
            <p-button label="Volver a Hoy" (onClick)="volverAHoy()" />
          </div>
        }
      }

      @if (aviso(); as a) {
        <div class="hy-toast" [class.hy-toast-mal]="a.mal" role="status" aria-live="polite">
          <span>{{ a.texto }}</span>
          @if (a.deshacer) { <button type="button" (click)="deshacer()">Deshacer</button> }
          @if (a.mal) { <button type="button" (click)="aviso.set(null)" aria-label="Cerrar aviso">Entendido</button> }
        </div>
      }

      <app-side-peek [open]="peek()" (openChange)="peek.set($event)" [title]="ficha()?.full_name || 'Candidato'" [width]="640">
        @if (ficha(); as f) {
          <app-rh-candidato-ficha [ficha]="f" [casilleros]="casilleros()" [gestiona]="gestiona()" (actualizada)="ficha.set($event)" (fusionado)="peek.set(false)" />
        } @else if (errorFicha()) {
          <p class="hy-aviso" role="alert">{{ errorFicha() }}</p>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .hy-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); max-width: 60rem; }
    .hy-acc { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .hy-saludo { margin: 0; font-size: var(--fs-base); color: var(--text-muted); }
    .hy-saludo b { color: var(--text-main); }
    .hy-tareas { display: flex; flex-direction: column; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .hy-tarea { display: grid; grid-template-columns: 3.25rem 1fr auto; gap: var(--sp-4); align-items: center; padding: var(--sp-4); }
    .hy-tarea + .hy-tarea { border-top: 1px solid var(--border-color); }
    .hy-num { display: grid; place-items: center; width: 3rem; height: 3rem; border-radius: var(--r-pill); background: var(--surface-2);
      font-size: var(--fs-h2); font-weight: 700; color: var(--text-main); }
    .hy-primera .hy-num { background: var(--card-bg); color: var(--action); box-shadow: inset 0 0 0 2px var(--action); }
    .hy-txt h2 { margin: 0; font-size: var(--fs-base); font-weight: 700; color: var(--text-main); }
    .hy-txt p { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .hy-txt .hy-quien { color: var(--text-main); }
    .hy-txt .hy-total { font-size: var(--fs-xs); }
    .hy-avance, .hy-pie { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .hy-pie a, .hy-fin a { color: var(--text-main); font-weight: 600; }
    .hy-fin { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-5); background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .hy-fin > i { font-size: 2rem; color: var(--ok-soft-fg); }
    .hy-fin h2 { margin: 0; font-size: var(--fs-h2); }
    .hy-fin p, .hy-fin ul { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .hy-modo { display: flex; flex-direction: column; gap: var(--sp-3); }
    .hy-paso { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .hy-paso h2 { margin: 0; font-size: var(--fs-base); font-weight: 700; }
    .hy-barra-l { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
    .hy-barra { flex: 1; height: 6px; border-radius: var(--r-pill); background: var(--border-color); overflow: hidden; }
    .hy-barra i { display: block; height: 100%; background: var(--ok-soft-fg); }
    .hy-tarjeta { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-5); background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .hy-tarjeta header h3 { margin: 0; font-size: var(--fs-h2); font-weight: 700; color: var(--text-main); }
    .hy-tarjeta header p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 700; vertical-align: middle; }
    .pill[data-t='nuevo'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .hy-datos { margin: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-2); }
    .hy-datos div { background: var(--surface-2); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); }
    .hy-datos dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .hy-datos dd { margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); overflow-wrap: anywhere; }
    .hy-contacto, .hy-fila { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .hy-ultimos { border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); }
    .hy-ultimos h4, .hy-caja h4 { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .hy-ultimos ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-xs); color: var(--text-main); }
    .hy-ultimos small { color: var(--text-muted); }
    .hy-nota { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .hy-aviso { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--warn-soft-bg); color: var(--warn-soft-fg); font-size: var(--fs-sm); }
    .hy-caja { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--surface-2); }
    .hy-caja-aviso { background: var(--warn-soft-bg); }
    .hy-liga { width: 100%; height: 2.25rem; padding: 0 var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); font-family: var(--font-mono); font-size: var(--fs-xs); }
    .hy-preg { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-muted); }
    .hy-resp { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); }
    .hy-r { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-height: 3.5rem; padding: var(--sp-2) var(--sp-3); text-align: left;
      border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main); font: inherit; cursor: pointer; }
    .hy-r:hover:not(:disabled) { background: var(--surface-hover-bg); }
    .hy-r:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .hy-r:disabled { opacity: .5; cursor: not-allowed; }
    .hy-r b { font-size: var(--fs-sm); }
    .hy-r small { font-size: var(--fs-xs); color: var(--text-muted); }
    kbd { font-family: var(--font-mono); font-size: var(--fs-micro); border: 1px solid var(--border-color); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: var(--surface-2); color: var(--text-muted); }
    .hy-teclas { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .hy-toast { position: fixed; left: 50%; bottom: calc(var(--sp-5) + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 50;
      display: flex; align-items: center; gap: var(--sp-3); max-width: min(36rem, calc(100vw - 2rem)); padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-4);
      border-radius: var(--r-md); background: var(--text-main); color: var(--card-bg); font-size: var(--fs-sm); box-shadow: var(--shadow-float); }
    .hy-toast button { border: 1px solid currentColor; background: none; color: inherit; border-radius: var(--r-sm); padding: var(--sp-1) var(--sp-3); font: inherit; font-weight: 700; cursor: pointer; }
    .hy-toast button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .hy-toast-mal { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    @container (max-width: 40rem) {
      .hy-tarea { grid-template-columns: 2.75rem 1fr; }
      .hy-tarea p-button { grid-column: 1 / -1; }
      .hy-datos, .hy-resp { grid-template-columns: 1fr 1fr; }
    }
    @media (prefers-reduced-motion: no-preference) { .hy-barra i { transition: width 200ms ease-out; } }
  `],
})
export class RhReclutamientoHoyComponent implements OnInit, OnDestroy {
  private readonly api = inject(ReclutamientoService);
  private readonly perms = inject(PermissionsService);

  readonly motivos = MOTIVOS_CIERRE;
  readonly dias = diasParaAgendar();
  readonly horas = HORAS_ENTREVISTA;

  readonly datos = signal<HrHoyDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly leidoEn = signal<Date | null>(null);
  readonly modo = signal<Modo>({ tipo: 'lista' });
  readonly cola = signal<HrHoyCandidatoDto[]>([]);
  readonly pregunta = signal<Pregunta>(null);
  readonly dia = signal<string | null>(this.dias[0]?.value ?? null);
  readonly hora = signal<string>(HORAS_ENTREVISTA[1]);
  readonly liga = signal<HrLigaCreadaDto | null>(null);
  readonly bloqueado = signal(false);
  readonly aviso = signal<{ texto: string; deshacer: boolean; mal: boolean } | null>(null);
  /** Lo contestado en esta sesión, por pendiente (para «Terminaste» y «Hoy llevas»). */
  readonly hechos = signal<Record<HrHoyPendienteId, string[]>>({ nuevos: [], seguimiento: [], expediente: [], jefe: [] });

  readonly peek = signal(false);
  readonly ficha = signal<HrCandidatoFichaDto | null>(null);
  readonly errorFicha = signal<string | null>(null);
  readonly casilleros = signal<HrCasilleroDto[]>([]);

  readonly gestiona = computed(() => this.perms.has(Permission.HR_RECRUITMENT_GESTIONAR));
  readonly conTrabajo = computed(() => (this.datos()?.pendientes ?? []).filter((p) => p.candidatos.length > 0));
  readonly pendiente = computed<HrHoyPendienteId>(() => { const m = this.modo(); return m.tipo === 'lista' ? 'nuevos' : m.p; });
  readonly actual = computed(() => this.cola()[0] ?? null);
  readonly respuestas = computed<Respuesta[]>(() => { const c = this.actual(); return c ? respuestasDe(this.pendiente(), c) : []; });
  readonly hechosHoy = computed(() => Object.values(this.hechos()).reduce((s, l) => s + l.length, 0));
  readonly cifras = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const paraHoy = d.pendientes.reduce((s, p) => s + p.candidatos.length, 0);
    const enTotal = d.pendientes.reduce((s, p) => s + p.total, 0);
    return [
      { label: 'Para hoy', value: paraHoy, format: 'number', sub: enTotal > paraHoy ? `de ${enTotal} pendientes en total` : 'todos los pendientes' },
      { label: 'Atendidos en esta sesión', value: this.hechosHoy(), format: 'number', tone: this.hechosHoy() ? 'ok' : 'default' },
      { label: `Sin movimiento +${d.dias_apartado} días`, value: d.apartados, format: 'number', tone: 'muted', sub: 'no cuentan como pendientes' },
    ];
  });
  readonly avance = computed(() => { const h = this.hechosDe(this.pendiente()); const t = h + this.cola().length; return t ? Math.round((h / t) * 100) : 0; });
  readonly resumen = computed(() => {
    const m = new Map<string, number>();
    for (const r of this.hechos()[this.pendiente()]) m.set(r, (m.get(r) ?? 0) + 1);
    return [...m].map(([texto, n]) => ({ texto, n }));
  });

  private porGuardar: PorGuardar | null = null;

  ngOnInit(): void {
    this.cargar();
    this.api.casilleros().subscribe({ next: (c) => this.casilleros.set(c), error: () => this.casilleros.set([]) });
  }

  ngOnDestroy(): void { void this.guardarYa(); }

  /** Si hay algo contestado que todavía no se guarda, el navegador pregunta antes de cerrar la pestaña. */
  @HostListener('window:beforeunload', ['$event'])
  antesDeSalir(e: BeforeUnloadEvent): void {
    if (this.porGuardar) { void this.guardarYa(); e.preventDefault(); e.returnValue = ''; }
  }

  @HostListener('document:keydown', ['$event'])
  tecla(e: KeyboardEvent): void {
    if (this.modo().tipo !== 'tarjeta' || this.peek()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('.p-select-overlay, .p-overlay'))) return;
    if (e.key === 'Escape') { e.preventDefault(); if (this.pregunta()) this.pregunta.set(null); else this.volverAHoy(); return; }
    if (this.pregunta() || this.liga()) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); this.saltar(); return; }
    const r = this.respuestas().find((x) => x.tecla === e.key);
    if (r && this.gestiona() && !this.bloqueado()) { e.preventDefault(); this.responder(r); }
  }

  texto(p: HrHoyPendienteId) { return TEXTO_PENDIENTE[p]; }
  etapa(id: string) { return etapaLabel(id); }
  fecha(iso: string | null) { return fechaHoraMx(iso); }
  tel(t: string) { return telefono(t); }
  soloDigitos(t: string) { return t.replace(/\D/g, ''); }
  whatsapp(t: string) { const d = this.soloDigitos(t).slice(-10); return `https://wa.me/52${d}`; }
  hechosDe(p: HrHoyPendienteId) { return this.hechos()[p].length; }
  saludo() { const h = new Date().getHours(); return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'; }
  nombres(l: HrHoyCandidatoDto[]): string {
    const n = l.slice(0, 3).map((c) => (c.full_name || 'Sin nombre').split(/\s+/).slice(0, 2).join(' '));
    return n.join(', ') + (l.length > 3 ? ` y ${l.length - 3} más` : '');
  }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.hoy().subscribe({
      next: (d) => { this.datos.set(d); this.leidoEn.set(new Date()); this.loading.set(false); },
      error: (e) => { this.error.set(rhError(e, 'No se pudieron leer los pendientes de hoy.')); this.loading.set(false); },
    });
  }

  empezar(p: HrHoyPendienteId): void {
    const g = this.datos()?.pendientes.find((x) => x.id === p);
    if (!g?.candidatos.length) return;
    this.cola.set([...g.candidatos]);
    this.pregunta.set(null);
    this.liga.set(null);
    this.modo.set({ tipo: 'tarjeta', p });
  }

  /** Guarda lo pendiente y vuelve a leer: los números de «Hoy» siempre son los del servidor. */
  async volverAHoy(): Promise<void> {
    this.pregunta.set(null);
    this.liga.set(null);
    this.modo.set({ tipo: 'lista' });
    await this.guardarYa();
    this.cargar();
  }

  saltar(): void {
    const l = this.cola();
    if (l.length > 1) this.cola.set([...l.slice(1), l[0]]);
    this.pregunta.set(null);
    this.liga.set(null);
  }

  responder(r: Respuesta): void {
    const c = this.actual();
    if (!c || !this.gestiona() || this.bloqueado()) return;
    switch (r.id) {
      case 'agendo': this.pregunta.set('agendar'); return;
      case 'cerrar': this.pregunta.set('cerrar'); return;
      case 'no_contesto':
        if (c.intentos_sin_respuesta + 1 >= INTENTOS_PARA_PREGUNTAR) { this.pregunta.set('tercer'); return; }
        this.noContesto(); return;
      case 'exp_mal':
        this.abrirFicha(c.id);
        this.avanzar(c, resultadoDe('exp_mal', c));
        this.mostrar(`Abrí la ficha de ${this.corto(c)}: retira el documento y pídelo otra vez.`, false);
        return;
      case 'liga_jefe': this.crearLigaJefe(c); return;
      default: this.diferir(c, r.id);
    }
  }

  noContesto(): void { const c = this.actual(); if (c) this.diferir(c, 'no_contesto'); }

  noContestoYCerrar(): void {
    const c = this.actual();
    if (!c) return;
    const plan = [...planDe('no_contesto', c), ...planDe('cerrar', c, { motivo: `No contestó (${c.intentos_sin_respuesta + 1} intentos)` })];
    this.diferirPlan(c, plan, 'Se cerraron por no contestar', `${this.corto(c)}: se cierra por no contestar`);
  }

  agendar(): void {
    const c = this.actual();
    if (!c || !this.dia()) return;
    this.diferir(c, 'agendo', { cuando: `${this.dia()} ${this.hora()}` });
  }

  cerrar(motivo: string): void { const c = this.actual(); if (c) this.diferir(c, 'cerrar', { motivo }); }

  abrirFicha(id: string): void {
    this.ficha.set(null);
    this.errorFicha.set(null);
    this.peek.set(true);
    this.api.ficha(id).subscribe({ next: (f) => this.ficha.set(f), error: (e) => this.errorFicha.set(rhError(e, 'No se pudo abrir la ficha.')) });
  }

  copiar(url: string): void {
    void navigator.clipboard?.writeText(url).then(() => this.mostrar('Liga copiada.', false), () => this.mostrar('No se pudo copiar: selecciona la liga y cópiala.', false, true));
  }

  siguienteTrasLiga(): void {
    const c = this.actual();
    this.liga.set(null);
    if (c) this.avanzar(c, resultadoDe('liga_jefe', c));
  }

  deshacer(): void {
    const g = this.porGuardar;
    if (!g) return;
    clearTimeout(g.timer);
    this.porGuardar = null;
    this.quitarHecho(g.p, g.resultado);
    this.cola.set([g.c, ...this.cola()]);
    if (this.modo().tipo === 'fin') this.modo.set({ tipo: 'tarjeta', p: g.p });
    this.aviso.set(null);
  }

  // ── lo que guarda ───────────────────────────────────────────────────────────────────────

  private corto(c: HrHoyCandidatoDto): string { return (c.full_name || 'Sin nombre').split(/\s+/).slice(0, 2).join(' '); }

  private diferir(c: HrHoyCandidatoDto, r: RespuestaId, extra: { motivo?: string; cuando?: string } = {}): void {
    const etiqueta: Record<string, string> = { interesa: 'le interesa', no_contesto: 'no contestó', agendo: 'entrevista agendada', cerrar: 'se cierra', exp_bien: 'expediente revisado' };
    this.diferirPlan(c, planDe(r, c, extra), resultadoDe(r, c), `${this.corto(c)}: ${etiqueta[r] ?? 'anotado'}`);
  }

  /**
   * La respuesta se ve aplicada al instante (pasa a la siguiente persona) y se GUARDA a los 5 s, o antes si se contesta
   * otra, se sale o se cierra la pestaña. Mientras, «Deshacer» la regresa sin que nada haya llegado al servidor.
   */
  private diferirPlan(c: HrHoyCandidatoDto, plan: Paso[], resultado: string, texto: string): void {
    void this.guardarYa();
    const p = this.pendiente();
    const timer = setTimeout(() => void this.guardarYa(), ESPERA_DESHACER_MS);
    this.porGuardar = { c, p, plan, resultado, timer };
    this.avanzar(c, resultado);
    this.mostrar(texto, true);
  }

  private avanzar(c: HrHoyCandidatoDto, resultado: string): void {
    const p = this.pendiente();
    this.hechos.set({ ...this.hechos(), [p]: [...this.hechos()[p], resultado] });
    this.cola.set(this.cola().filter((x) => x.id !== c.id));
    this.pregunta.set(null);
    this.bloqueado.set(true);
    setTimeout(() => this.bloqueado.set(false), BLOQUEO_DOBLE_CLIC_MS);
    if (!this.cola().length) this.modo.set({ tipo: 'fin', p });
  }

  private quitarHecho(p: HrHoyPendienteId, resultado: string): void {
    const l = [...this.hechos()[p]];
    const i = l.lastIndexOf(resultado);
    if (i >= 0) l.splice(i, 1);
    this.hechos.set({ ...this.hechos(), [p]: l });
  }

  /** Manda lo que esté por guardar. Si un paso falla, lo dice con lo que sí quedó, y la persona vuelve a su cola. */
  private async guardarYa(): Promise<void> {
    const g = this.porGuardar;
    if (!g) return;
    clearTimeout(g.timer);
    this.porGuardar = null;
    if (this.aviso()?.deshacer) this.aviso.set(null);
    let hechos = 0;
    try {
      for (const paso of g.plan) {
        if (paso.tipo === 'evento') await firstValueFrom(this.api.evento(g.c.id, paso.cuerpo));
        else await firstValueFrom(this.api.moverEtapa(g.c.id, paso.stage));
        hechos += 1;
      }
    } catch (e) {
      this.quitarHecho(g.p, g.resultado);
      const motivo = rhError(e, 'el servidor no respondió');
      const mitad = hechos > 0 ? ' Una parte sí quedó: revisa su ficha antes de repetirlo.' : '';
      this.mostrar(`No se guardó lo de ${this.corto(g.c)}: ${motivo}.${mitad}`, false, true);
      if (hechos === 0 && this.modo().tipo !== 'lista' && this.modo().tipo !== 'fin') this.cola.set([g.c, ...this.cola()]);
    }
  }

  private crearLigaJefe(c: HrHoyCandidatoDto): void {
    this.bloqueado.set(true);
    this.api.crearLiga(c.id, 'aptitudes').subscribe({
      next: (l) => { this.liga.set(l); this.bloqueado.set(false); },
      error: (e) => { this.bloqueado.set(false); this.mostrar(`No se pudo crear la liga: ${rhError(e, 'el servidor no respondió')}.`, false, true); },
    });
  }

  private timerAviso: ReturnType<typeof setTimeout> | null = null;
  private mostrar(texto: string, deshacer: boolean, mal = false): void {
    if (this.timerAviso) clearTimeout(this.timerAviso);
    this.aviso.set({ texto, deshacer, mal });
    if (!mal) this.timerAviso = setTimeout(() => this.aviso.set(null), ESPERA_DESHACER_MS);
  }
}
