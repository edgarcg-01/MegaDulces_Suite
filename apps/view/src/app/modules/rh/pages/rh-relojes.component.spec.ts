import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrLotePendienteDto, HrRelojDto, HrRelojEstadoDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { RhService } from '../rh.service';
import { SITIOS, permisos } from '../../../../testing/rh.fixture';
import { RhRelojesComponent } from './rh-relojes.component';

/**
 * `[RH.1.7]` Relojes checadores. Lo que se defiende: el semáforo dice la verdad (un reloj sin señal se ve, y uno
 * que nunca habló dice «nunca»), los cuatro colores se cuentan aunque sean cero, lo que llegó sin aplicar se ve
 * con su salida, y nada que cambie un reloj se ofrece sin `HR_DEVICES_GESTIONAR`.
 */
const estado = (over: Partial<HrRelojEstadoDto>): HrRelojEstadoDto => ({
  serie: 'S1', sucursalId: 'PH', alias: 'Entrada PH', modo: 'agente', ip: '10.0.0.5', nota: '', ultimaSenal: null, ultimaChecada: null,
  ultimoBackfill: null, segundosSinSenal: 60, logsEnReloj: 100, logsEnBase: 100, desfaseRelojSeg: 0, ultimoError: '', agenteVersion: '',
  agenteHost: '', semaforo: 'ok', ...over,
});
const RELOJ: HrRelojDto = {
  id: 'r-1', serial_number: 'S1', site_code: 'PH', site_name: 'Padre Hidalgo', label: 'Entrada PH', ip_address: '10.0.0.5', port: 4370,
  ingest_mode: 'agente', comm_key: 0, is_active: true, is_paused: false, notes: null, model: null, firmware: null,
};
const LOTE: HrLotePendienteDto = { serial_number: 'NUEVO9', source: 'agente', status: 'sin_registrar', error: null, lotes: 2, registros: 40, primero: '2026-10-06T14:00:00Z', ultimo: '2026-10-07T14:00:00Z' };

