import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrCandidatoFilaDto, HrTiempoPorEtapaDto, HrVacanteDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { authCon, permisos } from '../../../../testing/rh.fixture';
import { ReclutamientoService } from '../reclutamiento.service';
import { RhCandidatosComponent } from './rh-candidatos.component';
import { RhVacantesComponent, cuerpoDe, formDe } from './rh-vacantes.component';
import { RhReclutamientoRevisionesComponent, contraMeta } from './rh-reclutamiento-revisiones.component';

/**
 * `[RH.2.3]` Las tres pantallas de Reclutamiento. Lo que se defiende: la lista pide al servidor el apartado y la etapa
 * elegidos y muestra sus conteos; una vacante vacía se manda como «sin dato», no como texto en blanco; y el tiempo
 * por etapa se compara contra la meta de Mega Talento sin inventar una meta donde no hay.
 */
const fila = (o: Partial<HrCandidatoFilaDto> = {}): HrCandidatoFilaDto => ({
  id: 'c1', full_name: 'Ana Prueba', phone: '3511234567', phone_key: '3511234567', city_branch: 'Zamora', position_interest: 'Cajera',
  stage: 'aptitudes', stage_raw: 'aptitudes', source: 'portal', traffic_light: null, has_cv: true, no_rehire: false, is_spam: false,
  created_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), deleted_at: null, deletion_reason: null, ...o,
});

function api(over: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  return {
    candidatos: vi.fn(() => of({ total: 2, filas: [fila(), fila({ id: 'c2', full_name: 'Beto Prueba', has_cv: false, no_rehire: true })], por_etapa: { aptitudes: 2, filtro_inicial: 5 } })),
    casilleros: vi.fn(() => of([])),
    ficha: vi.fn(() => of(null)),
    vacantes: vi.fn(() => of([])),
    crearVacante: vi.fn(() => of({})),
    reingresos: vi.fn(() => of([])),
    duplicados: vi.fn(() => of([])),
    tiempoPorEtapa: vi.fn(() => of({ fases: [], total: 0 })),
    ...over,
  } as Record<string, ReturnType<typeof vi.fn>>;
}

async function montar<T>(cmp: new (...a: never[]) => T, svc: Record<string, unknown>, claves: string[]): Promise<ComponentFixture<T>> {
  await TestBed.configureTestingModule({
    imports: [cmp],
    providers: [
      provideRouter([]),
      { provide: ReclutamientoService, useValue: svc },
      { provide: PermissionsService, useValue: permisos(...claves) },
      { provide: AuthService, useValue: authCon(...claves) },
    ],
  }).compileComponents();
  const fix = TestBed.createComponent(cmp);
  fix.detectChanges();
  await fix.whenStable();
  fix.detectChanges();
  return fix;
}

const texto = (f: ComponentFixture<unknown>) => (f.nativeElement as HTMLElement).textContent ?? '';
const boton = (f: ComponentFixture<unknown>, t: string) =>
  [...(f.nativeElement as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim().startsWith(t)) as HTMLButtonElement | undefined;

describe('[RH.2.3] Candidatos', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ pide los postulados por omisión y muestra la lista con sus marcas y los conteos por etapa', async () => {
    const svc = api();
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    expect(svc['candidatos']).toHaveBeenCalledWith(expect.objectContaining({ view: 'postulados', stage: null }));
    expect(texto(f)).toContain('Ana Prueba');
    expect(texto(f)).toContain('No recontratable');
    expect(texto(f)).toContain('Sin CV');
    expect(boton(f, 'Todas')?.textContent).toContain('7');
    expect(boton(f, 'Aptitudes')?.textContent).toContain('2');
  });

  it('elegir una etapa o un apartado vuelve a pedir al servidor con ese filtro', async () => {
    const svc = api();
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    boton(f, 'Aptitudes')!.click();
    expect(svc['candidatos']).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'aptitudes' }));
    boton(f, 'Papelera')!.click();
    expect(svc['candidatos']).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'papelera', stage: null }));
  });
});

describe('[RH.2.3] Vacantes', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ NEGATIVA — un campo vacío viaja como null, nunca como texto en blanco', () => {
    const f = { ...formDe(null), name: '  Cajera  ', salary_text: '   ', area: 'Tienda' };
    expect(cuerpoDe(f)).toEqual(expect.objectContaining({ name: 'Cajera', salary_text: null, area: 'Tienda', is_active: true, sort_order: 999 }));
    // Las sucursales viajan como lista (de ahí sale la ciudad en la bolsa de trabajo).
    expect(cuerpoDe({ ...f, branch_codes: ['zamora-canindo'] }).branch_codes).toEqual(['zamora-canindo']);
  });

  it('quien sólo ve no tiene «Nueva vacante»; quien gestiona sí', async () => {
    const v: HrVacanteDto = { id: 'v1', name: 'Cajera', description: null, area: null, branch_codes: [], branches_text: 'Zamora', salary_text: null,
      schedule_text: null, requirements: null, image_url: null, competencies_sheet: null, extra: {}, is_active: false, sort_order: 1, created_at: '', updated_at: '' };
    const ver = await montar(RhVacantesComponent, api({ vacantes: vi.fn(() => of([v])) }), [Permission.HR_RECRUITMENT_VER]);
    expect(boton(ver, 'Nueva vacante')).toBeUndefined();
    expect(texto(ver)).toContain('Cerrada');
    TestBed.resetTestingModule();
    const gest = await montar(RhVacantesComponent, api({ vacantes: vi.fn(() => of([v])) }), [Permission.HR_RECRUITMENT_GESTIONAR]);
    expect(boton(gest, 'Nueva vacante')).toBeTruthy();
  });
});

describe('[RH.2.3] Revisiones', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('el tiempo por etapa contra la meta: sin meta no se juzga', () => {
    const f = (etapa: string, avg: number): HrTiempoPorEtapaDto => ({ etapa, n: 3, avg_horas: avg, min_horas: 1, max_horas: 90 });
    expect(contraMeta(f('filtro_inicial', 30))).toEqual({ meta: 24, pasa: true });
    expect(contraMeta(f('psicometria', 10))).toEqual({ meta: 72, pasa: false });
    expect(contraMeta(f('dictamen', 999))).toEqual({ meta: null, pasa: null });
  });

  it('⭐ lista a quien regresó estando marcado, con el motivo', async () => {
    const svc = api({
      reingresos: vi.fn(() => of([{ id: 'c9', full_name: 'Carlos Prueba', phone: '5213510000000', stage: 'filtro_inicial', created_at: '2026-10-10T00:00:00Z',
        marcado_id: 'c1', marcado_nombre: 'Carlos P.', motivo: 'abandonó el puesto en Yurécuaro', marcado_por: 'rh', marcado_en: '2026-08-01T00:00:00Z' }])),
    });
    const f = await montar(RhReclutamientoRevisionesComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    expect(texto(f)).toContain('Carlos Prueba');
    expect(texto(f)).toContain('abandonó el puesto en Yurécuaro');
    expect(texto(f)).toContain('351 000 0000');
  });
});
