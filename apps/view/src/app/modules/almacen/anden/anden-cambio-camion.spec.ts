import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { AndenComponent } from './anden.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { environment } from '../../../../environments/environment';
import type { AndenValeEnCurso, ErpOrderMatch, ErpPendingMenu, ReceivingSession } from '../receiving-session.service';

/**
 * `[WMS-REC.17]` — **el Andén entero: recibir un traspaso y cambiar de camión.**
 *
 * Se monta la pantalla de verdad (con sus hijos) y se le contesta la red a mano. Lo que se
 * cuida es lo que el usuario pidió, punta a punta:
 *
 *  1. el traspaso de CEDIS a Padre Hidalgo **aparece** y se abre **desde el embarque**
 *     (`erp_transfer` con origen, serie y folio — no como orden de entrada);
 *  2. a media captura hay un botón para **ir a otro camión**, que sale al menú **sin
 *     cancelar** el vale (no se manda ni un `/cancel`);
 *  3. el vale que se dejó aparece en **«En curso»** y se **retoma** de un toque.
 */
const BASE = `${environment.apiUrl}/commercial/receiving/sessions`;
const SES_ID = '11111111-1111-1111-1111-111111111111';
const WH = '22222222-2222-2222-2222-222222222222';

const menu: ErpPendingMenu = {
  alcance: 'listed',
  sucursales: [{
    sucursal: '01', warehouse_id: WH, warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
    pendientes: 1, compras: 0, anteriores: 0, traspasos: 1, ultimo: '2026-10-04', sin_almacen: false,
  }],
};

const embarque: ErpOrderMatch = {
  sucursal: '00', folio: '0001048', serie: 2, receipt_date: '2026-10-04',
  proveedor_code: null, proveedor_nombre: 'CEDIS BPIRAPUATO', monto: 10670.88,
  warehouse_id: WH, warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
  line_count: 2, service_count: 0,
  origin: { kind: 'transfer', isCedis: true, label: 'CEDIS', name: 'CEDIS BPIRAPUATO' },
  tipo: 'traspaso', fuente: 'embarque', recibido_kepler: null, dias_en_camino: 2,
  destino_code: 'TI001', destino_nombre: 'SUCURSAL PADRE HIDALGO',
};

const sesion: ReceivingSession = {
  id: SES_ID, folio: 'VE-2026-00013', warehouse_id: WH, warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
  supplier_code: 'TI000', source_kind: 'erp_transfer', source_ref: 'UD41/00/2/0001048', status: 'open',
  lines: [
    { id: 'l-1', product_id: 'p-1', sku: '95663', product_name: 'PALETA', expected_qty: 48, received_qty: 0,
      discrepancy_kind: 'pending', declared_qty: 0, held_qty: 0, expected_unit: 'PAQ' },
    { id: 'l-2', product_id: 'p-2', sku: '28196', product_name: 'CHICLE', expected_qty: 320, received_qty: 0,
      discrepancy_kind: 'pending', declared_qty: 0, held_qty: 0, expected_unit: 'PAQ' },
  ],
  origin: { kind: 'transfer', isCedis: true, label: 'CEDIS', name: 'CEDIS BPIRAPUATO' },
  erp: { sucursal: '00', folio: '0001048', monto: 10670.88, tipo: 'traspaso', fuente: 'embarque',
    proveedor_nombre: 'CEDIS BPIRAPUATO' },
};

const enCurso: AndenValeEnCurso = {
  id: SES_ID, folio: 'VE-2026-00013', source_kind: 'erp_transfer', documento: 'Embarque 00-2-0001048',
  warehouse_id: WH, warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
  origin: { kind: 'transfer', isCedis: true, label: 'CEDIS', name: 'CEDIS BPIRAPUATO' },
  renglones: 2, por_fechar: 2, abierto_por: 'Juan', created_at: '2026-10-06T18:00:00Z',
};

