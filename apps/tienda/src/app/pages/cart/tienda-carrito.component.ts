import { DecimalPipe } from '@angular/common';
import { Component, OnInit, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CarritoStateService } from '../../core/carrito-state.service';

@Component({
  selector: 'app-tienda-carrito',
  imports: [DecimalPipe, RouterLink],
  templateUrl: './tienda-carrito.component.html',
})
export class TiendaCarritoComponent implements OnInit {
  protected readonly carritoState = inject(CarritoStateService);

  protected readonly carrito = this.carritoState.carrito;
  protected readonly cargando = this.carritoState.cargando;

  protected readonly puedeContinuar = computed(() => {
    const c = this.carrito();
    return !!c && c.items.length > 0 && !c.hay_avisos;
  });

  ngOnInit(): void {
    this.carritoState.iniciar();
  }

  cambiar(itemId: number, delta: number, actual: number): void {
    const nueva = actual + delta;
    if (nueva < 0) return;
    this.carritoState.cambiarCantidad(itemId, nueva);
  }

  quitar(itemId: number): void {
    this.carritoState.quitar(itemId);
  }
}
