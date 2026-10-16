import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { ComercialService, ExpedienteDia, ExpedienteUltima } from '../../comercial/comercial.service';
import { DataScopeService, ScopeOption } from '../../../core/services/data-scope.service';
import { CAPTURA_MENSUAL, LIMITE_MENSUAL_DIAS, TiendaCaducidadesDiasComponent } from './tienda-caducidades-dias.component';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe(): void { /* jsdom */ } unobserve(): void { /* jsdom */ } disconnect(): void { /* jsdom */ } };
}

/**
 * `[P2.8.1]` «Capturas por día»: qué es un hueco y qué NO se afirma.
 *
 * El día «de hoy» del server es 2026-10-16 (viernes). El alcance son tres sucursales: 01, 02 y 03.
 *
 *   16 (hoy)  sólo la 01            → «en curso»: todavía no terminó, NO cuenta como hueco
 *   15        01 · 02 · 03          → completo
 *   14        01 · 03               → hueco parcial (falta la 02)
 *   13        nadie                 → sin captura (faltan las tres)
 *   12        01 · 02 · 03          → completo
 *   11        sólo la 02            → hueco parcial (faltan 01 y 03)
 *   10        01 · 02 · 03          → completo
 */
const SUC: ScopeOption[] = [
  { value: '01', label: 'Padre Hidalgo' },
  { value: '02', label: 'La Piedad Abastos' },
  { value: '03', label: '8 Esquinas' },
];
const dia = (fecha: string, sucursal: string, hojas = 2, capturistas = ['Ana']): ExpedienteDia => ({
  fecha, sucursal, warehouse_name: `Suc ${sucursal}`, hojas, capturistas, vencidos: 0, riesgosos: 0,
});
const DATOS: ExpedienteDia[] = [
  dia('2026-10-16', '01'),
  dia('2026-10-15', '01'), dia('2026-10-15', '02'), dia('2026-10-15', '03'),
  dia('2026-10-14', '01'), dia('2026-10-14', '03'),
  dia('2026-10-12', '01'), dia('2026-10-12', '02'), dia('2026-10-12', '03'),
  dia('2026-10-11', '02'),
  dia('2026-10-10', '01'), dia('2026-10-10', '02'), dia('2026-10-10', '03'),
];

