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
