import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrBajaPlazaDto, HrPosibleBajaDto, HrPosiblesBajasResponse } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { RhService } from '../rh.service';
import { SITIOS, asistencia, authCon, permisos } from '../../../../testing/rh.fixture';
import { RhBajasComponent } from './rh-bajas.component';

/**
 * `[RH.7.2]` Bajas. Lo que se defiende: quien sigue checando después de su baja va PRIMERO y se cuenta arriba; lo que
 * llegó de baja de Mega Talento lo dice (no inventa un motivo); reactivar pide confirmar; sin la clave no se ofrece.
 */
const baja = (o: Partial<HrBajaPlazaDto> = {}): HrBajaPlazaDto => ({
  person_code: '7', user_id: 'u-7', nombre: 'Prueba Uno', seccion: 'CAJAS', promotora: false,
  desde: '2026-11-01T18:00:00Z', motivo: 'renunció', por: 'rh.prueba', origen: 'suite',
  ultima_checada: null, checadas_desde_baja: 0, ...o,
});

describe('[RH.7.2] RhBajasComponent', () => {
  let fix: ComponentFixture<RhBajasComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render(o: { bajas: HrBajaPlazaDto[]; claves: string[]; extra?: Record<string, ReturnType<typeof vi.fn>> }) {
    api = {
      sitios: vi.fn(() => of(SITIOS)),
      bajas: vi.fn(() => of(o.bajas)),
      reactivar: vi.fn(() => of({ ok: true })),
      // Lo que pide el marco de las pestañas.
      asistencia: vi.fn(() => of(asistencia([]))),
      bancoHorasExtra: vi.fn(() => of({ personas: [] })),
      // [RH.14] Lo que la pantalla lee del padrón: vacío, para que no cambie lo que prueba este archivo.
      nombresPorConfirmar: vi.fn(() => of({ filas: [], total: 0 })),
      posiblesBajas: vi.fn(() => of({ site_code: '', dias: 31, filas: [], explicadas: [] })),
      fichaPersona: vi.fn(() => of(null)),
      catalogosFicha: vi.fn(() => of({ departamentos: [], puestos: [], sucursales: [] })),
      estadoRelojes: vi.fn(() => of([])),
      estadoCierre: vi.fn(() => of([])),
      directorio: vi.fn(() => of([])),
      incidencias: vi.fn(() => of([])),
      ...o.extra,
    };
    await TestBed.configureTestingModule({
      imports: [RhBajasComponent],
      providers: [
        provideRouter([]),
        { provide: RhService, useValue: api },
        { provide: PermissionsService, useValue: permisos(...o.claves) },
        { provide: AuthService, useValue: authCon(...o.claves) },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(RhBajasComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ quien sigue checando va primero y se cuenta arriba; lo de Mega Talento lo dice', async () => {
    await render({
      bajas: [
        baja(),
        baja({ person_code: '9', nombre: 'Prueba Dos', checadas_desde_baja: 3, ultima_checada: '2026-11-08T14:00:00Z' }),
        baja({ person_code: '12', nombre: 'Prueba Tres', origen: 'mega_talento', motivo: null, por: null }),
      ],
      claves: [Permission.HR_ATTENDANCE_VER],
    });
    expect(api['bajas']).toHaveBeenCalledWith('PH');
    expect(fix.componentInstance.filas()[0].person_code).toBe('9');
    expect(fix.componentInstance.resumen().map((m) => [m.label, m.value])).toEqual([['De baja en la plaza', 3], ['Siguen checando', 1]]);
    expect(texto()).toContain('Llegó de baja desde Mega Talento');
    expect(texto()).not.toContain('Reactivar');
  });

  it('reactivar pide confirmar y manda plaza y código', async () => {
    await render({ bajas: [baja()], claves: [Permission.HR_DEVICES_GESTIONAR] });
    const c = fix.componentInstance;
    expect(texto()).toContain('Reactivar');
    c.confirmar.set('7');
    fix.detectChanges();
    expect(texto()).toContain('Sí, reactivar');
    c.reactivar(baja());
    expect(api['reactivar']).toHaveBeenCalledWith({ site_code: 'PH', person_code: '7' });
    expect(api['bajas']).toHaveBeenCalledTimes(2);
  });

  // ── [RH.14.6] Posibles bajas y [RH.14.1] archivar ─────────────────────────────────────────────────────────────
  const posible = (o: Partial<HrPosibleBajaDto> = {}): HrPosibleBajaDto => ({
    person_code: '21', user_id: 'u-21', nombre: 'Prueba Cuatro', seccion: 'CAJAS', promotora: false,
    ultima_checada: '2026-09-01T15:00:00Z', dias_sin_checar: 78, otras_plazas_activas: 0, ...o,
  });
  const posibles = (filas: HrPosibleBajaDto[], explicadas: HrPosiblesBajasResponse['explicadas'] = []): HrPosiblesBajasResponse =>
    ({ site_code: 'PH', dias: 31, filas, explicadas });

  it('⭐ posibles bajas: pide la plaza con 31 días, prellena el motivo y dice quién no se propone por una incidencia', async () => {
    await render({
      bajas: [], claves: [Permission.HR_DEVICES_GESTIONAR],
      extra: { posiblesBajas: vi.fn(() => of(posibles([posible(), posible({ person_code: '22', user_id: 'u-22', nombre: 'Prueba Cinco', dias_sin_checar: null, ultima_checada: null })],
        [{ ...posible({ person_code: '23', nombre: 'Prueba Seis' }), incidencia: { etiqueta: 'Vacaciones', desde: '2026-10-20', hasta: '2026-12-01' } }]))) },
    });
    expect(api['posiblesBajas']).toHaveBeenCalledWith('PH', 31);
    const c = fix.componentInstance;
    expect(c.motivo()).toBe('Sin checar en esta plaza desde hace 31 días o más');
    expect(texto()).toContain('Prueba Cuatro');
    expect(texto()).toContain('nunca checó aquí');
    expect(texto()).toContain('1 con incidencia');
    // Sin nadie elegido no se puede dar de baja.
    expect(texto()).toContain('Dar de baja (0)');
  });

  it('⛔ lote parcial: dice cuántas sí y cuáles fallaron, y las fallidas SIGUEN elegidas para reintentar', async () => {
    const lote = vi.fn(() => of({ dados_de_baja: ['21'], fallaron: [{ person_code: '22', error: 'Ya está de baja en esta plaza.' }], sin_plazas: [] }));
    await render({
      bajas: [], claves: [Permission.HR_DEVICES_GESTIONAR],
      extra: { posiblesBajas: vi.fn(() => of(posibles([posible(), posible({ person_code: '22', user_id: 'u-22' })]))), darDeBajaLote: lote },
    });
    const c = fix.componentInstance;
    c.seleccion.set(c.posibles()!.filas);
    c.darDeBaja();
    expect(lote).toHaveBeenCalledWith({ site_code: 'PH', person_codes: ['21', '22'], motivo: 'Sin checar en esta plaza desde hace 31 días o más' });
    expect(c.seleccion().map((p) => p.person_code)).toEqual(['22']);
    expect(c.pbAviso()?.mal).toBe(true);
    expect(c.pbAviso()?.texto).toContain('1 dada de baja en la plaza · 1 fallaron');
  });

  it('[RH.14.1] quien se queda sin plazas: se propone archivar sólo a quien no tiene acceso, con confirmación', async () => {
    const archivar = vi.fn(() => of({ ok: true }));
    await render({
      bajas: [], claves: [Permission.HR_DEVICES_GESTIONAR],
      extra: {
        posiblesBajas: vi.fn(() => of(posibles([posible()]))),
        darDeBajaLote: vi.fn(() => of({ dados_de_baja: ['21'], fallaron: [], sin_plazas: [
          { user_id: 'u-21', nombre: 'Prueba Cuatro', archivable: true }, { user_id: 'u-30', nombre: 'Con Acceso', archivable: false }] })),
        archivarPersona: archivar,
      },
    });
    const c = fix.componentInstance;
    c.seleccion.set(c.posibles()!.filas);
    c.darDeBaja();
    fix.detectChanges();
    expect(texto()).toContain('2 sin plazas: Prueba Cuatro, Con Acceso');
    expect(texto()).toContain('1 con acceso (Sistemas)');
    expect(texto()).toContain('Archivar (1)');
    expect(archivar).not.toHaveBeenCalled();             // ⛔ nunca sola: pide confirmar
    c.confirmarArchivo.set(true);
    await c.archivar();
    expect(archivar).toHaveBeenCalledTimes(1);
    expect(archivar).toHaveBeenCalledWith({ user_id: 'u-21', motivo: expect.any(String) });
    expect(c.sinPlazas().map((s) => s.user_id)).toEqual(['u-30']);
  });

  it('busca por nombre, código o sección', async () => {
    await render({ bajas: [baja(), baja({ person_code: '9', nombre: 'Prueba Dos', seccion: 'ALMACEN' })], claves: [Permission.HR_ATTENDANCE_VER] });
    fix.componentInstance.buscar.set('almacen');
    expect(fix.componentInstance.filas().map((b) => b.person_code)).toEqual(['9']);
  });
});