describe('TiendaCaducidadesDiasComponent · qué es un hueco', () => {
  let fix: ComponentFixture<TiendaCaducidadesDiasComponent>;
  let cmp: TiendaCaducidadesDiasComponent;
  let llamadas: Array<{ sucursal?: string; dias?: number }>;
  const root = (): HTMLElement => fix.nativeElement as HTMLElement;
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  async function montar(opts: { alcance?: ScopeOption[] | null; datos?: ExpedienteDia[]; falla?: boolean; ultimas?: ExpedienteUltima[]; hoy?: string | null } = {}): Promise<void> {
    llamadas = [];
    const alcance = opts.alcance === undefined ? SUC : opts.alcance;
    await TestBed.configureTestingModule({
      imports: [TiendaCaducidadesDiasComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        {
          provide: ComercialService,
          useValue: {
            expedienteDias: (o: { sucursal?: string; dias?: number }) => {
              llamadas.push(o);
              if (opts.falla) return throwError(() => ({ error: { message: 'boom' } }));
              const filtrados = (opts.datos ?? DATOS).filter((d) => !o.sucursal || d.sucursal === o.sucursal);
              return of({ from: '2026-10-10', to: '2026-10-16', hoy: opts.hoy === undefined ? '2026-10-16' : (opts.hoy as string), data: filtrados, ultimas: opts.ultimas ?? [] });
            },
          },
        },
        { provide: DataScopeService, useValue: { misSucursales: () => signal(alcance).asReadonly() } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaCaducidadesDiasComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
  }

  const estados = (): Record<string, string> =>
    Object.fromEntries(cmp.filas().map((f) => [f.fecha.slice(8), cmp.estadoDe(f)]));
  const kpi = (label: string) => cmp.kpis().find((k) => k.label === label);

  it('⭐ cada día recibe su veredicto: completo, hueco parcial, sin captura y «en curso»', async () => {
    await montar();
    expect(estados()).toEqual({
      '16': 'encurso', '15': 'completo', '14': 'parcial', '13': 'vacio', '12': 'completo', '11': 'parcial', '10': 'completo',
    });
  });

  it('⭐ el día en curso NO cuenta como hueco: se declara, no se castiga a medias', async () => {
    await montar();
    expect(kpi('Días completos')).toMatchObject({ value: 3, sub: 'de 6 días · hoy sigue en curso' });
    expect(kpi('Días con huecos')).toMatchObject({ value: 3, tone: 'warn' });
  });

  it('dice QUÉ sucursales faltaron cada día (contra el alcance de quien mira, no contra una lista fija)', async () => {
    await montar();
    const f = (d: string) => cmp.filas().find((x) => x.fecha.endsWith(d))!;
    expect(f('14').faltan).toEqual(['02']);
    expect(f('11').faltan).toEqual(['01', '03']);
    expect(f('13').faltan).toEqual(['01', '02', '03']);
    expect(f('15').faltan).toEqual([]);
  });

  it('⭐ un día completo el MISMO día de hoy ya no es «en curso»: es completo', async () => {
    await montar({ datos: [dia('2026-10-16', '01'), dia('2026-10-16', '02'), dia('2026-10-16', '03')] });
    const hoy = cmp.filas().find((f) => f.fecha === '2026-10-16')!;
    expect(cmp.estadoDe(hoy)).toBe('completo');
  });

  it('⛔ si el alcance no ha contestado NO se afirma «completo» ni «con huecos»: sólo lo que se ve', async () => {
    await montar({ alcance: null });
    expect(cmp.filas().every((f) => f.faltan === null)).toBe(true);
    const e = estados();
    expect(e['15']).toBe('capturas');   // se subió algo: se dice eso y nada más
    expect(e['13']).toBe('vacio');      // nadie subió nada: eso sí se ve sin saber el alcance
    expect(Object.values(e)).not.toContain('completo');
    expect(Object.values(e)).not.toContain('parcial');
    expect(kpi('Días con huecos')).toBeUndefined();   // un «0 huecos» sería dibujar un cero que no se midió
    expect(kpi('Días completos')).toBeUndefined();
  });

  it('filtrar por una sucursal: se pide al server con su código y se compara SOLO contra ella', async () => {
    await montar();
    cmp.cambiarSucursal('03');
    await tick();
    expect(llamadas.at(-1)).toMatchObject({ sucursal: '03', dias: 30 });
    // la 03 subió 15, 14, 12 y 10 (y hoy no): los días 13 y 11 son hueco; hoy sigue en curso
    const e = estados();
    expect(e).toMatchObject({ '15': 'completo', '14': 'completo', '13': 'vacio', '12': 'completo', '11': 'vacio', '10': 'completo', '16': 'encurso' });
    expect(cmp.mostrarFaltan()).toBe(false);       // con una sola, «sin captura» por sucursal no dice nada
    expect(cmp.mostrarSucursales()).toBe(false);
  });

  it('cambiar el periodo vuelve a pedir con ese número de días', async () => {
    await montar();
    cmp.cambiarVentana('90');
    await tick();
    expect(llamadas.at(-1)).toMatchObject({ dias: 90 });
  });

  it('los filtros «Completos» y «Con huecos» se reparten los días cerrados (hoy en curso no entra en ninguno)', async () => {
    await montar();
    cmp.vista.set('huecos');
    expect(cmp.filas().map((f) => f.fecha.slice(8))).toEqual(['14', '13', '11']);
    cmp.vista.set('completos');
    expect(cmp.filas().map((f) => f.fecha.slice(8))).toEqual(['15', '12', '10']);
    cmp.vista.set('todos');
    expect(cmp.filas()).toHaveLength(7);
  });

  it('⭐ el enlace de un día lleva su fecha, y la sucursal sólo cuando no hay ambigüedad', async () => {
    await montar();
    const f = (d: string) => cmp.filas().find((x) => x.fecha.endsWith(d))!;
    expect(cmp.paramsDe(f('15'))).toEqual({ fecha: '2026-10-15' });                    // tres sucursales: sin filtro
    expect(cmp.paramsDe(f('11'))).toEqual({ fecha: '2026-10-11', sucursal: '02' });    // una sola subió: esa
    cmp.cambiarSucursal('03');
    await tick();
    expect(cmp.paramsDe(f('15'))).toEqual({ fecha: '2026-10-15', sucursal: '03' });    // la elegida manda
  });

  it('un error del server se muestra como error (con reintento), no como «no hay nada»', async () => {
    await montar({ falla: true });
    expect(cmp.error()).toBe('boom');
    expect(cmp.kpis()).toEqual([]);
  });

  // ── el CEDIS captura «al menos cada mes»: no es un hueco diario ──────────────────────────
  const CEDIS: ScopeOption = { value: '00', label: 'CEDIS' };
  const dias = (hoy: string, ultima: string): number => Math.round((Date.parse(hoy) - Date.parse(ultima)) / 86_400_000);
  const ult = (ultima: string | null): ExpedienteUltima[] => [{ sucursal: '00', warehouse_name: 'CEDIS', ultima }];

  it('⭐ el CEDIS NO cuenta como hueco diario: con las tres sucursales de diario completas, el día es «completo» aunque el CEDIS no suba', async () => {
    await montar({ alcance: [CEDIS, ...SUC], ultimas: ult('2026-10-05') });
    expect(CAPTURA_MENSUAL.has('00')).toBe(true);
    const f15 = cmp.filas().find((f) => f.fecha === '2026-10-15')!;
    expect(f15.faltan).toEqual([]);                 // 00 no está en `faltan`
    expect(cmp.estadoDe(f15)).toBe('completo');
    expect(cmp.filas().every((f) => !(f.faltan ?? []).includes('00'))).toBe(true);
    expect(cmp.totalSucursales()).toBe(3);          // «n de 3», no «n de 4»
  });

  it('si el CEDIS SÍ sube un día, aparece entre quienes subieron pero no cambia el veredicto de las de diario', async () => {
    await montar({ alcance: [CEDIS, ...SUC], datos: [...DATOS, dia('2026-10-14', '00')], ultimas: ult('2026-10-14') });
    const f14 = cmp.filas().find((f) => f.fecha === '2026-10-14')!;
    expect(f14.sucursales).toContain('00');
    expect(f14.subieronDiarias).toBe(2);            // 01 y 03; la 02 sigue faltando
    expect(f14.faltan).toEqual(['02']);
    expect(cmp.estadoDe(f14)).toBe('parcial');
  });

  it('⭐ el panel mensual mide la antigüedad de la última captura contra el límite, en sus dos bordes', async () => {
    const casos: Array<[string | null, string, number | null]> = [
      ['2026-10-05', 'alcorriente', 11],
      ['2026-09-15', 'alcorriente', LIMITE_MENSUAL_DIAS],        // 31 días exactos: todavía al corriente
      ['2026-09-14', 'atrasada', LIMITE_MENSUAL_DIAS + 1],       // 32: atrasada
      ['2026-06-01', 'atrasada', dias('2026-10-16', '2026-06-01')],
      [null, 'sinregistro', null],                                // nunca: se DECLARA, no se inventa una edad
    ];
    for (const [ultima, estado, edad] of casos) {
      TestBed.resetTestingModule();
      await montar({ alcance: [CEDIS, ...SUC], ultimas: ult(ultima) });
      expect(cmp.mensuales()).toEqual([{ sucursal: '00', nombre: 'CEDIS', ultima, dias: edad, estado }]);
    }
  });

  it('⛔ sin el «hoy» del server NO se afirma si el CEDIS va al corriente: no hay panel', async () => {
    await montar({ alcance: [CEDIS, ...SUC], ultimas: ult('2026-10-05'), hoy: null });
    expect(cmp.mensuales()).toEqual([]);
  });

  it('el panel se pinta con su estado (y no aparece si no hay ninguna sucursal mensual a la vista)', async () => {
    await montar({ alcance: [CEDIS, ...SUC], ultimas: ult('2026-09-01') });
    const txt = (fix.nativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('Captura mensual');
    expect(txt).toContain('Atrasada');
    TestBed.resetTestingModule();
    await montar();                                  // sólo 01, 02, 03
    expect((fix.nativeElement as HTMLElement).textContent).not.toContain('Captura mensual');
  });

  it('⭐ mirando SÓLO el CEDIS, un día sin hojas no es hueco ni «completo»: no hay nada diario que comparar', async () => {
    await montar({ alcance: [CEDIS, ...SUC], datos: [dia('2026-10-14', '00')], ultimas: ult('2026-10-14') });
    cmp.vista.set('huecos');
    cmp.cambiarSucursal('00');                       // al elegir el CEDIS, el filtro «huecos» ya no aplica
    await tick();
    expect(cmp.vista()).toBe('todos');
    expect(cmp.hayDiarias()).toBe(false);
    const e = Object.fromEntries(cmp.filas().map((f) => [f.fecha.slice(8), cmp.estadoDe(f)]));
    expect(e['14']).toBe('capturas');
    expect(e['13']).toBe('nodiaria');
    expect(Object.values(e)).not.toContain('vacio');
    expect(Object.values(e)).not.toContain('completo');
    expect(cmp.kpis().find((k) => k.label === 'Días con huecos')).toBeUndefined();
    expect(cmp.mensuales().map((m) => m.estado)).toEqual(['alcorriente']);
  });

  it('⭐ [candado] cada fila tiene tantas celdas como encabezados — un `display:flex` en el td las desalineó una vez', async () => {
    await montar();
    const ths = root().querySelectorAll('thead th').length;
    const filas = Array.from(root().querySelectorAll('tbody tr'));
    expect(filas.length).toBe(7);
    for (const tr of filas) expect(tr.children.length).toBe(ths);
    // ninguna celda debe dejar de ser celda de tabla: eso es lo que rompe la alineación
    for (const td of Array.from(root().querySelectorAll('tbody td'))) {
      expect(getComputedStyle(td).display).not.toBe('flex');
    }
  });
});
