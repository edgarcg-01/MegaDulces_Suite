import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, inject, input, output, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, map, of, switchMap } from 'rxjs';
import { VendorService, type VendorCustomer } from '../vendor.service';
import { type Falla, motivoDeFalla } from '../mis-cotizaciones';

/** Cuántos clientes se muestran al elegir; con más, se dice cuántos faltan y se pide escribir. */
const CLIENTES_POR_BUSQUEDA = 30;

/**
 * `[MCP.16]` Empezar una cotización: elegir al cliente (los de su ruta, como «Buscar cliente», VS.2) y abrir
 * la pantalla de cotizar (MCP.12). Vive en dos lugares con el MISMO comportamiento: la pestaña «Cotizaciones»
 * de «Pedidos» y el botón «Cotizar» del encabezado, que está en todas las pantallas (David, 2026-11-10:
 * «lo quiero disponible y a la mano 24/7»).
 */
@Component({
  selector: 'app-vendor-nueva-cotizacion',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="nc" (keydown.escape)="cerrar.emit()">
      <div class="nc-h">
        <b>¿A qué cliente le cotizas?</b>
        <button type="button" class="nc-x" (click)="cerrar.emit()" aria-label="Cerrar"><i class="pi pi-times" aria-hidden="true"></i></button>
      </div>
      <div class="nc-search">
        <i class="pi pi-search" aria-hidden="true"></i>
        <input #buscarCliente type="search" placeholder="Nombre o clave del cliente" [value]="busqueda()"
          (input)="buscar($any($event.target).value)" aria-label="Buscar cliente"
          inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off" spellcheck="false" />
      </div>
      <span class="nc-nota">Clientes de tu ruta de hoy. Una cotización no aparta mercancía.</span>
      @if (falla(); as f) {
        <div class="nc-err" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ f.texto }}</span>
          <button type="button" (click)="buscar(busqueda())">Reintentar</button>
        </div>
      } @else if (buscando() && !clientes().length) {
        <p class="nc-nota">Buscando…</p>
      } @else if (!clientes().length) {
        <p class="nc-nota">{{ busqueda().trim() ? 'Ningún cliente de tu ruta con «' + busqueda().trim() + '».' : 'No hay clientes en tu ruta de hoy.' }}</p>
      } @else {
        <ul class="nc-l">
          @for (cl of clientes(); track cl.id) {
            <li>
              <button type="button" (click)="elegir(cl)">
                <span>{{ cl.name }}</span>
                <span class="nc-clave">{{ cl.code }}</span>
              </button>
            </li>
          }
        </ul>
        @if (total() > clientes().length) {
          <p class="nc-nota">Mostrando {{ clientes().length }} de {{ total() }}: escribe el nombre para encontrar a los demás.</p>
        }
      }
      @if (verLista()) {
        <button type="button" class="nc-lista" (click)="irALista()">
          <i class="pi pi-list" aria-hidden="true"></i> Ver mis cotizaciones
        </button>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .nc { display: flex; flex-direction: column; gap: var(--sp-2); }
    .nc-h { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .nc-x { width: var(--tap-min); height: var(--tap-min); flex: none; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
    .nc-search { display: flex; align-items: center; gap: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-pill); padding: 0 var(--sp-3); }
    .nc-search i { color: var(--text-muted); }
    .nc-search:focus-within { border-color: var(--text-muted); }
    .nc-search input { flex: 1; min-width: 0; height: var(--tap-min); border: 0; background: none; color: var(--text-main);
      font-family: inherit; font-size: var(--fs-body); }
    .nc-nota { color: var(--text-muted); font-size: var(--fs-xs); margin: 0; }
    .nc-err { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--bad-border);
      border-radius: var(--r-md); color: var(--bad-fg); font-size: var(--fs-sm); }
    .nc-err button { margin-left: auto; flex: none; min-height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); padding: 0 var(--sp-3); font-family: inherit; cursor: pointer; }
    .nc-l { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .nc-l button { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2); width: 100%; min-height: var(--tap-min);
      padding: var(--sp-2) var(--sp-1); border: 0; border-bottom: 1px solid var(--border-color); background: transparent; color: var(--text-main);
      font-family: inherit; font-size: var(--fs-sm); text-align: left; cursor: pointer; }
    .nc-clave { color: var(--text-muted); font-size: var(--fs-xs); flex: none; font-family: var(--font-mono); }
    .nc-lista { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); min-height: var(--tap-min);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main);
      font-family: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; }
    .nc-x:focus-visible, .nc-err button:focus-visible, .nc-l button:focus-visible, .nc-lista:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  `],
})
export class VendorNuevaCotizacionComponent implements OnInit, AfterViewInit {
  private readonly vendor = inject(VendorService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** En el encabezado ofrece también ir a la lista; en la pestaña de la lista, no (ya está ahí). */
  readonly verLista = input(false);
  /** Se cierra (X, Escape, o ya se eligió y se navegó). */
  readonly cerrar = output<void>();

  readonly busqueda = signal('');
  readonly clientes = signal<VendorCustomer[]>([]);
  readonly total = signal(0);
  readonly buscando = signal(false);
  readonly falla = signal<Falla | null>(null);
  private readonly busqueda$ = new Subject<string>();
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('buscarCliente');

  ngOnInit(): void {
    this.busqueda$
      .pipe(
        debounceTime(250),
        // catchError DENTRO del switchMap: un fallo de red no mata la búsqueda.
        switchMap((s) =>
          this.vendor.listCustomers({ search: s.trim() || undefined, pageSize: CLIENTES_POR_BUSQUEDA, scope: 'mine' }).pipe(
            map((r) => ({ ok: true as const, r })),
            catchError((e: unknown) => of({ ok: false as const, e })),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((x) => {
        this.buscando.set(false);
        if (x.ok) {
          const data = x.r?.data ?? [];
          this.clientes.set(data);
          this.total.set(Math.max(Number(x.r?.total) || 0, data.length));
        } else {
          this.falla.set(motivoDeFalla(x.e, {
            generico: 'No se pudieron buscar tus clientes.',
            sinPermiso: 'Tu usuario no tiene permiso para buscar clientes.',
          }));
        }
      });
    this.buscar('');
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.input()?.nativeElement.focus());
  }

  buscar(v: string): void {
    this.busqueda.set(v);
    this.buscando.set(true);
    this.falla.set(null);
    this.busqueda$.next(v);
  }

  elegir(c: VendorCustomer): void {
    this.router.navigate(['/vendor/cotizar', c.id], { queryParams: { desde: 'cotizaciones' } });
    this.cerrar.emit();
  }

  irALista(): void {
    this.router.navigate(['/vendor/mis-pedidos'], { queryParams: { ver: 'cotizaciones' } });
    this.cerrar.emit();
  }
}
