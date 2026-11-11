import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { VendorNuevaCotizacionComponent } from './nueva-cotizacion.component';

/**
 * `[MCP.16]` «Cotizar» en el encabezado de TODAS las pantallas de la app del vendedor, como el checador de
 * precios (David, 2026-11-10: «lo quiero disponible y a la mano 24/7»). Abre bajo el encabezado el elegir
 * cliente y, de ahí, la pantalla de cotizar; sin salir de lo que se está haciendo.
 *
 * Sólo lo ve quien puede cotizar (`COMMERCIAL_QUOTES_GESTIONAR`): a los demás sería un botón que siempre
 * termina en «no tienes permiso». El permiso viaja en la sesión: si se reparte, se ve al volver a entrar.
 *
 * ⚠️ El host NO se posiciona: la ventana se acomoda contra el encabezado (sticky), a todo su ancho.
 */
@Component({
  selector: 'app-vendor-cotizar-encabezado',
  standalone: true,
  imports: [ButtonModule, VendorNuevaCotizacionComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:pointerdown)': 'alTocarFuera($event)' },
  template: `
    @if (puede) {
      <button
        pButton
        type="button"
        class="cz-btn"
        severity="secondary"
        size="small"
        text
        (click)="abierta.set(!abierta())"
        [attr.aria-expanded]="abierta()"
        aria-label="Cotizar"
        title="Cotizar a un cliente"
      ><span class="p-button-icon p-button-icon-left pi pi-file-edit" aria-hidden="true"></span><span class="cz-t">Cotizar</span></button>
      @if (abierta()) {
        <div class="cz-flota" role="region" aria-label="Cotizar">
          <app-vendor-nueva-cotizacion [verLista]="true" (cerrar)="abierta.set(false)" />
        </div>
      }
    }
  `,
  styles: [`
    :host { display: contents; }
    .cz-t { margin-left: 0.35rem; font-weight: 600; }
    /* En el celular, sólo el icono: el espacio del encabezado es para la caja de precios. */
    @media (max-width: 40rem) { .cz-t { display: none; } }
    .cz-flota {
      position: absolute; top: 100%; left: 0; right: 0; max-height: 70vh; overflow-y: auto; overscroll-behavior: contain;
      padding: var(--sp-3) var(--sp-4) var(--sp-4); background: var(--card-bg); color: var(--text-main);
      border-bottom: 1px solid var(--border-color); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    }
  `],
})
export class VendorCotizarEncabezadoComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly puede = inject(PermissionsService).has(Permission.COMMERCIAL_QUOTES_GESTIONAR);
  readonly abierta = signal(false);

  constructor() {
    // Al cambiar de pantalla (también al elegir cliente) la ventana se cierra.
    inject(Router).events
      .pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(() => this.abierta.set(false));
  }

  /** Tocar fuera del botón y de la ventana la cierra (como el checador). */
  alTocarFuera(ev: Event): void {
    if (!this.abierta()) return;
    const t = ev.target as Node | null;
    if (t && this.host.nativeElement.contains(t)) return;
    this.abierta.set(false);
  }
}
