import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { VisitMonitorResponse, VisitMonitorRow, VisitMonitorVendor } from '@megadulces/contracts';
import { ComercialVisitasDiaComponent, STATUS_LABEL } from './comercial-visitas-dia.component';
import { VisitMonitorService } from '../visit-monitor.service';

/**
 * `[MCP.3.7]` Visitas del día (supervisor). Lo que importa: (1) un error NO se pinta como «nadie
 * tenía ruta»; (2) lo no medido se nombra y NO suma a faltas; (3) con rutas abiertas, la cifra de
 * faltas se declara parcial; (4) el filtro «Faltas» deja sólo las faltas; (5) cambiar la fecha o el
 * vendedor vuelve a pedir con ese filtro.
 */
const fila = (o: Partial<VisitMonitorRow>): VisitMonitorRow => ({
  customer_id: 'c', code: 'C', name: 'Cliente', on_route: true, has_location: true, status: 'pendiente',
  no_sale_reason: null, notes: null, visited_at: null, ended_at: null, distance_m: null, far: false, nearest_m: null, ...o,
});
const conteos = (o: Partial<VisitMonitorVendor['counts']> = {}) => ({
  clientes: 0, visitados: 0, con_pedido: 0, sin_pedido: 0, abiertas: 0, faltas: 0, se_fue_sin_abrir: 0,
  no_paso: 0, sin_ubicacion: 0, sin_gps: 0, pendientes: 0, lejos: 0, ...o,
});
const ROWS: VisitMonitorRow[] = [
  fila({ customer_id: 'a', name: 'ABARROTES LUPITA', status: 'con_pedido', visited_at: '2026-10-21T16:05:00Z', distance_m: 12 }),
  fila({ customer_id: 'b', name: 'TIENDA DON BETO', status: 'sin_pedido', no_sale_reason: 'sin_recursos', visited_at: '2026-10-21T16:30:00Z', distance_m: 1500, far: true }),
  fila({ customer_id: 'c', name: 'MISCELANEA CHUY', status: 'se_fue_sin_abrir', nearest_m: 30 }),
  fila({ customer_id: 'd', name: 'ABARROTES DORA', status: 'sin_ubicacion', has_location: false }),
];
const RESP = (o: Partial<VisitMonitorResponse> = {}): VisitMonitorResponse => ({
  date: '2026-10-21', today: '2026-10-21', radius_m: 80, max_accuracy_m: 100, scope: 'equipo',
  alcance: { tipo_ruta: null, etiqueta: null },
  vendor_options: [{ user_id: 'v1', name: 'Rosa' }],
  vendors: [{
    user_id: 'v1', name: 'Rosa', routes: ['RUTA 27'], route_source: 'agenda', day_state: 'finalizada',
    started_at: '2026-10-21T14:00:00Z', finished_at: '2026-10-21T22:00:00Z', closed: true,
    gps_points: 320, gps_first_at: '2026-10-21T14:01:00Z', gps_last_at: '2026-10-21T21:58:00Z',
    counts: conteos({ clientes: 4, visitados: 2, con_pedido: 1, sin_pedido: 1, faltas: 1, se_fue_sin_abrir: 1, sin_ubicacion: 1, lejos: 1 }),
    rows: ROWS,
  }],
  totals: conteos({ clientes: 4, visitados: 2, con_pedido: 1, sin_pedido: 1, faltas: 1, se_fue_sin_abrir: 1, sin_ubicacion: 1, lejos: 1 }),
  ...o,
});

async function montar(resp: () => ReturnType<VisitMonitorService['monitor']>) {
  const svc = { monitor: vi.fn(resp) };
  await TestBed.configureTestingModule({
    imports: [ComercialVisitasDiaComponent],
    providers: [provideRouter([]), { provide: VisitMonitorService, useValue: svc }],
  }).compileComponents();
  const fix = TestBed.createComponent(ComercialVisitasDiaComponent);
  fix.detectChanges();
  await fix.whenStable();
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  return { fix, el, texto, svc, cmp: fix.componentInstance };
}

