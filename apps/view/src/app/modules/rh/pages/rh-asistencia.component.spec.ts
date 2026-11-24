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
import { By } from '@angular/platform-browser';
import { RhCapturaIncidenciaComponent } from '../components/rh-captura-incidencia.component';
import { By } from '@angular/platform-browser';
import { RhMarcoComponent } from '../components/rh-marco.component';

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
      // [RH.18.7] Con incidencias por calificar en la semana, la pantalla lee los nombres de los tipos.
      tiposIncidencia: vi.fn(() => of([])),
      asignarHorario: vi.fn(() => of({ ok: true, guardados: 1 })),
      quitarHorario: vi.fn(() => of({ ok: true, quitados: 1 })),
      editarFicha: vi.fn(() => of({ site_code: 'PH', person_code: '104', seccion: 'ALMACEN', promotora: false, nombre: null })),
      darDeBaja: vi.fn(() => of({ ok: true })),
      estadoRelojes: vi.fn(() => (relojes === 'error' ? throwError(() => new Error('403')) : of(relojes))),
      bancoHorasExtra: vi.fn(() => of({ personas: [] })),
      // [RH.14] Lo que la pantalla lee del padrón: vacío, para que no cambie lo que prueba este archivo.
      nombresPorConfirmar: vi.fn(() => of({ filas: [], total: 0 })),
      posiblesBajas: vi.fn(() => of({ site_code: '', dias: 31, filas: [], explicadas: [] })),
      fichaPersona: vi.fn(() => of(null)),
      catalogosFicha: vi.fn(() => of({ departamentos: [], puestos: [], sucursales: [] })),
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

  it('⭐ el reporte calcado: por departamento, un día por columna; D y C sólo cuando se pasó', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    const deptos = Array.from(el().querySelectorAll('tr.rs-depto')).map((t) => t.textContent?.replace(/\s+/g, ' ').trim());
    expect(deptos).toEqual(['CONTABILIDAD (1)', 'SISTEMAS (2)']);
    const dias = Array.from(el().querySelectorAll('th.rs-dia')).map((t) => t.textContent?.replace(/\s+/g, ''));
    // [RH.18.7] El encabezado del día en dos renglones: «Jueves» y «1 oct».
    expect(dias).toEqual(['Jueves1oct', 'Viernes2oct', 'Sábado3oct', 'Domingo4oct', 'Lunes5oct', 'Martes6oct', 'Miércoles7oct']);
    const uno = filas().find((f) => f.textContent?.includes('Prueba Uno'))!;
    expect(uno.textContent).toContain('07:56–17:04');   // [RH.13.5] en pantalla, rango sin espacios
    // [RH.13.5] Desayuno de 22 y comida de 59 sin pasarse: no se repiten en la celda (las pausas sí se ven).
    expect(uno.textContent).toContain('11:02');
    expect(uno.querySelector('.pz')).toBeNull();
    // [RH.18.5] El horario no está a la vista al abrir; con «Mostrar horario» empieza por la hora y «deducido» va aparte.
    expect(uno.querySelector('.rs-hor')).toBeNull();
    (el().querySelector('button.rs-ver-hor') as HTMLButtonElement).click();
    await ciclo();
    const uno2 = filas().find((f) => f.textContent?.includes('Prueba Uno'))!;
    expect(uno2.querySelector('.rs-hor small')?.textContent?.trim()).toBe('deducido');
    localStorage.removeItem('rh.asistencia.verHorario');
  });

  it('[RH.13.5] la comida que se pasó SÍ sale, con sus minutos y en ámbar', async () => {
    const datos = SEMANA();
    datos.personas[0].semanas[0].dias = [dia({ fecha: '2026-10-05', entrada: '07:56', salida: '17:04', comida: '13:00 – 14:15', comidaMin: 75, comidaExcesoMin: 15, desayunoMin: 10 })];
    await render({ datos, claves: [Permission.HR_ATTENDANCE_VER] });
    const uno = filas().find((f) => f.textContent?.includes('Prueba Uno'))!;
    expect([...uno.querySelectorAll('.pz .exc')].map((x) => x.textContent?.trim())).toEqual(['C 75']);
  });

  it('[RH.13.5] un renglón arriba de la tabla: el modo, cuántos, quién tiene algo y el PDF — sin repetir plaza ni semana', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    const barra = el().querySelector('.ra-barra')!;
    expect(barra.textContent).toContain('3 personas');
    expect(barra.textContent).toContain('1 con irregularidades');
    // Sólo el PDF para firmar, directo (David, 13-nov: sin Excel ni menú).
    expect([...barra.querySelectorAll('button')].some((b) => b.textContent?.includes('PDF para firmar'))).toBe(true);
    expect(barra.textContent).not.toContain('Excel');
    // Ya no hay un título que repita la plaza encima de la tabla, ni el párrafo de explicación bajo «Asistencia».
    expect(el().querySelector('.ra-rep h2')).toBeNull();
    expect(el().querySelector('.mc-head p')).toBeNull();
    // El buscador de todas las plazas vive en la cabecera.
    expect(el().querySelector('.mc-head .mc-buscar input')).not.toBeNull();
    // La leyenda va al pie, en palabras.
    expect(el().querySelector('.ra-ley')?.textContent).toContain('sólo si se pasó');
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

  it('⛔ el día de hoy no es falta: el modo Faltas cuenta 1 (el martes), no 2', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    // `[RH.13.5]` Faltas e Incidencias ya no son pestañas: la cifra va en el modo y en el globo del botón.
    const modo = Array.from(el().querySelectorAll('.ra-ver button')).find((b) => b.textContent?.includes('Faltas'));
    expect(modo?.querySelector('.ra-ver-n')?.textContent?.trim()).toBe('1');
    const inc = Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.includes('Incidencias'));
    expect(inc?.textContent?.replace(/\D/g, '')).toBe('2');
    const dos = filas().find((f) => f.textContent?.includes('Prueba Dos'))!;
    const celdas = Array.from(dos.querySelectorAll('td.rs-celda')).map((c) => c.textContent?.trim());
    // [RH.18.7] En pantalla la falta es un bloque que se lee; el PDF y el Excel siguen con «0 - 0» (el papel de RH).
    expect(celdas[5]).toBe('Faltasin justificar');
    expect(dos.querySelectorAll('td.rs-celda')[5].querySelector('.rs-blq.falta')).not.toBeNull();
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

  it('[RH.13.5] la semana también se elige en el calendario: cualquier día abre su semana de jueves a miércoles', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    const marco = fix.debugElement.query(By.directive(RhMarcoComponent)).componentInstance as RhMarcoComponent;
    expect(el().querySelector('[aria-label="Elegir la semana en el calendario"]')).not.toBeNull();
    // un martes lleva al jueves anterior; un jueves, a sí mismo
    marco.elegirDia(new Date(2026, 8, 22));
    expect(est().jueves()).toBe('2026-09-17');
    marco.elegirDia(new Date(2026, 8, 10));
    expect(est().jueves()).toBe('2026-09-10');
    // el calendario pinta la semana elegida completa, de jueves a miércoles
    const [ini, fin] = marco.rangoSemana();
    expect([ini.getDate(), ini.getDay(), fin.getDate(), fin.getDay()]).toEqual([10, 4, 16, 3]);
    // un día que todavía no llega no abre una semana futura: se queda en la actual
    marco.elegirDia(new Date(2027, 0, 20));
    expect(est().jueves()).toBe(est().juevesActual());
    // desde «Hoy», elegir un día sale del modo hoy
    est().irA('hoy');
    marco.elegirDia(new Date(2026, 8, 22));
    expect([est().modoHoy(), est().jueves()]).toEqual([false, '2026-09-17']);
  });

  it('[RH.13.5] «Personas» es plaza, departamento y personas: un departamento entero, sueltas o una sola', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    const marco = fix.debugElement.query(By.directive(RhMarcoComponent)).componentInstance as RhMarcoComponent;
    const nombres = () => filas().map((f) => f.querySelector('.rs-n')?.textContent?.trim());
    // las opciones traen a la gente debajo de su departamento
    expect(marco.opcPersonas().map((o) => o.value)).toEqual(['d:CONTABILIDAD', 'p:087', 'd:SISTEMAS', 'p:118', 'p:104']);
    marco.cambiarPersonas(['d:SISTEMAS']);
    await ciclo();
    expect(nombres()).toEqual(['Prueba Dos Ejemplo', 'Prueba Uno Ejemplo']);
    expect(texto()).toContain('solo SISTEMAS');
    expect(el().querySelector('.mc-per-sel')?.textContent?.trim()).toBe('SISTEMAS');
    // personas sueltas de dos departamentos (el campo cambia de a una casilla, como el clic)
    est().verATodos();
    marco.cambiarPersonas(['p:104']);
    marco.cambiarPersonas([...marco.valorPersonas(), 'p:087']);
    await ciclo();
    expect(nombres()).toEqual(['Prueba Tres Ejemplo', 'Prueba Uno Ejemplo']);
    expect(texto()).toContain('solo 2 personas');
    // una sola: su tabla día por día, y «Ver a todos» regresa a la plaza
    marco.cambiarPersonas(marco.valorPersonas().filter((v) => v !== 'p:087'));
    await ciclo();
    expect(el().querySelector('app-rh-reporte-semanal')).toBeNull();
    expect(texto()).toContain('solo esta persona');
    boton('Ver a todos')!.click();
    await ciclo();
    expect(filas()).toHaveLength(3);
    expect(el().querySelector('.mc-per-sel')).toBeNull();
  });

  it('⛔ con sólo VER, la ficha no ofrece capturar ni tocar el horario, y no hay botón Horario', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(boton('Horario')).toBeUndefined();
    fix.componentInstance.abrir(fix.componentInstance.todas()[0]);
    await ciclo();
    expect(boton('Capturar incidencia')).toBeUndefined();
    expect(boton('Asignarle horario')).toBeUndefined();
  });

  it('⛔ [RH.18.9] con CAPTURAR, la ficha y «solo esta persona» ya NO ofrecen captura: la incidencia se levanta en la tabla', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR] });
    const c = fix.componentInstance;
    // La tabla de la semana sí: cada celda trae su «+».
    expect(el().querySelectorAll('td.rs-celda button.rs-inc-btn').length).toBeGreaterThan(0);
    // La ficha no: ni «+ Incidencia» por día ni «Capturar incidencia»; su tabla de días sí se queda.
    c.abrir(c.todas().find((p) => p.codigo === '118')!);
    await ciclo();
    expect(document.querySelectorAll('button.pd-inc').length).toBe(0);
    // (El «Capturar incidencia» del encabezado de Asistencia es otra puerta: abre el panel, para cualquier persona o varios días.)
    const acciones = document.querySelector('.ra-acciones') as HTMLElement;
    expect(acciones).not.toBeNull();
    expect(Array.from(acciones.querySelectorAll('button')).some((b) => b.textContent?.includes('Capturar incidencia'))).toBe(false);
    expect(document.querySelector('app-rh-persona-dias .pd-tabla')).not.toBeNull();
    // «Solo esta persona», tampoco.
    c.cerrar();
    c.est.verSolo('118');
    await ciclo();
    expect(el().querySelector('.ra-una app-rh-persona-dias')).not.toBeNull();
    expect(el().querySelectorAll('.ra-una button.pd-inc').length).toBe(0);
  });

  describe('[RH.13.5] una sola pantalla', () => {
    /** Lo que piden Incidencias y Relojes al abrirse dentro del panel. */
    const completarApi = () => Object.assign(api, {
      tiposIncidencia: vi.fn(() => of([])), cierres: vi.fn(() => of([])), bitacora: vi.fn(() => of([])),
      relojes: vi.fn(() => of([])), lotesPendientes: vi.fn(() => of([])), ordenes: vi.fn(() => of({ relojes: [], ordenes: [] })),
      sinPersona: vi.fn(() => of({ filas: [], total: 0, secciones: [] })),
    });
    const conUrl = async (url: string) => { navigate.mockRestore(); await TestBed.inject(Router).navigateByUrl(url); await ciclo(); };
    const pestanas = () => Array.from(el().querySelectorAll('.ptab')).map((t) => t.querySelector('span')?.textContent?.trim());

    it('⭐ las pestañas son sólo las que contestan otra pregunta: Checadas · Horas extra · Cruces · Bajas', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR] });
      expect(pestanas().filter(Boolean)).toEqual(['Checadas', 'Horas extra', 'Cruces', 'Bajas']);
    });

    it('⭐ Faltas y Tolerancia son modos de la misma semana, con su cifra; la URL dice cuál', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER] });
      const modos = () => Array.from(el().querySelectorAll('.ra-ver button')).map((b) => [b.textContent?.replace(/\s+/g, ' ').trim(), b.getAttribute('aria-pressed')]);
      expect(modos()[0]).toEqual(['Semana', 'true']);
      expect(modos()[1][0]).toBe(`Faltas ${fix.componentInstance.est.nFaltas()}`);
      await conUrl('/?ver=faltas');
      expect(fix.componentInstance.ver()).toBe('faltas');
      expect(el().querySelector('app-rh-faltas')).not.toBeNull();
      expect(el().querySelector('app-rh-reporte-semanal')).toBeNull();
      // Embebida: sin su propio encabezado (el de Asistencia ya está arriba).
      expect(el().querySelectorAll('app-rh-marco').length).toBe(1);
    });

    it('⛔ NEGATIVA — un modo que no existe en la URL cae en la semana, no en una pantalla en blanco', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER] });
      await conUrl('/?ver=lo-que-sea');
      expect(fix.componentInstance.ver()).toBe('semana');
    });

    it('⭐ ?panel=incidencias abre Incidencias encima, montada y sin su marco; ?panel=relojes, Relojes', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR] });
      completarApi();
      await conUrl('/?panel=incidencias&site=PH');
      expect(fix.componentInstance.panel()).toBe('incidencias');
      expect(document.querySelector('app-rh-incidencias')).not.toBeNull();
      expect(document.querySelector('app-rh-incidencias app-rh-marco')).toBeNull();
      expect(api['tiposIncidencia']).toHaveBeenCalled();
      await conUrl('/?panel=relojes');
      expect(document.querySelector('app-rh-incidencias')).toBeNull();
      expect(document.querySelector('app-rh-relojes')).not.toBeNull();
      expect(document.querySelector('app-rh-relojes app-rh-marco')).toBeNull();
    });

    describe('[RH.18.4] la incidencia desde la celda del día, en la tabla de la semana', () => {
      /** La celda del día 6 de la persona 118 (la que tiene falta). */
      const celda = () => {
        const fila = Array.from(el().querySelectorAll('tr.rs-fila')).find((tr) => tr.querySelector('.rs-clv')?.textContent?.trim() === '118')!;
        const cols = fix.componentInstance.columnas().map((c) => c.fecha);
        return fila.querySelectorAll('td.rs-celda')[cols.indexOf('2026-10-06')] as HTMLElement;
      };

      it('⭐ tocar la celda abre la captura de ESE día y esa persona en un globo, sin abrir la ficha', async () => {
        await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR] });
        Object.assign(api, { tiposIncidencia: vi.fn(() => of([{ tipo: 'vacaciones', etiqueta: 'Vacaciones', codigo: 'VAC', excusaFalta: true }, { tipo: 'permiso_sin_goce', etiqueta: 'Permiso sin goce de sueldo', codigo: 'PSG', excusaFalta: true }, { tipo: 'incapacidad', etiqueta: 'Incapacidad', codigo: 'INC', excusaFalta: true }, { tipo: 'otros', etiqueta: 'Otros', codigo: 'OTR', excusaFalta: true }])) });
        const c = fix.componentInstance;
        celda().click();
        await ciclo();
        expect(c.sel()).toBeNull();
        expect(c.captura()).toMatchObject({ codigo: '118', fecha: '2026-10-06', origen: 'tabla' });
        expect([c.capturaForm()?.person_code, c.capturaForm()?.date_from, c.capturaForm()?.incident_type]).toEqual(['118', '2026-10-06', '']);
        // El globo trae los botones del día (falta: personal, cita médica, no registrada…).
        const textos = Array.from(document.querySelectorAll('.ra-globo button.ci-boton')).map((b) => b.querySelector('.ci-b-tit')?.textContent?.trim());
        expect(textos.slice(0, 3)).toEqual(['Personal', 'Cita médica', 'No registrada']);
        // Y el «+» de la celda es la misma puerta, para el teclado.
        expect(celda().querySelector('button.rs-inc-btn')?.getAttribute('aria-label')).toContain('Prueba Dos Ejemplo el');
      });

      it('⭐ desde el globo: un toque en «Personal» y Guardar; se dice si ya cuenta y se recalcula', async () => {
        await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR] });
        Object.assign(api, { tiposIncidencia: vi.fn(() => of([{ tipo: 'vacaciones', etiqueta: 'Vacaciones', codigo: 'VAC', excusaFalta: true }, { tipo: 'permiso_sin_goce', etiqueta: 'Permiso sin goce de sueldo', codigo: 'PSG', excusaFalta: true }, { tipo: 'incapacidad', etiqueta: 'Incapacidad', codigo: 'INC', excusaFalta: true }, { tipo: 'otros', etiqueta: 'Otros', codigo: 'OTR', excusaFalta: true }])), capturar: vi.fn(() => of({ id: 'i-1', status: 'capturada' })) });
        const c = fix.componentInstance;
        celda().click();
        await ciclo();
        (document.querySelector('.ra-globo button.ci-boton') as HTMLButtonElement).click();
        await ciclo();
        const antes = (api['asistencia'] as ReturnType<typeof vi.fn>).mock.calls.length;
        (document.querySelector('.ra-globo form') as HTMLFormElement).dispatchEvent(new Event('submit'));
        await ciclo();
        expect(api['capturar']).toHaveBeenCalledWith(expect.objectContaining({ person_code: '118', date_from: '2026-10-06', incident_type: 'permiso_sin_goce' }));
        expect(c.captura()).toBeNull();
        expect(c.aviso()?.texto).toContain('Cuenta cuando otra persona la califique');
        expect((api['asistencia'] as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(antes);
      });

      it('⛔ NEGATIVA — el nombre sigue abriendo la ficha (no levanta incidencia)', async () => {
        await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR] });
        const fila = Array.from(el().querySelectorAll('tr.rs-fila')).find((tr) => tr.querySelector('.rs-clv')?.textContent?.trim() === '118')!;
        (fila.querySelector('td.rs-nom') as HTMLElement).click();
        await ciclo();
        expect(fix.componentInstance.sel()?.codigo).toBe('118');
        expect(fix.componentInstance.captura()).toBeNull();
      });

      it('⛔ NEGATIVA — sin permiso de capturar, la celda hace lo de siempre: abre la ficha, sin «+»', async () => {
        await render({ claves: [Permission.HR_ATTENDANCE_VER] });
        // Con los tipos a la mano: si la celda capturara sin permiso, aquí se vería.
        Object.assign(api, { tiposIncidencia: vi.fn(() => of([{ tipo: 'otros', etiqueta: 'Otros', codigo: 'OTR', excusaFalta: true }])) });
        expect(celda().querySelector('button.rs-inc-btn')).toBeNull();
        celda().click();
        await ciclo();
        expect(fix.componentInstance.sel()?.codigo).toBe('118');
        expect(fix.componentInstance.captura()).toBeNull();
      });
    });

    it('⛔ NEGATIVA — sin permiso de capturar, la ficha no ofrece «+ Incidencia»', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER] });
      fix.componentInstance.abrir(fix.componentInstance.todas()[0]);
      await ciclo();
      expect(document.querySelectorAll('button.pd-inc').length).toBe(0);
    });

    it('[RH.13.5] cada columna que la pantalla angosta esconde existe en TODOS los renglones (si no, la tabla se corre)', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER] });
      const ancho = (tr: Element) => Array.from(tr.children).reduce((t, td) => t + Number(td.getAttribute('colspan') || 1), 0);
      // [RH.18.5] En los DOS estados de la columna Horario (oculta al abrir, y mostrada): ningún renglón se corre.
      for (const conHorario of [false, true]) {
        if (conHorario) { (el().querySelector('button.rs-ver-hor') as HTMLButtonElement).click(); await ciclo(); }
        const columnas = el().querySelectorAll('.rs-tabla thead th').length;
        const renglones = Array.from(el().querySelectorAll('.rs-tabla tbody tr:not(.rs-depto), .rs-tabla tfoot tr'));
        expect(renglones.length).toBeGreaterThan(3);
        for (const tr of renglones) {
          expect(ancho(tr)).toBe(columnas);
          for (const c of ['rs-c-gano', 'rs-c-uso', 'rs-c-saldo']) expect(tr.querySelectorAll('.' + c).length).toBe(1);
          expect(tr.querySelectorAll('.rs-hor').length).toBe(conHorario ? 1 : 0);
        }
        // La barra del departamento ocupa todo el ancho.
        for (const d of Array.from(el().querySelectorAll('.rs-tabla tr.rs-depto td'))) expect(Number(d.getAttribute('colspan'))).toBe(columnas);
        for (const c of ['rs-c-gano', 'rs-c-uso', 'rs-c-saldo']) expect(el().querySelectorAll('.rs-tabla thead th.' + c).length).toBe(1);
        expect(el().querySelectorAll('.rs-tabla thead th.rs-hor-h').length).toBe(conHorario ? 1 : 0);
      }
      localStorage.removeItem('rh.asistencia.verHorario');
      // El horario tiene a dónde bajar cuando su columna no cabe.
      expect(el().querySelectorAll('tr.rs-fila .rs-hor-movil').length).toBe(el().querySelectorAll('tr.rs-fila').length);
    });

    it('[RH.13.5] en pantalla angosta los filtros plegados dicen cuántos están puestos', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER] });
      const marco = fix.debugElement.query(By.directive(RhMarcoComponent)).componentInstance as RhMarcoComponent;
      expect(marco.filtrosActivos()).toBe(0);
      est().setPromotoras(true);
      expect(marco.filtrosActivos()).toBe(1);
      est().irA('hoy');
      expect(marco.filtrosActivos()).toBe(2);
      const btn = el().querySelector('.mc-filtros-btn') as HTMLButtonElement;
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      btn.click();
      await ciclo();
      expect(btn.getAttribute('aria-expanded')).toBe('true');
    });

    it('⭐ la rejilla es TABLA: la barra de cada departamento cubre todas las columnas y no hay columna de acciones suelta', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER] });
      const columnas = el().querySelectorAll('.rs-tabla thead th').length;
      const barras = Array.from(el().querySelectorAll('tr.rs-depto td')).map((td) => Number(td.getAttribute('colspan')));
      expect(barras.length).toBeGreaterThan(0);
      expect(new Set(barras)).toEqual(new Set([columnas]));
      // [RH.14.10] Sin «⋯»: lo que ofrecía está en la ficha que abre la fila (con clic o con Enter).
      expect(el().querySelectorAll('.rs-acc-btn').length).toBe(0);
      expect(el().querySelectorAll('tr.rs-fila[tabindex="0"]').length).toBe(el().querySelectorAll('tr.rs-fila').length);
    });

    it('cerrar el panel quita sólo lo que servía para abrirlo', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER] });
      fix.componentInstance.cerrarPanel();
      expect(navigate).toHaveBeenCalledWith([], expect.objectContaining({
        queryParamsHandling: 'merge', queryParams: { panel: null, nueva: null, persona: null, desde: null, site: null },
      }));
    });

    it('⭐ el botón principal es el paso que toca: semana en curso → «Capturar incidencia»', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR, Permission.HR_PERIOD_CLOSE] });
      expect(boton('Capturar incidencia')).toBeDefined();
      expect(boton('Cerrar semana')).toBeUndefined();
    });

    it('⭐ semana que ya terminó y sigue abierta → «Cerrar semana» (uno solo, nunca los dos)', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR, Permission.HR_PERIOD_CLOSE] });
      fix.componentInstance.est.irA('pasada');
      await ciclo();
      expect(boton('Cerrar semana')).toBeDefined();
      expect(boton('Capturar incidencia')).toBeUndefined();
    });

    it('⛔ NEGATIVA — sin permiso de cierre, la semana pasada no ofrece cerrarla', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR] });
      fix.componentInstance.est.irA('pasada');
      await ciclo();
      expect(boton('Cerrar semana')).toBeUndefined();
      expect(boton('Capturar incidencia')).toBeDefined();
    });

    it('Relojes e Incidencias son botones del encabezado, con lo que falta calificar en el globo', async () => {
      await render({ claves: [Permission.HR_ATTENDANCE_VER] });
      expect(boton('Relojes')).toBeDefined();
      const inc = Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.includes('Incidencias'));
      expect(inc?.textContent).toContain('2');
    });
  });

  it('con GESTIONAR, el horario de una persona va sólo a ella; el de «Horario» va a las que se ven', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR] });
    const c = fix.componentInstance;
    c.abrirHorario(c.todas()[0]);
    c.form.set({ turnos: [{ entrada: '09:00', salida: '18:30', comida: 45 }], sabado: false, sabadoEntrada: '09:00', sabadoSalida: '14:00' });
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

  it('⛔ [RH.14.7] con «Solo irregulares», el horario de «Horario» va SÓLO a las que se ven, y el texto dice cuántas', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR] });
    const c = fix.componentInstance;
    est().soloIrregulares.set(true);
    await ciclo();
    expect(c.filas().map((p) => p.codigo)).toEqual(['118']);
    expect(c.visibles().length).toBe(3);                 // lo que el filtro esconde sigue en «visibles»…
    c.abrirHorario(null);
    await ciclo();
    expect(texto()).toContain('la persona que se ve');   // …y antes el texto decía «las 3 personas que se ven»
    c.guardarHorario();
    expect(api['asignarHorario']).toHaveBeenLastCalledWith(expect.objectContaining({ person_codes: ['118'] }));
  });

  it('[RH.14.3] la ficha dice cómo está en cada reloj y manda su nombre al reloj; [RH.14.5] departamento y sucursal sin acceso', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR] });
    api['renombrar'] = vi.fn(() => of({ ok: true, nombre: 'Prueba Uno Ejemplo', relojes: 2 }));
    const ficha = {
      site_code: 'PH', person_code: '104', user_id: 'u-104', nombre: 'Prueba Uno Ejemplo', con_acceso: false, status: 'invited',
      activa_en_plaza: true, seccion: 'SISTEMAS', promotora: false, departamento_code: null, puesto_code: null, sucursal_code: null, zona_nombre: null,
      relojes: [{ device_label: 'Reloj A', serial_number: 'S1', device_user_id: '104', nombre_reloj: 'Uno' }],
      nombre_para_reloj: 'Prueba Uno Ejemplo', nombre_por_confirmar: null, plazas_activas: 1,
    };
    api['fichaPersona'].mockReturnValue(of(ficha));
    api['catalogosFicha'].mockReturnValue(of({ departamentos: [{ code: 'sis', name: 'Sistemas' }], puestos: [], sucursales: [{ code: '03', name: 'Morelia Centro', zone_name: null }] }));
    const c = fix.componentInstance;
    const p = c.todas().find((x) => x.codigo === '104')!;
    c.abrir(p);
    await ciclo();
    expect(api['fichaPersona']).toHaveBeenCalledWith('PH', '104');
    expect(document.body.textContent).toContain('#104 Uno');
    expect(document.body.textContent).toContain('Actualizar en el reloj');
    expect(c.relojDistinto(ficha)).toBe(true);
    c.ponerEnReloj(p, ficha);
    expect(api['renombrar']).toHaveBeenCalledWith('PH', '104', 'Prueba Uno Ejemplo');
    // Lo de la persona: sólo lo que cambió, con su código.
    c.abrirFicha(p);
    const f = c.fichaForm();
    if (!f) throw new Error('sin formulario');
    f.departamento = 'sis'; f.sucursal = '03';
    c.guardarFicha(p);
    expect(api['editarFicha']).toHaveBeenLastCalledWith({ site_code: 'PH', person_code: '104', departamento_code: 'sis', sucursal_code: '03' });
    // [RH.14.4] Con acceso a la Suite: el nombre SÍ se manda; ⛔ lo de la persona no (lo cambia Sistemas).
    api['fichaPersona'].mockReturnValue(of({ ...ficha, con_acceso: true }));
    c.abrir(p);
    c.abrirFicha(p);
    const g = c.fichaForm();
    if (!g) throw new Error('sin formulario');
    g.nombre = 'Otro Nombre Cualquiera'; g.departamento = 'sis'; g.seccion = 'almacen';
    c.guardarFicha(p);
    expect(api['editarFicha']).toHaveBeenLastCalledWith({ site_code: 'PH', person_code: '104', nombre: 'Otro Nombre Cualquiera', seccion: 'almacen' });
  });

  it('⭐ [RH.18.2] con acceso a la Suite, la ficha DICE por qué no ofrece departamento, puesto y sucursal (y a dónde ir)', async () => {
    const abrirCon = async (claves: string[], conAcceso: boolean) => {
      await render({ claves });
      api['fichaPersona'].mockReturnValue(of({
        site_code: 'PH', person_code: '104', user_id: 'u-104', nombre: 'Prueba Uno Ejemplo', con_acceso: conAcceso, status: 'active',
        activa_en_plaza: true, seccion: 'SISTEMAS', promotora: false, departamento_code: null, puesto_code: null, sucursal_code: null, zona_nombre: null,
        relojes: [], nombre_para_reloj: 'Prueba Uno Ejemplo', nombre_por_confirmar: null, plazas_activas: 1,
      }));
      api['catalogosFicha'].mockReturnValue(of({ departamentos: [{ code: 'sis', name: 'Sistemas' }], puestos: [], sucursales: [] }));
      const c = fix.componentInstance;
      const p = c.todas().find((x) => x.codigo === '104')!;
      c.abrir(p);
      await ciclo();
      c.abrirFicha(p);
      await ciclo();
      return document.querySelector('form[aria-label="Editar la ficha en esta plaza"]') as HTMLElement;
    };
    const base = [Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR];
    let form = await abrirCon([...base, Permission.USUARIOS_VER], true);
    expect(form.textContent).toContain('los cambia Sistemas en Administración › Personas');
    expect(form.querySelector('[aria-label="Departamento"]')).toBeNull();
    expect(form.querySelector('a.ra-ir')?.getAttribute('href')).toBe('/admin/users');
    TestBed.resetTestingModule();
    // ⛔ NEGATIVA — sin permiso de ver Personas, se explica igual pero sin una liga que rebotaría.
    form = await abrirCon(base, true);
    expect(form.textContent).toContain('los cambia Sistemas');
    expect(form.querySelector('a.ra-ir')).toBeNull();
    TestBed.resetTestingModule();
    // ⛔ NEGATIVA — sin acceso, no hay aviso: los tres campos están y se editan aquí.
    form = await abrirCon(base, false);
    expect(form.textContent).not.toContain('los cambia Sistemas');
    expect(form.querySelector('.ra-bloqueado')).toBeNull();
  });

  it('[RH.6.3] con dos horarios manda la lista; el primero va también suelto, y no pasa de 4', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR] });
    const c = fix.componentInstance;
    c.abrirHorario(c.todas()[0]);
    c.form.set({ turnos: [{ entrada: '08:00', salida: '17:00', comida: 60 }], sabado: false, sabadoEntrada: '', sabadoSalida: '' });
    c.agregarTurno();
    const f = c.form();
    if (!f) throw new Error('sin formulario');
    f.turnos[1].entrada = '13:00'; f.turnos[1].salida = '21:00';
    c.guardarHorario();
    expect(api['asignarHorario']).toHaveBeenLastCalledWith(expect.objectContaining({
      starts_at: '08:00', ends_at: '17:00', lunch_minutes: 60,
      shifts: [{ starts_at: '08:00', ends_at: '17:00', lunch_minutes: 60 }, { starts_at: '13:00', ends_at: '21:00', lunch_minutes: 60 }],
    }));
    c.abrirHorario(c.todas()[0]);
    for (let i = 0; i < 6; i++) c.agregarTurno();
    expect(c.form()?.turnos.length).toBe(4);
    c.quitarTurno(0);
    expect(c.form()?.turnos.length).toBe(3);
  });

  it('[RH.7.1] la ficha en la plaza: manda SÓLO lo que cambió; sin cambios no llama; sin la clave no hay «Editar»', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR] });
    const c = fix.componentInstance;
    const p = c.todas()[0];
    c.abrir(p);
    c.abrirFicha(p);
    expect(c.fichaForm()).toMatchObject({ codigo: '104', nombre: 'Prueba Uno Ejemplo', seccion: 'SISTEMAS', promotora: false });
    c.guardarFicha(p);
    expect(api['editarFicha']).not.toHaveBeenCalled();
    const f = c.fichaForm();
    if (!f) throw new Error('sin formulario');
    f.seccion = 'almacen';
    c.guardarFicha(p);
    expect(api['editarFicha']).toHaveBeenLastCalledWith({ site_code: 'PH', person_code: '104', seccion: 'almacen' });
    expect(c.fichaForm()).toBeNull();
  });

  it('[RH.7.2] dar de baja pide motivo de 5 letras, manda plaza y código, y cierra la ficha', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR] });
    const c = fix.componentInstance;
    const p = c.todas()[0];
    c.abrir(p);
    c.abrirBaja(p);
    c.motivoBaja.set('ya');
    c.darDeBaja(p);
    expect(api['darDeBaja']).not.toHaveBeenCalled();
    c.motivoBaja.set('renunció el viernes');
    c.darDeBaja(p);
    expect(api['darDeBaja']).toHaveBeenCalledWith({ site_code: 'PH', person_code: '104', motivo: 'renunció el viernes' });
    expect(c.sel()).toBeNull();
    expect(c.aviso()?.texto).toBe('De baja: Prueba Uno Ejemplo');
  });

  it('[RH.7.1] ⛔ sin HR_DEVICES_GESTIONAR no se ofrece editar la ficha', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR] });
    expect(fix.componentInstance.puedeEditarFicha()).toBe(false);
  });

  it('[RH.6.4] el reporte trae HE usó y HE saldo; sin saldo leído dice «—», no un cero', async () => {
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    const ths = [...el().querySelectorAll('app-rh-reporte-semanal th')].map((t) => t.textContent?.trim());
    // [RH.13.5] En pantalla dice «Extra» (en el PDF y el Excel sigue «HE», como el papel de RH).
    expect(ths).toEqual(expect.arrayContaining(['Extra ganó', 'Extra usó', 'Extra saldo']));
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

  it('[RH.13.5] sin administrar relojes, un reloj sin señal se dice en el chip pero NO trae la franja', async () => {
    relojes = [reloj({ semaforo: 'mudo', segundosSinSenal: null })];
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(el().querySelector('.mc-vivo')?.textContent?.trim()).toBe('Sin señal');
    expect(el().querySelector('app-rh-relojes-franja')).toBeNull();
  });

  it('⭐ [RH.1.7b] si el reloj de la plaza no reporta, el chip dice «Sin señal» y quien administra relojes ve el aviso', async () => {
    relojes = [reloj({ semaforo: 'mudo', segundosSinSenal: null }), reloj({ serie: 'S9', sucursalId: 'CEDIS', semaforo: 'ok' })];
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR] });
    expect(el().querySelector('.mc-vivo')?.textContent?.trim()).toBe('Sin señal');
    // [RH.18.8] Sin franja roja plegada: lo dicen el chip y el encabezado de Relojes (la explicación, al abrirlo).
    expect(el().querySelector('.rf-alerta')).toBeNull();
    expect(el().querySelector('.rf-resumen')?.textContent?.trim()).toBe('1 sin señal');
  });

  it('[RH.13.5] con todos los relojes al día no hay franja: ya lo dicen «En vivo» y el botón Relojes', async () => {
    relojes = [reloj({ semaforo: 'ok' })];
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(el().querySelector('.mc-vivo')).not.toBeNull();
    expect(el().querySelector('app-rh-relojes-franja')).toBeNull();
    expect(boton('Relojes')).toBeDefined();
  });

  it('[RH.13.5] un reloj con la hora corrida SÍ trae la franja aunque esté al día (a quien administra relojes)', async () => {
    relojes = [reloj({ semaforo: 'ok', desfaseRelojSeg: 600 })];
    await render({ claves: [Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR] });
    expect(el().querySelector('app-rh-relojes-franja')).not.toBeNull();
  });

  it('⛔ si no se pudo leer el estado de los relojes, no se pinta ni chip ni franja', async () => {
    relojes = 'error';
    await render({ claves: [Permission.HR_ATTENDANCE_VER] });
    expect(el().querySelector('.mc-vivo')).toBeNull();
    expect(el().querySelector('app-rh-relojes-franja')).toBeNull();
    expect(filas().length).toBe(3);   // la asistencia sí se ve
  });
});
