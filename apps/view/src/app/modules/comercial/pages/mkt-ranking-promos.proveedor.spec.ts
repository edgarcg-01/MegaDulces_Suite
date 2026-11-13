import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';

import { MktRankingPromosComponent, delProveedor, textoProveedor } from './mkt-ranking-promos.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import type { PromoMkt, ProveedorPromo } from '../mkt-ranking.service';
import { environment } from '../../../../environments/environment';

/**
 * `[MKT.24]` Objetivos: el proveedor de cada promoción lo asigna Mercadotecnia en la celda (Kepler
 * sólo trae la cubeta «PROMOCIONES MKT»). Lo pendiente se cuenta, se filtra y se guarda de un clic.
 */

const BASE = `${environment.apiUrl}/commercial/mkt-ranking`;
const PROV: ProveedorPromo = { id: '11111111-2222-4333-8444-555555555555', code: 'CD015', name: 'DULCES DEMO SA' };

const promo = (o: Partial<PromoMkt>): PromoMkt => ({
  id: 'k-00154', code: '00154', descripcion_kepler: '2 PROD DEMO = GRATIS 1', mecanica: '2 PROD DEMO = GRATIS 1',
  vigencia_desde: '2026-11-02', vigencia_hasta: null, canales: ['mostrador'], warehouse_codes: ['01'], activo: true,
  notas: null, objetivos: 0, updated_at: '', updated_by_username: null, proveedor: null, ...o,
});
const lista = [
  promo({}),
  promo({ id: '7afca9a3-6d1a-4130-870b-1f2d6e1c314a', code: '09066', mecanica: '3 LECHES = GRATIS 1', proveedor: PROV, proveedor_fuente: 'asignado' }),
];
const HERSHEY: ProveedorPromo = { id: '22222222-2222-4333-8444-555555555555', code: 'CH001', name: 'HERSHEY DEMO' };
const derivada = promo({ id: 'k-00108', code: '00108', mecanica: '4 BLS KISSES = GRATIS 1', proveedor: HERSHEY, proveedor_fuente: 'producto' });

function montar(puede = true) {
  TestBed.configureTestingModule({
    imports: [MktRankingPromosComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), MessageService,
      // Cualquier método del servicio de permisos: has*/can* contestan `puede`; lo demás (isAdmin…), false.
      { provide: PermissionsService, useValue: new Proxy({}, { get: (_t, k) => (/^(has|can)/.test(String(k)) ? () => puede : () => false) }) }],
  });
  const fixture = TestBed.createComponent(MktRankingPromosComponent);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  return { fixture, http, c: fixture.componentInstance };
}

async function cargado(puede = true) {
  const m = montar(puede);
  m.http.expectOne(`${BASE}/promos`).flush(lista);
  if (puede) m.http.expectOne(`${BASE}/proveedores`).flush([PROV]);
  await m.fixture.whenStable();
  m.fixture.detectChanges();
  return m;
}

describe('[MKT.24] proveedor de la promoción — reglas', () => {
  it('el texto lleva la clave de Kepler y el nombre; sin proveedor, lo dice', () => {
    expect(textoProveedor(PROV)).toBe('CD015 · DULCES DEMO SA');
    expect(textoProveedor(null)).toBe('Sin proveedor asignado');
  });

  it('el filtro: null = todas; «sin» = las que nadie asignó; un id = las suyas', () => {
    expect(lista.filter((p) => delProveedor(p, null))).toHaveLength(2);
    expect(lista.filter((p) => delProveedor(p, 'sin')).map((p) => p.code)).toEqual(['00154']);
    expect(lista.filter((p) => delProveedor(p, PROV.id)).map((p) => p.code)).toEqual(['09066']);
  });
});

