import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import {
  AREAS_ACUERDO, ETIQUETA_AREA_ACUERDO, ETIQUETA_SITUACION_ACUERDO, MAX_NOTA_CIERRE_ACUERDO,
  type AccionAcuerdo, type AcuerdoVista, type AreaAcuerdo, type ListaAcuerdos, type SituacionAcuerdo,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PROVEEDORES_TABS } from '../proveedores-tabs';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { motivoHttp } from '../../almacen/shared/http-motivo';
import { AcuerdosProveedoresService } from '../acuerdos-proveedores.service';
import { diaCorto, diaLargo, relativo } from '../citas-proveedores';
import {
  areaAcuerdo, conteoPorArea, cuantosMios, fechaMx, filtrarAcuerdos, plazoAparte, plazoEnPalabras, proveedorDelAcuerdo, respuestaAcuerdos,
  ptDialogoTactil, responsableEnPalabras, SEVERIDAD_ACUERDO, type DeQuien, type VistaAcuerdos,
} from '../acuerdos-proveedores';
import { AcuerdoFormComponent } from '../components/acuerdo-form.component';

/**
 * `[PQ.3.10]` Compras › Proveedores › **Acuerdos** (anexo C §10.20; DC43–DC46; ADR-128).
 *
 * Diseño, por escrito ANTES de la plantilla (skill `diseno` §0a/§0b):
 *  1. **Propósito.** Contesta UNA pregunta: «¿qué compromisos con proveedores están vencidos o por vencer, y de quién
 *     son?». El acto que cierra: marcar cumplido (o cancelar) con su nota.
 *  2. **Quién entra.** Los 7 roles que agendan Citas trabajan los acuerdos; Dirección (ver) consulta (DC44). Cada
 *     responsable llega desde «Mi trabajo» con «Míos» puesto (`?de=mios`). Uso: NO MEDIDO — Citas salió el 2026-11-26
 *     con 0 reuniones; la primera medición real será de Citas.
 *  3. **El estado real.** 0 acuerdos (la tabla nace con este tramo). Sin cuello medido, el orden por omisión es el del
 *     riesgo: lo vencido arriba, después lo que vence hoy y en la semana.
 *  4. **Nivel 0.** La respuesta en una frase y cinco cifras (vencidos, hoy, semana, al día, cerrados), cada una filtra la
 *     lista. La lista: cuándo vence (en palabras), qué se acordó, con qué proveedor y quién responde. UNA acción por
 *     renglón: «Cumplido».
 *  5. **Qué no ve.** La minuta y la gente de la reunión (viven en Citas, a un clic), los cerrados (a un clic, con su
 *     conteo), las cifras del proveedor (Revisión, PQ.3.9) y las ligas por área (DC46, otro tramo). No hay «Capturar» aquí:
 *     un acuerdo sale de una reunión (DC45) y se captura en su detalle; el vacío lleva a Citas.
 *  6. **Desglose.** Cada cifra → la lista filtrada por esa situación. Cada renglón → side-peek con todo (texto completo,
 *     responsable y quién lo asignó, fecha, reunión de origen, nota de cierre) → «Abrir la reunión» lleva a Citas con la
 *     reunión abierta (`?reunion=`). Endpoints: `GET …/acuerdos` (lista) y los de escritura; ninguno nuevo para leer.
 *  7. **Accesibilidad.** Buscador común (`[BU]`: proveedor, clave, texto, responsable, sin acentos ni orden), «Míos»,
 *     área con su conteo; todo con teclado; la situación siempre en palabras, el color sólo acompaña. Lista topada → se
 *     dice cuántas de cuántas.
 *  8. **Ligas.** De dónde viene: la reunión (fecha y proveedor en el renglón, abre en Citas). A dónde va: «Mi trabajo» de
 *     su responsable. Las ligas a MKTN001, condición de pago y ciclo/mínimo/precio NO existen todavía (DC46).
 *  9. **¿Le toca?** Trabajar los acuerdos vive aquí; capturarlos, en la reunión (Citas); el plan anual, en PQ.3.11.
 * 10. **Maqueta.** La de Citas: misma cabecera, pestañas, respuesta, tira, barra de filtros y tabla densa + side-peek.
 * 11. **Aceptación.** 44 px al dedo con puntero grueso; nada se sale a 390 px; ningún cero dibujado mientras carga o con
 *     error; lo que falta para guardar se dice antes de mandar.
 * 12. **Lo que no resuelve.** Avisos por correo/WhatsApp (el SMTP no sale, §9.5) y acuerdos sin reunión (DC45).
 *
 * Jerarquía (§Q.5): primario = la respuesta y lo acordado de cada renglón; secundario = cuándo vence, el proveedor y
 * quién responde; terciario = área, día de la reunión y quién lo sigue.
 */
