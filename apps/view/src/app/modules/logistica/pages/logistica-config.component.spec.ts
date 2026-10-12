import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { aNumero, LogisticaConfigComponent } from './logistica-config.component';

/**
 * Logística › Configuración: los montos (comisiones, viáticos, km) entran al formulario como
 * NÚMERO. Postgres los devuelve como texto («0.00») y, puesto así en un p-inputnumber, lo que se
 * teclea no llegaba al formulario: al guardar se mandaba «0.00» otra vez, sin error. Medido en
 * prod el 2026-10-12 (la comisión de CANINDO ZAMORA quedó en $0 tras editarla).
 */

describe('aNumero', () => {
  it('convierte el texto que manda Postgres', () => {
    expect(aNumero('129.00', 0)).toBe(129);
    expect(aNumero('0.00', 0)).toBe(0);
    expect(aNumero(91.2, 0)).toBe(91.2);
  });
  it('lo vacío da el valor por omisión, no NaN ni cero inventado', () => {
    expect(aNumero(null, null)).toBeNull();
    expect(aNumero(undefined, 0)).toBe(0);
    expect(aNumero('', null)).toBeNull();
    expect(aNumero('abc', null)).toBeNull();
  });
});

function montar() {
  TestBed.configureTestingModule({
    imports: [LogisticaConfigComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const f = TestBed.createComponent(LogisticaConfigComponent);
  const http = TestBed.inject(HttpTestingController);
  f.detectChanges();
  http.match(() => true).forEach((r: TestRequest) => r.flush([]));
  return { f, c: f.componentInstance };
}

describe('LogisticaConfigComponent — los montos entran como número', () => {
  it('editar una ruta con comisiones en texto deja números en el formulario', () => {
    const { c } = montar();
    c.openRouteDialog({
      id: 'r1', name: 'CANINDO ZAMORA', estimated_km: '186.5', driver_commission: '0.00',
      helper_commission: '91.20', active: true, notes: null,
    } as never);
    const v = c.routeForm.value;
    expect(v.driver_commission).toBe(0);
    expect(v.helper_commission).toBe(91.2);
    expect(v.estimated_km).toBe(186.5);
    expect(typeof v.driver_commission).toBe('number');
  });

  it('lo que se escribe después sí llega al cuerpo que se guarda', () => {
    const { c } = montar();
    c.openRouteDialog({ id: 'r1', name: 'X', driver_commission: '0.00', helper_commission: '0.00', active: true } as never);
    c.routeForm.patchValue({ driver_commission: 129 });
    expect(c.routeForm.value.driver_commission).toBe(129);
  });

  it('editar un viático con valor en texto deja un número', () => {
    const { c } = montar();
    c.openConfigDialog({ id: 'v1', key: 'viatico_comida', category: 'viatico', value: '100.0000', active: true } as never);
    expect(c.configForm.value.value).toBe(100);
  });
});