describe('[WMS-REC.17] Andén · traspaso y cambio de camión', () => {
  let fixture: ComponentFixture<AndenComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const texto = () => el().textContent || '';
  const boton = (t: string) =>
    Array.from(el().querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      (b.textContent || '').toLowerCase().includes(t.toLowerCase()));
  const pinta = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

  /** Contesta lo que la pantalla pide de ACOMPAÑAMIENTO (racks, congelado, por acomodar). */
  function contestarAccesorios(): void {
    for (const r of http.match(() => true) as TestRequest[]) {
      const u = r.request.url;
      if (u.includes('/warehouse-freeze')) r.flush({ warehouse_id: WH, frozen: false });
      else if (u.includes('/bins') || u.includes('/unlocated') || u.includes('/pick-suggestion')) r.flush([]);
      else throw new Error(`petición inesperada: ${r.request.method} ${u}`);
    }
  }

  /** Entra al menú del alta y le contesta el menú y la lista de «En curso». */
  async function abrirMenu(enCursoResp: AndenValeEnCurso[]): Promise<void> {
    http.expectOne(`${BASE}/en-curso`).flush(enCursoResp);
    http.expectOne(`${BASE}/erp-pending-branches`).flush(menu);
    await pinta();
  }

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [AndenComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: { user: signal({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => false } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AndenComponent);
    await pinta();
  });

  afterEach(() => {
    http.verify({ ignoreCancelled: true });
    localStorage.clear();
  });

  it('⭐ el traspaso de CEDIS aparece, se abre desde el embarque y se puede dejar para ir a otro camión', async () => {
    boton('Dar de alta caducidades')!.click();
    await abrirMenu([]);
    expect(texto()).toContain('1 traspaso en camino');

    // La sucursal → sus vales: el embarque del CEDIS.
    (el().querySelector('button.su-row') as HTMLButtonElement).click();
    http.expectOne((r) => r.url === `${BASE}/erp-pending` && r.params.get('sucursal') === '01').flush([embarque]);
    await pinta();
    expect(texto()).toContain('Embarque 0001048');
    expect(texto()).toContain('De CEDIS BPIRAPUATO');

    // Abrirlo: se pide como TRASPASO, con origen, serie y folio del embarque.
    (el().querySelector('button.va-row') as HTMLButtonElement).click();
    const abrir = http.expectOne((r) => r.method === 'POST' && r.url === BASE);
    expect(abrir.request.body).toEqual({
      source_kind: 'erp_transfer', erp_sucursal: '00', erp_serie: 2, erp_folio: '0001048',
    });
    abrir.flush(sesion);
    http.expectOne(`${BASE}/${SES_ID}`).flush(sesion);
    await pinta();
    contestarAccesorios();
    await pinta();

    // El vale abierto dice de dónde viene y qué documento es.
    expect(texto()).toContain('VE-2026-00013');
    expect(texto()).toContain('CEDIS BPIRAPUATO · Embarque 0001048');
    expect(texto()).toContain('PALETA');

    // Cambiar de camión: sin renglón abierto se sale directo, sin cancelar nada.
    const cambiar = boton('Cambiar de camión');
    expect(cambiar).toBeTruthy();
    cambiar!.click();
    await pinta();
    http.expectNone((r) => r.url.includes('/cancel'));
    await abrirMenu([enCurso]);

    // El vale que se dejó está en «En curso» y el menú sigue ahí para el siguiente camión.
    expect(texto()).toContain('En curso');
    expect(texto()).toContain('VE-2026-00013');
    expect(texto()).toContain('¿A qué sucursal entra la mercancía?');
    // Y no se reabre solo al volver a entrar: el borrador local se soltó.
    expect(Object.keys(localStorage).filter((k) => k.startsWith('anden.borrador.'))).toEqual([]);
  });

  it('con un renglón a medio capturar, pide confirmación antes de salir', async () => {
    boton('Dar de alta caducidades')!.click();
    await abrirMenu([enCurso]);

    // Retomar el vale desde «En curso».
    (el().querySelector('button.ec-row') as HTMLButtonElement).click();
    http.expectOne(`${BASE}/${SES_ID}`).flush(sesion);
    await pinta();
    contestarAccesorios();
    await pinta();
    expect(texto()).toContain('Vale retomado');
    expect(texto()).toContain('PALETA');

    // Se abre un renglón: lo que se escribe ahí es lo único que todavía no se guardó.
    const renglon = Array.from(el().querySelectorAll<HTMLButtonElement>('button.an-row'))
      .find((b) => (b.textContent || '').includes('PALETA'))!;
    renglon.click();
    await pinta();
    contestarAccesorios();
    await pinta();

    boton('Cambiar de camión')!.click();
    await pinta();
    expect(texto()).toContain('queda en curso');
    expect(texto()).toContain('no guardaste se pierde');

    // «Seguir aquí» no sale.
    boton('Seguir aquí')!.click();
    await pinta();
    expect(texto()).not.toContain('queda en curso');
    expect(boton('Cambiar de camión')).toBeTruthy();

    // «Ir a otro camión» sale al menú, sin cancelar el vale.
    boton('Cambiar de camión')!.click();
    await pinta();
    boton('Ir a otro camión')!.click();
    await pinta();
    http.expectNone((r) => r.url.includes('/cancel'));
    await abrirMenu([enCurso]);
    expect(texto()).toContain('¿A qué sucursal entra la mercancía?');
  });

  it('si «En curso» no se puede leer, el menú lo dice y sigue funcionando', async () => {
    boton('Dar de alta caducidades')!.click();
    http.expectOne(`${BASE}/en-curso`).flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    http.expectOne(`${BASE}/erp-pending-branches`).flush(menu);
    await pinta();
    expect(texto()).toContain('No se pudieron leer los vales incompletos');
    expect(el().querySelector('button.su-row')).toBeTruthy();
  });
});
