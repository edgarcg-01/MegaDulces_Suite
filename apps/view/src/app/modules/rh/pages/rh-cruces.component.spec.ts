import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrCrucesDto, HrPersonaCruce } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { RhService } from '../rh.service';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { SITIOS, asistencia, authCon, permisos } from '../../../../testing/rh.fixture';
import { RhCrucesComponent } from './rh-cruces.component';

/**
 * `[RH.7.4]` Cruces. Lo que se defiende: se pide la semana del estado compartido (todas las plazas), las rutas de
 * promotora arrancan ocultas y se pueden incluir, y la definición de cada clase está en pantalla (no en un `title`).
 */
const persona = (o: Partial<HrPersonaCruce>): HrPersonaCruce => ({
  user_id: 'u1', nombre: 'Prueba Uno', esPromotora: false, altas: [{ site_code: 'PH', codigo: '7' }, { site_code: 'MA', codigo: '21' }],
  clase: 'traslape', dias: [{ fecha: '2026-11-03', clase: 'traslape', huecoMin: -240,
    estancias: [{ site_code: 'PH', codigo: '7', primera: '07:00', ultima: '15:00', marcas: 2 }, { site_code: 'MA', codigo: '21', primera: '09:00', ultima: '13:00', marcas: 2 }] }],
  diasCruzados: 1, traslapes: 1, marcasAjenas: 0, ultimoDia: '2026-11-03', ...o,
});
const datos = (personas: HrPersonaCruce[]): HrCrucesDto => ({
  desde: '2026-10-29', hasta: '2026-11-04', enDosSedes: 16, personas,
  resumen: { personas: personas.length, dias: personas.length, traslapes: 1, marcasAjenas: 0, jornadasPartidas: 0,
    rutas: personas.filter((p) => p.clase === 'ruta_promotora').length },
});

describe('[RH.7.4] RhCrucesComponent', () => {
  let fix: ComponentFixture<RhCrucesComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render(personas: HrPersonaCruce[]) {
    api = {
      sitios: vi.fn(() => of(SITIOS)),
      cruces: vi.fn(() => of(datos(personas))),
      asistencia: vi.fn(() => of(asistencia([]))),
      bancoHorasExtra: vi.fn(() => of({ personas: [] })),
      estadoRelojes: vi.fn(() => of([])),
      estadoCierre: vi.fn(() => of([])),
      directorio: vi.fn(() => of([])),
      incidencias: vi.fn(() => of([])),
    };
    await TestBed.configureTestingModule({
      imports: [RhCrucesComponent],
      providers: [
        provideRouter([]),
        { provide: RhService, useValue: api },
        { provide: PermissionsService, useValue: permisos(Permission.HR_ATTENDANCE_VER) },
        { provide: AuthService, useValue: authCon(Permission.HR_ATTENDANCE_VER) },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(RhCrucesComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ pide la semana del estado compartido y pinta lo más grave primero', async () => {
    await render([persona({})]);
    const r = TestBed.inject(RhAsistenciaEstado).rango();
    expect(api['cruces']).toHaveBeenCalledWith(r.desde, r.hasta);
    expect(texto()).toContain('Jornadas encimadas');
    expect(texto()).toContain('Prueba Uno');
  });

  it('las rutas de promotora arrancan ocultas y se pueden incluir', async () => {
    await render([persona({}), persona({ user_id: 'u2', nombre: 'Prueba Dos', clase: 'ruta_promotora', esPromotora: true })]);
    const c = fix.componentInstance;
    expect(c.filas().map((p) => p.user_id)).toEqual(['u1']);
    expect(texto()).toContain('Incluir rutas de promotora (1)');
    c.verRutas.set(true);
    expect(c.filas().map((p) => p.user_id)).toEqual(['u1', 'u2']);
  });

  it('el detalle dice qué significa la clase, en pantalla', async () => {
    await render([persona({})]);
    fix.componentInstance.sel.set(persona({}));
    fix.detectChanges();
    await fix.whenStable();
    expect(document.body.textContent).toContain('Nadie está en dos plazas a la vez');
  });
});