describe('[MKT.24] Objetivos — asignar el proveedor', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('⭐ «Sin proveedor» se cuenta arriba y su desglose deja sólo las que faltan', async () => {
    const { c } = await cargado();
    const k = c.kpis().find((x) => x.label === 'Sin proveedor')!;
    expect(k.value).toBe(1);
    expect(k.drill).toBe('sin');
    c.drill('sin');
    expect(c.filas().map((p) => p.code)).toEqual(['00154']);
    expect(c.opcionesFiltroProveedor()).toEqual([
      { label: 'CD015 · DULCES DEMO SA (1)', value: PROV.id },
      { label: 'Sin proveedor asignado (1)', value: 'sin' },
    ]);
  });

  it('el buscador encuentra por el nombre del proveedor', async () => {
    const { c } = await cargado();
    c.busqueda.set('dulces demo');
    expect(c.filas().map((p) => p.code)).toEqual(['09066']);
  });

  it('⭐ elegir un proveedor lo guarda y relee la lista (la promo de Kepler ya tiene renglón: cambió su id)', async () => {
    const { c, http, fixture } = await cargado();
    const p = c.filas().find((x) => x.code === '00154')!;
    const hecho = c.asignarProveedor(p, PROV.id);
    // [negativa] un segundo clic mientras guarda no manda otra escritura
    void c.asignarProveedor(p, PROV.id);
    const req = http.expectOne(`${BASE}/promos/k-00154/proveedor`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ supplier_id: PROV.id });
    req.flush({ proveedor: PROV });
    await hecho;
    fixture.detectChanges();
    http.expectOne(`${BASE}/promos`).flush([promo({ id: 'nuevo-uuid', proveedor: PROV, proveedor_fuente: 'asignado' }), lista[1]]);
    await fixture.whenStable();
    expect(c.promos()!.find((x) => x.code === '00154')!.proveedor).toEqual(PROV);
    expect(c.guardandoProveedor()).toBeNull();
  });

  it('[negativa] elegir el mismo proveedor que ya tiene no escribe nada', async () => {
    const { c, http } = await cargado();
    await c.asignarProveedor(c.filas().find((x) => x.code === '09066')!, PROV.id);
    http.expectNone(`${BASE}/promos/7afca9a3-6d1a-4130-870b-1f2d6e1c314a/proveedor`);
  });

  it('[negativa] si el servidor no lo guarda (p. ej. falta la migración), se dice y la lista vuelve a lo guardado', async () => {
    const { c, http, fixture } = await cargado();
    // El componente trae su propio MessageService (providers): el espía va en SU inyector.
    const avisos = fixture.debugElement.injector.get(MessageService);
    const add = vi.spyOn(avisos, 'add');
    const hecho = c.asignarProveedor(c.filas().find((x) => x.code === '00154')!, PROV.id);
    http.expectOne(`${BASE}/promos/k-00154/proveedor`).flush({ message: 'Falta aplicar la migración del proveedor de promociones ([MKT.24]).' }, { status: 503, statusText: 'x' });
    await hecho;
    fixture.detectChanges();
    http.expectOne(`${BASE}/promos`).flush(lista);
    await fixture.whenStable();
    expect(c.promos()!.find((x) => x.code === '00154')!.proveedor).toBeNull();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error', detail: expect.stringContaining('migración') }));
  });

  it('⭐ el proveedor DEL PRODUCTO es una sugerencia: cuenta como «con proveedor», pero no es el valor guardado', async () => {
    const m = montar();
    m.http.expectOne(`${BASE}/promos`).flush([...lista, derivada]);
    m.http.expectOne(`${BASE}/proveedores`).flush([PROV, HERSHEY]);
    await m.fixture.whenStable();
    m.fixture.detectChanges();
    const p = m.c.filas().find((x) => x.code === '00108')!;
    expect(m.c.asignado(p)).toBeNull();
    expect(m.c.sugerencia(p)).toBe('Del producto: CH001 · HERSHEY DEMO');
    expect(m.c.kpis().find((k) => k.label === 'Sin proveedor')!.value).toBe(1);
    expect(m.c.kpis().find((k) => k.label === 'Sin proveedor')!.sub).toContain('1 tomados del producto');
    // Elegir el mismo que sugiere el producto SÍ escribe: lo confirma.
    const hecho = m.c.asignarProveedor(p, HERSHEY.id);
    m.http.expectOne(`${BASE}/promos/k-00108/proveedor`).flush({ proveedor: HERSHEY });
    await hecho;
    m.fixture.detectChanges();
    m.http.expectOne(`${BASE}/promos`).flush(lista);
    await m.fixture.whenStable();
  });

  it('quien sólo VE no carga la lista de proveedores ni ve selectores: lee el proveedor como texto', async () => {
    const { fixture } = await cargado(false);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.rp-prov p-select')).toBeNull();
    expect(el.textContent).toContain('CD015 · DULCES DEMO SA');
    expect(el.textContent).toContain('Sin proveedor asignado');
  });
});
