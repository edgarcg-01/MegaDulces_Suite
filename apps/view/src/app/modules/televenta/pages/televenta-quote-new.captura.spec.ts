/**
 * [COT.54] Cuánto cuesta capturar: del primer artículo en la bandeja hasta guardar, con las
 * búsquedas de esa captura y si salió de un respaldo. Se reporta sólo agregado.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { MessageService } from 'primeng/api';
import { of } from 'rxjs';

import { ItemBandeja, TeleventaQuoteNewComponent } from './televenta-quote-new.component';
import { QuotesService } from '../quotes.service';

const renglon = { id: 'r1', sku: '111', name: 'X', quantity: 1, rung: 'base' } as ItemBandeja;

describe('[COT.54] la medida de la captura', () => {
  function montar() {
    TestBed.configureTestingModule({
      imports: [TeleventaQuoteNewComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        MessageService,
        {
          provide: QuotesService,
          useValue: {
            branches: () => of({ mode: 'none', branches: [], writable: [], default_branch: null, resolvable: false }),
            listSalespersons: () => of([]),
          } satisfies Partial<QuotesService>,
        },
      ],
    });
    return TestBed.createComponent(TeleventaQuoteNewComponent).componentInstance;
  }

  it('sin artículo en la bandeja no hay captura que medir (no viaja nada)', () => {
    const c = montar();
    TestBed.tick();
    expect(c.medidaDeCaptura()).toBeUndefined();
  });

  it('⭐ el reloj arranca con el primer artículo; las búsquedas se cuentan', () => {
    const c = montar();
    const antes = Date.now();
    c.bandeja.set([renglon]);
    TestBed.tick();
    c.busquedasCaptura = 7;
    const m = c.medidaDeCaptura(antes + 95_000);
    expect(m?.busquedas).toBe(7);
    expect(m?.recuperada).toBe(false);
    expect(m!.segundos).toBeGreaterThanOrEqual(94);
    expect(m!.segundos).toBeLessThanOrEqual(96);
  });

  it('vaciar la bandeja reinicia el reloj', () => {
    const c = montar();
    c.bandeja.set([renglon]);
    TestBed.tick();
    c.bandeja.set([]);
    TestBed.tick();
    expect(c.medidaDeCaptura()).toBeUndefined();
  });
});
