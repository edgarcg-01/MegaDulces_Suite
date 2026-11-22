/**
 * [COT.50] La cotización a medias, con el aviso a la vista.
 *
 * Sergio (telemarketing, 2026-11-21): «dos veces esta semana se me cerró la ventana y perdí la
 * captura». Dos huecos en la pantalla, además del cierre de sesión (ver session-cleanup.spec):
 *   · mientras el aviso «Tienes una cotización sin terminar» esperaba respuesta, lo que se
 *     capturaba NO se respaldaba (una sola ranura: guardarlo pisaba al otro);
 *   · recuperar con algo ya capturado lo tiraba.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { MessageService } from 'primeng/api';
import { of } from 'rxjs';

import { ItemBandeja, TeleventaQuoteNewComponent } from './televenta-quote-new.component';
import { QuotesService } from '../quotes.service';
import { VERSION_BORRADOR, claveBorrador, leerBorradores, prefijoUsuario, type BorradorCotizacion } from '../cotizacion-a-medias';

const renglon = (sku: string): ItemBandeja => ({
  id: 'r-' + sku, sku, name: 'ART ' + sku, barcode: null, content: null,
  rung: 'base', unit_label: 'CJA', factor: null, quantity: 1,
  unit_price: 10, line_total: 10, price_source: 'list',
  base_unit: 'CJA', pack_size: null, list_price: 10, pasos: '', explicacion: '',
});

const borrador = (skus: string[], guardado = Date.now() - 60_000): BorradorCotizacion => ({
  v: VERSION_BORRADOR, guardado, modo: 'mayoreo', sucursal: '01', cliente: null, direccion: null, vendedor: null,
  contacto: { nombre: 'Abarrotes Lupita', tel: '', mail: '' }, origen: 'telemarketing', vigencia: null,
  lista: '', observaciones: '', bandeja: skus.map(renglon),
});

/** Las claves de borrador del usuario de la prueba (sin sesión: «sin-usuario»). */
const clavesDelUsuario = () =>
  Object.keys(localStorage).filter((k) => k === prefijoUsuario(undefined) || k.startsWith(prefijoUsuario(undefined) + ':'));

describe('[COT.50] la cotización a medias con el aviso a la vista', () => {
  beforeEach(() => {
    localStorage.clear();
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
  });

  async function abrir() {
    const fixture = TestBed.createComponent(TeleventaQuoteNewComponent);
    await Promise.resolve(); // la lectura de pendientes espera a saber qué pestañas siguen abiertas
    await Promise.resolve();
    return { fixture, c: fixture.componentInstance };
  }

  it('⭐ lo que se captura con el aviso a la vista también se respalda, sin pisar al borrador viejo', async () => {
    localStorage.setItem(claveBorrador(undefined, 'pestana-cerrada'), JSON.stringify(borrador(['111'])));
    const { c } = await abrir();
    expect(c.borradoresPendientes().map((p) => p.borrador.bandeja[0].sku)).toEqual(['111']);

    c.bandeja.set([renglon('222')]);
    TestBed.tick();

    const guardados = leerBorradores(undefined).map((p) => p.borrador.bandeja.map((r) => r.sku).join());
    expect(guardados.sort()).toEqual(['111', '222']);
  });

  it('⭐ recuperar con algo ya capturado lo aparta como otro borrador del aviso, no lo tira', async () => {
    localStorage.setItem(claveBorrador(undefined, 'pestana-cerrada'), JSON.stringify(borrador(['111'])));
    const { c } = await abrir();
    c.bandeja.set([renglon('222')]);
    TestBed.tick();

    c.recuperarBorrador(c.borradoresPendientes()[0]);
    TestBed.tick();

    expect(c.bandeja().map((r) => r.sku)).toEqual(['111']);
    expect(c.borradoresPendientes().map((p) => p.borrador.bandeja[0].sku)).toEqual(['222']);
    // En el navegador quedan dos ranuras: la de esta pestaña (111) y la apartada (222). La de la
    // pestaña cerrada ya no: lo recuperado vive en la de esta pestaña.
    expect(localStorage.getItem(claveBorrador(undefined, 'pestana-cerrada'))).toBeNull();
    expect(clavesDelUsuario()).toHaveLength(2);
  });

  it('descartar uno no toca los demás ni lo que lleva la pantalla', async () => {
    localStorage.setItem(claveBorrador(undefined, 'a'), JSON.stringify(borrador(['111'], Date.now() - 120_000)));
    localStorage.setItem(claveBorrador(undefined, 'b'), JSON.stringify(borrador(['333'])));
    const { c } = await abrir();
    c.bandeja.set([renglon('222')]);
    TestBed.tick();

    // El más nuevo primero.
    expect(c.borradoresPendientes().map((p) => p.borrador.bandeja[0].sku)).toEqual(['333', '111']);
    c.descartarBorrador(c.borradoresPendientes()[1]);

    expect(c.borradoresPendientes().map((p) => p.borrador.bandeja[0].sku)).toEqual(['333']);
    expect(localStorage.getItem(claveBorrador(undefined, 'a'))).toBeNull();
    expect(localStorage.getItem(claveBorrador(undefined, 'b'))).not.toBeNull();
    expect(c.bandeja().map((r) => r.sku)).toEqual(['222']);
  });
});
