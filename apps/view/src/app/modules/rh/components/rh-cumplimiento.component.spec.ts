import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import type { HrCumplimientoDto } from '@megadulces/contracts';

import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { RhCumplimientoComponent } from './rh-cumplimiento.component';

/** `[RH.15.x]` Cumplimiento: lo pendiente con su número. El aviso de privacidad (`[RH.15.6]`) ya no vive aquí. */
const datos = (over: Partial<HrCumplimientoDto> = {}): HrCumplimientoDto => ({
  site_code: 'cedis', hoy: '2026-11-17',
  huellasDeBajas: [{ codigo: '17', nombre: 'PRUEBA TRES', baja: '2026-11-01', dias: 16, pendiente: true },
    { codigo: '18', nombre: 'PRUEBA CUATRO', baja: '2026-11-15', dias: 2, pendiente: false }],
  conservar: [{ codigo: '17', nombre: 'PRUEBA TRES', baja: '2026-11-01', hasta: '2027-11-01' }],
  sinRegistro: [{ codigo: '16', nombre: 'PRUEBA DOS', ultima: '2026-11-02' }],
  ...over,
});

const montar = async (d: HrCumplimientoDto) => {
  await TestBed.configureTestingModule({
    imports: [RhCumplimientoComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: RhAsistenciaEstado, useValue: { sitio: signal('cedis'), nombreSitio: signal('CEDIS'), hoy: signal('2026-11-17') } }],
  }).compileComponents();
  const fix = TestBed.createComponent(RhCumplimientoComponent);
  fix.detectChanges();
  TestBed.inject(HttpTestingController).expectOne((r) => r.url.endsWith('/hr/attendance/compliance')).flush(d);
  fix.detectChanges();
  return fix;
};
const texto = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';

describe('[RH.15.x] cumplimiento de la plaza', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('dice cuántas huellas hay que quitar y quién no registra', async () => {
    const el = (await montar(datos())).nativeElement as HTMLElement;
    expect(texto(el)).toContain('1 por quitar');
    expect(texto(el)).toContain('hace 16 días · por quitar');
    expect(texto(el)).toContain('hace 2 días · en plazo');
    expect(texto(el)).toContain('última checada el 2026-11-02');
  });


  it('ya no ofrece el aviso de privacidad: se registra en Mesa de Servicio cuando Legal dé el texto', async () => {
    const el = (await montar(datos())).nativeElement as HTMLElement;
    expect(texto(el)).not.toContain('Aviso de privacidad');
    expect(texto(el)).not.toContain('Subir aviso firmado');
  });
});
