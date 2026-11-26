import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { CortesSucursalesResponse } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { FinanzasCortesSucursalesComponent } from './finanzas-cortes-sucursales.component';

/**
 * `[BFU.4.5.12]` **Llegar a Cortes/Sucursales desde Bancos ya filtrado.** En Bancos › Cuentas, la venta de tienda se abre por
 * sucursal y cada una dice «Ver sus cortes de caja»: esta pantalla tiene que abrir en ESE mes y con ESA sucursal elegida,
 * sin que la persona la vuelva a buscar. Vectores SINTÉTICOS (el repo es público).
 */
const suc = (sucursal: string, nombre: string) => ({ sucursal, sucursal_nombre: nombre, cortes: 1, vendido: 100, cobrado: 100, pendiente: 0 });
const RESPUESTA = {
  periodo: { from: '2026-10-01', to: '2026-10-31' }, alcance: { todas: true, sucursales: [] },
  totales: { cortes: 2, vendido: 200, cobrado: 200, pendiente: 0, sin_cobro: 0, con_diferencia: 0, sin_arqueo: 0, contado_igual_esperado: 0, con_declaracion_cajero: 0 },
  sucursales: [suc('05', 'Sucursal Cinco'), suc('08', 'Sucursal Ocho')], cortes: [], conteos_fuera_de_corte: [], cortes_en_blanco: 0,
  ultimo_corte: '2026-10-31', umbral_descuadre: 50, plazo_cobro_dias: 3,
} as unknown as CortesSucursalesResponse;

function montar(query: Record<string, string>) {
  TestBed.configureTestingModule({
    imports: [FinanzasCortesSucursalesComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
      { provide: PermissionsService, useValue: { isAdmin: () => true, isSuperadmin: () => false, has: () => true, hasExplicit: () => true, hasAny: () => true } }],
  });
  const fixture = TestBed.createComponent(FinanzasCortesSucursalesComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  const req = http.expectOne((r) => r.url.includes('/finance/cortes-sucursales'));
  const url = req.request.urlWithParams;
  req.flush(RESPUESTA);
  http.match(() => true);
  fixture.detectChanges();
  return { c: fixture.componentInstance, url };
}

describe('[BFU.4.5.12] Cortes/Sucursales abre en el mes y la sucursal que pide la liga de Bancos', () => {
  it('?month=2026-10&sucursal=08 → pide octubre y deja elegida la sucursal 08', () => {
    const { c, url } = montar({ month: '2026-10', sucursal: '08' });
    expect(url).toContain('month=2026-10');
    expect(c.mes()).toBe('2026-10');
    expect(c.selSuc()?.sucursal).toBe('08');
  });
  it('⛔ [negativa] un mes mal formado se ignora (queda el mes en curso) y una sucursal que no está no se inventa', () => {
    const { c, url } = montar({ month: '2026-13', sucursal: '99' });
    expect(url).not.toContain('month=2026-13');
    expect(c.mes()).toBe(c.mesOpts[0].value);
    expect(c.selSuc()).toBeNull();
  });
  it('sin parámetros, la pantalla abre como siempre', () => {
    const { c } = montar({});
    expect(c.mes()).toBe(c.mesOpts[0].value);
    expect(c.selSuc()).toBeNull();
  });
});
