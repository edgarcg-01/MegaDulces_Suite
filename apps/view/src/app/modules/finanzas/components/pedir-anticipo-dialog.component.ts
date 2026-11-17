import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, model, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { faltaSolicitudAnticipo, warehouseName, type AnticipoOcRow, type AnticipoProveedorRow, type AnticipoSolicitudBody } from '@megadulces/contracts';
import { leerPesos } from '../pages/calendario-pagos-descuento';
import { money } from '../../../shared/util/money.util';
import { environment } from '../../../../environments/environment';

/** Lo que devuelve el servidor al pedir el anticipo, más el nombre del proveedor para el aviso. */
export interface AnticipoPedido { obligation_id: string; monto: number; concepto: string; proveedor: string; fecha: string | null }

/** `pedir`: Compras, desde Anticipos, elige el día. `programar`: Dirección, desde el Calendario, en el día que ve. */
export type ModoAnticipo = 'pedir' | 'programar';

/**
 * `[PGP.119]` + `[PGP.138]` **Pedir o programar un anticipo a proveedor** — el diálogo, compartido.
 *
 * Nació dentro de *Anticipos* (`/finanzas/anticipos`, `/compras/anticipos`). Edgar, 2026-11-17: un botón en el
 * Calendario de pagos, **sólo para Dirección**. Una sola interfaz del flujo y una sola regla
 * (`faltaSolicitudAnticipo`, la misma del servidor), con dos modos:
 *  - `pedir` — Compras lo pide y elige el día; entra al Calendario por programar.
 *  - `programar` — Dirección, desde el Calendario, en el día que está viendo (no se elige otro: el día ES el
 *    contexto). La pantalla, al recibir `pedido`, lo pone en ese día.
 *
 * Lo que corrige la auditoría del 2026-11-17 (`[PGP.138]`): un error de lectura ya no se ve como «sin OC» ni
 * como «sin resultados» (dice qué falló y deja reintentar); cerrar con algo capturado pregunta antes de tirarlo;
 * la lista de proveedores no se anuncia como un `listbox` que no se recorre con flechas; lo que falta se lee al
 * enfocar el botón, no en cada tecla.
 */
