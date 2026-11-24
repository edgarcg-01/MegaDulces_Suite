import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  CAUSAS_REVISION, MOTIVOS_RETIROS, NOTA_REVISION_MAX, NOTA_REVISION_MIN, accionRevisionLabel, causaRevisionLabel,
  type ArqueoRevisionCajera, type ArqueoRevisionEvento, type ArqueoRevisionResp, type ArqueoRevisionTurno, type CausaRevision,
} from '@megadulces/contracts/http/arqueo-cajas';
import { ArqueoAvisoService, ArqueoRevisionService } from '../arqueo-revision.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

/** Un turno de la lista con la llave de su cajera (la tabla agrupa por ella). */
type Fila = ArqueoRevisionTurno & { grupo: string };

const DIAS = 7;
const SIN_CODIGO = '(sin código)';

/**
 * [SM.55] Tienda — Retiros por revisar (/tienda/arqueo/revision).
 *
 * La pregunta de la encargada: «¿empatan los retiros que se contaron en la Suite con los que
 * registró Kepler? Y si no, ¿de quién son y qué pasó?». La meta es que la diferencia sea 0:
 * si la cajera cuenta el retiro que faltaba, el turno sale solo de la lista; lo que no se pueda
 * emparejar se explica.
 *
 * Versión simple (David, 2026-11-24: la primera abrumaba): totales Kepler · Suite · Diferencia,
 * una lista por cajera con sus turnos siempre visibles, y un panel para decir qué pasó. El cajón
 * sin contar va como una línea por cajera, sin justificarse. Fuera: por día y firma, acciones y
 * cierre, 31 días (el servidor los conserva).
 *
 * Niveles: primario = la diferencia neta; secundario = la lista por cajera; terciario = horas,
 * folio e historial.
 */
