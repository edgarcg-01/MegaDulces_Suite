import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';
import { RhService } from './rh.service';
import { RhAsistenciaEstado } from './rh-asistencia.estado';
import { SITIOS, asistencia, permisos, persona } from '../../../testing/rh.fixture';

/**
 * `[RH.1.7c]` Lo que comparten las pestañas. Lo que se defiende: el periodo es la semana de nómina recortada a hoy,
 * cambiar de pestaña NO vuelve a pedir el cálculo, y los atajos son los de Mega Talento (Hoy, Esta semana, Semana
 * pasada) sin dejar avanzar a una semana que no ha empezado.
 */
describe('[RH.1.7c] RhAsistenciaEstado', () => {
  let est: RhAsistenciaEstado;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  function crear(...claves: string[]) {
    api = {
      sitios: vi.fn(() => of(SITIOS)),
      asistencia: vi.fn(() => of(asistencia([persona()]))),
      estadoRelojes: vi.fn(() => of([])),
      incidencias: vi.fn(() => of([{ id: '1' }, { id: '2' }])),
      estadoCierre: vi.fn(() => of([])),
      directorio: vi.fn(() => of([])),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: RhService, useValue: api }, { provide: PermissionsService, useValue: permisos(...claves) }],
    });
    est = TestBed.inject(RhAsistenciaEstado);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Miércoles 7-oct-2026: la semana de nómina abrió el jueves 1.
    vi.setSystemTime(new Date('2026-10-07T18:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); TestBed.resetTestingModule(); });

  it('arranca en el primer sitio ACTIVO con la semana de jueves a hoy', () => {
    crear(Permission.HR_ATTENDANCE_VER);
    est.iniciar();
    expect(est.sitio()).toBe('PH');
    expect(api['asistencia']).toHaveBeenCalledWith({ site_code: 'PH', date_from: '2026-10-01', date_to: '2026-10-07', only_promoters: false });
    expect(est.atajo()).toBe('esta');
  });

  it('⭐ cambiar de pestaña no vuelve a pedir el cálculo (misma plaza, mismo periodo)', () => {
    crear(Permission.HR_ATTENDANCE_VER);
    est.iniciar();
    est.iniciar();
    est.asegurar();
    expect(api['asistencia']).toHaveBeenCalledTimes(1);
    est.asegurar(true);
    expect(api['asistencia']).toHaveBeenCalledTimes(2);
  });

  it('atajos: hoy, semana pasada; y ⛔ no avanza a una semana que no ha empezado', () => {
    crear(Permission.HR_ATTENDANCE_VER);
    est.iniciar();
    est.irA('hoy');
    expect(est.rango()).toEqual({ desde: '2026-10-07', hasta: '2026-10-07' });
    est.irA('pasada');
    expect(est.rango()).toEqual({ desde: '2026-09-24', hasta: '2026-09-30' });
    expect(est.atajo()).toBe('pasada');
    est.moverSemana(7);
    est.moverSemana(7);
    expect(est.jueves()).toBe('2026-10-01');
  });

  it('cambiar de plaza limpia los filtros', () => {
    crear(Permission.HR_ATTENDANCE_VER);
    est.iniciar();
    est.departamentos.set(['SISTEMAS']);
    est.unica.set('101');
    est.buscar.set('ana');
    est.setSitio('CEDIS');
    expect([est.departamentos(), est.unica(), est.buscar()]).toEqual([[], null, '']);
    expect(api['asistencia']).toHaveBeenLastCalledWith(expect.objectContaining({ site_code: 'CEDIS' }));
  });

  it('el contador de Incidencias sale de las capturadas de la semana', () => {
    crear(Permission.HR_ATTENDANCE_VER);
    est.iniciar();
    expect(api['incidencias']).toHaveBeenCalledWith({ site_code: 'PH', date_from: '2026-10-01', date_to: '2026-10-07', statuses: 'capturada' });
    expect(est.pendientes()).toBe(2);
  });

  it('⛔ sin permiso para ver incidencias no se pide nada ni se pinta un cero', () => {
    crear(Permission.HR_DEVICES_GESTIONAR);
    est.iniciar();
    expect(api['incidencias']).not.toHaveBeenCalled();
    expect(est.pendientes()).toBeNull();
  });

  it('elegir a alguien de otra plaza: va a su plaza y deja su ficha pendiente', () => {
    crear(Permission.HR_ATTENDANCE_VER);
    est.iniciar();
    est.irAPersona({ site_code: 'CEDIS', site_name: 'CEDIS', codigo: '77', nombre: 'Prueba', departamento: null, ligado: true, promotora: false });
    expect([est.sitio(), est.fichaPendiente()]).toEqual(['CEDIS', '77']);
    expect(api['asistencia']).toHaveBeenLastCalledWith(expect.objectContaining({ site_code: 'CEDIS' }));
  });

  it('⛔ en una sucursal sin hora límite, la pestaña Tolerancia no lleva número', () => {
    crear(Permission.HR_ATTENDANCE_VER);
    api['asistencia'].mockReturnValue(of({ ...asistencia([persona({ retardoRealMin: 9 })]), mideRetardo: false }));
    est.iniciar();
    expect(est.nRebasados()).toBeNull();
    est.datos.set(asistencia([persona({ retardoRealMin: 9 })]));
    expect(est.nRebasados()).toBe(1);
  });

  it('el directorio se baja una sola vez', () => {
    crear(Permission.HR_ATTENDANCE_VER);
    est.cargarDirectorio();
    est.cargarDirectorio();
    expect(api['directorio']).toHaveBeenCalledTimes(1);
  });
});