@Component({
  selector: 'app-pedir-anticipo-dialog',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, DialogModule, SelectModule, DatePickerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" [modal]="true" [closable]="false" [closeOnEscape]="false" [header]="titulo()"
              [style]="{ width: '34rem' }" (onShow)="alAbrir()">
      <form class="pa-form" (ngSubmit)="guardar()" (keydown.escape)="pedirCerrar()">
        <p class="pa-help">{{ ayuda() }}</p>

        <label class="pa-label" for="pa-prov">Proveedor (de mercancía)</label>
        @if (prov(); as p) {
          <div class="pa-elegido"><span><b>{{ p.name }}</b> <span class="pa-muted">{{ p.code }}</span></span>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="quitarProveedor()" [attr.aria-label]="'Cambiar el proveedor ' + p.name">Cambiar</button></div>
        } @else {
          <input id="pa-prov" name="pa-prov" pInputText type="search" autocomplete="off" enterkeyhint="search" class="pa-full" placeholder="Nombre o código del proveedor"
                 [ngModel]="busca()" (ngModelChange)="buscarProveedor($event)" aria-describedby="pa-prov-estado" />
          <p id="pa-prov-estado" class="pa-muted" aria-live="polite">
            @switch (estadoBusqueda()) {
              @case ('buscando') { Buscando… }
              @case ('vacio') { Ningún proveedor de mercancía activo coincide con «{{ busca().trim() }}». }
              @case ('hay') { {{ opciones().length === 1 ? '1 proveedor' : opciones().length + ' proveedores' }}: elige uno. }
            }
          </p>
          @if (estadoBusqueda() === 'error') {
            <p class="pa-error" role="alert">No se pudo buscar el proveedor.
              <button pButton type="button" class="p-button-sm p-button-text" (click)="buscarAhora()">Reintentar</button></p>
          }
          @if (opciones().length) {
            <ul class="pa-opciones" aria-label="Proveedores encontrados">
              @for (o of opciones(); track o.id) {
                <li><button type="button" class="pa-opcion" (click)="elegirProveedor(o)">{{ o.name }} <span class="pa-muted">{{ o.code }}</span></button></li>
              }
            </ul>
          }
        }

        @if (prov()) {
          <label class="pa-label" for="pa-oc">Orden de compra (opcional)</label>
          @if (ocsError()) {
            <p class="pa-error" role="alert">No se pudieron leer las órdenes de compra de {{ prov()?.name }}: sin ellas no se sabe el tope del anticipo.
              <button pButton type="button" class="p-button-sm p-button-text" (click)="cargarOcs()">Reintentar</button></p>
          } @else {
            <p-select inputId="pa-oc" name="pa-oc" appendTo="body" [options]="ocOpciones()" optionLabel="label" optionValue="value" [ngModel]="oc()" (ngModelChange)="elegirOc($event)"
                      [showClear]="true" [placeholder]="ocsCargando() ? 'Leyendo sus órdenes…' : (ocs().length ? 'Sin OC' : 'No tiene órdenes abiertas')" [fluid]="true" [loading]="ocsCargando()" />
            @if (ocElegida(); as o) {
              <p class="pa-muted">OC de {{ pesos(o.total) }}; ya tiene {{ pesos(o.anticipado) }} en anticipos. El anticipo no pasa de lo que queda.</p>
            }
          }
        }

        <div class="pa-campos">
          <div>
            <label class="pa-label" for="pa-suc">Sucursal en Kepler</label>
            <p-select inputId="pa-suc" name="pa-suc" appendTo="body" [options]="sucursales" optionLabel="label" optionValue="value" [ngModel]="suc()" (ngModelChange)="suc.set($event)" placeholder="Elige" [fluid]="true" />
          </div>
          <div>
            <label class="pa-label" for="pa-monto">Importe</label>
            <input id="pa-monto" name="pa-monto" pInputText type="text" inputmode="decimal" autocomplete="off" class="pa-full comm-num" [ngModel]="monto()" (ngModelChange)="monto.set($event)" />
          </div>
        </div>
        <div class="pa-campos">
          <div>
            @if (modo() === 'programar') {
              <span class="pa-label">Se paga el</span>
              <p class="pa-fijo">{{ fechaLarga() }}</p>
            } @else {
              <label class="pa-label" for="pa-fecha">Pagar el</label>
              <p-datepicker inputId="pa-fecha" name="pa-fecha" [ngModel]="fecha()" (ngModelChange)="fecha.set($event)" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" [minDate]="hoy" [fluid]="true" />
            }
          </div>
          <div>
            <label class="pa-label" for="pa-motivo">Para qué es</label>
            <input id="pa-motivo" name="pa-motivo" pInputText type="text" autocomplete="off" class="pa-full" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Ej. apartar producto de temporada" />
          </div>
        </div>

        @if (falta(); as f) { <p id="pa-falta" class="pa-muted">{{ f }}</p> }
        @if (errorGuardar(); as e) { <p class="pa-error" role="alert">No se {{ modo() === 'programar' ? 'programó' : 'pidió' }} el anticipo: {{ e }}</p> }

        @if (confirmarDescarte()) {
          <div class="pa-descarte" role="alertdialog" aria-labelledby="pa-descarte-t">
            <p id="pa-descarte-t">¿Descartar lo capturado?</p>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="confirmarDescarte.set(false)">Seguir capturando</button>
            <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" (click)="cerrar()">Descartar</button>
          </div>
        } @else {
          <div class="pa-acciones">
            <button pButton type="button" class="p-button-text p-button-secondary" (click)="pedirCerrar()">Cancelar</button>
            <button pButton type="submit" [disabled]="!!falta() || guardando()" [loading]="guardando()" [attr.aria-describedby]="falta() ? 'pa-falta' : null">{{ accion() }}</button>
          </div>
        }
      </form>
    </p-dialog>
  `,
  styles: [`
    .pa-form { display: block; }
    .pa-help { font-size: var(--fs-sm); color: var(--text-muted); margin: 0 0 var(--sp-2); }
    .pa-muted { font-size: var(--fs-xs); color: var(--text-muted); margin: var(--sp-1) 0 0; }
    .pa-muted:empty { display: none; }
    .pa-error { font-size: var(--fs-sm); color: var(--bad-soft-fg); margin: var(--sp-2) 0 0; }
    .pa-label { display: block; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: var(--sp-3) 0 var(--sp-1); }
    .pa-fijo { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .pa-full { width: 100%; }
    .pa-campos { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
    .pa-elegido { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .pa-opciones { list-style: none; margin: var(--sp-1) 0 0; padding: 0; border: 1px solid var(--border-color); border-radius: var(--r-md); max-height: 14rem; overflow-y: auto; }
    .pa-opcion { display: block; width: 100%; text-align: left; padding: var(--sp-2) var(--sp-3); background: none; border: 0; color: var(--text-main); font: inherit; cursor: pointer; }
    .pa-opcion:hover { background: var(--overlay-hover); }
    .pa-opcion:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .pa-acciones, .pa-descarte { display: flex; justify-content: flex-end; align-items: center; gap: var(--sp-2); margin-top: var(--sp-4); }
    .pa-descarte p { margin: 0 auto 0 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    @media (max-width: 40rem) { .pa-campos { grid-template-columns: 1fr; } }
  `],
})
export class PedirAnticipoDialogComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly obligaciones = `${environment.apiUrl}/commercial/supplier-obligations`;
  private buscaTimer?: ReturnType<typeof setTimeout>;
  private buscaSeq = 0;

  /** Abierto o cerrado; la pantalla que lo usa lo abre. */
  readonly visible = model(false);
  readonly modo = input<ModoAnticipo>('pedir');
  /** El día con el que arranca: en `programar`, el día que se ve en el Calendario (fijo). */
  readonly fechaInicial = input<Date | null>(null);
  /** Se emite cuando el servidor creó la obligación: la pantalla avisa (y, en `programar`, la pone en el día). */
  readonly pedido = output<AnticipoPedido>();

  readonly titulo = computed(() => (this.modo() === 'programar' ? 'Programar anticipo a proveedor' : 'Pedir anticipo a proveedor'));
  readonly accion = computed(() => (this.modo() === 'programar' ? 'Programar anticipo' : 'Pedir anticipo'));
  readonly ayuda = computed(() => (this.modo() === 'programar'
    ? 'Queda como un pago propio en el día que estás viendo: Tesorería lo prepara y se autoriza como cualquier pago. Después se aplica contra facturas de la sucursal que elijas.'
    : 'Entra al Calendario de pagos como cualquier pago: se programa, Dirección lo autoriza y Tesorería lo paga. El anticipo sólo se puede aplicar después contra facturas de la sucursal que elijas.'));

  readonly sucursales = ['00', '01', '02', '03', '04', '05', '06', '07', '08'].map((c) => ({ label: warehouseName(c), value: c }));
  readonly hoy = new Date();
  readonly busca = signal('');
  readonly opciones = signal<AnticipoProveedorRow[]>([]);
  /** Lo que dice la búsqueda: nada escrito, buscando, sin coincidencias, con resultados o falló (distintos). */
  readonly estadoBusqueda = signal<'nada' | 'buscando' | 'vacio' | 'hay' | 'error'>('nada');
  readonly prov = signal<AnticipoProveedorRow | null>(null);
  readonly ocs = signal<AnticipoOcRow[]>([]);
  readonly ocsCargando = signal(false);
  readonly ocsError = signal(false);
  readonly oc = signal<string | null>(null);
  readonly suc = signal<string | null>(null);
  readonly monto = signal('');
  readonly fecha = signal<Date | null>(null);
  readonly motivo = signal('');
  readonly guardando = signal(false);
  readonly errorGuardar = signal<string | null>(null);
  readonly confirmarDescarte = signal(false);
  readonly ocOpciones = computed(() => this.ocs().map((o) => ({
    label: `OC ${o.folio} · ${warehouseName(o.sucursal)} · ${money(o.total)}${o.anticipado > 0 ? ` (ya ${money(o.anticipado)} en anticipos)` : ''}`, value: o.id,
  })));
  readonly ocElegida = computed(() => { const id = this.oc(); return this.ocs().find((o) => o.id === id) ?? null; });
  readonly fechaLarga = computed(() => {
    const f = this.fecha();
    return f ? f.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  });
  /** Hay algo capturado que se perdería al cerrar. */
  readonly sucio = computed(() => !!this.prov() || !!this.busca().trim() || !!this.monto().trim() || !!this.motivo().trim() || !!this.suc());
  /** Por qué todavía no se puede pedir: la MISMA regla que el servidor (`faltaSolicitudAnticipo`). */
  readonly falta = computed<string | null>(() => {
    // Todas las señales se leen siempre (sin cortocircuito): el computed no se queda sin dependencias.
    const prov = this.prov(), suc = this.suc(), leido = leerPesos(this.monto()), motivo = this.motivo(), fecha = this.fecha(), oc = this.ocElegida();
    const sinOcs = this.ocsError(), leyendoOcs = this.ocsCargando();
    if (prov && sinOcs) return 'Faltan sus órdenes de compra: reintenta leerlas antes de pedir (sin ellas no se sabe el tope).';
    if (prov && leyendoOcs) return 'Leyendo sus órdenes de compra…';
    if (leido.error) return leido.error;
    return faltaSolicitudAnticipo({
      supplier_code: prov?.code ?? null, sucursal: suc, monto: leido.pesos ?? 0, motivo, fecha: this.ymd(fecha),
      oc: oc ? { total: oc.total, anticipado: oc.anticipado, folio: oc.folio } : null,
    });
  });

  constructor() { this.destroyRef.onDestroy(() => clearTimeout(this.buscaTimer)); }

  /** Cada vez que se abre, el formulario arranca limpio y con la fecha de la pantalla. */
  alAbrir(): void { this.limpiar(); }
  limpiar(): void {
    this.busca.set(''); this.opciones.set([]); this.estadoBusqueda.set('nada'); this.prov.set(null);
    this.ocs.set([]); this.ocsError.set(false); this.ocsCargando.set(false); this.oc.set(null);
    this.suc.set(null); this.monto.set(''); this.motivo.set(''); this.errorGuardar.set(null); this.confirmarDescarte.set(false);
    const f = this.fechaInicial();
    this.fecha.set(f && f >= this.inicioDeHoy() ? new Date(f) : new Date());
  }
  /** Cancelar, Esc: si hay algo capturado, pregunta antes de tirarlo. */
  pedirCerrar(): void {
    if (this.guardando()) return;
    if (this.sucio() && !this.confirmarDescarte()) { this.confirmarDescarte.set(true); return; }
    this.cerrar();
  }
  cerrar(): void { this.confirmarDescarte.set(false); this.visible.set(false); }

  buscarProveedor(t: string): void {
    this.busca.set(t);
    clearTimeout(this.buscaTimer);
    if (!t.trim()) { this.opciones.set([]); this.estadoBusqueda.set('nada'); return; }
    this.estadoBusqueda.set('buscando');
    this.buscaTimer = setTimeout(() => this.buscarAhora(), 250);
  }
  buscarAhora(): void {
    const t = this.busca().trim();
    if (!t) return;
    const seq = ++this.buscaSeq;
    this.estadoBusqueda.set('buscando');
    this.http.get<AnticipoProveedorRow[]>(`${this.obligaciones}/anticipo/proveedores`, { params: { search: t } }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { if (seq !== this.buscaSeq) return; const xs = r ?? []; this.opciones.set(xs); this.estadoBusqueda.set(xs.length ? 'hay' : 'vacio'); },
        error: () => { if (seq !== this.buscaSeq) return; this.opciones.set([]); this.estadoBusqueda.set('error'); },
      });
  }
  elegirProveedor(p: AnticipoProveedorRow): void {
    this.prov.set(p); this.opciones.set([]); this.estadoBusqueda.set('nada');
    this.cargarOcs();
  }
  cargarOcs(): void {
    const p = this.prov();
    if (!p) return;
    this.oc.set(null); this.ocs.set([]); this.ocsError.set(false); this.ocsCargando.set(true);
    this.http.get<AnticipoOcRow[]>(`${this.obligaciones}/anticipo/ocs`, { params: { supplier_id: p.id } }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.ocs.set((r ?? []).map((o) => ({ ...o, total: Number(o.total), anticipado: Number(o.anticipado) }))); this.ocsCargando.set(false); },
      error: () => { this.ocs.set([]); this.ocsCargando.set(false); this.ocsError.set(true); },
    });
  }
  quitarProveedor(): void { this.prov.set(null); this.ocs.set([]); this.oc.set(null); this.ocsError.set(false); }
  /** Al elegir la OC, la sucursal pasa a ser la de la OC (ahí llegarán sus facturas); se puede cambiar. */
  elegirOc(id: string | null): void {
    this.oc.set(id);
    const oc = this.ocs().find((o) => o.id === id);
    if (oc?.sucursal) this.suc.set(oc.sucursal);
  }
  /** El botón se apaga en el primer clic; el servidor vuelve a revisar la OC y el tope. */
  guardar(): void {
    if (this.falta() || this.guardando()) return;
    const prov = this.prov();
    const suc = this.suc();
    const pesos = leerPesos(this.monto()).pesos;
    if (!prov || !suc || pesos == null) return;
    const fecha = this.ymd(this.fecha());
    const body: AnticipoSolicitudBody = {
      supplier_id: prov.id, sucursal: suc, monto: pesos, motivo: this.motivo().trim(), purchase_order_id: this.oc(), fecha,
    };
    this.guardando.set(true);
    this.errorGuardar.set(null);
    this.http.post<{ obligation_id: string; monto: number; concepto: string }>(`${this.obligaciones}/anticipo`, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.cerrar();
        this.pedido.emit({ ...r, monto: Number(r.monto), proveedor: prov.name, fecha });
      },
      error: (e: { error?: { message?: string } }) => {
        this.guardando.set(false);
        this.errorGuardar.set(e?.error?.message || 'intenta de nuevo en un momento.');
      },
    });
  }

  pesos(v: number | null | undefined): string { return money(v); }
  private inicioDeHoy(): Date { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  private ymd(d: Date | null): string | null {
    if (!d || Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
