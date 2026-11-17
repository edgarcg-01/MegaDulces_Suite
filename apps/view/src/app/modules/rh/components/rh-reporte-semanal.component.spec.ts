import { TestBed } from '@angular/core/testing';
import type { HrPersonaAsistencia } from '@megadulces/contracts';

import { persona } from '../../../../testing/rh.fixture';
import { columnasDelRango, porDepartamento } from '../reporte-formato';
import { RhReporteSemanalComponent } from './rh-reporte-semanal.component';

/**
 * `[RH.13.8]` — La columna Horario de la tabla semanal.
 *
 * Con varios horarios y sábado, el horario iba en UN renglón sin cortes en una columna con ancho máximo: el texto se
 * salía 208 px y quedaba encima de las checadas del jueves y el viernes (medido en Chrome con el CSS de la tabla). Lo
 * que se prueba aquí es lo que el CSS necesita para que no pase: un renglón por turno, cada uno en su propio bloque.
 */
const HOY = '2026-11-18';

const montar = (personas: HrPersonaAsistencia[]) => {
  TestBed.configureTestingModule({ imports: [RhReporteSemanalComponent] });
  const fix = TestBed.createComponent(RhReporteSemanalComponent);
  fix.componentRef.setInput('grupos', porDepartamento(personas, personas));
  fix.componentRef.setInput('todas', personas);
  fix.componentRef.setInput('columnas', columnasDelRango('2026-11-12', '2026-11-18', HOY));
  fix.componentRef.setInput('irregularidades', new Map());
  fix.componentRef.setInput('hoy', HOY);
  fix.detectChanges();
  return fix.nativeElement as HTMLElement;
};

const renglones = (el: HTMLElement) =>
  [...el.querySelectorAll('tr.rs-fila td.rs-hor')].map((td) => [...td.querySelectorAll('.rs-hor-r')].map((s) => s.textContent?.trim()));

describe('[RH.13.8] la columna Horario de la tabla semanal', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('varios horarios y sábado: un renglón por turno y el sábado aparte, no un solo renglón que se sale', () => {
    const el = montar([persona({ horarioAsignado: {
      entrada: '10:00', salida: '19:00', comidaMin: 60, sabado: true, sabadoEntrada: '07:30', sabadoSalida: '16:00', asignadoPor: null, actualizadoEn: null,
      horarios: [{ entrada: '10:00', salida: '19:00', comidaMin: 60 }, { entrada: '07:30', salida: '16:00', comidaMin: 60 }, { entrada: '12:30', salida: '21:00', comidaMin: 60 }],
    } })]);
    expect(renglones(el)).toEqual([['10:00–19:00', '07:30–16:00', '12:30–21:00', 'sáb 07:30–16:00']]);
  });

  it('un horario deducido sigue igual: la hora y «deducido» aparte', () => {
    const el = montar([persona({ horario: '10:00', turnos: ['10:00'] })]);
    expect(renglones(el)).toEqual([['10:00 am']]);
    expect(el.querySelector('tr.rs-fila td.rs-hor small')?.textContent?.trim()).toBe('deducido');
  });
});
