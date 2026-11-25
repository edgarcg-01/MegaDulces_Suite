import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrBancoHorasExtraDto, HrPersonaHorasExtraDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { RhService } from '../rh.service';
import { SITIOS, asistencia, authCon, permisos } from '../../../../testing/rh.fixture';
import { RhHorasExtraComponent } from './rh-horas-extra.component';

/**
 * `[RH.1.10]` Horas extra. Lo que se defiende: el saldo es el del servidor (no se recalcula aquí), el ajuste sale con su
 * signo y sólo con motivo, y quien no gestiona la asistencia no ve cómo ajustar ni quitar.
 */
const ana = (o: Partial<HrPersonaHorasExtraDto> = {}): HrPersonaHorasExtraDto => ({
  codigo: '15', nombreCompleto: 'Prueba Uno', departamento: 'ALMACEN', segun: 'deducido', salida: '18:00',
  ganadasMin: 90, usadasMin: 60, ajustesMin: 0, saldoMin: 30,
  ganadas: [{ fecha: '2026-09-25', entrada: '08:00', salida: '19:00', salidaEsperada: '18:00', extraMin: 60 }],
  usos: [], ajustes: [], ...o,
});
const banco = (personas: HrPersonaHorasExtraDto[]): HrBancoHorasExtraDto =>
  ({ sucursalId: 'PH', desde: '2026-09-24', hasta: '2026-10-07', bloqueMin: 30, sinHorarioFijo: 2, personas });

