import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrCierreDto, HrIncidenciaDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { RhService } from '../rh.service';
import { SITIOS, asistencia, authCon, incidencia, permisos } from '../../../../testing/rh.fixture';
import { RhIncidenciasComponent } from './rh-incidencias.component';

/**
 * `[RH.1.7]` Incidencias y cierre de semana. El servidor decide el flujo; la pantalla sólo ofrece los botones que
 * pueden servir. Lo que se defiende: nadie ve un botón que de seguro rebota (calificar sin permiso, auditar algo
 * que no está cerrado), no se cierra una semana que no ha terminado, y la captura manda exactamente lo que pide el tipo.
 */
const CIERRE: HrCierreDto = {
  id: 'c-1', site_code: 'PH', period_start: '2026-09-24', period_end: '2026-09-30', closed_by: 'u-1', closed_by_name: 'Cierre Prueba',
  closed_at: '2026-10-01T15:00:00.000Z', summary: { personas: 10, usables: 9, faltas: 2, retardoRealMin: 30, horasTrabajadas: 400, incidencias: 3 },
  reopened_by: null, reopened_by_name: null, reopened_at: null, reopen_reason: null, vigente: true,
};

describe('[RH.1.7] RhIncidenciasComponent', () => {
  let fix: ComponentFixture<RhIncidenciasComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';
  const boton = (label: string) => Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.trim() === label);

  async function render(o: { lista?: HrIncidenciaDto[]; cierres?: HrCierreDto[]; query?: Record<string, string>; claves: string[] }) {
    api = {
      sitios: vi.fn(() => of(SITIOS)),
      tiposIncidencia: vi.fn(() => of([{ tipo: 'vacaciones', etiqueta: 'Vacaciones', codigo: 'VAC', excusaFalta: true }])),
      incidencias: vi.fn(() => of(o.lista ?? [])),
      cierres: vi.fn(() => of(o.cierres ?? [])),
      bitacora: vi.fn(() => of([])),
      capturar: vi.fn(() => of(incidencia())),
      paso: vi.fn(() => of(incidencia({ status: 'calificada' }))),
      cerrarSemana: vi.fn(() => of(CIERRE)),
      reabrirSemana: vi.fn(() => of(CIERRE)),
      // `[RH.1.7c]` Lo que pide el marco de las pestañas (los contadores y la franja).
      asistencia: vi.fn(() => of(asistencia([]))),
      estadoRelojes: vi.fn(() => of([])),
      estadoCierre: vi.fn(() => of([])),
      directorio: vi.fn(() => of([])),
    };
    await TestBed.configureTestingModule({
      imports: [RhIncidenciasComponent],
      providers: [
        provideRouter([]),
        { provide: RhService, useValue: api },
        { provide: PermissionsService, useValue: permisos(...o.claves) },
        { provide: AuthService, useValue: authCon(...o.claves) },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(o.query ?? {}) } } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(RhIncidenciasComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T18:00:00Z')); // miércoles 7-oct, MX
  });
  afterEach(() => { vi.useRealTimers(); TestBed.resetTestingModule(); });

  it('⭐ por defecto: la semana en curso, lo que falta calificar', async () => {
    await render({ claves: [Permission.HR_INCIDENTS_CAPTURAR] });
    expect(api['incidencias']).toHaveBeenCalledWith({ site_code: 'PH', date_from: '2026-10-01', date_to: '2026-10-07', statuses: 'capturada' });
  });

  it('⭐ llegando desde Asistencia abre la captura con la persona, el sitio y la semana puestos', async () => {
    await render({ claves: [Permission.HR_INCIDENTS_CAPTURAR], query: { nueva: '1', site: 'CEDIS', persona: '205', desde: '2026-09-25' } });
    const c = fix.componentInstance;
    expect(c.sitio()).toBe('CEDIS');
    expect(c.jueves()).toBe('2026-09-24');
    expect(c.form()?.person_code).toBe('205');
    expect(c.form()?.date_from).toBe('2026-09-25');
  });

  it('⛔ NEGATIVA — un sitio que no existe en la URL no se usa: cae al primero activo', async () => {
    await render({ claves: [Permission.HR_INCIDENTS_CAPTURAR], query: { site: 'NO-EXISTE' } });
    expect(fix.componentInstance.sitio()).toBe('PH');
  });

  it('⛔ NEGATIVA — quien sólo captura no ve Calificar ni Rechazar; sí puede quitar lo suyo', async () => {
    await render({ claves: [Permission.HR_INCIDENTS_CAPTURAR] });
    expect(fix.componentInstance.acciones(incidencia()).map((a) => a.accion)).toEqual(['anular']);
  });

  it('quien califica ve Calificar, Rechazar (con motivo) y Quitar', async () => {
    await render({ claves: [Permission.HR_INCIDENTS_CALIFICAR] });
    const a = fix.componentInstance.acciones(incidencia());
    expect(a.map((x) => x.accion)).toEqual(['calificar', 'rechazar', 'anular']);
    expect(a.find((x) => x.accion === 'rechazar')?.motivo).toBe(true);
  });

  it('⛔ NEGATIVA — auditar sólo se ofrece sobre lo cerrado, y sólo a quien audita', async () => {
    await render({ claves: [Permission.HR_INCIDENTS_AUDITAR] });
    const c = fix.componentInstance;
    expect(c.acciones(incidencia({ status: 'calificada' }))).toEqual([]);
    expect(c.acciones(incidencia({ status: 'cerrada' })).map((x) => x.accion)).toEqual(['auditar']);
    TestBed.resetTestingModule();
    await render({ claves: [Permission.HR_INCIDENTS_CALIFICAR] });
    expect(fix.componentInstance.acciones(incidencia({ status: 'cerrada' }))).toEqual([]);
  });

  it('un paso sin motivo se ejecuta directo; con motivo, espera a que se escriba', async () => {
    await render({ lista: [incidencia()], claves: [Permission.HR_INCIDENTS_CALIFICAR] });
    const c = fix.componentInstance;
    c.elegir(incidencia(), 'rechazar', true);
    expect(api['paso']).not.toHaveBeenCalled();
    expect(c.pendiente()).toEqual({ accion: 'rechazar' });
    c.elegir(incidencia(), 'calificar', false);
    expect(api['paso']).toHaveBeenCalledWith('i-1', 'calificar', '');
  });

  it('⭐ la captura manda lo que pide cada tipo', async () => {
    await render({ claves: [Permission.HR_INCIDENTS_CAPTURAR] });
    const c = fix.componentInstance;
    const base = { person_code: ' 101 ', incident_type: 'vacaciones', date_from: '2026-10-02', date_to: '2026-10-03', note: '', horas: '', entrada: '', reason: '', authorized_by_name: '', deliver: false };
    expect(c.cuerpoCaptura(base, 'PH')).toEqual({
      site_code: 'PH', person_code: '101', incident_type: 'vacaciones', date_from: '2026-10-02', date_to: '2026-10-03',
      note: undefined, minutes: undefined, reason: undefined, authorized_by_name: undefined, deliver: undefined,
    });
    expect(c.cuerpoCaptura({ ...base, incident_type: 'horas_extra', horas: '01:30' }, 'PH').minutes).toBe(90);
    // Horario distinto: es de UN día (no lleva «hasta») y lleva la hora de entrada, el motivo y quién autorizó.
    const hd = c.cuerpoCaptura({ ...base, incident_type: 'horario_distinto', entrada: '10:15', reason: 'Cita médica', authorized_by_name: 'Jefe Prueba' }, 'PH');
    expect(hd.date_to).toBeUndefined();
    expect(hd.minutes).toBe(615);
    expect(hd.reason).toBe('Cita médica');
    expect(hd.authorized_by_name).toBe('Jefe Prueba');
  });

  it('⛔ NEGATIVA — la semana en curso no se puede cerrar todavía', async () => {
    await render({ claves: [Permission.HR_PERIOD_CLOSE] });
    expect(texto()).toContain('Se puede cerrar a partir del jueves siguiente');
    expect(boton('Cerrar semana para prenómina')).toBeUndefined();
  });

  it('la semana pasada se cierra; ya cerrada, se reabre sólo con motivo', async () => {
    await render({ claves: [Permission.HR_PERIOD_CLOSE], cierres: [CIERRE] });
    const c = fix.componentInstance;
    c.moverSemana(-7);
    fix.detectChanges();
    expect(texto()).toContain('Semana cerrada para prenómina');
    expect(texto()).toContain('Cierre Prueba');
    expect(boton('Cerrar semana para prenómina')).toBeUndefined();
    c.modoReabrir.set(true);
    fix.detectChanges();
    expect((boton('Reabrir') as HTMLButtonElement).disabled).toBe(true);
  });

  it('⛔ NEGATIVA — sin permiso de cierre, ni cerrar ni reabrir', async () => {
    await render({ claves: [Permission.HR_INCIDENTS_CALIFICAR], cierres: [CIERRE] });
    fix.componentInstance.moverSemana(-7);
    fix.detectChanges();
    expect(texto()).toContain('Semana cerrada para prenómina');
    expect(boton('Reabrir semana')).toBeUndefined();
  });
});
