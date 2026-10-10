import { readFileSync } from 'fs';
import { join } from 'path';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { Freshness } from '@megadulces/contracts';

import { ComprasPedidoRealComponent } from './compras-pedido-real.component';
import { ComprasService } from '../compras.service';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';

/**
 * `[RA-PERF.6]` / `[RA-PERF.8]` — el primer candado de ESTA pantalla.
 *
 * Medido el 2026-10-07: `/compras/pedido` tenía **cero** pruebas sobre el componente. Las cuatro
 * specs del módulo (`pedido-redondeo`, `pedido-unidades`, `pedido-requisicion-*`) cubren los
 * ayudantes que se habían EXTRAÍDO; las 3,652 líneas que quedaron —la orquestación de carga, el
 * grafo de signals, el guard de recursión y la píldora— no tenían ninguna. Por eso un guard que no
 * podía disparar sobrevivió 69 días en prod y una píldora muda pasó varias revisiones.
 *
 * Montar la pantalla también compila su template, que es la otra mitad de lo que no se verificaba.
 */

/** jsdom no implementa ResizeObserver y PrimeNG lo usa al montar. */
class ResizeObserverStub {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const FILTROS = { suppliers: [], brands: [], categories: [], warehouses: [] };

const VACIO = {
  total: 0, page: 1, pageSize: 20, coverage_days: 30,
  territories: [], totals: { pedido: 0, venta: 0, exis: 0 }, rows: [],
};

/**
 * `[RA.TR]` Lo que devuelve el diálogo de "En camino". Es mutable a propósito: los casos que
 * importan son justo los que cambian la FORMA de la respuesta (un backend sin desplegar que no
 * manda `aviso_transito`), no sus números.
 */
let EN_CAMINO: Record<string, unknown> | null = null;

/**
 * `[RA.CAP]` Lo que devuelve la deuda por acreedor. `'error'` simula el 403 de un comprador sin
 * permiso de Finanzas — el caso que NO puede terminar diciendo «no le debemos nada».
 */
let DEUDA: Record<string, unknown> | 'error' = { al: '2026-10-09', acreedores: [] };

/**
 * `[RA.PM]` Lo que devuelve la autopsia. `'error'` simula el 42P01 de un deploy que llego ANTES
 * que su migracion -- el caso que NO puede terminar leyendose como "no hay compras que no rindieran".
 */
let PM: Record<string, unknown> | 'error' = {
  veredictos: [], total_comprado: 0, total_nunca_salio: 0, total_sin_resolver: 0,
  computed_on: null, ventana_dias: 180, rows: [], total: 0, page: 1, pageSize: 50,
};

const FRESCO: Freshness = {
  data_as_of: new Date(Date.now() - 4 * 60_000).toISOString(),
  status: 'fresh', stale: false, age_human: '4 min',
  inputs: [{
    key: 'fact_replenishment_plan_stock', label: 'Fact del pedido (existencia + demanda)',
    at: new Date(Date.now() - 4 * 60_000).toISOString(), age_human: '4 min', status: 'fresh', stale: false,
  }],
};

/** `[RA-CICLO.1]` Un canal de reabasto, con lo mínimo que la pantalla lee de él. */
function canal(p: Partial<Record<string, unknown>> = {}) {
  return {
    warehouse_id: 'w-01', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
    supplier_id: 's-1', supplier_name: 'DULCES DEMO', via: 'purchase',
    source_warehouse_id: null, source_warehouse_code: null,
    cadence_days: 15, health_band: null,
    last_delivery_date: '2026-09-01', next_due_date: '2026-09-16',
    days_to_due: -22, lead_time_days: 4,
    n_skus: 40, n_below: 12, suggested_qty: 300, suggested_cost: 125000,
    ...p,
  };
}

function montar(workbook: Record<string, unknown>, worklist?: unknown, sub = 'u1') {
  const api = {
    filters: () => of(FILTROS),
    workbook: () => of(workbook),
    purchaseSuggestion: () => of({ rows: [] }),
    transferSuggestion: () => of({ rows: [] }),
    overstock: () => of({ rows: [] }),
    deadStock: () => of({ rows: [], total_value: 0 }),
    inTransit: () => of(EN_CAMINO),
    postmortem: () => (PM === 'error' ? throwError(() => new Error('42P01')) : of(PM)),
    sobrante: () => of({ tramos: [], total_valor: 0, total_quedado: 0, total_quedado_valor: 0, ventana_dias: 90, rows: [], total: 0, page: 1, pageSize: 50 }),
    // `[RA.CAP]` `null` = la llamada falló (es lo que devuelve el `catchError` del componente).
    deudaPorProveedor: () => (DEUDA === 'error' ? throwError(() => new Error('403')) : of(DEUDA)),
    worklist: () => (worklist === 'error'
      ? throwError(() => new Error('500'))
      : of(worklist ?? { total: 0, vencidos: 0, hoy: 0, prox7: 0, page: 1, pageSize: 500, rows: [] })),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ComprasPedidoRealComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ComprasService, useValue: api },
      { provide: AuthService, useValue: { user: () => ({ sub }), token: () => null, has: () => true } },
      { provide: UsoService, useValue: { reportarIncidente: () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(ComprasPedidoRealComponent);
  fixture.detectChanges();
  return fixture;
}

describe('[RA-PERF.8] la píldora dice la edad del DATO, y declara cuando no la sabe', () => {
  it('arranca en «sin medir»: nunca nace diciendo que está al día', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.frescura().status).toBe('unknown');
    expect(c.frescura().data_as_of).toBeNull();
  });

  it('toma la frescura que manda el SERVIDOR, no el reloj del navegador', () => {
    const c = montar({ ...VACIO, freshness: FRESCO }).componentInstance;
    expect(c.frescura().status).toBe('fresh');
    expect(c.frescura().data_as_of).toBe(FRESCO.data_as_of);
  });

  it('⛔ un backend que NO manda frescura deja «sin medir», no la frescura de la carga', () => {
    const c = montar(VACIO).componentInstance;
    // Ésta es la regresión que importa: caer a `Date.now()` acá es el bug que VP.0 corrigió en
    // 21 de 24 píldoras de la app — prometer la edad del dato y medir la de la consulta.
    expect(c.frescura().status).toBe('unknown');
    expect(c.frescura().stale).toBe(true);
  });

  it('la pantalla igual se monta y carga sus filas con el campo ausente (backend viejo)', () => {
    const c = montar({ ...VACIO, total: 3, rows: [] }).componentInstance;
    expect(c.wbTotal()).toBe(3);
  });
});

describe('[RA-PERF.6] el guard de recursión existe y no se dispara en uso normal', () => {
  it('money() formatea sin reventar aunque se lo llame miles de veces (volumen != recursión)', () => {
    const c = montar(VACIO).componentInstance;
    let ultimo = '';
    // Muy por encima del contador de 800: el camino caliente real (expandir todo) llama money()
    // cientos de veces con stack CORTO, y eso NO puede tumbar la pantalla.
    for (let i = 0; i < 3000; i++) ultimo = c.money(i);
    expect(ultimo).toContain('2,999');
  });

  it('money() no inventa un número cuando le llega basura', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.money(null)).toContain('0');
    expect(c.money(undefined)).toContain('0');
    expect(c.money('no-es-un-numero')).toContain('0');
  });
});