@Component({
  selector: 'app-tienda-arqueo-revision',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, RouterLink, ButtonModule, SelectModule, TableModule, TagModule, TextareaModule, ToastModule,
    PageTabsComponent, LoadStateComponent, MetricStripComponent, SidePeekComponent, FreshnessPillComponent,
  ],
  providers: [MessageService],
  template: `
    <p-toast />
    <div class="surf-page in rv-page">
      <app-page-tabs [tabs]="aviso.tabs()" />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="surf-page-title">Retiros por revisar</h1>
          <p class="surf-page-sub">
            Lo que Kepler registró en retiros contra lo que se contó en la Suite, de los últimos {{ dias }} días (hasta ayer).
            La meta: que los dos totales sean iguales. Lo que no se pueda emparejar se explica.
          </p>
        </div>
        @if (resp(); as r) {
          <div class="rv-head-tools">
            @if (r.frescura === 'ok' && r.datos_al) {
              <app-freshness-pill measures="data" [since]="r.datos_al" label="Kepler al" [staleAfterSec]="1800" />
            } @else {
              <span class="rv-nomedido" role="status"><i class="pi pi-question-circle" aria-hidden="true"></i>
                No se sabe de cuándo son los datos de Kepler{{ r.frescura === 'error' ? ': la última carga falló' : '' }}.</span>
            }
          </div>
        }
      </header>

      @if (resp()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Retiros: Kepler contra Suite" />
      }

      <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!cargando() && !error() && !filas().length"
        emptyTitle="Los retiros empatan con Kepler" emptyIcon="pi-check-circle"
        [emptyHint]="'En los últimos ' + dias + ' días, lo que se contó en la Suite es lo que registró Kepler.'" (retry)="cargar()">
        <!-- Con flechas se recorre la lista y con Enter se abre el turno (pSelectableRow). En el teléfono se apila (dt-stack). -->
        <p-table [value]="filas()" dataKey="clave" rowGroupMode="subheader" groupRowsBy="grupo" selectionMode="single" [rowHover]="true"
          (onRowSelect)="abrir($any($event).data)" class="surf-table surf-table--plain dt-stack rv-tabla" size="small">
          <ng-template #header>
            <tr>
              <th scope="col">Cajera / turno</th>
              <th scope="col" class="comm-num">Kepler</th>
              <th scope="col" class="comm-num">Suite</th>
              <th scope="col" class="comm-num">Diferencia</th>
              <th scope="col"><span class="sr-only">Estado</span></th>
            </tr>
          </ng-template>
          <ng-template #groupheader let-f>
            @if (cajera(f.grupo); as c) {
              <tr class="rv-cajera">
                <td data-label="Cajera">
                  <span class="rv-nombre">{{ c.cajero_nombre || c.cajero_code }}</span>
                  @if (c.cajero_nombre) { <span class="rv-sub"> {{ c.cajero_code }}</span> }
                  @if (c.motivos.cajon_sin_contar > 0) {
                    <div class="rv-cajon">Además, {{ c.motivos.cajon_sin_contar }} {{ c.motivos.cajon_sin_contar === 1 ? 'cierre' : 'cierres' }} sin contar el cajón ·
                      <a routerLink="/tienda/arqueos">Ver su historial</a></div>
                  }
                </td>
                <td class="comm-num rv-fuerte" data-label="Kepler">{{ money(c.retirado_kepler) }}</td>
                <td class="comm-num rv-fuerte" data-label="Suite">{{ money(c.retiros_contados) }}</td>
                <td class="comm-num rv-fuerte" data-label="Diferencia" [class.rv-neg]="c.retiros_diferencia < 0" [class.rv-pos]="c.retiros_diferencia > 0">{{ signo(c.retiros_diferencia) }}</td>
                <td data-label="">
                  @if (c.por_justificar > 0) { <p-tag [value]="c.por_justificar + ' sin explicar'" severity="warn" /> }
                  @else { <p-tag value="Todo explicado" severity="success" /> }
                </td>
              </tr>
            }
          </ng-template>
          <ng-template #body let-t>
            <tr [pSelectableRow]="t">
              <td data-label="Turno" class="rv-turno"><strong>{{ fechaCorta(t.fecha) }} · Caja {{ t.caja }}</strong>
                <span class="rv-sub"> · {{ hora(t.hora_apertura) }}–{{ hora(t.hora_cierre) }} · folio {{ t.folio }}</span></td>
              <td class="comm-num" data-label="Kepler">{{ money(t.retirado_kepler) }}</td>
              <td class="comm-num" data-label="Suite">{{ money(t.retiros_contados) }}</td>
              <td class="comm-num" data-label="Diferencia" [class.rv-neg]="t.retiros_diferencia < 0" [class.rv-pos]="t.retiros_diferencia > 0">{{ signo(t.retiros_diferencia) }}</td>
              <td data-label="" class="rv-accion">
                @if (t.estado === 'por_justificar') {
                  <p-button label="Justificar" size="small" (onClick)="abrir(t)" [ariaLabel]="'Justificar la caja ' + t.caja + ' del ' + fechaCorta(t.fecha)" />
                } @else {
                  <p-button [label]="causaCorta(t)" size="small" [text]="true" severity="success" icon="pi pi-check" (onClick)="abrir(t)"
                    [ariaLabel]="'Ver la explicación de la caja ' + t.caja + ' del ' + fechaCorta(t.fecha)" />
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
        <p class="rv-nota-tabla"><span class="rv-neg">−</span> Kepler registró más de lo que se contó · <span class="rv-pos">+</span> se contó más de lo
          que registró Kepler. Si la cajera cuenta el retiro que faltaba y los totales empatan, el turno sale solo de la lista.
          Cuenta por código de cajera de Kepler: si un código lo usan varias personas, el número es del código.</p>
      </app-load-state>
    </div>

    <app-side-peek [open]="peek()" (openChange)="cerrar($event)" [width]="480" [sucio]="sucio()" [title]="peekTitulo()" [subtitle]="peekSub()">
      @if (sel(); as t) {
        <section class="rv-peek">
          <div class="rv-tres">
            <div><div class="rv-sub">Kepler</div><div class="rv-cifra">{{ money(t.retirado_kepler) }}</div></div>
            <div><div class="rv-sub">Suite</div><div class="rv-cifra">{{ money(t.retiros_contados) }}</div></div>
            <div><div class="rv-sub">Diferencia</div><div class="rv-cifra" [class.rv-neg]="t.retiros_diferencia < 0" [class.rv-pos]="t.retiros_diferencia > 0">{{ signo(t.retiros_diferencia) }}</div></div>
          </div>
          <p class="rv-p">{{ lectura(t) }}</p>

          @if (t.historial.length) {
            <h3 class="rv-h">Lo que se ha dicho</h3>
            <ol class="rv-hist">
              @for (e of t.historial; track $index) {
                <li><strong>{{ eventoTxt(e) }}</strong>@if (e.nota) { — {{ e.nota }} }
                  <div class="rv-sub">{{ e.por_nombre || e.por || 'Sin usuario' }} · {{ fechaHora(e.at) }}</div></li>
              }
            </ol>
          }

          @if (t.estado === 'cerrado') {
            <p class="rv-p rv-sub">Caso cerrado: su explicación ya no se puede cambiar.</p>
          } @else if (t.estado === 'por_justificar' || corregir()) {
            <label class="rv-fld" for="rv-causa">{{ t.justificacion ? 'Corregir: ¿por qué no empatan?' : '¿Por qué no empatan?' }}</label>
            <p-select inputId="rv-causa" [options]="causas" optionLabel="label" optionValue="value" [ngModel]="causa()"
              (ngModelChange)="causa.set($event)" placeholder="Elige la causa" appendTo="body" class="rv-select" />
            <label class="rv-fld" for="rv-nota">Explícalo</label>
            <textarea pTextarea id="rv-nota" rows="3" [maxlength]="notaMax" [ngModel]="nota()" (ngModelChange)="nota.set($event)"
              placeholder="Ej.: Hablé con la cajera; el retiro de las 14:00 está en la bóveda y no lo capturó." class="rv-nota"></textarea>
            <div class="rv-cuenta" [class.rv-neg]="notaCorta()">{{ notaLen() }} / {{ notaMax }}@if (notaCorta()) { · mínimo {{ notaMin }} letras }</div>
            <div class="rv-acciones">
              @if (t.justificacion) { <p-button label="Cancelar" [text]="true" (onClick)="corregir.set(false)" /> }
              <p-button label="Guardar" icon="pi pi-check" [disabled]="!valida() || guardando()" [loading]="guardando()" (onClick)="guardar()" />
            </div>
          } @else {
            <div class="rv-acciones"><p-button label="Corregir la explicación" [text]="true" (onClick)="corregir.set(true)" /></div>
          }
        </section>
      }
    </app-side-peek>
  `,
  styles: [`
    :host { display: block; }
    .rv-head-tools { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; }
    .rv-nomedido { font-size: var(--fs-xs); color: var(--text-muted); display: inline-flex; gap: var(--sp-1); align-items: center; }
    .rv-tabla { margin-top: var(--sp-4); display: block; }
    .rv-cajera td { background: var(--surface-ground); padding-top: var(--sp-3); padding-bottom: var(--sp-3); }
    .rv-nombre { font-weight: 700; font-size: var(--fs-body); }
    .rv-fuerte { font-weight: 600; }
    .rv-cajon { font-size: var(--fs-xs); color: var(--warn-soft-fg); margin-top: 2px; }
    .rv-turno { padding-left: var(--sp-5); }
    .rv-accion { text-align: right; }
    .rv-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .rv-neg { color: var(--bad-fg); }
    .rv-pos { color: var(--info-fg); }
    .rv-nota-tabla { font-size: var(--fs-xs); color: var(--text-muted); margin: var(--sp-2) 0 0; }
    .rv-peek { display: flex; flex-direction: column; gap: var(--sp-2); }
    .rv-tres { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); }
    .rv-cifra { font-weight: 700; font-variant-numeric: tabular-nums; }
    .rv-h { font-size: var(--fs-sm); font-weight: 600; margin: var(--sp-4) 0 0; }
    .rv-p { margin: 0; }
    .rv-hist { margin: 0; padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-2); }
    .rv-fld { font-size: var(--fs-sm); font-weight: 600; margin-top: var(--sp-3); }
    .rv-select, .rv-nota { width: 100%; }
    .rv-cuenta { font-size: var(--fs-xs); color: var(--text-muted); text-align: right; }
    .rv-acciones { display: flex; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-2); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
})
export class TiendaArqueoRevisionComponent implements OnInit {
  private readonly svc = inject(ArqueoRevisionService);
  readonly aviso = inject(ArqueoAvisoService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly dias = DIAS;
  readonly causas = CAUSAS_REVISION.map((c) => ({ value: c.value, label: c.label }));
  readonly notaMin = NOTA_REVISION_MIN;
  readonly notaMax = NOTA_REVISION_MAX;

  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly resp = signal<ArqueoRevisionResp | null>(null);

  readonly peek = signal(false);
  readonly sel = signal<Fila | null>(null);
  readonly causa = signal<CausaRevision | null>(null);
  readonly nota = signal('');
  readonly corregir = signal(false);
  readonly guardando = signal(false);

  private readonly cajeras = computed(() => new Map((this.resp()?.cajeras ?? []).map((c) => [c.cajero_code, c])));

  /**
   * Los turnos cuyos retiros NO empatan hoy, agrupados por cajera en el orden del servidor (mayor
   * descuadre primero); dentro de cada una, lo que falta explicar arriba y lo más reciente primero.
   */
  readonly filas = computed<Fila[]>(() => {
    const orden = [...this.cajeras().keys()];
    return (this.resp()?.turnos ?? [])
      .filter((t) => t.motivos.some((m) => MOTIVOS_RETIROS.includes(m)))
      .map((t) => ({ ...t, grupo: t.cajero_code ?? SIN_CODIGO }))
      .sort((a, b) => orden.indexOf(a.grupo) - orden.indexOf(b.grupo)
        || Number(b.estado === 'por_justificar') - Number(a.estado === 'por_justificar')
        || b.fecha.localeCompare(a.fecha)
        || a.caja.localeCompare(b.caja, 'es', { numeric: true }));
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const k = this.resp()?.totales;
    if (!k) return [];
    return [
      { label: 'Retiros en Kepler', value: k.retirado_kepler, format: 'currency2' },
      { label: 'Contados en la Suite', value: k.retiros_contados, format: 'currency2' },
      {
        label: 'Diferencia', value: k.retiros_diferencia, format: 'currency2', tone: k.retiros_diferencia === 0 && !k.turnos_descuadre ? 'ok' : 'bad',
        sub: k.turnos_descuadre
          ? `${this.money(k.retiros_descuadre)} sin empatar en ${k.turnos_descuadre} turnos de ${k.cajeras_descuadre} cajeras · ${k.por_justificar} sin explicar`
          : 'Todo empata',
      },
    ];
  });

  readonly peekTitulo = computed(() => {
    const t = this.sel();
    return t ? `${t.cajero_nombre || t.cajero_code || 'Sin código'} · Caja ${t.caja} · ${this.fechaCorta(t.fecha)}` : '';
  });
  readonly peekSub = computed(() => {
    const t = this.sel();
    return t ? `folio ${t.folio} · ${t.warehouse_nombre ?? t.warehouse_code}` : null;
  });

  readonly notaLen = computed(() => this.nota().trim().length);
  readonly notaCorta = computed(() => this.notaLen() > 0 && this.notaLen() < NOTA_REVISION_MIN);
  readonly valida = computed(() => !!this.causa() && this.notaLen() >= NOTA_REVISION_MIN && this.notaLen() <= NOTA_REVISION_MAX);
  readonly sucio = computed(() => !!this.causa() || this.nota().trim().length > 0);

  ngOnInit(): void { this.cargar(); }

  /** unsavedChangesGuard: lo escrito a medias no se pierde al cambiar de pestaña. */
  hasUnsavedChanges(): boolean { return this.peek() && this.sucio(); }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void { if (this.hasUnsavedChanges()) e.preventDefault(); }

  cargar(): void {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const hasta = sumarDias(hoy, -1);
    const desde = sumarDias(hasta, -(DIAS - 1));
    this.cargando.set(true);
    this.error.set(null);
    this.svc.pendientes({ desde, hasta }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.resp.set(r);
        this.cargando.set(false);
        // El aviso de las pestañas sale de la MISMA lista: no hace falta otra consulta.
        this.aviso.fijar({
          desde, hasta, por_justificar: r.totales.por_justificar,
          en_seguimiento: r.turnos.filter((t) => t.estado === 'en_seguimiento').length,
          dias_sin_revisar: r.dias.filter((d) => !d.revisado).length,
        });
      },
      error: (e: HttpErrorResponse) => {
        this.cargando.set(false);
        this.error.set(e.status === 403
          ? 'No tienes permiso para revisar los retiros. Lo hace la encargada de la sucursal.'
          : (e.error?.message as string | undefined) || 'No se pudo cargar. Revisa tu conexión y vuelve a intentar.');
      },
    });
  }

  cajera(grupo: string): ArqueoRevisionCajera | null { return this.cajeras().get(grupo) ?? null; }

  abrir(t: Fila): void {
    this.causa.set(null); this.nota.set(''); this.corregir.set(false);
    this.sel.set(t);
    this.peek.set(true);
  }

  cerrar(abierto: boolean): void {
    this.peek.set(abierto);
    if (!abierto) { this.sel.set(null); this.causa.set(null); this.nota.set(''); this.corregir.set(false); }
  }

  /** Se deshabilita en el primer clic; al volver se recarga del servidor (la fuente). Si falla, lo escrito se queda. */
  guardar(): void {
    const t = this.sel(), causa = this.causa();
    if (!t || !causa || !this.valida() || this.guardando()) return;
    this.guardando.set(true);
    this.svc.justificar({ warehouse_code: t.warehouse_code, fecha: t.fecha, caja: t.caja, folio: t.folio, causa, nota: this.nota().trim() })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => {
          this.guardando.set(false);
          this.cerrar(false);
          this.toast.add({ severity: 'success', summary: 'Explicación guardada', detail: `Caja ${t.caja} · ${this.fechaCorta(t.fecha)}` });
          this.cargar();
        },
        error: (e: HttpErrorResponse) => {
          this.guardando.set(false);
          this.toast.add({
            severity: 'error', summary: 'No se guardó', life: 8000,
            detail: (e.error?.message as string | undefined) || 'Revisa tu conexión y vuelve a intentar. Lo que escribiste sigue aquí.',
          });
        },
      });
  }

  /** La lectura del turno en llano (Q.2): qué dice Kepler, qué tiene la Suite y qué falta. */
  lectura(t: ArqueoRevisionTurno): string {
    if (t.retiros_diferencia < 0) {
      return t.retiros_contados === 0
        ? `Kepler registró ${this.money(t.retirado_kepler)} en retiros y en la Suite no se contó ninguno.`
        : `Kepler registró ${this.money(t.retirado_kepler)} en retiros y en la Suite se contaron ${this.money(t.retiros_contados)}: faltan ${this.money(-t.retiros_diferencia)}.`;
    }
    if (t.retiros_diferencia > 0) {
      return `En la Suite se contaron ${this.money(t.retiros_contados)}, ${this.money(t.retiros_diferencia)} más de lo que registró Kepler (${this.money(t.retirado_kepler)}).`;
    }
    return 'Los retiros de este turno ya empatan con Kepler.';
  }

  causaCorta(t: ArqueoRevisionTurno): string {
    const label = causaRevisionLabel(t.justificacion?.causa) ?? 'Explicado';
    return label.length > 28 ? `${label.slice(0, 26)}…` : label;
  }

  eventoTxt(e: ArqueoRevisionEvento): string {
    if (e.tipo === 'cerrado') return 'Caso cerrado';
    if (e.tipo === 'accion') return `Acción: ${accionRevisionLabel(e.valor)}`;
    return `Causa: ${causaRevisionLabel(e.valor)}`;
  }

  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });
  }

  /** La diferencia con su signo explícito: el + también rompe el empate. */
  signo(v: number): string {
    if (!v) return '—';
    return v > 0 ? `+${this.money(v)}` : this.money(v);
  }

  hora(h: string | null): string { return h ? h.slice(0, 5) : '—'; }

  fechaCorta(f: string): string {
    return new Date(`${f}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  fechaHora(iso: string): string {
    return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}

function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
