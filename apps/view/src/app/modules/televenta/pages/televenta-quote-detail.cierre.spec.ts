/**
 * [COT.52] Cerrar el borrador sin pedido, con motivo. La regla del servidor (motivo → estado) se
 * prueba en libs/commercial (quote-close.spec.ts); aquí, lo que la pantalla manda y cuándo deja.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { ConfirmationService, MessageService } from 'primeng/api';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { TeleventaQuoteDetailComponent } from './televenta-quote-detail.component';
import { QuotesService } from '../quotes.service';

describe('[COT.52] cerrar sin pedido', () => {
  function montar() {
    const close = vi.fn(() => of({ id: 'q1', code: 'COT-2026-00001', status: 'rejected' as const, close_reason: 'precio' }));
    TestBed.configureTestingModule({
      imports: [TeleventaQuoteDetailComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        MessageService,
        ConfirmationService,
        { provide: QuotesService, useValue: { close } satisfies Partial<QuotesService> },
      ],
    });
    const c = TestBed.createComponent(TeleventaQuoteDetailComponent).componentInstance;
    const recargar = vi.spyOn(c, 'recargar').mockImplementation(() => undefined);
    return { c, close, recargar };
  }

  it('sin motivo no se puede cerrar; con «otro» hace falta escribir cuál', () => {
    const { c } = montar();
    c.abrirCierre();
    expect(c.puedeCerrar()).toBe(false);
    c.cierreMotivo.set('otro');
    expect(c.puedeCerrar()).toBe(false);
    c.cierreNota.set('   ');
    expect(c.puedeCerrar()).toBe(false);
    c.cierreNota.set('cerró su tienda');
    expect(c.puedeCerrar()).toBe(true);
    c.cierreMotivo.set('precio');
    c.cierreNota.set('');
    expect(c.puedeCerrar()).toBe(true);
  });

  it('⭐ cerrar manda el motivo (y la nota limpia o null), cierra el diálogo y recarga', () => {
    const { c, close, recargar } = montar();
    c.abrirCierre();
    c.cierreMotivo.set('precio');
    c.cierreNota.set('  ');
    c.cerrarSinPedido({ id: 'q1' });
    expect(close).toHaveBeenCalledWith('q1', { motivo: 'precio', nota: null });
    expect(c.cierreAbierto()).toBe(false);
    expect(recargar).toHaveBeenCalledWith(true);
  });

  it('NEGATIVA: sin motivo elegido no llama al servidor', () => {
    const { c, close } = montar();
    c.abrirCierre();
    c.cerrarSinPedido({ id: 'q1' });
    expect(close).not.toHaveBeenCalled();
  });
});