describe('[RA-CICLO.1] el CUÁNDO: a quién le toca pedir, y qué pasa cuando no se puede medir', () => {
  it('⛔ antes de leer nada, el tablero NO dice «0 vencidos»: dice sin medir', () => {
    const c = montar(VACIO).componentInstance;
    // Arranca en modo 'pedido', así que el ciclo todavía no se consultó. Dibujar un 0 acá sería
    // exactamente el `cfg ? classify : 'ok'` que la Fase VP midió dando verde incondicional:
    // el comprador leería «nadie está vencido» cuando lo que pasa es que nadie preguntó.
    expect(c.cicloKpi().every((k) => k.value === '—')).toBe(true);
    expect(c.cicloKpi()[0].label).toBe('Vencidos');
  });

  it('⛔ si la consulta FALLA, sigue sin medir y lo declara — no cae a cero', () => {
    const c = montar(VACIO, 'error').componentInstance;
    c.setMode('ciclo');
    expect(c.wlError()).toBe(true);
    expect(c.wlRows().length).toBe(0);
    expect(c.cicloKpi()[0].value).toBe('—');
  });

  it('con datos reales cuenta los vencidos y los marca mal, no los deja en neutro', () => {
    const c = montar(VACIO, { total: 737, vencidos: 472, hoy: 31, prox7: 90, page: 1, pageSize: 500, rows: [canal()] }).componentInstance;
    c.setMode('ciclo');
    expect(c.wlError()).toBe(false);
    expect(c.wlRows().length).toBe(1);
    const k = c.cicloKpi();
    expect(k[0].value).toBe(472);
    expect(k[0].tone).toBe('bad');
    expect(k[3].value).toBe(737);
  });

  it('cero vencidos SÍ es un cero legítimo y se pinta bien — la ausencia medida no es la no medida', () => {
    const c = montar(VACIO, { total: 10, vencidos: 0, hoy: 0, prox7: 4, page: 1, pageSize: 500, rows: [] }).componentInstance;
    c.setMode('ciclo');
    expect(c.cicloKpi()[0].value).toBe(0);
    expect(c.cicloKpi()[0].tone).toBe('ok');
  });

  it('el atraso distingue las cuatro situaciones, y «sin fecha» no se disfraza de al día', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.atrasoTxt(canal({ days_to_due: -22 }))).toBe('22 d tarde');
    expect(c.atrasoSev(canal({ days_to_due: -22 }))).toBe('danger');
    expect(c.atrasoTxt(canal({ days_to_due: 0 }))).toBe('hoy');
    expect(c.atrasoSev(canal({ days_to_due: 0 }))).toBe('warn');
    expect(c.atrasoTxt(canal({ days_to_due: 5 }))).toBe('en 5 d');
    expect(c.atrasoTxt(canal({ days_to_due: null }))).toBe('sin fecha');
    expect(c.atrasoSev(canal({ days_to_due: null }))).toBe('secondary');
  });

  it('«Armar» deja el proveedor y la sucursal puestos en el Pedido — ése es el puente', () => {
    const c = montar(VACIO, { total: 1, vencidos: 1, hoy: 0, prox7: 0, page: 1, pageSize: 500, rows: [canal()] }).componentInstance;
    c.setMode('ciclo');
    c.irAPedido(canal());
    expect(c.fSupplier).toBe('s-1');
    expect(c.wbWarehouses).toEqual(['w-01']);
    expect(c.mode()).toBe('pedido');
  });
});

