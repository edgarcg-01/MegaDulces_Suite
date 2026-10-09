import { TestBed } from '@angular/core/testing';
import type { RevisionGps } from '@megadulces/contracts';
import { RevisionGpsComponent } from './revision-gps.component';

/**
 * EMB.21 — La revisión con GPS se lee sola: qué se capturó, qué marca el GPS, qué difiere, y POR
 * QUÉ no se pudo revisar cuando no se pudo. Lo que falta sale «—», nunca un cero.
 */

const TOL = { minutos: 60, km: 0.2 };

function pintar(revision: RevisionGps | null, extra: { cargando?: boolean; error?: string | null } = {}) {
  TestBed.configureTestingModule({ imports: [RevisionGpsComponent] });
  const f = TestBed.createComponent(RevisionGpsComponent);
  f.componentRef.setInput('revision', revision);
  if (extra.cargando != null) f.componentRef.setInput('cargando', extra.cargando);
  if (extra.error !== undefined) f.componentRef.setInput('error', extra.error);
  f.detectChanges();
  const el = f.nativeElement as HTMLElement;
  const filas = Object.fromEntries([...el.querySelectorAll('tbody tr')].map((tr) => [
    tr.querySelector('th')!.textContent!.trim(),
    [...tr.querySelectorAll('td')].map((td) => td.textContent!.replace(/\s+/g, ' ').trim()),
  ]));
  return { el, filas, texto: el.textContent!.replace(/\s+/g, ' ') };
}

describe('RevisionGpsComponent', () => {
  it('lo que difiere se ve: veredicto, la tabla y cada diferencia en una frase', () => {
    const { filas, texto, el } = pintar({
      estado: 'difiere', motivo: null, tolerancias: TOL,
      capturado: { salida: '06:30', llegada: '17:30', duerme_fuera: false, km: 40, viaticos: 200 },
      gps: { salida: '08:30', llegada: '17:30', duerme_fuera: false, km: 38, km_metodo: 'trazo', puntos: 4, viaticos: 100 },
      diferencias: ['Viáticos: con el horario del GPS serían $100.00 en vez de $200.00 (cambia desayuno).'],
    });
    expect(el.querySelector('.rg-pill')!.textContent!.trim()).toBe('Difiere del GPS');
    expect(filas['Salida']).toEqual(['06:30', '08:30']);
    expect(filas['Viáticos']).toEqual(['$200.00', '$100.00']);
    expect(filas['Kilómetros'][1]).toContain('por trazo');
    expect(texto).toContain('cambia desayuno');
    expect(texto).toContain('más de 60 min');
  });

  it('lo que no se pudo revisar dice por qué y no pinta ningún dato del GPS', () => {
    const { filas, texto } = pintar({
      estado: 'no_medible', motivo: 'La unidad no tiene rastreador GPS.', tolerancias: TOL,
      capturado: { salida: '08:00', llegada: '17:00', duerme_fuera: false, km: null, viaticos: 0 },
      gps: null, diferencias: [],
    });
    expect(texto).toContain('No se pudo revisar');
    expect(texto).toContain('La unidad no tiene rastreador GPS.');
    expect(filas['Salida']).toEqual(['08:00', '—']);
    expect(filas['Kilómetros']).toEqual(['—', '—']);
    expect(texto).not.toContain('Coincide');
  });

  it('mientras carga o si falla, lo dice', () => {
    expect(pintar(null, { cargando: true }).texto).toContain('Revisando el recorrido');
    TestBed.resetTestingModule();
    expect(pintar(null, { error: 'sin conexión' }).texto).toContain('No se pudo revisar: sin conexión');
  });
});
