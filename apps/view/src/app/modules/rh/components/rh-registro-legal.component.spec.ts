import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';

import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { RhRegistroLegalComponent } from './rh-registro-legal.component';

/** `[RH.15.9]` El registro para la autoridad: el último año por defecto, el tope del servidor y lo que se pide. */
const montar = async () => {
  await TestBed.configureTestingModule({
    imports: [RhRegistroLegalComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: RhAsistenciaEstado, useValue: { sitio: signal('cedis') } }],
  }).compileComponents();
  const fix = TestBed.createComponent(RhRegistroLegalComponent);
  fix.componentRef.setInput('codigo', '15');
  fix.componentRef.setInput('hoy', '2026-11-17');
  fix.detectChanges();
  await fix.whenStable();
  return fix;
};

describe('[RH.15.9] registro para la autoridad', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('por defecto pide el último año hasta hoy', async () => {
    const cmp = (await montar()).componentInstance;
    expect([cmp.desde(), cmp.hasta(), cmp.falta()]).toEqual(['2025-11-17', '2026-11-17', null]);
  });

  it('más de 400 días o fechas al revés: no deja bajar y dice por qué', async () => {
    const cmp = (await montar()).componentInstance;
    cmp.desde.set('2025-01-01');
    expect(cmp.falta()).toContain('Más de 400 días');
    cmp.desde.set('2026-12-01');
    expect(cmp.falta()).toContain('anterior a la inicial');
  });

  it('pide la persona, la plaza y el periodo, una sola vez aunque se apriete dos veces', async () => {
    const cmp = (await montar()).componentInstance;
    const http = TestBed.inject(HttpTestingController);
    cmp.bajar();
    cmp.bajar();
    const reqs = http.match((r) => r.url.endsWith('/hr/attendance/registro'));
    expect(reqs.length).toBe(1);
    expect(reqs[0].request.params.toString()).toBe('site_code=cedis&person_code=15&date_from=2025-11-17&date_to=2026-11-17');
  });
});
