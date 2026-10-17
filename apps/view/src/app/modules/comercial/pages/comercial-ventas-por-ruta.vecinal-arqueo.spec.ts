import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, Subject } from 'rxjs';
import { ComercialService, SalesByRouteRow, VecinalConciliacion } from '../comercial.service';
import { ComercialVentasPorRutaComponent } from './comercial-ventas-por-ruta.component';

/**
 * `[VEC.24]` — **La pestaña «Depósito» no hereda el arqueo de la ruta anterior.**
 *
 * ── El defecto, medido en prod el 2026-10-16 ─────────────────────────────────────────────────
 * Abrir `1V002` y después `1V001` publicaba los 13 días de octubre **de 1V002** bajo el título
 * «Ruta 1V001». El 03-oct decía $7,498 donde `1V001` había vendido **$22,903.59**; el 02-oct,
 * $6,953 contra $25,141.97. El backend estaba bien: devuelve lo correcto para cada ruta.
 *
 * ── Por qué no se veía ───────────────────────────────────────────────────────────────────────
 * Se juntaron tres cosas, y ninguna sola alcanza:
 *   1. `openRoute()` tiraba `depReporte` (el depósito de CAOS) y **no** `arqData`.
 *   2. `setTab('deposito')` sólo pide si `!arqData()`, así que con la respuesta vieja en mano la
 *      ruta nueva **no volvía a preguntar**.
 *   3. `arqFilas` filtra por PERTENENCIA a `rutas`, y en Padre Hidalgo las dos rutas timbran en
 *      la misma caja TODOS los días — así que las filas viejas **pasaban el filtro enteras**.
 *
 * ⭐ Por eso la prueba vigila el efecto y no la línea: afirma que la ruta nueva **vuelve a
 * preguntar** y que mientras tanto **no muestra** el número de la anterior. Una prueba que sólo
 * mirara `arqData === null` seguiría verde si mañana alguien cambia el guard de `setTab`.
 */

const FILA_1V002: VecinalConciliacion['filas'][number] = {
  warehouse_code: '01',
  warehouse_name: 'Padre Hidalgo',
  caja: 4,
  date: '2026-10-03',
  rutas: ['1V001', '1V002'],
  vecinal: 30402.07,
  tickets: 13,
  arqueo_venta: 30402.07,
  otros_en_la_caja: 0,
  vecinal_pct: 100,
  efectivo_esperado: 30402.07,
  efectivo_contado: 30402.07,
  efectivo_diff: 0,
  veredicto: 'cuadra',
  // ⛔ Éste es el número envenenado: es la venta de 1V002, no la de 1V001 ($22,903.59).
  vecinal_ruta: 7498.48,
} as VecinalConciliacion['filas'][number];

function ruta(route_no: string): SalesByRouteRow {
  return {
    warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
    route_code: route_no, route_no, label: `RUTA VECINAL PH ${route_no.slice(-1)}`,
    monthly: {}, revenue_total: 0, units_total: 0, tickets_total: 0, share_pct: 0,
  };
}

function montar() {
  /**
   * ⚠️ **Un Subject POR LLAMADA, no uno compartido.** Con uno solo, `next()` alimenta a las dos
   * suscripciones y la prueba de la respuesta tardía falla por culpa del doble: la segunda
   * suscripción —que sí es de la ruta abierta— pinta el dato y parece que el código no filtró.
   * Un doble que no distingue las llamadas no puede juzgar cuál llegó tarde.
   */
  const arqueos: Subject<VecinalConciliacion>[] = [];
  const svc = {
    salesByRoute: vi.fn().mockReturnValue(of({ rows: [], months: [], totals: null })),
    salesByRouteRoutes: vi.fn().mockReturnValue(of([])),
    salesByRouteProducts: vi.fn().mockReturnValue(of([])),
    salesByRouteClients: vi.fn().mockReturnValue(of([])),
    salesByRouteDetail: vi.fn().mockReturnValue(of({
      route_code: '1V001', daily: [], products: [], clients: [], units: [], tickets: null,
    })),
    vecinalConciliacion: vi.fn().mockImplementation(() => {
      const s = new Subject<VecinalConciliacion>();
      arqueos.push(s);
      return s;
    }),
    routeCreditSales: vi.fn().mockReturnValue(of({ filas: [], summary: null })),
  };
  TestBed.configureTestingModule({
    imports: [ComercialVentasPorRutaComponent],
    providers: [
      provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      { provide: ComercialService, useValue: svc },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
    ],
  });
  const fix = TestBed.createComponent(ComercialVentasPorRutaComponent);
  return { cmp: fix.componentInstance as any, svc, arqueos };
}

