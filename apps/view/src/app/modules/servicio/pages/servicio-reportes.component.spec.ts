import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { SdReportResponse, SdSlaCompliance } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioReportesComponent } from './servicio-reportes.component';

/**
 * `[MS.3.15]` El tiempo registrado en Reportes. Lo que se defiende: «—» cuando NADIE registró (nunca «0 min»),
 * junto con la cobertura («N de M»), y nada desglosado por persona.
 */
const C: SdSlaCompliance = { cumplidos: 0, incumplidos: 0, en_plazo: 0, sin_plazo: 0, cumplimiento_pct: null };
const T = { n: 0, p50: null, p90: null };

const REPORTE: SdReportResponse = {
  periodo: { desde: '2026-10-01', hasta: '2026-10-05' },
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

describe('[MS.3.15] ServicioReportesComponent — tiempo registrado', () => {
  let fix: ComponentFixture<ServicioReportesComponent>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const filasCategoria = () => Array.from((fix.nativeElement as HTMLElement).querySelectorAll('section[aria-labelledby="h-cat"] tbody tr'));

  async function render(r: SdReportResponse = REPORTE) {
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

  it('⭐ el total y cada categoría muestran su tiempo registrado, con cuántas solicitudes lo tienen', async () => {
    await render();
    expect(texto()).toContain('Tiempo registrado');
    expect(filasCategoria()[0].textContent).toContain('2 h 15 min');
    expect(filasCategoria()[0].textContent).toContain('3 de 3');
  });

  it('⛔ NEGATIVA — una categoría donde nadie registró sale «—», NUNCA «0 min»', async () => {
    await render();
    expect(filasCategoria()[1].textContent).toContain('—');
    expect(filasCategoria()[1].textContent).toContain('0 de 2');
    expect(filasCategoria()[1].textContent).not.toContain('0 min');
  });

  it('⛔ NEGATIVA — si nadie registró nada en todo el periodo, el total también es «—»', async () => {
    await render({ ...REPORTE, totales: { ...REPORTE.totales, minutos_trabajados: null, con_tiempo: 0 } });
    const kpi = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('.sr-kpi')).find((k) => k.textContent?.includes('Tiempo registrado'));
    expect(kpi?.querySelector('b')?.textContent?.trim()).toBe('—');
  });

  it('dice que el tiempo es sólo lo registrado a mano y que no se desglosa por persona', async () => {
    await render();
    expect(texto()).toContain('nadie lo registró');
    expect(texto()).toContain('No se desglosa por persona');
  });
});
