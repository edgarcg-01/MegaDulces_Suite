import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { AndenComponent } from './anden.component';
import { AndenOfflineService } from './anden-offline.service';
import { ANDEN_STORE, MemoriaAndenStore } from './anden-offline.store';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { environment } from '../../../../environments/environment';
import type { ReceivingSession } from '../receiving-session.service';

/**
 * `[WMS-REC.20]` — **El Andén entero, sin red.** Lo que pidió quien recibe, punta a punta:
 *
 *  1. con poco o nada de internet se puede ABRIR un vale (de los que el equipo bajó con red) y
 *     FECHAR, sin que la pantalla se trabe ni pierda nada;
 *  2. al volver la conexión, lo terminado se manda SOLO, en orden, y cada caducidad cae en el
 *     renglón que el servidor creó para su producto;
 *  3. abrir la pantalla sin red NO borra el vale a medias (antes el borrador se tiraba ante
 *     cualquier error).
 */
const API = environment.apiUrl;
const BASE = `${API}/commercial/receiving/sessions`;
const WH = '22222222-2222-2222-2222-222222222222';

const paquete = {
  sucursal: '01',
  generado_en: '2026-10-07T18:00:00.000Z',
  vales: [{
    sucursal: '01', folio: '0000412', receipt_date: '2026-10-07', proveedor_code: 'C001', proveedor_nombre: 'DE LA ROSA',
    monto: 1500, warehouse_id: WH, warehouse_code: '01', warehouse_name: 'Padre Hidalgo', line_count: 2, service_count: 0,
    origin: { kind: 'supplier', isCedis: false, label: 'Proveedor', name: 'DE LA ROSA' }, tipo: 'compra', fuente: 'orden_entrada',
    lineas: [
      { expected_sku: '70001', expected_name: 'PALETA', expected_qty: 24, expected_unit: 'PZA', product_id: 'p-a', sku: '70001', product_name: 'PALETA' },
      { expected_sku: '70002', expected_name: 'CHICLE', expected_qty: 10, expected_unit: 'PZA', product_id: 'p-b', sku: '70002', product_name: 'CHICLE' },
    ],
  }],
};

/** El vale como lo crea el servidor al llegar la apertura: los renglones en OTRO orden. */
const delServidor = (extra: Partial<ReceivingSession> = {}): ReceivingSession => ({
  id: 'srv-1', folio: 'VE-2026-00042', warehouse_id: WH, warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
  source_kind: 'erp_receipt', source_ref: '01/0000412', status: 'open',
  lines: [
    { id: 'srv-b', product_id: 'p-b', sku: '70002', product_name: 'CHICLE', expected_sku: '70002', expected_qty: 10, received_qty: 0, discrepancy_kind: 'pending', declared_qty: 0, held_qty: 0 },
    { id: 'srv-a', product_id: 'p-a', sku: '70001', product_name: 'PALETA', expected_sku: '70001', expected_qty: 24, received_qty: 0, discrepancy_kind: 'pending', declared_qty: 0, held_qty: 0 },
  ],
  ...extra,
});

