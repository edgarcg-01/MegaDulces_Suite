import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TiendaApiService } from '../../core/tienda-api.service';
import { PedidoDetalle, PedidoItem } from '../../core/models';

@Component({
  selector: 'app-tienda-pedido',
  imports: [DecimalPipe, DatePipe, RouterLink],
  templateUrl: './tienda-pedido.component.html',
})
export class TiendaPedidoComponent implements OnInit {
  private readonly api = inject(TiendaApiService);
  private readonly route = inject(ActivatedRoute);

  protected readonly pedido = signal<PedidoDetalle | null>(null);
  protected readonly items = signal<PedidoItem[]>([]);
  protected readonly cargando = signal(true);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    const seguimiento = this.route.snapshot.paramMap.get('seguimiento');
    if (!seguimiento) { this.error.set('Folio no válido'); this.cargando.set(false); return; }
    this.api.pedido(seguimiento).subscribe({
      next: (r) => {
        this.cargando.set(false);
        if (!r.ok || !r.pedido) { this.error.set(r.error ?? 'Pedido no encontrado'); return; }
        this.pedido.set(r.pedido);
        this.items.set(r.items ?? []);
      },
      error: () => {
        this.cargando.set(false);
        this.error.set('No se pudo consultar el pedido.');
      },
    });
  }
}
