import { DecimalPipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TiendaApiService } from '../../core/tienda-api.service';
import { CarritoStateService } from '../../core/carrito-state.service';
import { ProductoTienda, UnidadTienda } from '../../core/models';
import { brandPlaceholderGradient } from '../../core/util/brand-placeholder';

@Component({
  selector: 'app-tienda-producto',
  imports: [DecimalPipe, RouterLink],
  templateUrl: './tienda-producto.component.html',
})
export class TiendaProductoComponent implements OnInit {
  private readonly api = inject(TiendaApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly carritoState = inject(CarritoStateService);

  protected readonly producto = signal<ProductoTienda | null>(null);
  protected readonly unidadElegida = signal<UnidadTienda | null>(null);
  protected readonly cantidad = signal(1);
  protected readonly cargando = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly agregando = signal(false);
  protected readonly agregado = signal(false);

  protected readonly placeholder = brandPlaceholderGradient;

  protected readonly maxCantidad = computed(() => {
    const u = this.unidadElegida();
    const p = this.producto();
    if (!u || !p) return 1;
    return Math.max(1, Math.floor(p.disponible / u.piezas));
  });

  ngOnInit(): void {
    this.carritoState.iniciar();
    const codigo = this.route.snapshot.paramMap.get('codigo');
    if (!codigo) { this.router.navigateByUrl('/'); return; }
    this.api.producto(codigo).subscribe({
      next: (r) => {
        this.cargando.set(false);
        if (!r.ok || !r.producto) { this.error.set(r.error ?? 'Producto no encontrado'); return; }
        this.producto.set(r.producto);
        this.unidadElegida.set(r.producto.unidades[0] ?? null);
      },
      error: () => {
        this.cargando.set(false);
        this.error.set('No se pudo cargar el producto.');
      },
    });
  }

  elegirUnidad(u: UnidadTienda): void {
    this.unidadElegida.set(u);
    this.cantidad.set(1);
  }

  cambiarCantidad(delta: number): void {
    const n = Math.min(this.maxCantidad(), Math.max(1, this.cantidad() + delta));
    this.cantidad.set(n);
  }

  async agregar(): Promise<void> {
    const p = this.producto();
    const u = this.unidadElegida();
    if (!p || !u) return;
    this.agregando.set(true);
    this.agregado.set(false);
    const r = await this.carritoState.agregar(p.codigo, u.unidad, this.cantidad());
    this.agregando.set(false);
    if (r.ok) {
      this.agregado.set(true);
      setTimeout(() => this.agregado.set(false), 2500);
    } else {
      this.error.set(r.error ?? 'No se pudo agregar al carrito');
    }
  }
}