describe('[RA-BORR] el pedido a medio capturar no se pierde', () => {
  const KEY = 'pedido-borrador:u1';
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });

  /** Una fila del workbook con una sucursal en su desglose, lo mínimo para capturar. */
  const fila = () => ({
    product_id: 'p-1', sku: '95434', nombre: 'NIKOLO', supplier_id: 's-1', supplier_name: 'DEMO',
    uxc: 16, caja_cost: 646.29, cells: {}, signals: null,
  });
  /** Una sucursal del desglose. `seed` 0 y `rung` null: lo que se lea sale del capturado, no del motor. */
  const suc = (code: string) => ({ code, name: code, cc: 1, exis: 0, seed: 0, seedUnit: 'caja', rung: null, vta: 0, nat: 0, natu: '', natuRaw: '', hub: false, mx: null, rop: null, added: false });

  it('⛔ cambiar un filtro YA NO borra lo capturado — era el accidente real', () => {
    const c = montar(VACIO).componentInstance;
    c.setDispOf(fila(), suc('01') as never, 12);
    expect(c.qtyOf(fila(), suc('01'))).toBe(12);
    c.loadWorkbook();                       // es lo que dispara cada chip, filtro y buscador
    expect(c.qtyOf(fila(), suc('01'))).toBe(12);
  });

  it('⛔ y el aviso de «cambios sin guardar» sigue ENCENDIDO después de recargar la vista', () => {
    const c = montar(VACIO).componentInstance;
    c.setDispOf(fila(), suc('01') as never, 5);
    expect(c.hasUnsavedChanges()).toBe(true);
    c.loadWorkbook();
    // Apagarlo acá era la mitad silenciosa del defecto: dejaba mudos al guard de ruta y al
    // beforeunload justo cuando hay trabajo que perder.
    expect(c.hasUnsavedChanges()).toBe(true);
  });

  it('lo capturado se escribe en el navegador y vuelve en la siguiente sesión', () => {
    const c = montar(VACIO).componentInstance;
    c.setDispOf(fila(), suc('08') as never, 7);
    c.onBeforeUnload({ preventDefault: () => undefined } as BeforeUnloadEvent);   // fuerza el guardado
    expect(localStorage.getItem(KEY)).toBeTruthy();

    const c2 = montar(VACIO).componentInstance;
    expect(c2.qtyOf(fila(), suc('08'))).toBe(7);
    expect(c2.borradorRecuperado()?.n).toBe(1);
    expect(c2.hasUnsavedChanges()).toBe(true);
  });

  it('⭐ NEGATIVA: un borrador de hace más de 3 días NO se recupera — es de otro ciclo de compra', () => {
    const viejo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    localStorage.setItem(KEY, JSON.stringify({ v: 1, at: viejo, q: { 'p-1|01': 9 }, u: {}, d: {} }));
    const c = montar(VACIO).componentInstance;
    expect(c.borradorRecuperado()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();   // y se limpia solo, no queda basura
  });

  it('⭐ NEGATIVA: el borrador de OTRA persona no se hereda — la llave lleva su usuario', () => {
    // La escribe `u1` (misma computadora, turno anterior) y la abre `u2`. ⚠️ Escrita por el
    // componente, no a mano: si se sembrara la llave con un nombre inventado, quitarle el usuario
    // a `bkey()` seguiría dando verde y la prueba negativa no probaría nada.
    const a = montar(VACIO).componentInstance;
    a.setDispOf(fila(), suc('01') as never, 99);
    a.onBeforeUnload({ preventDefault: () => undefined } as BeforeUnloadEvent);
    expect(localStorage.getItem(KEY)).toBeTruthy();

    const b = montar(VACIO, undefined, 'u2').componentInstance;
    // En una sucursal la misma computadora la usan varias personas.
    expect(b.borradorRecuperado()).toBeNull();
    expect(b.qtyOf(fila(), suc('01'))).toBe(0);
  });

  it('⭐ NEGATIVA: un borrador con la forma vieja o corrupta se descarta, no se arrastra', () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 99, at: Date.now(), q: { 'p-1|01': 9 } }));
    expect(montar(VACIO).componentInstance.borradorRecuperado()).toBeNull();
    localStorage.setItem(KEY, 'no-es-json');
    expect(montar(VACIO).componentInstance.borradorRecuperado()).toBeNull();
  });

  it('descartar lo borra de verdad: de la pantalla y del navegador', () => {
    const c = montar(VACIO).componentInstance;
    c.setDispOf(fila(), suc('01') as never, 4);
    c.onBeforeUnload({ preventDefault: () => undefined } as BeforeUnloadEvent);
    c.descartarBorrador();
    expect(c.qtyOf(fila(), suc('01'))).toBe(0);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(c.hasUnsavedChanges()).toBe(false);
  });

  it('sin cantidades no deja cascarón: la próxima sesión no anuncia un pedido vacío', () => {
    const c = montar(VACIO).componentInstance;
    c.onBeforeUnload({ preventDefault: () => undefined } as BeforeUnloadEvent);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(montar(VACIO).componentInstance.borradorRecuperado()).toBeNull();
  });
});

