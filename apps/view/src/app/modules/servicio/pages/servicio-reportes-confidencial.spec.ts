import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { SdReportResponse, SdSlaCompliance } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioReportesComponent } from './servicio-reportes.component';

/**
 * `[MSH.3]` El reporte de un área CONFIDENCIAL. Lo que se defiende:
 *  · ⛔ con el reporte SUPRIMIDO (menos casos que el mínimo) NO se pinta ninguna cifra: ni un «0», ni «0 %», ni las tablas;
 *  · se dice por qué y cuál es el mínimo, para que no parezca un fallo;
 *  · con el mínimo cubierto el reporte sale normal, y sin desglose por prioridad cuando el área no la usa;
 *  · un reporte normal queda igual (control).
 */
const C: SdSlaCompliance = { cumplidos: 0, incumplidos: 0, en_plazo: 0, sin_plazo: 0, cumplimiento_pct: null };
const T = { n: 0, p50: null, p90: null };

const REPORTE: SdReportResponse = {
  periodo: { desde: '2026-10-01', hasta: '2026-10-05' },
  colas: [{ id: 'q-ti', code: 'ti', name: 'TI (Sistemas)', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true }],
  cola_id: null,
  medido_at: '2026-10-05T18:00:00.000Z',
  truncado: false,
  totales: { creados: 5, resueltos: 3, abiertos: 2, cancelados: 0, reabiertos: 0, reabiertos_pct: 0, minutos_trabajados: 135, con_tiempo: 3 },
  primera_respuesta: C,
  resolucion: C,
  por_prioridad: [],
  por_categoria: [
    { category_id: 'a', name: 'Redes', creados: 3, resueltos: 2, resolucion_incumplidos: 0, reabiertos: 0, t_resolucion: T, minutos_trabajados: 135, con_tiempo: 3 },
    { category_id: 'b', name: 'Respaldos', creados: 2, resueltos: 1, resolucion_incumplidos: 0, reabiertos: 0, t_resolucion: T, minutos_trabajados: null, con_tiempo: 0 },
  ],
  por_sucursal: [],
  recurrentes: [],
  no_medido: ['El tiempo trabajado es sólo el que se registra a mano.'],
};

describe('[MSH.3] ServicioReportesComponent — área confidencial', () => {
  let fix: ComponentFixture<ServicioReportesComponent>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const el = () => fix.nativeElement as HTMLElement;

  async function render(r: SdReportResponse) {
    await TestBed.configureTestingModule({
      imports: [ServicioReportesComponent],
      providers: [{ provide: ServiceDeskService, useValue: { report: vi.fn(() => of(r)) } }],
    }).compileComponents();
    fix = TestBed.createComponent(ServicioReportesComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  const SUPRIMIDO: SdReportResponse = {
    ...REPORTE,
    totales: { creados: 0, resueltos: 0, abiertos: 0, cancelados: 0, reabiertos: 0, reabiertos_pct: null, minutos_trabajados: null, con_tiempo: 0 },
    por_categoria: [], no_medido: ['Esta área es confidencial: con menos de 5 casos no se muestra ninguna cifra.'],
    suprimido: { minimo: 5, motivo: 'menos de 5 casos en el periodo' },
  };

  it('⛔ NEGATIVA — suprimido: no hay KPIs, ni tablas, ni ceros; sí el motivo y el mínimo', async () => {
    await render(SUPRIMIDO);
    expect(texto()).toContain('Reporte no disponible');
    expect(texto()).toContain('menos de 5 solicitudes');
    expect(el().querySelector('.sr-kpis')).toBeNull();
    expect(el().querySelector('table')).toBeNull();
    expect(texto()).not.toContain('Creadas');
    expect(texto()).not.toContain('0 %');
  });

  it('⭐ con el mínimo cubierto el reporte sale normal; sin prioridades, sin la tabla «Por prioridad»', async () => {
    await render({ ...REPORTE, por_prioridad: [] });
    expect(el().querySelector('.sr-kpis')).not.toBeNull();
    expect(texto()).not.toContain('Reporte no disponible');
    expect(el().querySelector('section[aria-labelledby="h-pri"]')).toBeNull();
    expect(el().querySelector('section[aria-labelledby="h-cat"]')).not.toBeNull();
  });
});
