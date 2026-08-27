import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, forkJoin, of, switchMap, catchError, map } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { EntradasService, EntradaRow, EntradasReport, EntradasQuery, ProofFile, RemisionOcr } from '../entradas.service';
import { branchName } from '../../../core/constants/store-branches';
import { money } from '../../../shared/util';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/** Una hoja en el sobre de esta entrada, con su estado de lectura y subida. */
interface Hoja {
  id: number;
  name: string;
  dataUri: string;
  kind: 'image' | 'pdf';
  bytes: number;
  leyendo: boolean;
  sha256?: string;
  folio?: string | null;
  total?: number | null;
  subtotal?: number | null;
  fecha?: string | null;
  rfc?: string | null;
  dupDe?: string | null;   // ya subida antes → bloquea guardar
  ocr?: Partial<RemisionOcr>;
}

/**
 * `[RE.13.1]` — **Mis pendientes**: la worklist del capturista de sucursal.
 *
 * Es una lista de TAREAS, no un reporte. La pantalla anterior (`/compras/entradas`,
 * 1,826 líneas) hacía cuatro trabajos a la vez y ninguno bien para este usuario:
 * ordenaba por lo más RECIENTE (escondiendo el atraso), no filtraba por sucursal (el
 * de Yurécuaro con 16 entradas navegaba entre las 815 de CEDIS), cortaba en 300 filas
 * en silencio, y sólo aceptaba PDF — o sea el que tiene el papel en la mano y un
 * celular no podía subir nada.
 *
 * Acá: sólo lo tuyo, lo más viejo primero, con los días a la vista, y la cámara.
 * La auditoría por línea, los ajustes del proveedor y la validación NO viven acá:
 * son el trabajo del revisor (`/compras/entradas/revision`) y de Compras 360.
 */