describe('[RA-PEND.2] el lote se frena ANTES del clic, no después de perder el trabajo', () => {
  /** Un documento válido del plan: compra de un proveedor, un almacén, un renglón con cantidad. */
  const doc = (o: Record<string, unknown> = {}) => ({
    warehouse_id: 'w-01', supplier_id: 's-1', source_type: 'supplier',
    lines: [{ product_id: 'p-1', supplier_id: 's-1', source_type: 'supplier', final_qty: 3, unit_cost: 100 }],
    ...o,
  });

  it('un plan sano no tiene bloqueantes — el freno no puede estorbar el camino feliz', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set([doc(), doc({ warehouse_id: 'w-08' })]);
    expect(c.planBloqueos()).toEqual([]);
  });

  it('⛔ pasarse del tope del lote se dice acá, no en un 400 después de armar todo', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set(Array.from({ length: 301 }, () => doc()));
    const bl = c.planBloqueos();
    expect(bl.length).toBeGreaterThan(0);
    expect(bl[0]).toContain('301');
    expect(bl[0]).toContain('300');
  });

  it('un documento sin renglones con cantidad lo señala POR NÚMERO — el lote es todo o nada', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set([doc(), doc({ lines: [{ product_id: 'p-2', final_qty: 0, unit_cost: 10 }] })]);
    expect(c.planBloqueos().some((b: string) => b.includes('documento 2'))).toBe(true);
  });

  it('una compra que mezcla dos proveedores se frena: el servidor la rechaza y tira el lote entero', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set([doc({ lines: [
      { product_id: 'p-1', supplier_id: 's-1', source_type: 'supplier', final_qty: 2, unit_cost: 10 },
      { product_id: 'p-2', supplier_id: 's-2', source_type: 'supplier', final_qty: 2, unit_cost: 10 },
    ] })]);
    expect(c.planBloqueos().some((b: string) => b.includes('más de un proveedor'))).toBe(true);
  });

  it('un traspaso sin origen se frena — es una de las reglas duras de insertRequisition', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set([doc({ source_type: 'branch', supplier_id: null, source_warehouse_id: null })]);
    expect(c.planBloqueos().some((b: string) => b.includes('desde dónde sale'))).toBe(true);
  });

  it('⭐ el tope es EXACTO: 300 pasa y 301 no — un off-by-one acá bloquea un lote legítimo', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set(Array.from({ length: 300 }, () => doc()));
    expect(c.planBloqueos()).toEqual([]);
  });
});

