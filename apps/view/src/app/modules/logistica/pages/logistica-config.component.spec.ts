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
    // getRawValue: con la ruta tarifada y sin autorizador los controles quedan deshabilitados.
    const v = c.routeForm.getRawValue();
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
    expect(c.configForm.getRawValue().value).toBe(100);
  });
});

describe('LogisticaConfigComponent — tarifas fijas (EMB.28.1)', () => {
  const RUTA = { id: 'r1', name: 'CANINDO ZAMORA', driver_commission: '180.00', helper_commission: '120.00', active: true };
  const VIATICO = { id: 'v1', key: 'viatico_comida', category: 'viatico', value: '100.0000', active: true };

  function conPermisos(autorizador: boolean) {
    const { c } = montar();
    vi.spyOn(c, 'puedeAutorizar').mockReturnValue(autorizador);
    return c;
  }

  it('sin ser autorizador, una ruta fijada abre con comisiones y nombre bloqueados y no los manda', () => {
    const c = conPermisos(false);
    c.openRouteDialog(RUTA as never);
    expect(c.rutaBloqueada()).toBe(true);
    expect(c.routeForm.get('driver_commission')?.disabled).toBe(true);
    expect(c.routeForm.get('name')?.disabled).toBe(true);
    expect(c.routeForm.get('notes')?.enabled).toBe(true);
    expect('driver_commission' in c.routeForm.value).toBe(false);
  });

  it('el autorizador la edita completa', () => {
    const c = conPermisos(true);
    c.openRouteDialog(RUTA as never);
    expect(c.rutaBloqueada()).toBe(false);
    expect(c.routeForm.get('driver_commission')?.enabled).toBe(true);
  });

  it('una ruta en cero se captura sin autorizador (primera vez)', () => {
    const c = conPermisos(false);
    c.openRouteDialog({ ...RUTA, driver_commission: '0.00', helper_commission: '0.00' } as never);
    expect(c.rutaBloqueada()).toBe(false);
    expect(c.routeForm.get('driver_commission')?.enabled).toBe(true);
  });

  it('abrir una ruta fijada y luego una nueva no deja los campos bloqueados', () => {
    const c = conPermisos(false);
    c.openRouteDialog(RUTA as never);
    c.openRouteDialog();
    expect(c.routeForm.get('driver_commission')?.enabled).toBe(true);
  });

  it('un viático fijado bloquea valor, clave y categoría; un costo por km no', () => {
    const c = conPermisos(false);
    c.openConfigDialog(VIATICO as never);
    expect(c.configBloqueada()).toBe(true);
    expect(c.configForm.get('value')?.disabled).toBe(true);
    c.openConfigDialog({ id: 'k1', key: 'costo_km_f350', category: 'costo_km', value: '4.05', active: true } as never);
    expect(c.configBloqueada()).toBe(false);
    expect(c.configForm.get('value')?.enabled).toBe(true);
  });
});
