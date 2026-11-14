import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map, type Observable } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { PAPELES_FIRMA, folioVale, type CambiosTrabajoVale, type PapelFirma, type ValeDetalle } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { FirmaTrazoComponent } from '../components/firma-trazo.component';
import { ValesService } from '../vales.service';
import { PAPEL, cuandoMx, etiquetaEstadoVale, etiquetaEvento, severidadEstadoVale } from '../vales-formato';

type CampoTrabajo = 'work_detail' | 'materials_used' | 'outcome' | 'follow_up_notes' | 'general_notes';
const CAMPOS: { campo: CampoTrabajo; rotulo: string; filas: number }[] = [
  { campo: 'work_detail', rotulo: 'Trabajo realizado', filas: 4 },
  { campo: 'materials_used', rotulo: 'Materiales usados', filas: 2 },
  { campo: 'outcome', rotulo: 'Resultado', filas: 2 },
  { campo: 'follow_up_notes', rotulo: 'Observaciones de seguimiento', filas: 2 },
  { campo: 'general_notes', rotulo: 'Observaciones generales', filas: 2 },
];

/**
 * `[MDT.3.4]` Un vale de servicio — ¿qué falta para cerrarlo?
 *
 * Arriba el folio, el estado y la acción que toca ahora (tomar, completar); después el trabajo, las tres
 * firmas y el historial. Los botones salen de lo que el SERVIDOR dice que esta persona puede hacer
 * (`acciones`), con el porqué de lo que no. El trabajo se guarda con un botón y salir con cambios sin
 * guardar pregunta antes.
 */