describe('[RA-PERF.7] los índices memoizados no cambian lo que la pantalla responde', () => {
  it('un producto sin filas devuelve SIEMPRE la misma referencia vacía', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.trasRows('no-existe')).toBe(c.trasRows('otro-que-tampoco'));
    expect(c.trasRows('no-existe').length).toBe(0);
  });

  it('sin desglose cargado, el traspaso del producto es 0 y no revienta', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.prodTr('no-existe')).toBe(0);
    expect(c.detailRows('no-existe')).toEqual([]);
  });
});

describe('[RA.TR] el diálogo de "En camino" no explica una regla que ya no corre', () => {
  const FUENTE = readFileSync(join(__dirname, 'compras-pedido-real.component.ts'), 'utf8');

  it('el motivo lo PINTA el servidor, no la pantalla', () => {
    // Si el texto viviera en el template, al cambiar POLITICA_TRANSITO en el backend la pantalla
    // seguiría explicando el comportamiento viejo — y nadie lo notaría, porque sigue siendo una
    // frase con sentido. Por eso viaja en la respuesta (ADR-056).
    expect(FUENTE).toContain('tranAviso()');
    expect(FUENTE).toContain('res.aviso_transito');
  });

  it('⛔ NEGATIVA: el template ya NO trae la explicación vieja de la curva', () => {
    // Era literalmente "Cada orden pesa según su antigüedad", y desde el 2026-10-09 es falsa:
    // ninguna orden pesa, porque ninguna se descuenta.
    expect(FUENTE).not.toContain('Cada orden pesa según su antigüedad');
    expect(FUENTE).not.toContain('se descuenta casi completa');
  });

  it('⭐ y el aviso arranca VACÍO: sin dato del servidor la pantalla calla, no inventa', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.tranAviso()).toBe('');
  });

  it('cuando el servidor manda la política, el diálogo la publica tal cual', () => {
    EN_CAMINO = {
      product: { sku: '95434', nombre: 'DEMO' }, lead_days: 4, rows: [],
      total_cajas: 180, total_valor: 42000,
      descuenta_cajas: 0, fact_cajas: 180,
      politica_transito: 'ignorar', aviso_transito: 'El sugerido NO descuenta las OC en camino.',
    };
    const c = montar(VACIO).componentInstance;
    c.openTransit({ product_id: 'p-1', sku: '95434', nombre: 'DEMO' } as never);
    expect(c.tranAviso()).toBe('El sugerido NO descuenta las OC en camino.');
    expect(c.tranDescuenta()).toBe(0);
  });

  it('⛔ un backend SIN desplegar (sin el campo) deja el aviso vacío, no un texto inventado', () => {
    // Éste es el caso que de verdad puede pasar: el view se despliega antes que la api. Si la
    // pantalla rellenara con la explicación vieja, diría que el motor pesa por antigüedad — que
    // es justo lo que dejó de hacer. Callar es correcto; inventar, no.
    EN_CAMINO = {
      product: { sku: '95434', nombre: 'DEMO' }, rows: [],
      total_cajas: 180, total_valor: 42000, descuenta_cajas: 97.4,
    };
    const c = montar(VACIO).componentInstance;
    c.tranAviso.set('resto de una apertura anterior');
    c.openTransit({ product_id: 'p-1', sku: '95434', nombre: 'DEMO' } as never);
    expect(c.tranAviso()).toBe('');
    // ⭐ Y el número sí llega: la ausencia del motivo no se contagia a la cifra.
    expect(c.tranDescuenta()).toBe(97.4);
  });

  it('⭐ el aviso NO queda pegado entre dos productos distintos', () => {
    EN_CAMINO = { product: null, rows: [], total_cajas: 1, total_valor: 1, aviso_transito: 'A' };
    const c = montar(VACIO).componentInstance;
    c.openTransit({ product_id: 'p-1', sku: 'X', nombre: 'X' } as never);
    expect(c.tranAviso()).toBe('A');
    EN_CAMINO = { product: null, rows: [], total_cajas: 1, total_valor: 1 };
    c.openTransit({ product_id: 'p-2', sku: 'Y', nombre: 'Y' } as never);
    expect(c.tranAviso()).toBe('');
  });
});