@Component({
  selector: 'app-compras-acuerdos',
  standalone: true,
  imports: [
    FormsModule, RouterLink, ButtonModule, TableModule, TagModule, DialogModule, InputTextModule, SelectModule, TextareaModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent, SidePeekComponent, PageTabsComponent,
    AcuerdoFormComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page ac-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Acuerdos con proveedores</h1>
          <p class="surf-page-sub">
            <span>Lo que se decidió en cada reunión, con su responsable y su fecha compromiso.</span>
          </p>
        </div>
        <div class="ac-head-acc">
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      @if (errorAccion()) { <p class="ac-error" role="alert">{{ errorAccion() }}</p> }
      @if (aviso()) { <p class="ac-aviso" role="status">{{ aviso() }}</p> }

      <!-- La respuesta y las cifras SÓLO con la lista leída: cargando o con error no se dibuja un cero. -->
      @if (lista() && !error()) {
        <p class="ac-respuesta" role="status">{{ respuestaTexto() }}</p>
        <app-metric-strip [items]="kpis()" density="compact" ariaLabel="Acuerdos" (drill)="irA($event)" />
      }

      <div class="ac-barra">
        <app-segmented [options]="opcionesVista()" [value]="vista()" (valueChange)="cambiarVista($event)" ariaLabel="Abiertos o cerrados" />
        <app-segmented [options]="opcionesDe()" [value]="de()" (valueChange)="de.set($any($event))" ariaLabel="De quién" />
        <p-select [options]="opcionesArea()" [ngModel]="filtroArea()" (ngModelChange)="filtroArea.set($event)" optionLabel="label" optionValue="value"
                  ariaLabel="Área" class="ac-area" appendTo="body" />
        <input pInputText type="search" class="ac-buscar" [ngModel]="q()" (ngModelChange)="q.set($event)"
               placeholder="Buscar acuerdo, proveedor o responsable" aria-label="Buscar acuerdo, proveedor o responsable" autocomplete="off" />
        @if (situacion(); as s) {
          <button pButton type="button" class="p-button-sm p-button-text" (click)="situacion.set(null)" [attr.aria-label]="'Quitar el filtro ' + etiqueta(s)">
            <span class="p-button-label">Sólo {{ etiqueta(s).toLowerCase() }} ✕</span>
          </button>
        }
      </div>

      <app-load-state class="dt-scope" [loading]="cargando()" [error]="error()" [isEmpty]="vacio()" [skeletonRows]="6"
                      emptyIcon="pi-list-check" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()"
                      [emptyCta]="vista() === 'abiertos' ? 'Ir a Citas' : null" (cta)="irACitas()" (retry)="cargar()">
        <p-table [value]="filtrados()" dataKey="id" class="ac-table dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                 [rowHover]="true" [tableStyle]="{ 'min-width': '44rem' }">
          <ng-template #header>
            <tr>
              <th>Vence</th>
              <th>Qué se acordó</th>
              <th>Proveedor</th>
              <th>Responsable</th>
              <th><span class="ac-sr">Acciones</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-a>
            <tr [class.ac-cerrado]="a.situacion === 'cancelado'">
              <td role="cell" data-label="Vence">
                <div class="ac-celda">
                  <p-tag [value]="etiqueta(a.situacion)" [severity]="sev(a.situacion)" />
                  @if (aparte(a); as p) { <span class="ac-sub">{{ p }}</span> }
                </div>
              </td>
              <td role="cell" data-label="Qué se acordó">
                <div class="ac-celda">
                  <button type="button" class="ac-link" (click)="abrir(a)" [attr.aria-label]="'Ver el acuerdo: ' + a.description">{{ a.description }}</button>
                  <span class="ac-sub">{{ area(a.area) }}</span>
                </div>
              </td>
              <td role="cell" data-label="Proveedor">
                <div class="ac-celda">
                  <span>{{ proveedor(a) }}</span>
                  <span class="ac-sub">Reunión del {{ diaCorto(a.meeting_date) }}</span>
                </div>
              </td>
              <td role="cell" data-label="Responsable">
                <div class="ac-celda">
                  <span>{{ resp(a).quien }}</span>
                  @if (resp(a).sub; as s) { <span class="ac-sub">{{ s }}</span> }
                </div>
              </td>
              <td role="cell" data-label="Acciones">
                <div class="ac-acc">
                  @if (puedeAgendar() && puede(a, 'cumplir')) {
                    <button pButton type="button" class="p-button-sm p-button-text" (click)="abrirCierre(a, 'cumplir')"
                            [attr.aria-label]="'Marcar cumplido: ' + a.description">
                      <span class="p-button-label">Cumplido</span>
                    </button>
                  }
                </div>
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="5" class="ac-nota">Ningún acuerdo con esos filtros.</td></tr>
          </ng-template>
        </p-table>
        @if (lista(); as l) {
          @if (vista() === 'abiertos' && l.abiertos.total > l.abiertos.acuerdos.length) {
            <p class="ac-nota ac-pie">Se ven los {{ l.abiertos.acuerdos.length }} que vencen primero de {{ l.abiertos.total }} abiertos: los filtros y el buscador miran sólo ésos.</p>
          }
          @if (vista() === 'cerrados' && l.cerrados.total > l.cerrados.acuerdos.length) {
            <p class="ac-nota ac-pie">Se ven los {{ l.cerrados.acuerdos.length }} cerrados más recientes de {{ l.cerrados.total }}.</p>
          }
        }
      </app-load-state>

      <!-- ===== Detalle de un acuerdo ===== -->
      <app-side-peek [open]="!!sel()" (openChange)="!$event && sel.set(null)" [width]="520"
                     [title]="sel() ? proveedor(sel()!) : 'Acuerdo'"
                     [subtitle]="sel() ? area(sel()!.area) + ' · ' + plazo(sel()!) : null">
        @if (sel(); as a) {
          <div class="ac-peek">
            <section>
              <div class="ac-peek-estado">
                <p-tag [value]="etiqueta(a.situacion)" [severity]="sev(a.situacion)" />
                @if (a.status === 'in_progress') { <span class="ac-sub">Ya se está trabajando.</span> }
              </div>
              @if (puedeAgendar() && a.acciones.length) {
                <div class="ac-acc">
                  @if (puede(a, 'cumplir')) {
                    <button pButton type="button" class="p-button-sm" (click)="abrirCierre(a, 'cumplir')"><span class="p-button-label">Marcar cumplido</span></button>
                  }
                  @if (puede(a, 'iniciar')) {
                    <button pButton type="button" class="p-button-sm p-button-outlined" (click)="iniciar(a)" [disabled]="guardando()">
                      <span class="p-button-label">Marcar en curso</span>
                    </button>
                  }
                  @if (puede(a, 'editar')) {
                    <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" (click)="editar(a)">
                      <span class="p-button-label">Editar</span>
                    </button>
                  }
                </div>
              }
            </section>

            <section>
              <h3>Qué se acordó</h3>
              <p class="ac-texto">{{ a.description }}</p>
            </section>

            <section>
              <h3>Responsable</h3>
              <p>{{ resp(a).quien }}</p>
              @if (resp(a).sub; as s) { <p class="ac-sub">{{ s }}: le aparece en su «Mi trabajo».</p> }
              <p class="ac-sub">Lo asignó {{ a.assigned_by || 'alguien sin nombre' }} el {{ diaLargo(fechaMx(a.assigned_at)) }}.</p>
            </section>

            <section>
              <h3>Fecha compromiso</h3>
              <p>{{ diaLargo(a.due_date) }} <span class="ac-sub ac-inline">({{ rel(a.due_date) }})</span></p>
            </section>

            <section>
              <h3>De la reunión</h3>
              <p>{{ proveedor(a) }} · {{ diaLargo(a.meeting_date) }}</p>
              <a class="ac-ir" [routerLink]="['/compras/citas']" [queryParams]="{ reunion: a.meeting_id }">Abrir la reunión en Citas (minuta y quién fue)</a>
            </section>

            @if (a.closing_note) {
              <section>
                <h3>{{ a.status === 'done' ? 'Cómo se cumplió' : 'Por qué se canceló' }}</h3>
                <p class="ac-texto">{{ a.closing_note }}</p>
                <p class="ac-sub">Lo cerró {{ a.closed_by || 'alguien sin nombre' }}{{ a.closed_at ? ' el ' + diaLargo(fechaMx(a.closed_at)) : '' }}.</p>
              </section>
            }

            @if (puedeAgendar() && puede(a, 'cancelar')) {
              <section class="ac-peek-baja">
                <button pButton type="button" class="p-button-sm p-button-text ac-btn-bad" (click)="abrirCierre(a, 'cancelar')">
                  <span class="p-button-label">Cancelar el acuerdo</span>
                </button>
              </section>
            }
          </div>
        }
      </app-side-peek>

      <!-- ===== Cumplir o cancelar: siempre con nota ===== -->
      <p-dialog [visible]="dlgCierre()" (visibleChange)="dlgCierre.set($event)" [modal]="true" [draggable]="false" [style]="{ width: 'min(32rem, 96vw)' }"
                [header]="cierre() === 'cumplir' ? 'Marcar como cumplido' : 'Cancelar el acuerdo'" [pt]="ptDialogo">
        <div class="ac-form">
          @if (acuerdoCierre(); as a) { <p class="ac-sub">{{ a.description }} · {{ proveedor(a) }}</p> }
          <label class="ac-label" for="ac-nota">{{ cierre() === 'cumplir' ? 'Cómo se cumplió' : 'Por qué ya no procede' }}</label>
          <textarea pTextarea id="ac-nota" rows="3" [(ngModel)]="fNota" [maxlength]="maxNota"></textarea>
          <p class="ac-nota">Queda con la nota, quién y cuándo, y ya no se reabre: si hace falta otro, se captura en la siguiente reunión.</p>
          @if (errorDlg()) { <p class="ac-error" role="alert">{{ errorDlg() }}</p> }
        </div>
        <ng-template #footer>
          <button pButton type="button" class="p-button-text p-button-secondary" (click)="dlgCierre.set(false)"><span class="p-button-label">Cerrar sin guardar</span></button>
          <button pButton type="button" [class.ac-btn-bad-solid]="cierre() === 'cancelar'" (click)="guardarCierre()" [disabled]="!fNota.trim() || guardando()">
            <span class="p-button-label">{{ guardando() ? 'Guardando…' : (cierre() === 'cumplir' ? 'Marcar cumplido' : 'Cancelar el acuerdo') }}</span>
          </button>
        </ng-template>
      </p-dialog>

      <app-acuerdo-form (guardado)="recargar($event)" />
    </div>
  `,
  styleUrls: ['./compras-acuerdos.component.css'],
})
export class ComprasAcuerdosComponent implements OnInit {
  readonly tabs = PROVEEDORES_TABS;
  private readonly api = inject(AcuerdosProveedoresService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly form = viewChild.required(AcuerdoFormComponent);

  readonly puedeAgendar = this.perms.has$(Permission.COMPRAS_CITAS_AGENDAR);
  readonly maxNota = MAX_NOTA_CIERRE_ACUERDO;
  readonly ptDialogo = ptDialogoTactil();

  // ── La lista ─────────────────────────────────────────────────────────────────────────────────
  readonly lista = signal<ListaAcuerdos | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly vista = signal<VistaAcuerdos>('abiertos');
  readonly de = signal<DeQuien>('todos');
  readonly filtroArea = signal<AreaAcuerdo | 'todas'>('todas');
  readonly situacion = signal<SituacionAcuerdo | null>(null);
  readonly q = signal('');
  readonly aviso = signal<string | null>(null);
  readonly errorAccion = signal<string | null>(null);
  readonly guardando = signal(false);
  /** El acuerdo que pidió el enlace (`?acuerdo=`), para abrirlo cuando llegue la lista. */
  private pedido: string | null = null;

  private readonly yo = computed(() => this.auth.user()?.sub ?? null);
  readonly hoy = computed(() => this.lista()?.hoy ?? '');

  /** La vista elegida, sin el filtro de área (para contar por área). */
  private readonly deLaVista = computed(() => {
    const l = this.lista();
    if (!l) return [] as AcuerdoVista[];
    return filtrarAcuerdos(l, { vista: this.vista(), de: this.de(), area: null, situacion: this.situacion(), q: '', yo: this.yo() });
  });
  readonly filtrados = computed(() => {
    const l = this.lista();
    if (!l) return [] as AcuerdoVista[];
    const area = this.filtroArea();
    return filtrarAcuerdos(l, { vista: this.vista(), de: this.de(), area: area === 'todas' ? null : area, situacion: this.situacion(), q: this.q(), yo: this.yo() });
  });
  readonly vacio = computed(() => {
    const l = this.lista();
    if (!l) return false;
    return (this.vista() === 'abiertos' ? l.abiertos.total : l.cerrados.total) === 0;
  });
  readonly vacioTitulo = computed(() => (this.vista() === 'abiertos' ? 'Sin acuerdos abiertos' : 'Ningún acuerdo cerrado todavía'));
  readonly vacioPista = computed(() => (this.vista() === 'abiertos'
    ? 'Los acuerdos se capturan en el detalle de una reunión realizada, en Citas: lo que se decidió, con su responsable y su fecha.'
    : 'Cuando un acuerdo se cumpla o se cancele, queda aquí con su nota.'));
  readonly respuestaTexto = computed(() => (this.lista() ? respuestaAcuerdos(this.lista()!) : ''));

  readonly kpis = computed<MetricStripItem[]>(() => {
    const l = this.lista();
    if (!l) return [];
    const s = l.abiertos.por_situacion;
    return [
      { label: 'Vencidos', value: s.vencido, format: 'number', tone: s.vencido ? 'bad' : 'muted', drill: 'vencido', drillLabel: 'Ver los acuerdos vencidos' },
      { label: 'Vencen hoy', value: s.vence_hoy, format: 'number', tone: s.vence_hoy ? 'warn' : 'muted', drill: 'vence_hoy', drillLabel: 'Ver los que vencen hoy' },
      { label: 'Esta semana', value: s.esta_semana, format: 'number', tone: 'default', drill: 'esta_semana', drillLabel: 'Ver los que vencen esta semana' },
      { label: 'Al día', value: s.al_dia, format: 'number', tone: 'muted', drill: 'al_dia', drillLabel: 'Ver los que vencen después' },
      { label: 'Cerrados', value: l.cerrados.total, format: 'number', tone: 'muted', drill: 'cerrados', drillLabel: 'Ver los cumplidos y cancelados' },
    ];
  });

  readonly opcionesVista = computed<SegOption[]>(() => {
    const l = this.lista();
    return [
      { label: 'Abiertos', value: 'abiertos', count: l ? l.abiertos.total : undefined },
      { label: 'Cerrados', value: 'cerrados', count: l ? l.cerrados.total : undefined },
    ];
  });
  readonly opcionesDe = computed<SegOption[]>(() => {
    const l = this.lista();
    return [
      { label: 'Todos', value: 'todos' },
      { label: 'Míos', value: 'mios', count: l ? cuantosMios(l, this.vista(), this.yo()) : undefined },
    ];
  });
  readonly opcionesArea = computed(() => {
    const c = conteoPorArea(this.deLaVista());
    return [
      { label: `Todas las áreas (${this.deLaVista().length})`, value: 'todas' },
      ...AREAS_ACUERDO.map((a) => ({ label: `${ETIQUETA_AREA_ACUERDO[a]} (${c[a]})`, value: a })),
    ];
  });

  // ── El detalle y el cierre ───────────────────────────────────────────────────────────────────
  readonly sel = signal<AcuerdoVista | null>(null);
  readonly dlgCierre = signal(false);
  readonly cierre = signal<'cumplir' | 'cancelar'>('cumplir');
  readonly acuerdoCierre = signal<AcuerdoVista | null>(null);
  readonly errorDlg = signal<string | null>(null);
  fNota = '';

  // ── Lo que la plantilla pone en palabras ─────────────────────────────────────────────────────
  readonly diaCorto = diaCorto;
  readonly diaLargo = diaLargo;
  readonly fechaMx = fechaMx;
  readonly area = areaAcuerdo;
  readonly proveedor = proveedorDelAcuerdo;
  readonly resp = responsableEnPalabras;
  etiqueta = (s: SituacionAcuerdo) => ETIQUETA_SITUACION_ACUERDO[s];
  sev = (s: SituacionAcuerdo) => SEVERIDAD_ACUERDO[s];
  plazo = (a: AcuerdoVista) => plazoEnPalabras(a, this.hoy());
  aparte = (a: AcuerdoVista) => plazoAparte(a, this.hoy());
  rel = (fecha: string) => relativo(fecha, this.hoy() || fecha);
  puede = (a: AcuerdoVista, x: AccionAcuerdo) => a.acciones.indexOf(x) >= 0;

  ngOnInit(): void {
    const p = this.route.snapshot.queryParamMap;
    if (p.get('de') === 'mios') this.de.set('mios');
    this.pedido = p.get('acuerdo');
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.lista().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (l) => {
        this.lista.set(l);
        this.cargando.set(false);
        this.cargadoEn.set(new Date());
        this.refrescarSeleccion(l);
      },
      error: (e) => { this.error.set(motivoHttp(e, 'leer los acuerdos')); this.cargando.set(false); },
    });
  }

  /** Tras leer: el acuerdo que pidió el enlace, o el que estaba abierto (con sus datos nuevos). */
  private refrescarSeleccion(l: ListaAcuerdos): void {
    const id = this.pedido ?? this.sel()?.id ?? null;
    if (!id) return;
    const abierto = l.abiertos.acuerdos.find((a) => a.id === id);
    const cerrado = l.cerrados.acuerdos.find((a) => a.id === id);
    if (this.pedido) {
      this.pedido = null;
      if (cerrado) this.vista.set('cerrados');
      if (!abierto && !cerrado) this.aviso.set('Ese acuerdo no está entre los que se cargaron (puede ser un cerrado viejo).');
    }
    this.sel.set(abierto ?? cerrado ?? null);
  }

  cambiarVista(v: string): void {
    if (v !== 'abiertos' && v !== 'cerrados') return;
    this.vista.set(v);
    this.situacion.set(null);
  }

  irA(clave: string): void {
    if (clave === 'cerrados') { this.cambiarVista('cerrados'); return; }
    this.vista.set('abiertos');
    this.situacion.set(clave as SituacionAcuerdo);
  }

  irACitas(): void {
    void this.router.navigate(['/compras/citas']);
  }

  abrir(a: AcuerdoVista): void {
    this.sel.set(a);
  }

  recargar(mensaje: string): void {
    this.aviso.set(mensaje);
    this.errorAccion.set(null);
    this.cargar();
  }

  editar(a: AcuerdoVista): void {
    this.form().editar(a, {
      meetingId: a.meeting_id, meetingDate: a.meeting_date, proveedor: proveedorDelAcuerdo(a),
      organizador: a.area === 'supplier' ? a.assigned_to.nombre : null,
    });
  }

  iniciar(a: AcuerdoVista): void {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.errorAccion.set(null);
    this.api.iniciar(a.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.guardando.set(false); this.recargar('El acuerdo quedó en curso.'); },
      error: (e) => { this.guardando.set(false); this.errorAccion.set(motivoHttp(e, 'marcar el acuerdo en curso')); },
    });
  }

  abrirCierre(a: AcuerdoVista, accion: 'cumplir' | 'cancelar'): void {
    this.acuerdoCierre.set(a);
    this.cierre.set(accion);
    this.fNota = '';
    this.errorDlg.set(null);
    this.dlgCierre.set(true);
  }

  guardarCierre(): void {
    const a = this.acuerdoCierre();
    if (!a || !this.fNota.trim() || this.guardando()) return;
    const cumplir = this.cierre() === 'cumplir';
    this.guardando.set(true);
    this.errorDlg.set(null);
    const peticion = cumplir ? this.api.cumplir(a.id, this.fNota) : this.api.cancelar(a.id, this.fNota);
    peticion.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.guardando.set(false);
        this.dlgCierre.set(false);
        this.recargar(cumplir ? 'Acuerdo cumplido: queda con su nota en «Cerrados».' : 'Acuerdo cancelado: queda con su nota en «Cerrados».');
      },
      error: (e) => { this.guardando.set(false); this.errorDlg.set(motivoHttp(e, cumplir ? 'marcar el acuerdo cumplido' : 'cancelar el acuerdo')); },
    });
  }
}