describe('[RH.1.10] RhHorasExtraComponent', () => {
  let fix: ComponentFixture<RhHorasExtraComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render(o: { personas: HrPersonaHorasExtraDto[]; claves: string[] }) {
    api = {
      sitios: vi.fn(() => of(SITIOS)),
      bancoHorasExtra: vi.fn(() => of(banco(o.personas))),
      // [RH.14] Lo que la pantalla lee del padrón: vacío, para que no cambie lo que prueba este archivo.
      nombresPorConfirmar: vi.fn(() => of({ filas: [], total: 0 })),
      posiblesBajas: vi.fn(() => of({ site_code: '', dias: 31, filas: [], explicadas: [] })),
      fichaPersona: vi.fn(() => of(null)),
      catalogosFicha: vi.fn(() => of({ departamentos: [], puestos: [], sucursales: [] })),
      crearAjusteHorasExtra: vi.fn(() => of({ id: 'a1', fecha: '2026-09-24', minutos: 330, motivo: 'x', creadoPor: '', creadoEn: '' })),
      anularAjusteHorasExtra: vi.fn(() => of({ ok: true })),
      // Lo que pide el marco de las pestañas.
      asistencia: vi.fn(() => of(asistencia([]))),
      estadoRelojes: vi.fn(() => of([])),
      estadoCierre: vi.fn(() => of([])),
      directorio: vi.fn(() => of([])),
      incidencias: vi.fn(() => of([])),
    };
    await TestBed.configureTestingModule({
      imports: [RhHorasExtraComponent],
      providers: [
        provideRouter([]),
        { provide: RhService, useValue: api },
        { provide: PermissionsService, useValue: permisos(...o.claves) },
        { provide: AuthService, useValue: authCon(...o.claves) },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(RhHorasExtraComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ lista el banco de la plaza con el saldo que da el servidor', async () => {
    await render({ personas: [ana(), ana({ codigo: '16', nombreCompleto: 'Prueba Dos', saldoMin: -45, ganadasMin: 0, usadasMin: 45 })], claves: [Permission.HR_ATTENDANCE_VER] });
    expect(api['bancoHorasExtra']).toHaveBeenCalledWith('PH');
    expect(texto()).toContain('Prueba Uno');
    expect(texto()).toContain('+0h 30m');
    expect(texto()).toContain('−0h 45m');
    expect(texto()).toContain('2 persona(s) de planta');
  });

  it('⭐ [RH.6.7] lo pagado en efectivo sale en su columna y en la ficha; sin el dato (API anterior), «—» y no 0', async () => {
    const pagada = ana({ codigo: '17', nombreCompleto: 'Prueba Tres', pagadasMin: 60, saldoMin: -30,
      pagos: [{ id: 'p1', fecha: '2026-10-01', minutos: 60, nota: 'nómina del 15' }] });
    await render({ personas: [pagada, ana({ codigo: '18', nombreCompleto: 'Prueba Cuatro' })], claves: [Permission.HR_ATTENDANCE_VER] });
    const celda = (n: string) => Array.from((fix.nativeElement as HTMLElement).querySelectorAll('tbody tr'))
      .find((tr) => tr.textContent?.includes(n))?.querySelector('td[data-label="Pagadas"]')?.textContent?.trim();
    expect([celda('Prueba Tres'), celda('Prueba Cuatro')]).toEqual(['1h 00m', '—']);
    fix.componentInstance.abrir(pagada);
    fix.detectChanges();
    expect(document.body.textContent).toContain('nómina del 15');
    expect(document.body.textContent).toContain('le pagaron');
  });

  it('el ajuste sale con su signo, y sólo con motivo de 5 letras', async () => {
    await render({ personas: [ana()], claves: [Permission.HR_ATTENDANCE_GESTIONAR] });
    const c = fix.componentInstance;
    c.abrir(ana());
    c.signo.set('-1');
    c.horasAjuste.set('1:30');
    c.motivoAjuste.set('ok');
    expect(c.ajusteValido()).toBe(false);
    c.motivoAjuste.set('corrección de septiembre');
    expect(c.minutosAjuste()).toBe(-90);
    c.guardarAjuste();
    expect(api['crearAjusteHorasExtra']).toHaveBeenCalledWith(expect.objectContaining({
      site_code: 'PH', person_code: '15', minutes: -90, reason: 'corrección de septiembre', effective_date: '2026-09-24',
    }));
  });

  it('⛔ NEGATIVA — quien sólo ve no puede ajustar ni quitar ajustes', async () => {
    const conAjuste = ana({ ajustesMin: 330, saldoMin: 360, ajustes: [{ id: 'a1', fecha: '2026-09-24', minutos: 330, motivo: 'saldo que traía', creadoPor: 'rh', creadoEn: '' }] });
    await render({ personas: [conAjuste], claves: [Permission.HR_ATTENDANCE_VER] });
    fix.componentInstance.abrir(conAjuste);
    fix.detectChanges();
    expect(texto()).toContain('saldo que traía');
    expect(texto()).not.toContain('Ajustar el saldo');
    expect(texto()).not.toContain('Quitar');
  });

  // ── [RH.19.2] Las ganadas son un aproximado que RH corrige con justificación ──
  const filaBtn = (txt: string) => Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button')).find((b) => b.textContent?.trim() === txt);

  it('⭐ [RH.19.2] «Ganadas (aprox.)» se edita: las horas correctas y la justificación salen como ajuste por la diferencia', async () => {
    await render({ personas: [ana()], claves: [Permission.HR_ATTENDANCE_GESTIONAR] });
    expect(texto()).toContain('Ganadas (aprox.)');
    filaBtn('Editar')!.click();
    fix.detectChanges();
    const c = fix.componentInstance;
    c.horasCorrectas.set('0:30');
    c.justificacion.set('se quedó esperando transporte');
    fix.detectChanges();
    expect(texto()).toContain('queda en 0h 30m');
    c.guardarEdicion(ana());
    expect(api['crearAjusteHorasExtra']).toHaveBeenCalledWith({
      site_code: 'PH', person_code: '15', minutes: -60, effective_date: '2026-10-07',
      reason: 'Ganadas corregidas de 1h 30m a 0h 30m: se quedó esperando transporte',
    });
  });

  it('⛔ NEGATIVA [RH.19.2] — sin justificación, con la misma cifra o con un valor que no es hora, no se guarda', async () => {
    await render({ personas: [ana()], claves: [Permission.HR_ATTENDANCE_GESTIONAR] });
    const c = fix.componentInstance;
    c.editar(ana());
    for (const [h, j] of [['0:30', 'no'], ['1:30', 'mismo valor de antes'], ['una hora', 'justificación larga']]) {
      c.horasCorrectas.set(h); c.justificacion.set(j);
      expect(c.edicionValida()).toBe(false);
      c.guardarEdicion(ana());
    }
    expect(api['crearAjusteHorasExtra']).not.toHaveBeenCalled();
    // A cero sí se puede: es una cifra.
    c.horasCorrectas.set('0'); c.justificacion.set('no fueron horas extra');
    expect(c.edicionValida()).toBe(true);
  });

  it('[RH.19.2] la corrección se ve en Ganadas («aprox → corregida») y no se repite en Ajustes; el saldo es el del servidor', async () => {
    const corregida = ana({
      ajustesMin: 270, saldoMin: 300,
      ajustes: [
        { id: 'c1', fecha: '2026-10-07', minutos: -60, motivo: 'Ganadas corregidas de 1h 30m a 0h 30m: esperaba transporte', creadoPor: 'rh', creadoEn: '' },
        { id: 'a1', fecha: '2026-09-24', minutos: 330, motivo: 'saldo que traía', creadoPor: 'rh', creadoEn: '' },
      ],
    });
    await render({ personas: [corregida], claves: [Permission.HR_ATTENDANCE_VER] });
    const celda = (lbl: string) => (fix.nativeElement as HTMLElement).querySelector(`td[data-label="${lbl}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
    expect(celda('Ganadas (aprox.)')).toBe('1h 30m → 0h 30m');
    expect(celda('Ajustes')).toBe('+5h 30m');
    expect(celda('Saldo')).toBe('+5h 00m');
    // ⛔ quien sólo ve no edita
    expect(filaBtn('Editar')).toBeUndefined();
  });

  it('⛔ NEGATIVA — quitar un ajuste exige motivo', async () => {
    await render({ personas: [ana()], claves: [Permission.HR_ATTENDANCE_GESTIONAR] });
    const c = fix.componentInstance;
    c.motivoAnular.set('no');
    c.anular('a1');
    expect(api['anularAjusteHorasExtra']).not.toHaveBeenCalled();
    c.motivoAnular.set('se capturó dos veces');
    c.anular('a1');
    expect(api['anularAjusteHorasExtra']).toHaveBeenCalledWith('a1', 'se capturó dos veces');
  });
});
