import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TiendaApiService } from '../../core/tienda-api.service';
import { CarritoStateService } from '../../core/carrito-state.service';
import { CatalogoFiltros, ProductoTienda } from '../../core/models';
import { brandPlaceholderGradient } from '../../core/util/brand-placeholder';

type Vista = 'grid' | 'lista';
const CLAVE_VISTA = 'tienda_vista_catalogo';

@Component({
  selector: 'app-tienda-catalog',
  imports: [FormsModule, RouterLink, DecimalPipe],
  templateUrl: './tienda-catalog.component.html',
})
export class TiendaCatalogComponent implements OnInit {
  private readonly api = inject(TiendaApiService);
  protected readonly carritoState = inject(CarritoStateService);

  protected readonly productos = signal<ProductoTienda[]>([]);
  protected readonly filtros = signal<CatalogoFiltros | null>(null);
  protected readonly cargando = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly page = signal(1);
  protected readonly paginas = signal(1);
  protected readonly total = signal(0);

  protected readonly q = signal('');
  protected readonly familia = signal('');
  protected readonly marca = signal('');
  protected readonly vista = signal<Vista>(
    (localStorage.getItem(CLAVE_VISTA) as Vista) || 'grid');

  protected readonly hayMas = computed(() => this.page() < this.paginas());
  protected readonly placeholder = brandPlaceholderGradient;

  ngOnInit(): void {
    this.carritoState.iniciar();
    this.api.filtros().subscribe(f => this.filtros.set(f));
    this.buscar();
  }

  cambiarVista(v: Vista): void {
    this.vista.set(v);
    localStorage.setItem(CLAVE_VISTA, v);
  }

  buscar(): void {
    this.page.set(1);
    this.cargar(false);
  }

  cargarMas(): void {
    this.page.set(this.page() + 1);
    this.cargar(true);
  }

  private cargar(agregar: boolean): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.catalogo({
      q: this.q().trim() || undefined,
      familia: this.familia() || undefined,
      marca: this.marca() || undefined,
      page: this.page(),
      limit: 40,
    }).subscribe({
      next: (r) => {
        this.productos.set(agregar ? [...this.productos(), ...r.productos] : r.productos);
        this.paginas.set(r.paginas);
        this.total.set(r.total);
        this.cargando.set(false);
      },
      error: () => {
        this.error.set('No se pudo cargar el catálogo. Intenta de nuevo en un momento.');
        this.cargando.set(false);
      },
    });
  }
}
