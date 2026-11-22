/**
 * [COT.53] Al elegir un artículo, la pantalla cuenta qué se escribió, qué se eligió y en qué lugar
 * de la lista estaba — anónimo (el servidor no guarda quién). Sin lugar en la lista, no inventa uno.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { MessageService } from 'primeng/api';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { TeleventaQuoteNewComponent } from './televenta-quote-new.component';
import { QuoteCatalogRow, QuotesService } from '../quotes.service';

const fila = (sku: string) => ({ sku, name: 'ART ' + sku } as QuoteCatalogRow);

describe('[COT.53] el buscador cuenta lo que se elige', () => {
  function montar() {
    const registrarBusqueda = vi.fn();
    TestBed.configureTestingModule({
      imports: [TeleventaQuoteNewComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        MessageService,
        {
          provide: QuotesService,
          useValue: { registrarBusqueda, listSalespersons: () => of([]), stock: (branch: string) => of({ branch, stock_as_of: null, items: [] }) } satisfies Partial<QuotesService>,
        },
      ],
    });
    const c = TestBed.createComponent(TeleventaQuoteNewComponent).componentInstance;
    c.sucursal.set('01');
    c.terminoArticulo = 'mazapan';
    c.resultadosArticulos.set([fila('111'), fila('70056'), fila('222')]);
    return { c, registrarBusqueda };
  }

  it('⭐ manda término, SKU, su lugar en la lista (1 = el primero) y cuántos había', () => {
    const { c, registrarBusqueda } = montar();
    c.elegirArticulo(fila('70056'));
    expect(registrarBusqueda).toHaveBeenCalledWith({ branch: '01', term: 'mazapan', chosen_sku: '70056', position: 2, results: 3 });
  });

  it('un artículo que no estaba en la lista (otro camino de elección) no se cuenta: no hay lugar que decir', () => {
    const { c, registrarBusqueda } = montar();
    c.elegirArticulo(fila('999'));
    expect(registrarBusqueda).not.toHaveBeenCalled();
  });
});
