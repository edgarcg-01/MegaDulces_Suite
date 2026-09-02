import { DecimalPipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { CarritoStateService } from '../core/carrito-state.service';

/**
 * Pill flotante sticky: conteo + total (Geist Mono, tabular-nums) + CTA al
 * carrito. Sección "catálogo mayorista" de DESIGN.md. Oculta en /carrito,
 * /checkout y /pedido — ahí el carrito ya está a la vista.
 */
@Component({
  selector: 'app-sticky-cart-bar',
  imports: [RouterLink, DecimalPipe],
  template: `
    @if (visible()) {
      <a routerLink="/carrito"
         class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3
                rounded-full bg-action px-5 py-3 text-white shadow-lg
                hover:bg-action-hover active:scale-[0.98] transition">
        <span class="flex h-6 w-6 items-center justify-center rounded-full bg-white/25 text-xs font-bold">
          {{ cantidad() }}
        </span>
        <span class="font-mono tabular-nums font-semibold">{{ total() | number: '1.2-2' }}</span>
        <span class="text-sm font-medium opacity-90">Ver carrito</span>
      </a>
    }
  `,
  standalone: true,
})
export class StickyCartBarComponent {
  private readonly carritoState = inject(CarritoStateService);
  private readonly router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(e => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  private readonly ocultaEnRuta = computed(() => {
    const u = this.url();
    return u.startsWith('/carrito') || u.startsWith('/checkout') || u.startsWith('/pedido');
  });

  readonly cantidad = computed(() =>
    this.carritoState.carrito()?.items?.reduce((n, i) => n + i.cantidad, 0) ?? 0);

  readonly total = computed(() => this.carritoState.carrito()?.total ?? 0);

  readonly visible = computed(() => this.cantidad() > 0 && !this.ocultaEnRuta());
}
