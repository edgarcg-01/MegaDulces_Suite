import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import type { HrExpedienteFirmasDto } from '@megadulces/contracts';

import { RhFirmasService } from '../rh-firmas.service';
import { RhExpedienteFirmasComponent } from './rh-expediente-firmas.component';

/**
 * `[RH.15.11]` El expediente de firmas de una persona: la semana más nueva primero, cómo firmó, y lo anulado o de
 * otra versión dicho con palabras. Vacío ≠ error.
 */
const expediente: HrExpedienteFirmasDto = {
  site_code: 'cedis', person_code: '15', firmas: [
    { site_code: 'cedis', period_start: '2026-11-05', period_end: '2026-11-11', department: 'ALMACEN', via: 'celular',
      firmado_at: '2026-11-17T14:03:00', id: 'f2', vigente: true, anulada: null },
    { site_code: 'cedis', period_start: '2026-11-05', period_end: '2026-11-11', department: 'ALMACEN', via: 'celular',
      firmado_at: '2026-11-16T10:00:00', id: 'f1', vigente: true, anulada: { at: '2026-11-17T09:00:00', motivo: 'firmó otra persona' } },
    { site_code: 'cedis', period_start: '2026-10-29', period_end: '2026-11-04', department: 'ALMACEN', via: 'papel',
      firmado_at: '2026-11-06T12:00:00', id: 'h1', vigente: false, anulada: null },
  ],
};

const montar = async (resp: () => ReturnType<RhFirmasService['expediente']>) => {
  await TestBed.configureTestingModule({
    imports: [RhExpedienteFirmasComponent],
    providers: [{ provide: RhFirmasService, useValue: { expediente: resp, comprobante: () => of(null), archivo: () => of({ url: 'x' }) } }],
  }).compileComponents();
  const fix = TestBed.createComponent(RhExpedienteFirmasComponent);
  fix.componentRef.setInput('site', 'cedis');
  fix.componentRef.setInput('persona', '15');
  fix.detectChanges();
  await fix.whenStable();
  fix.detectChanges();
  return fix.nativeElement as HTMLElement;
};
const texto = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';

describe('[RH.15.11] expediente de firmas de una persona', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('cada semana firmada con cómo y cuándo; anulada y de otra versión dichas; comprobante u hoja según cómo firmó', async () => {
    const el = await montar(() => of(expediente));
    const filas = [...el.querySelectorAll('.ef-lista li')].map((li) => texto(li as HTMLElement));
    expect(filas).toHaveLength(3);
    expect(filas[0]).toContain('Semana del 05/11/26 al 11/11/26');
    expect(filas[0]).toContain('En su celular · 17/11/26 14:03 · ALMACEN');
    expect(filas[0]).toContain('Comprobante');
    expect(filas[1]).toContain('Anulada: firmó otra persona');
    expect(filas[2]).toContain('En papel');
    expect(filas[2]).toContain('De otra versión');
    expect(filas[2]).toContain('Ver hoja');
  });

  it('sin firmas lo dice; un error de lectura NO se pinta como «no ha firmado»', async () => {
    const vacio = await montar(() => of({ ...expediente, firmas: [] }));
    expect(texto(vacio)).toContain('Todavía no ha firmado ninguna semana');
    TestBed.resetTestingModule();
    const roto = await montar(() => throwError(() => new HttpErrorResponse({ status: 500, error: { message: 'falló la base' } })));
    expect(texto(roto)).not.toContain('Todavía no ha firmado');
    expect(texto(roto)).toContain('falló la base');
  });
});