describe('[RA.CAP] la deuda del proveedor al momento de pedirle', () => {
  const FILTROS_SUP = {
    suppliers: [
      { id: 's-1', name: 'DULCES DEMO', code: 'C0001', min_order_boxes: null, min_order_amount: null },
      { id: 's-2', name: 'SIN ACREEDOR', code: 'C9999', min_order_boxes: null, min_order_amount: null },
      { id: 's-3', name: 'SIN CODIGO', code: null, min_order_boxes: null, min_order_amount: null },
    ],
    brands: [], categories: [], warehouses: [],
  };

  function montarConDeuda(sub = 'u1') {
    const c = montar(VACIO, undefined, sub).componentInstance;
    c.filters.set(FILTROS_SUP);
    return c;
  }

  beforeEach(() => {
    DEUDA = {
      al: '2026-10-09',
      acreedores: [{ codigo: 'C0001', nombre: 'DULCES DEMO', pendiente: 480000, vencido: 310000, saldo: 480000 }],
    };
  });

  it('sin proveedor elegido no se muestra nada: el dato es POR proveedor', () => {
    const c = montarConDeuda();
    expect(c.deudaProv()).toBeNull();
    expect(c.deudaSinCruce()).toBe(false);
  });

  it('⭐ con proveedor que casa, publica pendiente y vencido', () => {
    const c = montarConDeuda();
    c.fSupplier = 's-1';
    expect(c.deudaProv()?.pendiente).toBe(480000);
    expect(c.deudaProv()?.vencido).toBe(310000);
    expect(c.deudaAl()).toBe('2026-10-09');
  });

  it('⛔ un proveedor SIN acreedor se DECLARA, no se calla', () => {
    // Callarse se lee como "no le debemos nada", que es una afirmación. Acá no se midió.
    const c = montarConDeuda();
    c.fSupplier = 's-2';
    expect(c.deudaProv()).toBeNull();
    expect(c.deudaSinCruce()).toBe(true);
  });

  it('⛔ y uno sin código tampoco se calla', () => {
    const c = montarConDeuda();
    c.fSupplier = 's-3';
    expect(c.deudaSinCruce()).toBe(true);
  });

  it('⭐⭐ si la llamada FALLA (403 del comprador), no dice ni que debe ni que no debe', () => {
    // Éste es el caso que importa: un comprador sin permiso de Finanzas. Mostrar «sin acreedor»
    // sería mentir con cara de dato; mostrar $0 sería peor. El silencio es lo correcto hasta que
    // haya dato, y `deudaError` lo deja registrado.
    DEUDA = 'error';
    const c = montarConDeuda();
    c.fSupplier = 's-1';
    expect(c.deudaError()).toBe(true);
    expect(c.deudaProv()).toBeNull();
    expect(c.deudaSinCruce()).toBe(false);
  });

  it('⭐ un acreedor sin deuda simplemente no viene, y eso SÍ es «no le debemos»', () => {
    // El backend filtra los que están en cero. La diferencia con el caso de arriba es que acá la
    // llamada SÍ funcionó.
    DEUDA = { al: '2026-10-09', acreedores: [] };
    const c = montarConDeuda();
    c.fSupplier = 's-1';
    expect(c.deudaError()).toBe(false);
    expect(c.deudaProv()).toBeNull();
    // ⚠️ Con el mapa vacío NO se declara «sin cruce»: no se puede distinguir de «nadie debe nada».
    expect(c.deudaSinCruce()).toBe(false);
  });

  it('el código se compara sin espacios: Kepler los trae a la derecha', () => {
    DEUDA = { al: '2026-10-09', acreedores: [{ codigo: 'C0001  ', nombre: 'X', pendiente: 10, vencido: 0, saldo: 10 }] };
    const c = montarConDeuda();
    c.fSupplier = 's-1';
    expect(c.deudaProv()?.pendiente).toBe(10);
  });
});

