import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrAsistenciaResponse } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { RhService } from '../rh.service';
import { SITIOS, asistencia, permisos, persona } from '../../../../testing/rh.fixture';
import { RhAsistenciaComponent } from './rh-asistencia.component';

/**
 * `[RH.1.7]` Asistencia. Lo que se defiende: se pide la semana de nómina (jueves a miércoles) recortada a hoy,
 * sólo se ofrecen sitios activos, lo que no es de fiar se marca «No usar», y cada botón aparece sólo con su permiso.
 */
describe('[RH.1.7] RhAsistenciaComponent', () => {
  let fix: ComponentFixture<RhAsistenciaComponent>;
  let api: { sitios: ReturnType<typeof vi.fn>; asistencia: ReturnType<typeof vi.fn>; asignarHorario: ReturnType<typeof vi.fn>; quitarHorario: ReturnType<typeof vi.fn> };
  const navigate = vi.fn();
  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';
  const filas = () => Array.from(el().querySelectorAll('.ra-table tbody tr')) as HTMLElement[];
  const boton = (label: string) => Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.trim() === label);

  async function render(d: HrAsistenciaResponse, ...claves: string[]) {
    api = {
      sitios: vi.fn(() => of(SITIOS)),
      asistencia: vi.fn(() => of(d)),
      asignarHorario: vi.fn(() => of({ ok: true, guardados: 1 })),
      quitarHorario: vi.fn(() => of({ ok: true, quitados: 1 })),
    };
    await TestBed.configureTestingModule({
      imports: [RhAsistenciaComponent],
      providers: [
        { provide: RhService, useValue: api },
        { provide: PermissionsService, useValue: permisos(...claves) },
        { provide: Router, useValue: { navigate } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(RhAsistenciaComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Miércoles 7-oct-2026, mediodía en México: la semana de nómina abrió el jueves 1.
    vi.setSystemTime(new Date('2026-10-07T18:00:00Z'));
    navigate.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); TestBed.resetTestingModule(); });

  it('⭐ pide la semana de nómina del primer sitio ACTIVO, de jueves a hoy', async () => {
    await render(asistencia([persona()]), Permission.HR_ATTENDANCE_VER);
    expect(api.asistencia).toHaveBeenCalledWith({ site_code: 'PH', date_from: '2026-10-01', date_to: '2026-10-07', only_promoters: false });
    expect(texto()).toContain('jue 1 oct – mié 7 oct');
  });

  it('⛔ NEGATIVA — un sitio dado de baja no se ofrece', async () => {
    await render(asistencia([persona()]), Permission.HR_ATTENDANCE_VER);
    expect(fix.componentInstance.sitios().map((s) => s.code)).toEqual(['PH', 'CEDIS']);
  });

  it('⛔ NEGATIVA — no deja avanzar a una semana que no ha empezado', async () => {
    await render(asistencia([persona()]), Permission.HR_ATTENDANCE_VER);
    expect(fix.componentInstance.esSemanaActual()).toBe(true);
    fix.componentInstance.moverSemana(-7);
    expect(fix.componentInstance.esSemanaActual()).toBe(false);
    // La semana pasada se pide completa: ya terminó.
    expect(api.asistencia).toHaveBeenLastCalledWith(expect.objectContaining({ date_from: '2026-09-24', date_to: '2026-09-30' }));
  });

  it('⭐ lo que no es de fiar se marca «No usar»; lo que tiene duda, «Revisar»', async () => {
    await render(asistencia([
      persona({ codigo: '1', usable: false, marcas: [{ codigo: 'sin_patron', gravedad: 'alta', detalle: 'x' }] }),
      persona({ codigo: '2', marcas: [{ codigo: 'rotativo', gravedad: 'media', detalle: 'y' }] }),
      persona({ codigo: '3' }),
    ]), Permission.HR_ATTENDANCE_VER);
    expect(filas().map((f) => f.querySelector('.pill')?.textContent?.trim())).toEqual(['No usar', 'Revisar', 'Bien']);
  });

  it('⛔ NEGATIVA — cero faltas o cero retardo se dice «—», no «0»', async () => {
    await render(asistencia([persona({ retardoRealMin: 0, faltas: 0 })]), Permission.HR_ATTENDANCE_VER);
    const celdas = Array.from(filas()[0].querySelectorAll('td')).map((c) => c.textContent?.trim());
    expect(celdas[2]).toBe('—');
    expect(celdas[3]).toBe('—');
  });

  it('la búsqueda filtra por nombre o número', async () => {
    await render(asistencia([persona({ codigo: '11', nombreCompleto: 'Alfa Prueba' }), persona({ codigo: '22', nombreCompleto: 'Beta Prueba' })]), Permission.HR_ATTENDANCE_VER);
    fix.componentInstance.buscar.set('beta');
    fix.detectChanges();
    expect(filas().length).toBe(1);
    fix.componentInstance.buscar.set('11');
    fix.detectChanges();
    expect(filas()[0].textContent).toContain('Alfa Prueba');
  });

  it('⛔ NEGATIVA — con sólo VER, la ficha no ofrece capturar ni tocar el horario', async () => {
    await render(asistencia([persona()]), Permission.HR_ATTENDANCE_VER);
    filas()[0].click();
    fix.detectChanges();
    expect(texto()).toContain('Prueba Uno Ejemplo');
    expect(boton('Capturar incidencia')).toBeUndefined();
    expect(boton('Asignar horario')).toBeUndefined();
  });

  it('con CAPTURAR, «Capturar incidencia» lleva a Incidencias con la persona y la semana puestas', async () => {
    await render(asistencia([persona({ codigo: '101' })]), Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR);
    filas()[0].click();
    fix.detectChanges();
    boton('Capturar incidencia')!.click();
    expect(navigate).toHaveBeenCalledWith(['/rh/incidencias'], { queryParams: { nueva: 1, site: 'PH', persona: '101', desde: '2026-10-01' } });
  });

  it('con GESTIONAR, asignar horario manda el horario completo y sin sábado no manda horas de sábado', async () => {
    await render(asistencia([persona({ codigo: '101' })]), Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR);
    const c = fix.componentInstance;
    c.abrir(c.visibles()[0]);
    c.abrirHorario(c.visibles()[0]);
    c.formHorario.set({ entrada: '09:00', salida: '18:30', comida: 45, sabado: false, sabadoEntrada: '09:00', sabadoSalida: '14:00' });
    c.guardarHorario(c.visibles()[0]);
    expect(api.asignarHorario).toHaveBeenCalledWith({
      site_code: 'PH', person_codes: ['101'], starts_at: '09:00', ends_at: '18:30', lunch_minutes: 45,
      works_saturday: false, saturday_starts_at: undefined, saturday_ends_at: undefined,
    });
  });
});