describe('ComercialVisitasDiaComponent · [MCP.3.7]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ un error se dice como error, nunca como «nadie tenía ruta»', async () => {
    const { texto } = await montar(() => throwError(() => ({ error: { message: 'Esa persona no es de tu equipo' } })));
    expect(texto()).toContain('Esa persona no es de tu equipo');
    expect(texto()).not.toContain('Nadie de tu equipo tenía ruta');
  });

  it('vacío real: lo dice, con el porqué del equipo', async () => {
    const { texto } = await montar(() => of(RESP({ vendors: [], totals: conteos() })));
    expect(texto()).toContain('Nadie de tu equipo tenía ruta ese día');
    expect(texto()).toContain('No tienes vendedores a tu cargo');
  });

  it('⭐ pinta cada estado con su nombre, el motivo en llano y la distancia lejana marcada', async () => {
    const { texto } = await montar(() => of(RESP()));
    expect(texto()).toContain('Rosa');
    expect(texto()).toContain('RUTA 27');
    expect(texto()).toContain('Con pedido');
    expect(texto()).toContain('No tiene dinero');
    expect(texto()).toContain('1.5 km · lejos');
    expect(texto()).toContain('Se fue sin abrir');
    expect(texto()).toContain('1 cliente sin ubicación sin visitar');
    expect(texto()).toContain('GPS de');
  });

  it('⛔ «Sin ubicación» y «Sin GPS» no suman a faltas; con rutas abiertas las faltas se declaran parciales', async () => {
    const { cmp } = await montar(() => of(RESP()));
    const faltas = cmp.kpis().find((k) => k.label === 'Faltas')!;
    expect(faltas.value).toBe(1);
    expect(faltas.state).toBeUndefined();
    // Uno juzgado y otro con la ruta abierta: la cifra existe, pero es parcial.
    const abiertas = RESP();
    abiertas.vendors.push({ ...abiertas.vendors[0], user_id: 'v2', name: 'Beto', closed: false, day_state: 'en_ruta' });
    cmp.data.set(abiertas);
    const f2 = cmp.kpis().find((k) => k.label === 'Faltas')!;
    expect(f2.state).toBe('parcial');
    expect(f2.stateNote).toContain('ruta sigue abierta');
  });

  it('el filtro «Faltas» deja sólo las faltas', async () => {
    const { cmp, fix, texto } = await montar(() => of(RESP()));
    cmp.filter.set('faltas');
    fix.detectChanges();
    expect(texto()).toContain('MISCELANEA CHUY');
    expect(texto()).not.toContain('ABARROTES LUPITA');
    expect(texto()).not.toContain('ABARROTES DORA');
  });

  it('cambiar fecha o vendedor vuelve a pedir con ese filtro', async () => {
    const { cmp, svc } = await montar(() => of(RESP()));
    cmp.setDate(new Date('2026-10-20T18:00:00Z'));
    expect(svc.monitor).toHaveBeenLastCalledWith('2026-10-20', null);
    cmp.setUser('v1');
    expect(svc.monitor).toHaveBeenLastCalledWith('2026-10-20', 'v1');
  });

  describe('sin información basura', () => {
    const veinte = (o: Partial<VisitMonitorRow>, n: number, pref: string) =>
      Array.from({ length: n }, (_, i) => fila({ customer_id: `${pref}${i}`, name: `${pref.toUpperCase()} ${i}`, ...o }));
    const conFilas = (rows: VisitMonitorRow[], o: Partial<VisitMonitorVendor> = {}, r: Partial<VisitMonitorResponse> = {}) => {
      const base = RESP(r);
      base.vendors[0] = { ...base.vendors[0], rows, ...o };
      return base;
    };

    it('la regla de «falta» ya no ocupa el cuerpo: está en la ayuda junto a Faltas', async () => {
      const { texto, el } = await montar(() => of(RESP()));
      expect(texto()).not.toContain('estuvo a menos de');
      expect(texto()).not.toContain('no se cuenta como falta');
      expect(el.querySelector('app-context-help')?.getAttribute('topic')).toBe('visitas-del-dia');
    });

    it('cabecera: sólo el código de ruta; «agenda vigente» sólo si no es hoy; GPS de 1 punto = «Sin GPS suficiente»', async () => {
      const unPunto = { gps_points: 1, gps_first_at: '2026-10-21T21:40:00Z', gps_last_at: '2026-10-21T21:40:00Z', routes: ['1V003 PAULINA MICHELLE PLACENCIA BRAVO'] };
      const { texto, cmp, fix } = await montar(() => of(conFilas(ROWS, unPunto)));
      expect(texto()).toContain('1V003');
      expect(texto()).not.toContain('PLACENCIA');
      expect(texto()).not.toContain('agenda vigente');
      expect(texto()).toContain('Sin GPS suficiente');
      expect(texto()).not.toMatch(/GPS de .* a /);
      cmp.data.set(conFilas(ROWS, unPunto, { date: '2026-10-20' }));
      fix.detectChanges();
      expect(texto()).toContain('agenda vigente');
    });

    it('⭐ los sin ubicación NO visitados se juntan en UNA línea plegada; los visitados sin ubicación sí van en la tabla', async () => {
      const rows = [
        ...veinte({ status: 'sin_ubicacion', has_location: false }, 14, 'su'),
        fila({ customer_id: 'vx', name: 'VISITADO SIN UBIC', status: 'sin_pedido', has_location: false, visited_at: '2026-10-21T16:00:00Z', no_sale_reason: 'cerrado' }),
        fila({ customer_id: 'f', name: 'FALTA', status: 'no_paso' }),
      ];
      const { el, texto } = await montar(() => of(conFilas(rows)));
      const filas = el.querySelectorAll('p-table tbody tr');
      expect(filas.length).toBe(2);
      expect(texto()).toContain('14 clientes sin ubicación sin visitar');
      const fold = el.querySelector('details.vd-fold')!;
      expect(fold.querySelectorAll('li').length).toBe(14);
      expect(texto()).toContain('VISITADO SIN UBIC');
    });

    it('celdas sin dato = «—» con el motivo en title; columna sin NINGÚN dato se oculta', async () => {
      const rows = [
        fila({ customer_id: 'a', name: 'A', status: 'con_pedido', visited_at: '2026-10-21T16:05:00Z', distance_m: null }),
        fila({ customer_id: 'b', name: 'B', status: 'no_paso' }),
      ];
      const { el, texto } = await montar(() => of(conFilas(rows)));
      expect(texto()).not.toContain('Distancia al abrir');
      expect(texto()).not.toContain('Lo más cerca que pasó');
      expect(texto()).not.toContain('sin GPS al abrir');
      expect(el.querySelector('[title="No lo abrió"]')?.textContent?.trim()).toBe('—');
    });

    it('si alguna fila tiene distancia, la columna aparece y la vacía dice por qué en title', async () => {
      const rows = [
        fila({ customer_id: 'a', name: 'A', status: 'con_pedido', visited_at: '2026-10-21T16:05:00Z', distance_m: 12 }),
        fila({ customer_id: 'b', name: 'B', status: 'sin_pedido', visited_at: '2026-10-21T16:30:00Z', distance_m: null, no_sale_reason: 'cerrado' }),
      ];
      const { el, texto } = await montar(() => of(conFilas(rows)));
      expect(texto()).toContain('Distancia al abrir');
      expect(texto()).not.toContain('Lo más cerca que pasó');
      expect(el.querySelector('[title="El celular no mandó GPS al abrir"]')).not.toBeNull();
    });

    it('⭐ orden: faltas → sin pedido → con pedido → pendientes', async () => {
      const rows = [
        fila({ customer_id: '1', name: 'PEND', status: 'pendiente' }),
        fila({ customer_id: '2', name: 'CONP', status: 'con_pedido', visited_at: '2026-10-21T16:05:00Z' }),
        fila({ customer_id: '3', name: 'SINP', status: 'sin_pedido', visited_at: '2026-10-21T16:06:00Z', no_sale_reason: 'cerrado' }),
        fila({ customer_id: '4', name: 'FALT', status: 'se_fue_sin_abrir', nearest_m: 20 }),
      ];
      const { el } = await montar(() => of(conFilas(rows)));
      const nombres = [...el.querySelectorAll('p-table tbody tr .vd-cname')].map((x) => x.textContent?.trim());
      expect(nombres).toEqual(['FALT', 'SINP', 'CONP', 'PEND']);
    });

    it('KPIs: sólo Visitados, Con pedido, Sin pedido y Faltas; sin ubicación como dato secundario', async () => {
      const { cmp, texto } = await montar(() => of(RESP()));
      expect(cmp.kpis().map((k) => k.label)).toEqual(['Visitados', 'Con pedido', 'Sin pedido', 'Faltas']);
      expect(texto()).toContain('1 de 4 clientes sin ubicación');
    });

    it('⛔ si ningún día se puede juzgar, Faltas se declara «sin medir», nunca un 0', async () => {
      const { cmp } = await montar(() => of(conFilas(ROWS, { closed: false, day_state: 'en_ruta' })));
      const f = cmp.kpis().find((k) => k.label === 'Faltas')!;
      expect(f.state).toBe('no_medido');
      expect(f.value).not.toBe(0);
    });

    it('alcance vecinal: una línea discreta «Rutas vecinales» y el vacío lo dice', async () => {
      const { texto } = await montar(() => of(RESP({ alcance: { tipo_ruta: 'vecinal', etiqueta: 'Rutas vecinales' }, vendors: [], totals: conteos() })));
      expect(texto()).toContain('Rutas vecinales');
      expect(texto()).toContain('Nadie de tu equipo tenía ruta vecinal ese día');
    });
  });

  it('todos los estados tienen texto (ninguno se pinta con su clave cruda)', () => {
    for (const v of Object.values(STATUS_LABEL)) expect(v.label).not.toMatch(/_/);
  });
});