describe('[WMS-REC.20] Andén · sin red', () => {
  let fixture: ComponentFixture<AndenComponent>;
  let http: HttpTestingController;
  let store: MemoriaAndenStore;
  let conRed = false;
  const el = () => fixture.nativeElement as HTMLElement;
  const texto = () => el().textContent || '';
  const boton = (t: string) =>
    Array.from(el().querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent || '').includes(t));
  const pinta = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const respira = async () => { await new Promise((r) => setTimeout(r, 0)); await pinta(); };

  function montar(): void {
    TestBed.configureTestingModule({
      imports: [AndenComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: { user: signal({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => false } },
        { provide: ANDEN_STORE, useValue: store },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AndenComponent);
  }

  beforeEach(() => {
    localStorage.clear();
    store = new MemoriaAndenStore();
    conRed = false;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => conRed);
  });

  afterEach(() => {
    http?.verify({ ignoreCancelled: true });
    vi.restoreAllMocks();
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('⭐ sin red se abre el vale bajado y se fecha; al volver la red se manda solo y en orden', async () => {
    await store.guardarPaquete(paquete as never);
    montar();
    await pinta();

    // El menú sale de lo que bajó el equipo, y se dice que no hay red.
    boton('Dar de alta caducidades')!.click();
    await respira();
    expect(texto()).toContain('Sin conexión');
    (el().querySelector('button.su-row') as HTMLButtonElement).click();
    await respira();
    expect(texto()).toContain('0000412');

    // Abrir: sin un solo pedido al servidor.
    (el().querySelector('button.va-row') as HTMLButtonElement).click();
    await respira();
    expect(texto()).toContain('Sin folio aún');
    expect(texto()).toContain('por mandar');
    expect(texto()).toContain('PALETA');
    http.expectNone(() => true);

    // Fechar la paleta completa: queda guardada en el equipo y sale de la cola de fechado.
    const cmp = fixture.componentInstance;
    const paleta = cmp.s.lineas().find((l) => l.expected_sku === '70001')!;
    await cmp.confirmarFechado({ linea: paleta, entradas: [{ cantidad: 24, lote: 'L1', caducidadIso: '2027-01-31', fotoDataUri: null }] });
    await respira();
    expect(cmp.s.pendientesFechar().map((l) => l.expected_sku)).toEqual(['70002']);
    expect(texto()).toContain('Guardada en el equipo');
    const red = TestBed.inject(AndenOfflineService);
    expect(red.ops().map((o) => o.tipo)).toEqual(['abrir', 'fechar', 'renglon']);
    http.expectNone(() => true);
    // Fechar encadena al siguiente renglón (R3); la recarga al mandar espera a que nadie esté
    // escribiendo uno, así que el bodeguero vuelve a la lista.
    expect(cmp.s.actual()?.expected_sku).toBe('70002');
    cmp.volverALista();
    await pinta();

    // Vuelve la red: se manda TODO solo, en orden.
    conRed = true;
    red.online.set(true);
    const envio = red.flush();
    await respira();
    const abrir = http.expectOne((r) => r.method === 'POST' && r.url === BASE);
    const llave = cmp.s.vale()!.id.replace('local:', '');
    expect(abrir.request.body).toMatchObject({ source_kind: 'erp_receipt', erp_sucursal: '01', erp_folio: '0000412', client_uuid: llave });
    abrir.flush(delServidor());
    await respira();
    const fechar = http.expectOne((r) => r.method === 'POST' && r.url === `${API}/commercial/receiving/evaluate`);
    // La paleta es srv-a aunque el servidor la haya devuelto segunda.
    expect(fechar.request.body).toMatchObject({ receiving_line_id: 'srv-a', source_ref: 'VE-2026-00042', quantity: 24, product_id: 'p-a' });
    expect(fechar.request.body.client_uuid).toMatch(/^[0-9a-f-]{36}$/);
    fechar.flush({ id: 'c1', verdict: 'green', status: 'accepted' });
    await respira();
    const renglon = http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/srv-1/lines/srv-a`);
    expect(renglon.request.body).toEqual({ received_qty: 24 });
    renglon.flush(delServidor());
    await envio;
    await respira();
    // La pantalla recarga el vale con su folio real.
    http.expectOne(`${BASE}/srv-1`).flush(delServidor());
    await respira();
    for (const r of http.match(() => true)) r.flush(r.request.url.includes('warehouse-freeze') ? { frozen: false } : []);
    await respira();
    expect(red.pendientes()).toBe(0);
    expect(texto()).toContain('Mandado');
    expect(texto()).toContain('VE-2026-00042');
  });

  it('abrir la pantalla sin red recupera el vale a medias del equipo y NO borra el borrador', async () => {
    await store.guardarVale({
      key: 'srv-9', sessionId: 'srv-9', vale: delServidor({ id: 'srv-9', folio: 'VE-2026-00099' }), mapa: {},
      sucursal: '01', erp: null, actualizado: '2026-10-07T10:00:00Z',
    });
    localStorage.setItem('anden.borrador.srv-9', JSON.stringify({ sessionId: 'srv-9', guardadoEn: Date.now() }));
    montar();
    await pinta();
    await respira();
    expect(texto()).toContain('VE-2026-00099');
    expect(texto()).toContain('Vale recuperado');
    expect(localStorage.getItem('anden.borrador.srv-9')).not.toBeNull();
  });

  it('un 500 al recuperar NO borra el borrador; un 404 sí (el vale de verdad ya no existe)', async () => {
    conRed = true;
    localStorage.setItem('anden.borrador.srv-7', JSON.stringify({ sessionId: 'srv-7', guardadoEn: Date.now() }));
    montar();
    await pinta();
    await respira();
    http.expectOne(`${BASE}/srv-7`).flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    await respira();
    expect(localStorage.getItem('anden.borrador.srv-7')).not.toBeNull();
    TestBed.resetTestingModule();

    montar();
    await pinta();
    await respira();
    http.expectOne(`${BASE}/srv-7`).flush({ message: 'Sesión no encontrada' }, { status: 404, statusText: 'Not Found' });
    await respira();
    expect(localStorage.getItem('anden.borrador.srv-7')).toBeNull();
  });

  it('sin red y sin nada bajado, el menú lo dice en vez de quedarse vacío', async () => {
    montar();
    await pinta();
    boton('Dar de alta caducidades')!.click();
    await respira();
    expect(texto()).toContain('todavía no bajó los vales');
  });
});