describe('[RH.1.7] RhRelojesComponent', () => {
  let fix: ComponentFixture<RhRelojesComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';
  const filas = () => Array.from(el().querySelectorAll('.rr-table tbody tr')) as HTMLElement[];
  const boton = (label: string) => Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.trim() === label);

  async function render(o: { estado: HrRelojEstadoDto[]; lotes?: HrLotePendienteDto[]; claves: string[] }) {
    api = {
      sitios: vi.fn(() => of(SITIOS)),
      estadoRelojes: vi.fn(() => of(o.estado)),
      relojes: vi.fn(() => of([RELOJ])),
      lotesPendientes: vi.fn(() => of(o.lotes ?? [])),
      guardarReloj: vi.fn(() => of(RELOJ)),
      reprocesar: vi.fn(() => of({ lotes: 2, aplicados: 2, aceptadas: 40 })),
      ordenes: vi.fn(() => of({ relojes: [], ordenes: [] })),
      renombrar: vi.fn(() => of({ ok: true, nombre: 'NUEVO', relojes: 2 })),
      restaurar: vi.fn(() => of({ ok: true, relojes: 2 })),
      cancelarOrden: vi.fn(() => of({ ok: true })),
    };
    await TestBed.configureTestingModule({
      imports: [RhRelojesComponent],
      providers: [
        { provide: RhService, useValue: api },
        { provide: PermissionsService, useValue: permisos(...o.claves) },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(RhRelojesComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ el semáforo: «Sin señal» se ve, con el nombre del sitio y el problema', async () => {
    await render({ estado: [estado({ serie: 'S1', semaforo: 'mudo', segundosSinSenal: 3 * 86400, ultimoError: 'No responde el puerto' })], claves: [Permission.HR_ATTENDANCE_VER] });
    const f = filas()[0].textContent ?? '';
    expect(f).toContain('Sin señal');
    expect(f).toContain('hace 3 d');
    expect(f).toContain('Padre Hidalgo');
    expect(f).toContain('No responde el puerto');
  });

  it('⛔ NEGATIVA — un reloj que nunca habló dice «nunca», no «hace un momento»', async () => {
    await render({ estado: [estado({ segundosSinSenal: null, semaforo: 'mudo' })], claves: [Permission.HR_ATTENDANCE_VER] });
    expect(filas()[0].textContent).toContain('nunca');
  });

  it('⛔ NEGATIVA — los cuatro colores se cuentan aunque sean cero', async () => {
    await render({ estado: [estado({ semaforo: 'ok' }), estado({ serie: 'S2', semaforo: 'ok' })], claves: [Permission.HR_ATTENDANCE_VER] });
    expect(fix.componentInstance.resumen()).toEqual([{ s: 'ok', n: 2 }, { s: 'atrasado', n: 0 }, { s: 'mudo', n: 0 }, { s: 'pendiente', n: 0 }]);
    expect(el().querySelectorAll('.rr-kpi').length).toBe(4);
  });

  it('⭐ lo que llegó sin aplicar se ve aunque nadie pueda aplicarlo', async () => {
    await render({ estado: [estado({})], lotes: [LOTE], claves: [Permission.HR_ATTENDANCE_VER] });
    expect(texto()).toContain('Llegaron checadas que no se aplicaron');
    expect(texto()).toContain('NUEVO9');
    expect(texto()).toContain('serie sin dar de alta');
    // Sin GESTIONAR: se informa, no se ofrece.
    expect(boton('Aplicar ahora')).toBeUndefined();
    expect(boton('Dar de alta')).toBeUndefined();
  });

  it('⛔ NEGATIVA — con sólo VER no se ofrece agregar, editar ni cambiar a nadie en un reloj', async () => {
    await render({ estado: [estado({})], claves: [Permission.HR_ATTENDANCE_VER] });
    expect(boton('Agregar reloj')).toBeUndefined();
    filas()[0].click();
    fix.detectChanges();
    expect(fix.componentInstance.peek()).toBe(false);
    fix.componentInstance.persona.set('101');
    fix.detectChanges();
    expect(boton('Renombrar')).toBeUndefined();
    expect(boton('Volver a darlo de alta')).toBeUndefined();
  });

  it('con GESTIONAR, «Dar de alta» abre el formulario con la serie que llegó', async () => {
    await render({ estado: [estado({})], lotes: [LOTE], claves: [Permission.HR_DEVICES_GESTIONAR] });
    boton('Dar de alta')!.click();
    expect(fix.componentInstance.form()).toMatchObject({ serie: 'NUEVO9', nuevo: true, site_code: 'PH' });
  });

  it('editar un reloj trae sus datos y manda el cuerpo limpio (vacío = null)', async () => {
    await render({ estado: [estado({})], claves: [Permission.HR_DEVICES_GESTIONAR] });
    const c = fix.componentInstance;
    c.editar('S1');
    const f = c.form()!;
    expect(f).toMatchObject({ serie: 'S1', nuevo: false, label: 'Entrada PH', port: 4370 });
    c.form.set({ ...f, label: '  ', ip_address: '', notes: ' nota ', is_paused: true });
    c.guardar();
    expect(api['guardarReloj']).toHaveBeenCalledWith('S1', {
      site_code: 'PH', label: null, ip_address: null, port: 4370, ingest_mode: 'agente', comm_key: 0, is_active: true, is_paused: true, notes: 'nota',
    });
  });

  it('⛔ NEGATIVA — sin serie no se guarda nada', async () => {
    await render({ estado: [estado({})], claves: [Permission.HR_DEVICES_GESTIONAR] });
    const c = fix.componentInstance;
    c.editar(null);
    c.guardar();
    expect(api['guardarReloj']).not.toHaveBeenCalled();
    expect(c.avisoForm()).toContain('número de serie');
  });

  it('aplicar los lotes dice cuántos entraron, y avisa si quedó alguno', async () => {
    await render({ estado: [estado({})], lotes: [LOTE], claves: [Permission.HR_DEVICES_GESTIONAR] });
    const c = fix.componentInstance;
    api['reprocesar'].mockReturnValueOnce(of({ lotes: 2, aplicados: 1, aceptadas: 20 }));
    c.reprocesar('NUEVO9');
    expect(c.avisoOrdenes()).toEqual({ texto: 'NUEVO9: 1 de 2 lote(s) aplicados, 20 checadas nuevas.', mal: true });
  });
});