@Component({
  selector: 'app-vales-detalle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, ButtonModule, DialogModule, InputTextModule, SelectModule, TagModule, TextareaModule, ToastModule,
    ConfirmDialogModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, ContextHelpComponent, FirmaTrazoComponent],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page vd-page">
      <p-toast position="top-center"></p-toast>
      <p-confirmdialog></p-confirmdialog>
      <a class="vd-volver" routerLink="/vales/lista"><i class="pi pi-arrow-left" aria-hidden="true"></i> Vales de servicio</a>

      <app-load-state [loading]="cargando() && !v()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
        @if (v(); as e) {
          <header class="surf-page-head">
            <div class="surf-page-head-text">
              <h1>Vale {{ folio(e.folio) }} <p-tag [value]="etiquetaEstadoVale(e.status)" [severity]="severidadEstadoVale(e.status)" /></h1>
              <p class="surf-page-sub">{{ e.activity }}</p>
            </div>
            <div class="vd-acciones">
              <app-freshness-pill measures="fetch" [since]="cargado()" label="Actualizado" [staleAfterSec]="300" />
              <app-context-help topic="vales-servicio" />
            </div>
          </header>

          <app-metric-strip [items]="kpis()" ariaLabel="Datos del vale" density="compact" />
          <p class="vd-datos">{{ e.requesting_area }}@if (e.location_detail) { · {{ e.location_detail }} } · pidió {{ e.requester_name }}
            · levantado {{ cuando(e.created_at) }}@if (e.source === 'mdtask') { · <strong>cargado de MDTask</strong> }</p>
          @if (e.status === 'cancelled' && e.cancel_reason) { <p class="vd-banda vd-banda-gris" role="status">Cancelado: {{ e.cancel_reason }}</p> }

          <div class="vd-botones">
            @if (e.acciones.take === null) {
              <button pButton type="button" (click)="ejecutar(svc.tomar(e.id), 'Lo tomaste')" [disabled]="ocupado()">
                <span class="p-button-label">Tomar este vale</span></button>
            }
            @if (e.acciones.complete === null) {
              <button pButton type="button" (click)="completar()" [disabled]="ocupado() || !trabajoEscrito()" [attr.title]="trabajoEscrito() ? null : 'Escribe el trabajo realizado'">
                <span class="p-button-label">Completar</span></button>
            }
            @if (e.acciones.assign === null) {
              <p-select [options]="responsables()" optionLabel="etiqueta" optionValue="id" [ngModel]="null" (ngModelChange)="asignar($event)"
                        [filter]="true" filterBy="etiqueta" (onShow)="cargarResponsables()" placeholder="Asignar a…" ariaLabel="Asignar el vale" appendTo="body" />
            }
            @if (e.acciones.cancel === null) {
              <button pButton type="button" class="p-button-text" (click)="pedirMotivo('cancel')" [disabled]="ocupado()">
                <span class="p-button-label">Cancelar vale</span></button>
            }
            @if (e.acciones.reopen === null) {
              <button pButton type="button" class="p-button-outlined" (click)="pedirMotivo('reopen')" [disabled]="ocupado()">
                <span class="p-button-label">Reabrir</span></button>
            }
          </div>
          @if (e.status === 'open' && e.acciones.take !== null && e.acciones.assign !== null) {
            <p class="vd-nota">Espera a que alguien lo tome. {{ e.acciones.take }}</p>
          }

          <section class="vd-seccion" aria-labelledby="vd-t-trabajo">
            <h2 id="vd-t-trabajo">El trabajo</h2>
            @for (c of campos; track c.campo) {
              <label class="vd-campo" [for]="'vd-' + c.campo">
                <span class="vd-rotulo">{{ c.rotulo }}</span>
                <textarea pTextarea [id]="'vd-' + c.campo" [rows]="c.filas" maxlength="4000" [value]="borrador()[c.campo] ?? ''"
                          [readonly]="!e.puede_editar_trabajo" (input)="escribir(c.campo, $any($event.target).value)"></textarea>
              </label>
            }
            <div class="vd-campo">
              <span class="vd-rotulo" id="vd-seg">¿Requiere seguimiento?</span>
              <app-segmented [options]="opcionesSeguimiento" [value]="seguimiento()" (valueChange)="elegirSeguimiento($event)"
                             ariaLabel="Requiere seguimiento" />
            </div>
            @if (e.puede_editar_trabajo) {
              <div class="vd-guardar">
                <span class="vd-nota" aria-live="polite">{{ sucio() ? 'Hay cambios sin guardar' : 'Todo guardado' }}</span>
                <button pButton type="button" class="p-button-outlined" (click)="guardar()" [disabled]="ocupado() || !sucio()">
                  <span class="p-button-label">Guardar</span></button>
              </div>
            }
          </section>

          <section class="vd-seccion" aria-labelledby="vd-t-firmas">
            <h2 id="vd-t-firmas">Firmas <span class="vd-nota">(ninguna es obligatoria para cerrar)</span></h2>
            <ul class="vd-firmas">
              @for (p of papeles; track p) {
                <li class="vd-firma">
                  <span class="vd-rotulo">{{ papel[p] }}</span>
                  @if (firmaDe(p); as f) {
                    @if (f.url) { <img [src]="f.url" [alt]="'Firma de ' + f.signer_name" class="vd-firma-img" width="240" height="90" /> }
                    <span>{{ f.signer_name }} · {{ f.signed_on }}</span>
                    @if (e.status !== 'completed' && e.puede_editar_trabajo) {
                      <button type="button" class="vd-enlace" (click)="pedirQuitarFirma(f.id, papel[p])" [disabled]="ocupado()">Quitar</button>
                    }
                  } @else {
                    <span class="vd-nota">Sin firma</span>
                    @if (e.puede_firmar) {
                      <button pButton type="button" class="p-button-outlined vd-firmar" (click)="abrirFirma(p)" [disabled]="ocupado()">
                        <span class="p-button-label">Firmar</span></button>
                    }
                  }
                </li>
              }
            </ul>
          </section>

          <section class="vd-seccion" aria-labelledby="vd-t-hist">
            <h2 id="vd-t-hist">Historial</h2>
            <ol class="vd-hist">
              @for (h of e.eventos; track $index) {
                <li><span class="vd-cuando">{{ cuando(h.at) }}</span> {{ h.actor_name || 'Alguien' }} — {{ etiquetaEvento(h.kind) }}@if (h.note) { : {{ h.note }} }</li>
              }
            </ol>
          </section>
        }
      </app-load-state>

      <p-dialog [visible]="!!firmando()" (visibleChange)="!$event && firmando.set(null)" [modal]="true"
                [header]="firmando() ? papel[firmando()!] : ''" [style]="{ width: 'min(32rem, 96vw)' }" [draggable]="false">
        @if (firmando()) {
          <div class="vd-form">
            <label class="vd-campo" for="vd-firmante"><span class="vd-rotulo">Nombre de quien firma</span>
              <input pInputText id="vd-firmante" maxlength="120" [value]="firmante()" (input)="firmante.set($any($event.target).value)" />
            </label>
            <app-firma-trazo (cambio)="trazo.set($event)" />
          </div>
        }
        <ng-template #footer>
          <button pButton type="button" class="p-button-text" (click)="firmando.set(null)" [disabled]="ocupado()"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" (click)="firmar()" [disabled]="ocupado() || !trazo() || !firmante().trim()"><span class="p-button-label">Guardar firma</span></button>
        </ng-template>
      </p-dialog>

      <p-dialog [visible]="!!motivoDe()" (visibleChange)="!$event && motivoDe.set(null)" [modal]="true"
                [header]="motivoDe() === 'cancel' ? '¿Cancelar este vale?' : '¿Reabrir este vale?'" [style]="{ width: 'min(30rem, 96vw)' }" [draggable]="false">
        <label class="vd-campo" for="vd-motivo"><span class="vd-rotulo">Motivo (queda en el historial)</span>
          <textarea pTextarea id="vd-motivo" rows="3" maxlength="500" [value]="motivo()" (input)="motivo.set($any($event.target).value)"></textarea>
        </label>
        <ng-template #footer>
          <button pButton type="button" class="p-button-text" (click)="motivoDe.set(null)" [disabled]="ocupado()"><span class="p-button-label">Volver</span></button>
          <button pButton type="button" [class.p-button-danger]="motivoDe() === 'cancel'" (click)="confirmarMotivo()" [disabled]="ocupado() || !motivo().trim()">
            <span class="p-button-label">{{ motivoDe() === 'cancel' ? 'Cancelar vale' : 'Reabrir' }}</span></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .vd-page { display: flex; flex-direction: column; gap: var(--sp-4); }
    .vd-volver { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 44px; color: var(--text-muted); text-decoration: none; }
    .vd-volver:focus-visible, .vd-enlace:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .vd-acciones { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .vd-datos { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .vd-banda { margin: 0; padding: var(--sp-3); border-radius: var(--r-md); }
    .vd-banda-gris { background: var(--overlay-hover); color: var(--text-main); }
    .vd-botones { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .vd-botones button { min-height: 44px; }
    .vd-seccion { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .vd-seccion h2 { margin: 0; font-size: var(--fs-md); font-weight: 600; }
    .vd-campo { display: flex; flex-direction: column; gap: var(--sp-1); }
    .vd-rotulo { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .vd-nota { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); font-weight: 400; }
    .vd-guardar { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-3); }
    .vd-firmas { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-3); grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
    .vd-firma { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); }
    .vd-firma-img { max-width: 100%; height: auto; background: var(--neutral-50); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .vd-firmar { min-height: 44px; }
    .vd-enlace { min-height: 36px; padding: 0; background: none; border: none; cursor: pointer; color: var(--text-muted); text-decoration: underline; font: inherit; }
    @media (pointer: coarse) { .vd-enlace { min-height: 44px; } }
    .vd-hist { margin: 0; padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .vd-cuando { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .vd-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    /* En angosto (celular, panel lateral) cada acción ocupa su renglón: el pulgar no atina a dos botones juntos. */
    @container (max-width: 40rem) {
      .vd-botones > * { flex: 1 1 100%; }
      .vd-guardar { flex-direction: column; align-items: stretch; }
    }
  `],
})
export class ValesDetalleComponent {
  readonly svc = inject(ValesService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly route = inject(ActivatedRoute);

  readonly folio = folioVale;
  readonly etiquetaEstadoVale = etiquetaEstadoVale;
  readonly severidadEstadoVale = severidadEstadoVale;
  readonly etiquetaEvento = etiquetaEvento;
  readonly cuando = cuandoMx;
  readonly papel = PAPEL;
  readonly papeles = PAPELES_FIRMA;
  readonly campos = CAMPOS;
  readonly opcionesSeguimiento: SegOption[] = [{ label: 'Sí', value: 'si' }, { label: 'No', value: 'no' }, { label: 'Sin contestar', value: 'nc' }];

  private readonly id = toSignal(this.route.paramMap.pipe(map((p) => p.get('id') ?? '')), { initialValue: '' });
  readonly v = signal<ValeDetalle | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargado = signal<Date | null>(null);
  readonly ocupado = signal(false);

  /** Lo que se escribe del trabajo, contra lo guardado (para «cambios sin guardar»). */
  readonly borrador = signal<CambiosTrabajoVale>({});
  readonly seguimiento = signal<string>('nc');

  readonly firmando = signal<PapelFirma | null>(null);
  readonly firmante = signal('');
  readonly trazo = signal<string | null>(null);
  readonly motivoDe = signal<'cancel' | 'reopen' | null>(null);
  readonly motivo = signal('');
  readonly responsables = signal<{ id: string; etiqueta: string }[]>([]);

  private readonly alCambiarId = effect(() => { const id = this.id(); if (id) untracked(() => this.cargar()); });

  readonly sucio = computed(() => {
    const e = this.v();
    if (!e) return false;
    const b = this.borrador();
    const segActual = e.needs_follow_up === true ? 'si' : e.needs_follow_up === false ? 'no' : 'nc';
    return CAMPOS.some((c) => (b[c.campo] ?? '') !== (e[c.campo] ?? '')) || this.seguimiento() !== segActual;
  });
  readonly trabajoEscrito = computed(() => !!(this.borrador().work_detail ?? '').trim());
  readonly kpis = computed<MetricStripItem[]>(() => {
    const e = this.v();
    if (!e) return [];
    return [
      { label: 'Lo atiende', value: e.assignee_name || 'Nadie todavía', tone: e.assignee_name ? 'default' : 'warn' },
      { label: 'Firmas', value: e.firmas_detalle.length, sub: 'de 3, opcionales', tone: 'muted' },
      { label: 'Fecha del servicio', value: e.service_date, tone: 'muted' },
    ];
  });

  @HostListener('window:beforeunload', ['$event'])
  alSalir(ev: BeforeUnloadEvent): void {
    if (this.sucio()) { ev.preventDefault(); ev.returnValue = ''; }
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.svc.detalle(this.id()).subscribe({
      next: (e) => this.poner(e),
      error: (err: HttpErrorResponse) => { this.cargando.set(false); this.error.set(err.error?.message || err.message); },
    });
  }

  escribir(campo: CampoTrabajo, valor: string): void {
    this.borrador.update((b) => ({ ...b, [campo]: valor }));
  }

  elegirSeguimiento(v: string): void {
    if (this.v()?.puede_editar_trabajo) this.seguimiento.set(v);
  }

  firmaDe(p: PapelFirma) {
    return this.v()?.firmas_detalle.find((f) => f.role === p) ?? null;
  }

  guardar(): void {
    const e = this.v();
    if (!e || !this.sucio()) return;
    this.ejecutar(this.svc.guardar(e.id, this.cambios()), 'Trabajo guardado');
  }

  /** Completar manda el trabajo en el mismo cuerpo: lo escrito y no guardado no se pierde al cerrar. */
  completar(): void {
    const e = this.v();
    if (!e) return;
    this.confirm.confirm({
      header: '¿Completar este vale?',
      message: 'Se cierra con el trabajo escrito. Las firmas que se pongan después ya no se pueden quitar.',
      acceptLabel: 'Sí, completar', rejectLabel: 'Seguir', rejectButtonStyleClass: 'p-button-text',
      accept: () => this.ejecutar(this.svc.completar(e.id, this.cambios()), `Vale ${folioVale(e.folio)} completado`),
    });
  }

  cargarResponsables(): void {
    if (this.responsables().length) return;
    this.svc.responsables().subscribe({
      next: (rs) => this.responsables.set(rs.map((r) => ({ id: r.id, etiqueta: r.puesto ? `${r.nombre} · ${r.puesto}` : r.nombre }))),
      error: (err: HttpErrorResponse) => this.fallo('No se cargó la lista de personas', err),
    });
  }

  asignar(userId: string | null): void {
    const e = this.v();
    if (!e || !userId) return;
    this.ejecutar(this.svc.asignar(e.id, userId), 'Vale asignado');
  }

  pedirMotivo(a: 'cancel' | 'reopen'): void {
    this.motivo.set('');
    this.motivoDe.set(a);
  }

  confirmarMotivo(): void {
    const e = this.v();
    const a = this.motivoDe();
    const m = this.motivo().trim();
    if (!e || !a || !m) return;
    const peticion = a === 'cancel' ? this.svc.cancelar(e.id, m) : this.svc.reabrir(e.id, m);
    this.ejecutar(peticion, a === 'cancel' ? 'Vale cancelado' : 'Vale reabierto', () => this.motivoDe.set(null));
  }

  abrirFirma(p: PapelFirma): void {
    const e = this.v();
    this.trazo.set(null);
    this.firmante.set(p === 'performed' ? (e?.assignee_name ?? '') : p === 'received' ? (e?.requester_name ?? '') : (e?.supervisor_name ?? ''));
    this.firmando.set(p);
  }

  firmar(): void {
    const e = this.v();
    const p = this.firmando();
    const img = this.trazo();
    if (!e || !p || !img || !this.firmante().trim()) return;
    this.ejecutar(this.svc.firmar(e.id, { role: p, signer_name: this.firmante().trim(), image_base64: img }), 'Firma guardada', () => this.firmando.set(null));
  }

  pedirQuitarFirma(firmaId: string, papel: string): void {
    const e = this.v();
    if (!e) return;
    this.confirm.confirm({
      header: '¿Quitar esta firma?',
      message: `Se quita la firma de «${papel}». Habrá que volver a firmar.`,
      icon: 'pi pi-exclamation-triangle', acceptLabel: 'Sí, quitar', rejectLabel: 'Conservar',
      acceptButtonStyleClass: 'p-button-danger', rejectButtonStyleClass: 'p-button-text',
      accept: () => this.ejecutar(this.svc.quitarFirma(e.id, firmaId), 'Firma quitada'),
    });
  }

  /** Una escritura: apaga los botones en el PRIMER clic (el doble toque no manda dos veces). */
  ejecutar(peticion: Observable<ValeDetalle>, exito: string, despues?: () => void): void {
    if (this.ocupado()) return;
    this.ocupado.set(true);
    peticion.subscribe({
      next: (e) => { this.ocupado.set(false); this.poner(e); despues?.(); this.toast.add({ severity: 'success', summary: exito }); },
      error: (err: HttpErrorResponse) => { this.ocupado.set(false); this.fallo('No se pudo', err); },
    });
  }

  private cambios(): CambiosTrabajoVale {
    const b = this.borrador();
    const s = this.seguimiento();
    const out: CambiosTrabajoVale = { needs_follow_up: s === 'si' ? true : s === 'no' ? false : null };
    for (const c of CAMPOS) out[c.campo] = (b[c.campo] ?? '').trim() || null;
    return out;
  }

  private poner(e: ValeDetalle): void {
    this.v.set(e);
    this.cargando.set(false);
    this.cargado.set(new Date());
    const b: CambiosTrabajoVale = {};
    for (const c of CAMPOS) b[c.campo] = e[c.campo] ?? '';
    this.borrador.set(b);
    this.seguimiento.set(e.needs_follow_up === true ? 'si' : e.needs_follow_up === false ? 'no' : 'nc');
  }

  private fallo(titulo: string, err: HttpErrorResponse): void {
    this.toast.add({ severity: 'error', summary: titulo, detail: err.error?.message || err.message });
  }
}