describe('[RA.PM] la autopsia de la compra, como segunda lente de Sobrante', () => {
  beforeEach(() => {
    PM = {
      veredictos: [
        { veredicto: 'nunca_salio', label: 'Nunca salió', pares: 441, comprado: 4435816, salido: 0, en_piso: 3900000 },
        { veredicto: 'rindio', label: 'Rindió', pares: 9000, comprado: 150000000, salido: 210000000, en_piso: 9000000 },
      ],
      total_comprado: 166855583, total_nunca_salio: 4435816, total_sin_resolver: 66378636,
      computed_on: '2026-10-09', ventana_dias: 180,
      rows: [{ product_id: 'p-1', sku: '1', nombre: 'X', proveedor: 'P', supplier_id: null,
        warehouse_code: '01', warehouse_name: 'PH', no_vende: false, comprado: 1000,
        comprado_sin_resolver: 0, n_recibos: 2, primera_compra: null, ultima_compra: '2026-09-01',
        dias_desde_compra: 38, salido: 0, vendido: 0, traspasado: 0, ultima_salida: null,
        valor_hoy: 900, rotacion: 0, veredicto: 'nunca_salio' }],
      total: 1, page: 1, pageSize: 50,
    };
  });

  it('arranca en la lente de existencia: la pestaña no cambia de significado sola', () => {
    expect(montar(VACIO).componentInstance.sobLente()).toBe('existencia');
  });

  it('⭐ al cambiar de lente carga la autopsia y publica sus veredictos', () => {
    const c = montar(VACIO).componentInstance;
    c.setLente('compra');
    expect(c.sobLente()).toBe('compra');
    expect(c.pmVeredictos().length).toBe(2);
    expect(c.pmComprado()).toBe(166855583);
    expect(c.pmSinResolver()).toBe(66378636);
  });

  it('⛔⛔ si el endpoint falla (deploy sin su migración), lo DECLARA — no muestra cero', () => {
    // Una tabla vacía acá se lee como «no hay compras que no rindieran», que es exactamente la
    // conclusión opuesta a la verdadera.
    PM = 'error';
    const c = montar(VACIO).componentInstance;
    c.setLente('compra');
    expect(c.pmError()).toBe(true);
    expect(c.pmRows().length).toBe(0);
    expect(c.pmVeredictos().length).toBe(0);
  });

  it('⛔ la frescura `null` NO se cae a hoy: se declara sin medir', () => {
    PM = { ...(PM as Record<string, unknown>), computed_on: null };
    const c = montar(VACIO).componentInstance;
    c.setLente('compra');
    expect(c.pmComputedOn()).toBeNull();
  });

  it('⭐ `sin_resolver` se pinta NEUTRO, no como una compra que salió mal', () => {
    const c = montar(VACIO).componentInstance;
    const neutro = c.pmCls({ veredicto: 'sin_resolver', label: '', pares: 1, comprado: 1, salido: 0, en_piso: 0 });
    const malo = c.pmCls({ veredicto: 'nunca_salio', label: '', pares: 1, comprado: 1, salido: 0, en_piso: 0 });
    expect(neutro).toContain('mute');
    expect(malo).toContain('bad');
    expect(neutro).not.toBe(malo);
  });

  it('⭐ y su explicación dice que NO se puede juzgar, no que rindió mal', () => {
    const c = montar(VACIO).componentInstance;
    const t = c.pmTitle({ veredicto: 'sin_resolver', label: '', pares: 441, comprado: 4435816, salido: 0, en_piso: 0 });
    expect(t).toMatch(/no se puede juzgar/i);
    // ⛔ Y NO dice nada que suene a desempeño: el dinero está ahí, pero el veredicto no existe.
    expect(t).not.toMatch(/rindió mal|no rindió/i);
  });

  it('la rotación `null` sale como guion, nunca como 0%', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.pmRot({ rotacion: null } as never)).toBe('—');
    expect(c.pmRot({ rotacion: 0 } as never)).toBe('0%');
  });
});
