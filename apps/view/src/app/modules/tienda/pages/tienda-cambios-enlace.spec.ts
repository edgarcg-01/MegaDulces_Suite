import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { EtiquetasService } from '../etiquetas.service';
import { TiendaCambiosPrecioComponent } from './tienda-cambios-precio.component';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe(): void { /* jsdom */ } unobserve(): void { /* jsdom */ } disconnect(): void { /* jsdom */ } };
}

/**
 * `[ETQ-AVISOS.2]` El enlace de la campana: `?plaza=01&fecha=2026-10-08`.
 *
 * Un parámetro inventado no puede dejar la pantalla en una tabla vacía que se lee «no cambió
 * nada»: se valida con la misma forma que el backend y, si no sirve, todo sigue como siempre.
 */
const stubSvc = {
  priceChanges: () => of({ items: [], fecha: '', truncado: false, fuente_al: null, ocultos_centavo: 0, productos_del_dia: 0, tope_productos: 300, freshness: null }),
  priceChangeBranches: () => of([]),
};

function montar(query: Record<string, string>, warehouse?: string): TiendaCambiosPrecioComponent {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TiendaCambiosPrecioComponent],
    providers: [
      provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      { provide: EtiquetasService, useValue: stubSvc },
      { provide: AuthService, useValue: { user: () => ({ warehouse_code: warehouse, username: 'qa' }), token: () => null } },
      { provide: PermissionsService, useValue: { has: () => false } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
    ],
  });
  return TestBed.createComponent(TiendaCambiosPrecioComponent).componentInstance;
}

describe('Cambios de precio · enlace desde la campana', () => {
  it('⭐ quien no tiene tienda propia entra directo a la plaza y al día del aviso', () => {
    const c = montar({ plaza: '03', fecha: '2026-10-08' });
    expect(c.sucursal()).toBe('03');
    expect(c.fecha()).toBe('2026-10-08');
  });

  it('⛔ quien SÍ tiene tienda propia queda anclado a la suya: el enlace no le cambia de plaza', () => {
    const c = montar({ plaza: '03', fecha: '2026-10-08' }, '01');
    expect(c.sucursal()).toBe('01');
    expect(c.fecha()).toBe('2026-10-08');
  });

  it('sin parámetros todo sigue como siempre: ayer y sin plaza elegida', () => {
    const c = montar({});
    expect(c.fecha()).toBe(c.ayer);
    expect(c.sucursal()).toBeNull();
  });

  it('⛔ parámetros inválidos se ignoran (no dejan una tabla vacía que se lee «no cambió nada»)', () => {
    for (const q of [{ plaza: 'ABC', fecha: 'ayer' }, { plaza: '1', fecha: '2026-13-45x' }, { plaza: "01' OR 1=1", fecha: '' }]) {
      const c = montar(q);
      expect(c.sucursal()).toBeNull();
      expect(c.fecha()).toBe(c.ayer);
    }
  });

  it('un día futuro se ignora: no hay bitácora de lo que todavía no pasa', () => {
    const c = montar({ plaza: '01', fecha: '2999-01-01' });
    expect(c.fecha()).toBe(c.ayer);
  });
});
