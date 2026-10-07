import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { LogisticaShipmentsComponent } from './logistica-shipments.component';

/**
 * EMB.12 — En la pantalla de Embarques, «Nuevo embarque» ya no abre el formulario en blanco:
 * lleva a elegir el viaje de Kepler. El formulario manual sigue vivo para lo que Kepler no emite,
 * y se abre con `?manual=1`.
 */

function montar(query: Record<string, string> = {}) {
  TestBed.configureTestingModule({
    imports: [LogisticaShipmentsComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap(query)), snapshot: { queryParamMap: convertToParamMap(query) } } },
    ],
  });
  const f = TestBed.createComponent(LogisticaShipmentsComponent);
  const http = TestBed.inject(HttpTestingController);
  f.detectChanges();
  for (let i = 0; i < 4; i++) {
    for (const r of http.match(() => true).filter((x) => !x.cancelled)) {
      const u = r.request.url;
      if (/\/shipments$/.test(u)) r.flush({ items: [], page: 1, pageSize: 50, total: 0, totalPages: 0 });
      else if (/counts/.test(u)) r.flush({ total: 0, byStatus: {} });
      else if (/erp-shipments\/trips/.test(u)) r.flush({ rows: [], page: 1, limit: 100, total: 0 });
      else if (/erp-shipments\/(today|live)/.test(u)) r.flush(/live/.test(u) ? { rows: [] } : null);
      else r.flush([]);
    }
  }
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement };
}

describe('Embarques — «Nuevo embarque» (EMB.12)', () => {
  it('el botón lleva al flujo de Kepler', () => {
    const { el } = montar();
    const a = [...el.querySelectorAll('a')].find((x) => x.textContent!.includes('Nuevo embarque')) as HTMLAnchorElement;
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toBe('/logistica/shipments/nuevo');
  });

  it('?manual=1 abre el formulario de siempre en «Propios de la app»', () => {
    const { f } = montar({ manual: '1' });
    expect(f.componentInstance.mode()).toBe('shipments');
    expect(f.componentInstance.dialogVisible).toBe(true);
  });
});