@Component({
  selector: 'app-compras-entradas-pendientes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, SelectModule, DialogModule,
    TagModule, ToastModule, SegmentedComponent, LoadStateComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page in ep">
      <p-toast />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pendientes de subir</h1>
          <p class="surf-page-sub">
            Subí la <strong>factura del proveedor</strong> de cada orden de entrada. Lo más
            atrasado va primero. La comparo contra el total de Kepler.
          </p>
        </div>
        <div class="ep-head-actions">
          @if (variasSucursales()) {
            <p-select [options]="sucursalOpts()" [ngModel]="sucursalSel()" (onChange)="setSucursal($event.value)"
                      optionLabel="label" optionValue="value" placeholder="Todas las mías" [showClear]="true"
                      styleClass="ep-sel" ariaLabel="Sucursal" appendTo="body" />
          } @else if (unaSucursal(); as s) {
            <span class="ep-suc-fija" title="Tu alcance es esta sucursal"><i class="pi pi-building" aria-hidden="true"></i> {{ s }}</span>
          }
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="reload()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      @if (sinAlcance()) {
        <!-- Fail-closed explicado: sin sucursal en la ficha no hay filas, y una tabla vacía
             se lee como "el sistema no funciona". -->
        <div class="ep-block" role="status">
          <i class="pi pi-lock" aria-hidden="true"></i>
          <div>
            <p class="ep-block-t">Tu usuario no tiene sucursal asignada</p>
            <p class="ep-block-s">Sin sucursal no hay entradas que mostrarte. Pedile a Sistemas que te
              configure el alcance de sucursal y volvé a entrar.</p>
          </div>
        </div>
      } @else {

        @if (report(); as r) {
          <!-- El marcador del día: cuánto falta y cuánto está vencido. Un capturista no
               necesita "$ por comprobar"; necesita saber si puede irse a su casa. -->
          <div class="ep-scoreboard" [class.done]="faltan(r) === 0">
            @if (faltan(r) === 0) {
              <i class="pi pi-check-circle" aria-hidden="true"></i>
              <p class="ep-sb-main">Todo al día — no te falta subir nada</p>
            } @else {
              <div class="ep-sb-nums">
                <span class="ep-sb-big">{{ faltan(r) }}</span>
                <span class="ep-sb-lbl">te faltan<br />de {{ r.kpis.entradas }}</span>
              </div>
              <div class="ep-sb-bar" [attr.aria-label]="'Avance ' + avance(r) + '%'">
                <span [style.width.%]="avance(r)"></span>
              </div>
              <span class="ep-sb-pct">{{ avance(r) }}% subido</span>
              @if (r.kpis.atrasadas > 0) {
                <button type="button" class="ep-sb-late" (click)="soloAtrasadas()"
                        [title]="'Más de ' + r.settings.sla_capture_days + ' días sin factura'">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  {{ r.kpis.atrasadas }} vencidas
                </button>
              }
            }
          </div>

          @if (r.kpis.rechazados > 0 && estado() !== 'rechazado') {
            <!-- Antes, una evidencia devuelta se quedaba muerta: el que la subió nunca se
                 enteraba. Es lo primero que tiene que ver al entrar. -->
            <button type="button" class="ep-returned" (click)="setEstado('rechazado')">
              <i class="pi pi-undo" aria-hidden="true"></i>
              <span><strong>{{ r.kpis.rechazados }}</strong> te {{ r.kpis.rechazados === 1 ? 'la devolvieron' : 'las devolvieron' }} — hay que volver a subirlas</span>
              <i class="pi pi-angle-right" aria-hidden="true"></i>
            </button>
          }
        }

        <div class="ep-filters">
          <app-segmented [options]="estadoOpts" [value]="estado()" (valueChange)="setEstado($event)" ariaLabel="Qué mostrar" />
          <input pInputText [(ngModel)]="search" (keyup.enter)="reload()" (blur)="reload()"
                 placeholder="Últimos 4 del folio (ej. 0397) o proveedor…" class="ep-search" aria-label="Buscar entrada" />
          @if (rezago()) {
            <button pButton type="button" class="p-button-sm p-button-text" (click)="setRezago(false)"
                    title="Volver al periodo del proceso">
              <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span>
              <span class="p-button-label">Salir del rezago</span>
            </button>
          } @else if (report()?.settings; as cfg) {
            <button pButton type="button" class="p-button-sm p-button-text ep-rezago" (click)="setRezago(true)"
                    [title]="'Entradas anteriores al ' + cfg.reception_start + ' — fuera del proceso vivo'">
              <span class="p-button-icon p-button-icon-left pi pi-history" aria-hidden="true"></span>
              <span class="p-button-label">Ver rezago</span>
            </button>
          }
        </div>

        @if (error()) {
          <app-load-state [error]="error()" (retry)="reload()" />
        } @else if (loading() && !report()) {
          <div class="ep-skel" aria-busy="true" aria-label="Cargando pendientes">
            @for (i of [1,2,3,4,5,6]; track i) { <span class="ep-sk-row"></span> }
          </div>
        } @else if (rows().length === 0) {
          <div class="ep-empty">
            <i class="pi pi-check-circle" aria-hidden="true"></i>
            <p>{{ estado() === 'pendiente' ? 'No te falta ninguna factura en este filtro.' : 'Sin entradas para este filtro.' }}</p>
          </div>
        } @else {
          <!-- Un solo organismo para las dos formas: en angosto cada renglón se apila
               (celular, junto a la mercancía) y en ancho se alinea en columnas. -->
          <ul class="ep-list" [class.loading]="loading()">
            @for (c of rows(); track c.sucursal + '/' + c.folio) {
              <li class="ep-row" [class.late]="c.atrasada">
                <span class="ep-dias" [class]="'is-' + tono(c)" [title]="c.dias + ' días desde la recepción'">
                  {{ c.dias }}<em>d</em>
                </span>
                <span class="ep-folio" [title]="'Folio ' + c.folio">
                  <b>{{ ultimos4(c.folio) }}</b>
                  @if (variasSucursales()) { <em class="ep-suc">{{ suc(c.sucursal) }}</em> }
                </span>
                <span class="ep-prov" [title]="c.proveedor_nombre || ''">
                  {{ c.proveedor_nombre || c.proveedor_code || '—' }}
                  <em>{{ c.receipt_date | date:'dd/MM' }}@if (c.fecha_futura) { <i class="pi pi-exclamation-triangle" title="Fecha capturada adelantada en el ERP"></i> }</em>
                </span>
                <span class="ep-monto">{{ money(c.monto) }}</span>
                <span class="ep-estado">
                  @if (c.deposit_status === 'rechazado') {
                    <p-tag value="Devuelta" severity="danger" />
                  } @else if (c.deposit_status === 'validado') {
                    <p-tag value="Validada" severity="success" />
                  } @else if (c.deposits > 0) {
                    <p-tag value="Enviada" severity="info" />
                    @if (!c.monto_match) { <i class="pi pi-exclamation-triangle ep-nomatch" title="El total de la factura no cuadra con Kepler"></i> }
                  }
                </span>
                <span class="ep-act">
                  @if (canManage()) {
                    <button pButton type="button" class="p-button-sm" [class.p-button-outlined]="c.deposits > 0" (click)="abrir(c)">
                      <span class="p-button-icon p-button-icon-left pi" [ngClass]="c.deposits > 0 ? 'pi-plus' : 'pi-camera'" aria-hidden="true"></span>
                      <span class="p-button-label">{{ c.deposits > 0 ? 'Otra' : 'Subir factura' }}</span>
                    </button>
                  }
                </span>
              </li>
            }
          </ul>

          @if (report(); as r) {
            <div class="ep-pager">
              <span>{{ desde() }}–{{ hasta() }} de <strong>{{ r.total }}</strong></span>
              <button pButton type="button" class="p-button-sm p-button-text" [disabled]="page() === 1 || loading()" (click)="irPagina(page() - 1)">
                <span class="p-button-icon pi pi-angle-left" aria-hidden="true"></span><span class="p-button-label">Anterior</span>
              </button>
              <button pButton type="button" class="p-button-sm p-button-text" [disabled]="hasta() >= r.total || loading()" (click)="irPagina(page() + 1)">
                <span class="p-button-label">Siguiente</span><span class="p-button-icon pi pi-angle-right" aria-hidden="true"></span>
              </button>
            </div>
          }
        }
      }
    </div>

    <!-- Hoja de captura: la entrada ya está elegida (viene del renglón), así que acá sólo
         se trata de la foto. Sin buscador de folio, sin selector de rol, sin checklist. -->
    <p-dialog [visible]="abierta() !== null" (visibleChange)="onCerrar($event)" [modal]="true" [draggable]="false"
              [style]="{ width: '34rem', maxWidth: '96vw' }" [breakpoints]="{ '640px': '100vw' }"
              [header]="abierta() ? 'Factura de la entrada ' + abierta()!.folio : ''">
      @if (abierta(); as t) {
        <div class="ep-cap">
          <dl class="ep-cap-head">
            <div><dt>Proveedor</dt><dd>{{ t.proveedor_nombre || t.proveedor_code || '—' }}</dd></div>
            <div><dt>Fecha</dt><dd>{{ t.receipt_date | date:'dd/MM/yy' }}</dd></div>
            <div class="ta-r"><dt>Total en Kepler</dt><dd class="ep-cap-monto">{{ money(t.monto) }}</dd></div>
          </dl>

          @if (t.deposit_status === 'rechazado') {
            <div class="ep-cap-rej">
              <i class="pi pi-undo" aria-hidden="true"></i>
              <span>Esta evidencia te la devolvieron. Subí de nuevo la factura correcta.</span>
            </div>
          }

          @if (!hojas().length) {
            <div class="ep-drop">
              <label class="ep-pick primary">
                <i class="pi pi-camera" aria-hidden="true"></i> Tomar foto
                <input type="file" accept="image/*" capture="environment" (change)="onFiles($event)" hidden />
              </label>
              <label class="ep-pick">
                <i class="pi pi-upload" aria-hidden="true"></i> Elegir archivo
                <input type="file" accept="image/*,application/pdf" multiple (change)="onFiles($event)" hidden />
              </label>
              <p class="ep-drop-hint">Foto o PDF de la factura. Si son varias hojas, agregalas todas.</p>
            </div>
          } @else {
            <ul class="ep-hojas">
              @for (h of hojas(); track h.id) {
                <li class="ep-hoja" [class.dup]="!!h.dupDe">
                  <span class="ep-hoja-th">
                    @if (h.kind === 'image') { <img [src]="h.dataUri" [alt]="h.name" /> }
                    @else { <i class="pi pi-file-pdf" aria-hidden="true"></i> }
                  </span>
                  <span class="ep-hoja-body">
                    <b [title]="h.name">{{ h.name }}</b>
                    <em>
                      @if (h.leyendo) { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Leyendo la factura… }
                      @else if (h.dupDe) { <span class="bad">Ya subida en la entrada {{ h.dupDe }}</span> }
                      @else if (h.total != null) { Total leído {{ money(h.total) }}@if (h.folio) { · folio {{ h.folio }} } }
                      @else { No se pudo leer el total — se guarda igual }
                      · {{ kb(h.bytes) }}
                    </em>
                  </span>
                  <button type="button" class="ep-hoja-x" (click)="quitar(h)" [attr.aria-label]="'Quitar ' + h.name">
                    <i class="pi pi-times" aria-hidden="true"></i>
                  </button>
                </li>
              }
            </ul>

            @if (cuadre() !== null) {
              <div class="ep-cuadre" [class.ok]="cuadre()" [class.bad]="!cuadre()" role="status">
                <i class="pi" [ngClass]="cuadre() ? 'pi-check-circle' : 'pi-exclamation-triangle'" aria-hidden="true"></i>
                @if (cuadre()) { <span>La factura <strong>cuadra</strong> con el total de Kepler.</span> }
                @else { <span>La factura difiere <strong>{{ money(dif()) }}</strong> del total de Kepler. Se puede guardar: el revisor decide.</span> }
              </div>
            }

            <label class="ep-pick small">
              <i class="pi pi-plus" aria-hidden="true"></i> Agregar otra hoja
              <input type="file" accept="image/*,application/pdf" multiple (change)="onFiles($event)" hidden />
            </label>
          }

          @if (capError()) { <p class="ep-cap-err">{{ capError() }}</p> }
        </div>
      }
      <ng-template #footer>
        <button pButton type="button" text (click)="cerrar()"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" [loading]="guardando()" [disabled]="!puedeGuardar()" (click)="guardar()">
          <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
          <span class="p-button-label">Enviar factura</span>
        </button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ep { container-type: inline-size; }
    .ep-head-actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .ep-suc-fija { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-xs, .75rem);
      color: var(--text-muted); border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); padding: .18rem .5rem; }

    /* Marcador: el número grande es lo que falta, no lo que se hizo. */
    .ep-scoreboard { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
      padding: .8rem 1rem; margin-bottom: .85rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); }
    .ep-scoreboard.done { color: var(--ok-fg); border-color: color-mix(in oklab, var(--ok-fg) 35%, var(--border-color)); }
    .ep-scoreboard.done .pi { font-size: 1.15rem; }
    .ep-sb-main { margin: 0; font-weight: 600; }
    .ep-sb-nums { display: flex; align-items: baseline; gap: .45rem; }
    .ep-sb-big { font-size: 1.9rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
    .ep-sb-lbl { font-size: var(--fs-xs, .75rem); color: var(--text-muted); line-height: 1.15; }
    .ep-sb-bar { flex: 1 1 8rem; height: .4rem; border-radius: 99px; background: var(--border-color); overflow: hidden; min-width: 6rem; }
    .ep-sb-bar > span { display: block; height: 100%; background: var(--ok-fg); border-radius: 99px; transition: width .3s ease; }
    @media (prefers-reduced-motion: reduce) { .ep-sb-bar > span { transition: none; } }
    .ep-sb-pct { font-size: var(--fs-xs, .75rem); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ep-sb-late { display: inline-flex; align-items: center; gap: .35rem; border: 1px solid currentColor;
      background: transparent; color: var(--bad-fg); border-radius: var(--r-sm, .35rem); padding: .2rem .55rem;
      font: inherit; font-size: var(--fs-xs, .75rem); cursor: pointer; }
    .ep-sb-late:hover { background: color-mix(in oklab, var(--bad-fg) 8%, transparent); }

    .ep-returned { display: flex; align-items: center; gap: .6rem; width: 100%; text-align: left;
      padding: .6rem .9rem; margin-bottom: .85rem; cursor: pointer; font: inherit;
      color: var(--bad-fg); background: color-mix(in oklab, var(--bad-fg) 7%, transparent);
      border: 1px solid color-mix(in oklab, var(--bad-fg) 35%, var(--border-color)); border-radius: var(--r-md, .5rem); }
    .ep-returned > span { flex: 1; }

    .ep-block { display: flex; gap: .8rem; align-items: flex-start; padding: 1.1rem 1.2rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); }
    .ep-block .pi { font-size: 1.2rem; color: var(--text-muted); }
    .ep-block-t { margin: 0 0 .2rem; font-weight: 600; }
    .ep-block-s { margin: 0; color: var(--text-muted); font-size: var(--fs-sm, .85rem); max-width: 46ch; }

    .ep-filters { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-bottom: .85rem; }
    .ep-search { flex: 1 1 18rem; min-width: 12rem; }

    .ep-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-color);
      border-radius: var(--r-md, .5rem); overflow: hidden; }
    .ep-list.loading { opacity: .6; }
    .ep-row { display: grid; align-items: center; gap: .2rem .8rem; padding: .55rem .8rem;
      grid-template-columns: 3rem 1fr auto; grid-template-areas: 'dias folio act' 'dias prov act' 'dias monto est'; }
    .ep-row + .ep-row { border-top: 1px solid var(--border-color); }
    .ep-row:hover { background: var(--surface-hover, var(--surface-sunken)); }
    @container (min-width: 46rem) {
      .ep-row { grid-template-columns: 3.2rem 6.5rem minmax(10rem, 1fr) 8rem 7.5rem auto;
        grid-template-areas: 'dias folio prov monto est act'; }
    }
    .ep-dias { grid-area: dias; display: inline-flex; align-items: baseline; justify-content: center; gap: .05rem;
      font-variant-numeric: tabular-nums; font-weight: 700; font-size: 1rem;
      border-radius: var(--r-sm, .35rem); padding: .15rem .3rem; }
    .ep-dias em { font-style: normal; font-size: .65em; opacity: .75; }
    .ep-dias.is-ok { color: var(--text-muted); }
    .ep-dias.is-warn { color: var(--warn-fg, var(--bad-fg)); background: color-mix(in oklab, var(--warn-fg, var(--bad-fg)) 10%, transparent); }
    .ep-dias.is-bad { color: var(--bad-fg); background: color-mix(in oklab, var(--bad-fg) 12%, transparent); }
    .ep-folio { grid-area: folio; }
    .ep-folio b { font-family: var(--font-mono); font-size: 1.05rem; letter-spacing: .02em; }
    .ep-suc { display: block; font-style: normal; font-size: var(--fs-micro, .72rem); color: var(--text-muted); }
    .ep-prov { grid-area: prov; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ep-prov em { font-style: normal; color: var(--text-muted); font-size: var(--fs-micro, .72rem); margin-left: .4rem; }
    .ep-monto { grid-area: monto; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: 600; }
    .ep-estado { grid-area: est; display: inline-flex; align-items: center; gap: .3rem; }
    .ep-nomatch { color: var(--bad-fg); }
    .ep-act { grid-area: act; }
    @container (min-width: 46rem) { .ep-monto, .ep-estado { justify-self: end; } .ep-monto { text-align: right; } }

    .ep-pager { display: flex; align-items: center; gap: .5rem; justify-content: flex-end;
      margin-top: .6rem; font-size: var(--fs-xs, .75rem); color: var(--text-muted); }
    .ep-skel { display: grid; gap: .35rem; }
    .ep-sk-row { height: 2.6rem; border-radius: var(--r-sm, .35rem);
      background: linear-gradient(90deg, var(--border-color) 25%, var(--surface-sunken) 50%, var(--border-color) 75%);
      background-size: 200% 100%; animation: ep-sh 1.2s infinite; }
    @keyframes ep-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .ep-sk-row { animation: none; } }
    .ep-empty { display: grid; place-items: center; gap: .5rem; padding: 3rem 1rem; color: var(--text-muted); }
    .ep-empty .pi { font-size: 1.6rem; color: var(--ok-fg); }
    .ep-empty p { margin: 0; }

    /* Hoja de captura */
    .ep-cap { display: flex; flex-direction: column; gap: .85rem; }
    .ep-cap-head { display: flex; gap: 1.2rem; flex-wrap: wrap; margin: 0; padding: .65rem .85rem;
      background: var(--surface-sunken, var(--card-bg)); border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); }
    .ep-cap-head > div { display: flex; flex-direction: column; gap: .1rem; }
    .ep-cap-head dt { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .ep-cap-head dd { margin: 0; font-weight: 600; }
    .ep-cap-monto { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ep-cap-head .ta-r { margin-left: auto; text-align: right; }
    .ep-cap-rej { display: flex; gap: .5rem; align-items: center; padding: .5rem .7rem; font-size: var(--fs-sm, .85rem);
      color: var(--bad-fg); border: 1px solid color-mix(in oklab, var(--bad-fg) 35%, var(--border-color)); border-radius: var(--r-sm, .35rem); }
    .ep-drop { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; padding: 1.2rem;
      border: 1px dashed var(--border-color); border-radius: var(--r-md, .5rem); }
    .ep-pick { display: inline-flex; align-items: center; gap: .4rem; cursor: pointer;
      padding: .55rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem);
      font-weight: 600; min-height: 2.75rem; /* toque cómodo en celular */ }
    .ep-pick:hover { border-color: var(--action); color: var(--action); }
    .ep-pick.primary { background: var(--action); border-color: var(--action); color: #fff; }
    .ep-pick.primary:hover { filter: brightness(1.06); color: #fff; }
    .ep-pick.small { align-self: flex-start; padding: .35rem .7rem; font-weight: 500; min-height: 2.25rem; font-size: var(--fs-sm, .85rem); }
    .ep-pick:focus-within { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px; }
    .ep-drop-hint { flex: 1 1 100%; margin: 0; color: var(--text-muted); font-size: var(--fs-xs, .75rem); }
    .ep-hojas { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
    .ep-hoja { display: flex; gap: .6rem; align-items: center; padding: .45rem;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); }
    .ep-hoja.dup { border-color: var(--bad-fg); }
    .ep-hoja-th { width: 2.6rem; height: 2.6rem; flex: 0 0 auto; display: grid; place-items: center;
      overflow: hidden; border-radius: var(--r-sm, .35rem); background: var(--surface-sunken); }
    .ep-hoja-th img { width: 100%; height: 100%; object-fit: cover; }
    .ep-hoja-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .ep-hoja-body b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm, .85rem); }
    .ep-hoja-body em { font-style: normal; color: var(--text-muted); font-size: var(--fs-micro, .72rem); }
    .ep-hoja-body .bad { color: var(--bad-fg); }
    .ep-hoja-x { background: transparent; border: 0; color: var(--text-muted); cursor: pointer; padding: .3rem; }
    .ep-hoja-x:hover { color: var(--bad-fg); }
    .ep-cuadre { display: flex; gap: .5rem; align-items: center; padding: .5rem .7rem; font-size: var(--fs-sm, .85rem);
      border-radius: var(--r-sm, .35rem); border: 1px solid var(--border-color); }
    .ep-cuadre.ok { color: var(--ok-fg); border-color: color-mix(in oklab, var(--ok-fg) 35%, var(--border-color)); }
    .ep-cuadre.bad { color: var(--warn-fg, var(--bad-fg)); border-color: color-mix(in oklab, var(--warn-fg, var(--bad-fg)) 35%, var(--border-color)); }
    .ep-cap-err { margin: 0; color: var(--bad-fg); font-size: var(--fs-sm, .85rem); }
  `],
})
export class ComprasEntradasPendientesComponent {
  private readonly svc = inject(EntradasService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly report = signal<EntradasReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);

  /** Sin `undefined`: `''` ya significa "todas" y el segmented necesita un string siempre. */
  readonly estado = signal<Exclude<EntradasQuery['estado'], undefined>>('pendiente');
  readonly sucursalSel = signal<string | null>(null);
  readonly rezago = signal(false);
  readonly diasMin = signal<number | undefined>(undefined);
  readonly page = signal(1);
  search = '';
  private readonly pageSize = 50;

  readonly estadoOpts = [
    { label: 'Pendientes', value: 'pendiente' },
    { label: 'Devueltas', value: 'rechazado' },
    { label: 'Enviadas', value: 'por_validar' },
    { label: 'Validadas', value: 'validado' },
    { label: 'Todas', value: '' },
  ];

  readonly canManage = computed(() =>
    this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_GESTIONAR] === true);

  // ── alcance: decide si hay selector, chip fijo, o bloqueo explicado ──
  private readonly alcance = computed(() => this.report()?.alcance?.sucursales ?? null);
  readonly sinAlcance = computed(() => { const a = this.alcance(); return !!a && a.length === 0; });
  readonly variasSucursales = computed(() => { const a = this.alcance(); return a === null || a.length > 1; });
  readonly unaSucursal = computed(() => { const a = this.alcance(); return a && a.length === 1 ? this.suc(a[0]) : null; });
  readonly sucursalOpts = computed(() => {
    const a = this.alcance();
    const codes = a ?? Array.from(new Set(this.rows().map((r) => r.sucursal))).sort();
    return codes.map((c) => ({ label: this.suc(c), value: c }));
  });

  suc(code: string): string { return branchName(code) || code; }
  money = money;
  ultimos4(folio: string): string { const d = String(folio || '').replace(/\D/g, ''); return d.slice(-4) || folio; }
  kb(b: number): string { return b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }

  faltan(r: EntradasReport): number { return Math.max(0, r.kpis.entradas - r.kpis.con_comprobante); }
  avance(r: EntradasReport): number {
    return r.kpis.entradas === 0 ? 100 : Math.round((r.kpis.con_comprobante / r.kpis.entradas) * 100);
  }
  desde(): number { const r = this.report(); return !r || r.total === 0 ? 0 : (this.page() - 1) * this.pageSize + 1; }
  hasta(): number { const r = this.report(); return !r ? 0 : Math.min(r.total, this.page() * this.pageSize); }

  /** Tres niveles sobre el SLA del tenant: al día · pasado · muy pasado (2×). */
  tono(c: EntradaRow): 'ok' | 'warn' | 'bad' {
    const sla = this.report()?.settings?.sla_capture_days ?? 3;
    if (c.dias > sla * 2) return 'bad';
    if (c.dias > sla) return 'warn';
    return 'ok';
  }

  // ── carga (un solo pipeline: el último pedido gana, no hay carreras) ──
  private readonly pedir = new Subject<void>();

  constructor() {
    this.pedir.pipe(
      switchMap(() => {
        this.loading.set(true);
        this.error.set(null);
        const q: EntradasQuery = {
          estado: this.estado(),
          search: this.search || undefined,
          warehouse_codes: this.sucursalSel() ? [this.sucursalSel() as string] : undefined,
          carril: this.rezago() ? 'rezago' : 'al_dia',
          dias_min: this.diasMin(),
          orden: 'antiguedad',
          page: this.page(),
          pageSize: this.pageSize,
        };
        return this.svc.list(q).pipe(catchError((e) => {
          this.error.set(e?.error?.message || 'No se pudo cargar la lista de pendientes.');
          this.loading.set(false);
          return of(null);
        }));
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => { if (r) { this.report.set(r); } this.loading.set(false); });
    this.reload();
  }

  reload(): void { this.pedir.next(); }
  private volverAlInicio(): void { this.page.set(1); this.diasMin.set(undefined); }
  setEstado(v: string): void {
    this.estado.set((v || '') as Exclude<EntradasQuery['estado'], undefined>);
    this.volverAlInicio(); this.reload();
  }
  setSucursal(v: string | null): void { this.sucursalSel.set(v || null); this.volverAlInicio(); this.reload(); }
  setRezago(v: boolean): void { this.rezago.set(v); this.volverAlInicio(); this.reload(); }
  soloAtrasadas(): void {
    const sla = this.report()?.settings?.sla_capture_days ?? 3;
    this.estado.set('pendiente'); this.diasMin.set(sla + 1); this.page.set(1); this.reload();
  }
  irPagina(n: number): void { this.page.set(Math.max(1, n)); this.reload(); }

  // ─────────────────────────── captura ───────────────────────────
  readonly abierta = signal<EntradaRow | null>(null);
  readonly hojas = signal<Hoja[]>([]);
  readonly guardando = signal(false);
  readonly capError = signal('');
  private seq = 0;

  abrir(c: EntradaRow): void { this.abierta.set(c); this.hojas.set([]); this.capError.set(''); }
  cerrar(): void { this.abierta.set(null); this.hojas.set([]); this.capError.set(''); }
  onCerrar(v: boolean): void { if (!v) this.cerrar(); }
  quitar(h: Hoja): void { this.hojas.update((l) => l.filter((x) => x.id !== h.id)); }

  readonly leyendoAlguna = computed(() => this.hojas().some((h) => h.leyendo));
  readonly hayDup = computed(() => this.hojas().some((h) => !!h.dupDe));
  readonly puedeGuardar = computed(() =>
    this.hojas().length > 0 && !this.leyendoAlguna() && !this.hayDup() && !this.guardando());

  /** La hoja fiscal (la que trae importe) manda el cuadre. */
  private readonly fiscal = computed(() => this.hojas().find((h) => h.total != null || h.subtotal != null) || null);
  /** `null` = todavía no se puede opinar (sin lectura con importe). */
  readonly cuadre = computed<boolean | null>(() => {
    const t = this.abierta(); const f = this.fiscal();
    if (!t || !f) return null;
    const tol = this.report()?.settings?.match_tolerance ?? 1;
    const cerca = (v: number | null | undefined) => v != null && Math.abs(Number(v) - t.monto) <= tol;
    return cerca(f.total) || cerca(f.subtotal);
  });
  readonly dif = computed(() => {
    const t = this.abierta(); const f = this.fiscal();
    if (!t || !f) return 0;
    const cands = [f.total, f.subtotal].filter((v): v is number => v != null);
    if (!cands.length) return 0;
    return Math.min(...cands.map((v) => Math.abs(v - t.monto)));
  });

  async onFiles(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = ''; // permite volver a elegir el mismo archivo
    for (const file of files) {
      const esPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      let dataUri: string;
      try {
        // Una foto de celular son 3–6 MB en base64 sobre la red de una sucursal: se
        // reduce ANTES de salir del teléfono. El PDF va tal cual (ya viene liviano).
        dataUri = esPdf ? await this.leer(file) : await this.comprimir(file);
      } catch {
        this.capError.set(`No se pudo leer ${file.name}.`);
        continue;
      }
      const h: Hoja = {
        id: ++this.seq, name: file.name || (esPdf ? 'factura.pdf' : 'factura.jpg'),
        dataUri, kind: esPdf ? 'pdf' : 'image',
        bytes: Math.round((dataUri.length - (dataUri.indexOf(',') + 1)) * 0.75),
        leyendo: true,
      };
      this.hojas.update((l) => [...l, h]);
      // OCR: además de leer el total, deja la lectura del lado del server (es la que
      // manda para el cuadre) y detecta la hoja ya subida antes.
      this.svc.ocr(dataUri, 'factura').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (o) => this.parchar(h.id, {
          leyendo: false, sha256: o.sha256, folio: o.folio, total: o.total, subtotal: o.subtotal,
          fecha: o.fecha, rfc: o.rfc, ocr: o,
          dupDe: o.duplicate ? `${o.duplicate.sucursal}/${o.duplicate.folio}` : null,
        }),
        error: () => this.parchar(h.id, { leyendo: false }),
      });
    }
  }

  private parchar(id: number, p: Partial<Hoja>): void {
    this.hojas.update((l) => l.map((h) => (h.id === id ? { ...h, ...p } : h)));
  }

  private leer(file: File): Promise<string> {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(file);
    });
  }

  /** Reduce el lado mayor a 1,600 px y baja a JPEG 0.8 — legible para el OCR y del humano. */
  private async comprimir(file: File): Promise<string> {
    const raw = await this.leer(file);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('imagen ilegible')); i.src = raw;
      });
      const max = 1600;
      const esc = Math.min(1, max / Math.max(img.width, img.height));
      if (esc === 1 && raw.length < 1_500_000) return raw;
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * esc); cv.height = Math.round(img.height * esc);
      cv.getContext('2d')?.drawImage(img, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/jpeg', 0.8);
    } catch {
      return raw; // si el navegador no pudo decodificar, va la original
    }
  }

  guardar(): void {
    const t = this.abierta();
    const hojas = this.hojas();
    if (!t || !hojas.length || this.guardando()) return;
    this.capError.set('');
    this.guardando.set(true);
    forkJoin(hojas.map((h) => this.svc.uploadFile(h.dataUri, 'factura').pipe(map((up) => ({ h, up })))))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (subidas) => {
          const files: ProofFile[] = subidas.map(({ h, up }) => ({
            ...up, role: 'factura', name: h.name,
            sha256: h.sha256, ocr_folio: h.folio ?? null, ocr_total: h.total ?? null,
            ocr_fecha: h.fecha ?? null, ocr_rfc: h.rfc ?? null,
          }));
          const f = this.fiscal();
          this.svc.attach({ sucursal: t.sucursal, folio: t.folio, files, ocr: f?.ocr })
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: (res) => {
                this.guardando.set(false);
                this.cerrar();
                this.toast.add({
                  severity: res.monto_match ? 'success' : 'warn',
                  summary: `Factura enviada — entrada ${t.folio}`,
                  detail: res.monto_match ? 'El total cuadra ✓' : 'Guardada; el total no cuadra y el revisor la va a mirar.',
                });
                this.reload();
              },
              error: (e) => { this.guardando.set(false); this.capError.set(e?.error?.message || 'No se pudo enviar la factura.'); },
            });
        },
        error: (e) => { this.guardando.set(false); this.capError.set(e?.error?.message || 'No se pudo subir el archivo. Reintentá.'); },
      });
  }
}
