import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrBajaPlazaDto } from '@megadulces/contracts';
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

  async function render(o: { bajas: HrBajaPlazaDto[]; claves: string[] }) {
    api = {
      sitios: vi.fn(() => of(SITIOS)),
      bajas: vi.fn(() => of(o.bajas)),
      reactivar: vi.fn(() => of({ ok: true })),
      // Lo que pide el marco de las pestañas.
      asistencia: vi.fn(() => of(asistencia([]))),
      bancoHorasExtra: vi.fn(() => of({ personas: [] })),
      estadoRelojes: vi.fn(() => of([])),
      estadoCierre: vi.fn(() => of([])),
      directorio: vi.fn(() => of([])),
      incidencias: vi.fn(() => of([])),
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

  it('busca por nombre, código o sección', async () => {
    await render({ bajas: [baja(), baja({ person_code: '9', nombre: 'Prueba Dos', seccion: 'ALMACEN' })], claves: [Permission.HR_ATTENDANCE_VER] });
    fix.componentInstance.buscar.set('almacen');
    expect(fix.componentInstance.filas().map((b) => b.person_code)).toEqual(['9']);
  });
});