describe('VEC.24 · el arqueo de la vecinal no se hereda entre rutas', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ al abrir otra ruta vuelve a PREGUNTAR el arqueo, no reusa el de la anterior', () => {
    const { cmp, svc, arqueos } = montar();

    cmp.openRoute(ruta('1V002'));
    cmp.setTab('deposito');
    expect(svc.vecinalConciliacion).toHaveBeenCalledTimes(1);
    expect(svc.vecinalConciliacion).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), '1V002');
    arqueos[0].next({ filas: [FILA_1V002] } as VecinalConciliacion);
    expect(cmp.arqDias().length).toBe(1);

    // Y ahora la otra ruta de la MISMA caja: es donde el defecto se publicaba.
    cmp.openRoute(ruta('1V001'));
    cmp.setTab('deposito');
    expect(svc.vecinalConciliacion).toHaveBeenCalledTimes(2);
    expect(svc.vecinalConciliacion).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), '1V001');
    // ⭐ Y mientras la respuesta no llega, la tabla está VACÍA — no con el número de 1V002.
    expect(cmp.arqDias().length).toBe(0);
  });

  it('⛔ una respuesta que llega TARDE, de la ruta vieja, no se pinta', () => {
    const { cmp, svc, arqueos } = montar();

    cmp.openRoute(ruta('1V002'));
    cmp.setTab('deposito');
    // Se cambia de ruta con la petición de 1V002 todavía en vuelo.
    cmp.openRoute(ruta('1V001'));
    cmp.setTab('deposito');
    expect(svc.vecinalConciliacion).toHaveBeenCalledTimes(2);

    // Llega la vieja (`arqueos[0]`, la de 1V002), después de haber abierto 1V001. Si se pintara,
    // 1V001 mostraría los $7,498.48 de 1V002 otra vez.
    arqueos[0].next({ filas: [FILA_1V002] } as VecinalConciliacion);
    expect(cmp.arqDias().length).toBe(0);
  });
});

/**
 * `[VEC.31]` — **«1 vencida(s)» tiene que decir CUÁL.**
 *
 * Edgar, 2026-10-16, mirando la pantalla: *«me dice una vencida pero no sé cuál»*. Un contador
 * sin el documento detrás no deja hacer nada: el número que alarma tiene que llevar a la factura.
 *
 * ⭐ Se afirma sobre las FACTURAS que la pantalla mostraría, no sobre el estado del acordeón:
 * `creditoAbierto() === fecha` seguiría verde aunque el filtro trajera las facturas del día
 * equivocado — que es exactamente la clase de defecto que `[VEC.24]` acaba de costar.
 */
describe('VEC.31 · el crédito del día se abre y nombra sus facturas', () => {
  afterEach(() => TestBed.resetTestingModule());

  const fac = (folio: string, fecha: string, extra: Record<string, unknown> = {}) => ({
    warehouse_code: '01', warehouse_name: 'Padre Hidalgo', route_no: '1V001', route_name: null,
    folio, fecha, vence: fecha, cliente_code: 'C1', importe: 1000, neto: 1000,
    cobrado: 0, saldo: 1000, cobranza: 'vigente', dias_vencida: null, abonos: [], ...extra,
  });

  it('⛔ abre SÓLO las facturas de ese día, y nombra la vencida', () => {
    const { cmp } = montar();
    cmp.openRoute(ruta('1V001'));
    cmp.creditoData.set({
      filas: [
        fac('0001595', '2026-10-08', { cobranza: 'vencida', dias_vencida: 6, saldo: 6424 }),
        fac('0001618', '2026-10-12'),
      ],
      summary: null,
    } as never);

    // Antes de abrir no hay detalle: la fila no se expande sola.
    expect(cmp.creditoAbierto()).toBeNull();

    cmp.verCredito('2026-10-08');
    const fs = cmp.facturasDelDia('2026-10-08');
    expect(fs?.length).toBe(1);
    expect(fs?.[0].folio).toBe('0001595');
    // ⭐ Lo que el usuario fue a buscar: cuál, y hace cuánto.
    expect(cmp.etiquetaCobranza(fs![0])).toBe('VENCIDA hace 6 d');

    // El día de al lado NO se cuela.
    expect(cmp.facturasDelDia('2026-10-12')?.[0].folio).toBe('0001618');
  });

  it('⛔ un día sin facturas devuelve null, no una lista vacía', () => {
    // ADR-056: «no llegó el detalle» y «no hay» se dicen distinto. Con `[]` la plantilla
    // pintaría un bloque vacío, que se lee como «este día no facturó» — y puede ser que el
    // detalle no haya llegado.
    const { cmp } = montar();
    cmp.openRoute(ruta('1V001'));
    cmp.creditoData.set({ filas: [fac('0001618', '2026-10-12')], summary: null } as never);
    expect(cmp.facturasDelDia('2026-10-09')).toBeNull();
  });

  it('⛔ el mismo click cierra: no quedan dos días abiertos a la vez', () => {
    const { cmp } = montar();
    cmp.openRoute(ruta('1V001'));
    cmp.verCredito('2026-10-08');
    expect(cmp.creditoAbierto()).toBe('2026-10-08');
    cmp.verCredito('2026-10-12');
    expect(cmp.creditoAbierto()).toBe('2026-10-12');
    cmp.verCredito('2026-10-12');
    expect(cmp.creditoAbierto()).toBeNull();
  });
});
