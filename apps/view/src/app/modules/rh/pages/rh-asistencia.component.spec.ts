import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { HrAsistenciaResponse, HrCierreDto, HrPersonaDirectorioDto, HrRelojEstadoDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { RhService } from '../rh.service';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { SITIOS, asistencia, authCon, dia, permisos, persona } from '../../../../testing/rh.fixture';
import { RhAsistenciaComponent } from './rh-asistencia.component';

/**
 * `[RH.1.7c]` Checadas: el reporte semanal «calcado» de Mega Talento. Lo que se defiende: se lee como el papel de
 * RH (una fila por persona, un día por columna, por departamento, con D y C), la fila en rojo es la que tiene algo
 * que revisar, el día en curso no se acusa, lo parcial dice que lo es, y cada botón aparece sólo con su permiso.
 */
describe('[RH.1.7c] RhAsistenciaComponent — Checadas', () => {
  let fix: ComponentFixture<RhAsistenciaComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let navigate: ReturnType<typeof vi.spyOn>;
  let relojes: HrRelojEstadoDto[] | 'error' = [];
  let cierres: HrCierreDto[] = [];
  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';
  const filas = () => Array.from(el().querySelectorAll('tr.rs-fila')) as HTMLElement[];
  const boton = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const badges = () => Object.fromEntries(Array.from(el().querySelectorAll('.ptab')).map((t) => [t.querySelector('span')?.textContent?.trim(), t.querySelector('.ptab-num')?.textContent?.trim() ?? null]));
  const est = () => TestBed.inject(RhAsistenciaEstado);
  const ciclo = async () => { fix.detectChanges(); await fix.whenStable(); fix.detectChanges(); };

  /** Sistemas: Uno (lunes normal) y Dos (faltó el martes y hoy todavía no llega); Contabilidad: Tres. */
  const SEMANA = (): HrAsistenciaResponse => asistencia([
    persona({
      codigo: '104', nombreCompleto: 'Prueba Uno Ejemplo', departamento: 'Sistemas · sis',
      semanas: [{ ...persona().semanas[0], dias: [dia({ fecha: '2026-10-05', entrada: '07:56', salida: '17:04', comida: '11:02 – 11:24 · 14:01 – 15:00', desayunoMin: 22, comidaMin: 59 })] }],
    }),
    persona({
      codigo: '118', nombreCompleto: 'Prueba Dos Ejemplo', departamento: 'Sistemas · sis', faltas: 2,
      semanas: [{ ...persona().semanas[0], dias: [dia({ fecha: '2026-10-06', estado: 'falta', entrada: null, salida: null }), dia({ fecha: '2026-10-07', estado: 'falta', entrada: null, salida: null })] }],
    }),
    persona({ codigo: '087', nombreCompleto: 'Prueba Tres Ejemplo', departamento: 'Contabilidad · con' }),
  ]);

  async function render(o: { datos?: HrAsistenciaResponse; claves: string[]; directorio?: HrPersonaDirectorioDto[]; porSitio?: Record<string, HrAsistenciaResponse> }) {
    const datos = o.datos ?? SEMANA();
    api = {
      sitios: vi.fn(() => of(SITIOS)),
      asistencia: vi.fn((q: { site_code: string }) => of(o.porSitio?.[q.site_code] ?? datos)),
      asignarHorario: vi.fn(() => of({ ok: true, guardados: 1 })),
      quitarHorario: vi.fn(() => of({ ok: true, quitados: 1 })),
      estadoRelojes: vi.fn(() => (relojes === 'error' ? throwError(() => new Error('403')) : of(relojes))),
      incidencias: vi.fn(() => of([{ id: 'a' }, { id: 'b' }])),
      estadoCierre: vi.fn(() => of(cierres)),
      directorio: vi.fn(() => of(o.directorio ?? [])),
    };
    await TestBed.configureTestingModule({
      imports: [RhAsistenciaComponent],
      providers: [
        provideRouter([]),
        { provide: RhService, useValue: api },
        { provide: PermissionsService, useValue: permisos(...o.claves) },
        { provide: AuthService, useValue: authCon(...o.claves) },
      ],
    }).compileComponents();
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fix = TestBed.createComponent(RhAsistenciaComponent);
    await ciclo();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Miércoles 7-oct-2026, mediodía en México: la semana de nómina abrió el jueves 1.
    vi.setSystemTime(new Date('2026-10-07T18:00:00Z'));
    relojes = [];
    cierres = [];
  });
  afterEach(() => { vi.useRealTimers(); TestBed.resetTestingModule(); document.querySelectorAll('.p-popover').forEach((x) => x.remove()); });

  it('pide la semana de nómina del primer sitio ACTIVO, de jueves a hoy', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(api['asistencia']).toHaveBeenCalledWith({ site_code: 'PH', date_from: '2026-10-01', date_to: '2026-10-07', only_promoters: false });
    expect(texto()).toContain('jue 1 oct – mié 7 oct');
  });

  it('⭐ el reporte calcado: por departamento, un día por columna, con D y C', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    const deptos = Array.from(el().querySelectorAll('tr.rs-depto')).map((t) => t.textContent?.replace(/\s+/g, ' ').trim());
    expect(deptos).toEqual(['CONTABILIDAD (1)', 'SISTEMAS (2)']);
    const dias = Array.from(el().querySelectorAll('th.rs-dia')).map((t) => t.textContent?.replace(/\s+/g, ''));
    expect(dias).toEqual(['Jue1', 'Vie2', 'Sáb3', 'Dom4', 'Lun5', 'Mar6', 'Mié7']);
    const uno = filas().find((f) => f.textContent?.includes('Prueba Uno'))!;
    expect(uno.textContent).toContain('07:56 - 17:04');
    expect(uno.textContent).toContain('D 22');
    expect(uno.textContent).toContain('C 59');
  });

  it('⭐ la fila en rojo es la que tiene algo que revisar, y «Solo irregulares» la aísla', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(filas().filter((f) => f.classList.contains('irr')).map((f) => f.querySelector('.rs-clv')?.textContent)).toEqual(['118']);
    expect(texto()).toContain('1 con irregularidades');
    boton('Solo irregulares')!.click();
    await ciclo();
    expect(filas().length).toBe(1);
    expect(texto()).toContain('sólo con irregularidades');
  });

  it('⛔ el día de hoy no es falta: la pestaña Faltas cuenta 1 (el martes), no 2', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(badges()['Faltas']).toBe('1');
    expect(badges()['Incidencias']).toBe('2');
    const dos = filas().find((f) => f.textContent?.includes('Prueba Dos'))!;
    const celdas = Array.from(dos.querySelectorAll('td.rs-celda')).map((c) => c.textContent?.trim());
    expect(celdas[5]).toBe('0 - 0');
    expect(celdas[6]).toBe('·');
  });

  it('los departamentos elegidos filtran, y el reporte dice que es parcial', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    est().departamentos.set(['SISTEMAS']);
    await ciclo();
    expect(filas().length).toBe(2);
    expect(el().querySelector('.ra-parcial')?.textContent).toContain('solo SISTEMAS');
  });

  it('la búsqueda filtra la plaza por nombre o número', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    est().buscar.set('tres');
    await ciclo();
    expect(filas().map((f) => f.querySelector('.rs-clv')?.textContent)).toEqual(['087']);
    est().buscar.set('118');
    await ciclo();
    expect(filas()[0].textContent).toContain('Prueba Dos');
  });

  it('⭐ «Buscar en todas las plazas»: sugiere de otra plaza y, al elegir, va a ella y abre la ficha', async () => {
    const cedis = asistencia([persona({ codigo: '77', nombreCompleto: 'Prueba Siete Cedis' })]);
    await render({
      claves: [Permission.HR_ATTENDANCE_VER], porSitio: { CEDIS: cedis },
      directorio: [{ site_code: 'CEDIS', site_name: 'CEDIS', codigo: '77', nombre: 'Prueba Siete Cedis', departamento: null, ligado: true, promotora: false }],
    });
    const input = el().querySelector('.mc-buscar input') as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));
    input.value = 'siete';
    input.dispatchEvent(new Event('input'));
    await ciclo();
    const sug = el().querySelector('.mc-sug button') as HTMLButtonElement;
    expect(sug.textContent).toContain('CEDIS');
    sug.click();
    await ciclo();
    expect(api['asistencia']).toHaveBeenLastCalledWith(expect.objectContaining({ site_code: 'CEDIS' }));
    expect(fix.componentInstance.sel()?.codigo).toBe('77');
  });

  it('la fila abre la ficha con su semana día por día; «Ver solo a esta persona» deja sólo a ella', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    filas().find((f) => f.textContent?.includes('Prueba Uno'))!.click();
    await ciclo();
    expect(fix.componentInstance.sel()?.codigo).toBe('104');
    expect(el().querySelector('app-side-peek')?.textContent).toContain('Lun 5');
    boton('Ver solo a esta persona')!.click();
    await ciclo();
    expect(fix.componentInstance.sel()).toBeNull();
    expect(texto()).toContain('solo esta persona');
    expect(el().querySelector('app-rh-reporte-semanal')).toBeNull();
  });

  it('⛔ con sólo VER, la ficha no ofrece capturar ni tocar el horario, y no hay botón Horario', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(boton('Horario')).toBeUndefined();
    fix.componentInstance.abrir(fix.componentInstance.todas()[0]);
    await ciclo();
    expect(boton('Capturar incidencia')).toBeUndefined();
    expect(boton('Asignarle horario')).toBeUndefined();
  });

  it('con CAPTURAR, «Capturar incidencia» lleva a Incidencias con la persona y la semana puestas', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR] });
    fix.componentInstance.capturar(fix.componentInstance.todas()[0]);
    expect(navigate).toHaveBeenCalledWith(['/rh/incidencias'], { queryParams: { nueva: 1, site: 'PH', persona: '104', desde: '2026-10-01' } });
  });

  it('con GESTIONAR, el horario de una persona va sólo a ella; el de «Horario» va a las que se ven', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR] });
    const c = fix.componentInstance;
    c.abrirHorario(c.todas()[0]);
    c.form.set({ entrada: '09:00', salida: '18:30', comida: 45, sabado: false, sabadoEntrada: '09:00', sabadoSalida: '14:00' });
    c.guardarHorario();
    expect(api['asignarHorario']).toHaveBeenLastCalledWith({
      site_code: 'PH', person_codes: ['104'], starts_at: '09:00', ends_at: '18:30', lunch_minutes: 45,
      works_saturday: false, saturday_starts_at: undefined, saturday_ends_at: undefined,
    });
    est().departamentos.set(['SISTEMAS']);
    c.abrirHorario(null);
    c.guardarHorario();
    expect(api['asignarHorario']).toHaveBeenLastCalledWith(expect.objectContaining({ person_codes: ['104', '118'] }));
  });

  it('semana pasada sin cerrar: el aviso dice qué falta para cerrarla', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    est().irA('pasada');
    await ciclo();
    expect(el().querySelector('.mc-cierre')?.textContent).toContain('ya terminó y no está cerrada');
    expect(el().querySelector('.mc-cierre')?.textContent).toContain('calificar 2 incidencias');
  });

  it('semana pasada cerrada: se dice, con quién la cerró', async () => {
    cierres = [{ id: 'c', site_code: 'PH', period_start: '2026-09-24', period_end: '2026-09-30', closed_by: 'u', closed_by_name: 'Rh Prueba',
      closed_at: '2026-10-01T15:00:00Z', summary: null, reopened_by: null, reopened_by_name: null, reopened_at: null, reopen_reason: null, vigente: true }];
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    est().irA('pasada');
    await ciclo();
    expect(el().querySelector('.mc-cierre')?.textContent).toContain('Semana cerrada para prenómina por Rh Prueba');
  });

  const reloj = (o: Partial<HrRelojEstadoDto>): HrRelojEstadoDto => ({
    serie: 'S1', sucursalId: 'PH', alias: 'Entrada PH', modo: 'agente', ip: '', nota: '', ultimaSenal: null, ultimaChecada: null, ultimoBackfill: null,
    segundosSinSenal: 30, logsEnReloj: null, logsEnBase: null, desfaseRelojSeg: null, ultimoError: '', agenteVersion: '', agenteHost: '', semaforo: 'ok', ...o,
  });

  it('⭐ [RH.1.7b] si el reloj de la plaza no reporta, el chip dice «Sin señal» y el aviso se ve', async () => {
    relojes = [reloj({ semaforo: 'mudo', segundosSinSenal: null }), reloj({ serie: 'S9', sucursalId: 'CEDIS', semaforo: 'ok' })];
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(el().querySelector('.mc-vivo')?.textContent?.trim()).toBe('Sin señal');
    expect(el().querySelector('.rf-alerta')?.textContent).toContain('no ha reportado');
    expect(el().querySelector('.rf-resumen')?.textContent?.trim()).toBe('1 sin señal');
  });

  it('⛔ si no se pudo leer el estado de los relojes, no se pinta ni chip ni franja', async () => {
    relojes = 'error';
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(el().querySelector('.mc-vivo')).toBeNull();
    expect(el().querySelector('app-rh-relojes-franja')).toBeNull();
    expect(filas().length).toBe(3);   // la asistencia sí se ve
  });
});
