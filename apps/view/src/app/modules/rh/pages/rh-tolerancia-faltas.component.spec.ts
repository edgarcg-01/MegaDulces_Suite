import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrAsistenciaResponse } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { RhService } from '../rh.service';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { SITIOS, asistencia, authCon, dia, permisos, persona } from '../../../../testing/rh.fixture';
import { RhToleranciaComponent } from './rh-tolerancia.component';
import { RhFaltasComponent } from './rh-faltas.component';

/**
 * `[RH.1.7c]` Las pestañas Tolerancia y Faltas. Lo que se defiende: Tolerancia lista del que más se pasó al que menos
 * y aparta a quien tiene el número bloqueado; en una sucursal sin hora límite no mide nada; Faltas no cuenta el día de
 * hoy; y tocar a alguien lleva a su ficha en Checadas.
 */
describe('[RH.1.7c] Tolerancia y Faltas', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let navigate: ReturnType<typeof vi.spyOn>;

  async function render<T>(comp: new (...a: never[]) => T, datos: HrAsistenciaResponse, ...claves: string[]): Promise<ComponentFixture<T>> {
    api = {
      sitios: vi.fn(() => of(SITIOS)), asistencia: vi.fn(() => of(datos)), estadoRelojes: vi.fn(() => of([])),
      incidencias: vi.fn(() => of([])), estadoCierre: vi.fn(() => of([])), directorio: vi.fn(() => of([])),
    };
    await TestBed.configureTestingModule({
      imports: [comp],
      providers: [
        provideRouter([]), { provide: RhService, useValue: api },
        { provide: PermissionsService, useValue: permisos(...claves) }, { provide: AuthService, useValue: authCon(...claves) },
      ],
    }).compileComponents();
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fix = TestBed.createComponent(comp);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    return fix;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T18:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); TestBed.resetTestingModule(); });

  it('⭐ Tolerancia: del que más se pasó al que menos; el número bloqueado va aparte', async () => {
    const fix = await render(RhToleranciaComponent, asistencia([
      persona({ codigo: '1', nombreCompleto: 'Prueba Uno', retardoRealMin: 8, atrasoBrutoMin: 23 }),
      persona({ codigo: '2', nombreCompleto: 'Prueba Dos', retardoRealMin: 28, atrasoBrutoMin: 43 }),
      persona({ codigo: '3', nombreCompleto: 'Prueba Tres', retardoRealMin: 5, usable: false }),
      persona({ codigo: '4', nombreCompleto: 'Prueba Cuatro', retardoRealMin: 0 }),
    ]), Permission.HR_ATTENDANCE_VER);
    const el = fix.nativeElement as HTMLElement;
    const tablas = Array.from(el.querySelectorAll('table.rt-tabla'));
    expect(Array.from(tablas[0].querySelectorAll('tbody tr')).map((r) => r.querySelector('td')?.textContent)).toEqual(['2', '1']);
    expect(el.textContent).toContain('Por confirmar (1)');
    expect(el.textContent).not.toContain('Prueba Cuatro');
    (tablas[0].querySelector('tbody tr') as HTMLElement).click();
    expect(TestBed.inject(RhAsistenciaEstado).fichaPendiente()).toBe('2');
    expect(navigate).toHaveBeenCalledWith(['/rh/asistencia']);
  });

  it('⛔ Tolerancia en una sucursal sin hora límite: lo dice y no mide', async () => {
    const d = { ...asistencia([persona({ retardoRealMin: 9 })]), mideRetardo: false };
    const fix = await render(RhToleranciaComponent, d, Permission.HR_ATTENDANCE_VER);
    const el = fix.nativeElement as HTMLElement;
    expect(el.textContent).toContain('no tiene hora límite de entrada');
    expect(el.querySelector('table.rt-tabla')).toBeNull();
  });

  it('⭐ Faltas: un renglón por día faltado, sin el de hoy, con «Capturar incidencia» si tiene permiso', async () => {
    const p = persona({
      codigo: '118', nombreCompleto: 'Prueba Dos',
      semanas: [{ ...persona().semanas[0], dias: [dia({ fecha: '2026-10-06', estado: 'falta' }), dia({ fecha: '2026-10-07', estado: 'falta' })] }],
    });
    const fix = await render(RhFaltasComponent, asistencia([p]), Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR);
    const el = fix.nativeElement as HTMLElement;
    const filas = Array.from(el.querySelectorAll('table.rf-tabla tbody tr'));
    expect(filas.length).toBe(1);
    expect(filas[0].textContent).toContain('martes 6');
    fix.componentInstance.capturar(p, '2026-10-06');
    expect(navigate).toHaveBeenCalledWith(['/rh/incidencias'], { queryParams: { nueva: 1, site: 'PH', persona: '118', desde: '2026-10-06' } });
  });

  it('⛔ Faltas sin permiso de capturar: no hay botón', async () => {
    const p = persona({ semanas: [{ ...persona().semanas[0], dias: [dia({ fecha: '2026-10-06', estado: 'falta' })] }] });
    const fix = await render(RhFaltasComponent, asistencia([p]), Permission.HR_ATTENDANCE_VER);
    expect((fix.nativeElement as HTMLElement).querySelector('.rf-acc p-button')).toBeNull();
  });
});
