import { readFileSync } from 'fs';
import { join } from 'path';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { EMPTY, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ConfirmationService } from 'primeng/api';
import type { Freshness } from '@megadulces/contracts';

import { ComprasPedidoRealComponent } from './compras-pedido-real.component';
import { ComprasService } from '../compras.service';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';
import { CONTEXT_HELP } from '../../../shared/context-help/context-help.dictionary';

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

function montar(workbook: Record<string, unknown>, worklist?: unknown, sub = 'u1', extra: Record<string, unknown> = {}) {
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
    // `[RA-UX.1]` El lote se crea: es lo que dispara la limpieza de lo armado.
    createRequisitionBatch: () => of({ batch_id: 'b-1', batch_folio: 'RQ-LOTE-TEST', total: 1, compras: 1, traspasos: 0 }),
    // `[RA-UX.2]` Los dos XLSX: el del servidor (sugerido) y el de lo capturado.
    exportWorkbookXlsx: () => EMPTY,   // sin descarga real: jsdom no tiene createObjectURL
    exportPedidoXlsx: () => EMPTY,
    // `[RA-NEG.1]` El panel de negociación: por default no llega nada (se queda «leyendo»).
    negociacion: () => EMPTY,
    worklist: () => (worklist === 'error'
      ? throwError(() => new Error('500'))
      : of(worklist ?? { total: 0, vencidos: 0, hoy: 0, prox7: 0, page: 1, pageSize: 500, rows: [] })),
    ...extra,
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

describe('[RA-UX] auditoría de interacción 2026-10-21: lo que la persona hace, la pantalla lo cumple', () => {
  const KEY = 'pedido-borrador:u1';
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });
  const fila = (pid = 'p-1') => ({
    product_id: pid, sku: pid, nombre: pid, supplier_id: 's-1', supplier_name: 'DEMO',
    uxc: 16, caja_cost: 646.29, cells: {}, signals: null,
  });
  const suc = (code: string) => ({ code, name: code, cc: 1, exis: 0, seed: 0, seedUnit: 'caja', rung: null, vta: 0, nat: 0, natu: '', natuRaw: '', hub: false, mx: null, rop: null, added: false });
  /** Un plan con UN documento de compra de los productos dados (es lo que arma buildReq). */
  const plan = (...pids: string[]) => [{
    warehouse_id: 'w-01', supplier_id: 's-1', source_type: 'supplier',
    lines: pids.map((product_id) => ({ product_id, supplier_id: 's-1', source_type: 'supplier', final_qty: 3, unit_cost: 100 })),
  }];

  // ── [RA-UX.1] el lote no se puede volver a generar con un clic ──
  it('⛔ tras generar, lo armado SALE: cantidad, marca y aviso de cambios sin guardar', () => {
    const c = montar(VACIO).componentInstance;
    c.setDispOf(fila('p-1') as never, suc('01') as never, 5);
    expect(c.selected().has('p-1')).toBe(true);
    c.plan.set(plan('p-1') as never);
    c.confirmarPlan();
    expect(c.qtyOf(fila('p-1') as never, suc('01') as never)).toBe(0);
    expect(c.selected().has('p-1')).toBe(false);
    expect(c.hasUnsavedChanges()).toBe(false);
  });

  it('⛔ NEGATIVA: al salir de la pantalla NO reescribe el borrador de un pedido ya armado', () => {
    // Era la segunda puerta al duplicado: borradorCleanup volvía a guardar las cantidades y la
    // siguiente visita decía «Recuperé tu pedido a medio capturar» de algo ya generado.
    const f = montar(VACIO);
    const c = f.componentInstance;
    c.setDispOf(fila('p-1') as never, suc('01') as never, 5);
    c.onBeforeUnload({ preventDefault: () => undefined } as BeforeUnloadEvent);
    expect(localStorage.getItem(KEY)).toBeTruthy();
    c.plan.set(plan('p-1') as never);
    c.confirmarPlan();
    f.destroy();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(montar(VACIO).componentInstance.borradorRecuperado()).toBeNull();
  });

  it('lo escrito en OTRO producto, no armado, se queda — con su marca y su borrador', () => {
    const c = montar(VACIO).componentInstance;
    c.setDispOf(fila('p-1') as never, suc('01') as never, 5);
    c.setDispOf(fila('p-2') as never, suc('01') as never, 7);
    c.plan.set(plan('p-1') as never);
    c.confirmarPlan();
    expect(c.qtyOf(fila('p-2') as never, suc('01') as never)).toBe(7);
    expect(c.selected().has('p-2')).toBe(true);
    expect(c.hasUnsavedChanges()).toBe(true);
    const guardado = JSON.parse(localStorage.getItem(KEY) || '{}');
    expect(Object.keys(guardado.q || {})).toEqual(['p-2|01']);
  });

  // ── [RA-UX.3] escribir marca ──
  it('escribir una cantidad marca el producto; escribir 0 no', () => {
    const c = montar(VACIO).componentInstance;
    c.setDispOf(fila('p-1') as never, suc('01') as never, 0);
    expect(c.selected().has('p-1')).toBe(false);
    c.setDispOf(fila('p-1') as never, suc('01') as never, 3);
    expect(c.selected().has('p-1')).toBe(true);
  });

  // [RA-UX.9] Cambia a propósito: desmarcar a mano es una decisión y ya no se reclama. El aviso
  // queda para lo que se quedó afuera SIN querer: un borrador recuperado.
  it('⭐ lo escrito que volvió de un borrador sin estar en la requisición se AVISA, y se puede agregar desde el aviso', () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, at: Date.now(), q: { 'p-1|01': 3 }, u: {}, d: {} }));
    const c = montar(VACIO).componentInstance;
    c.wbRows.set([fila('p-1')] as never);
    expect(c.sinMarcar()).toEqual({ total: 1, cargados: 1 });
    c.marcarEscritos();
    expect(c.selected().has('p-1')).toBe(true);
    expect(c.sinMarcar()).toBeNull();
  });

  it('un borrador recuperado de productos que NO están cargados se avisa, pero no se puede marcar', () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, at: Date.now(), q: { 'p-9|01': 4 }, u: {}, d: {} }));
    const c = montar(VACIO).componentInstance;
    expect(c.sinMarcar()).toEqual({ total: 1, cargados: 0 });
  });

  // ── [RA-UX.2] el XLSX dice qué exporta ──
  it('sin nada marcado, el XLSX dice «sugerido» y baja el del servidor', () => {
    const f = montar(VACIO);
    const c = f.componentInstance;
    const api = TestBed.inject(ComprasService);
    const srv = vi.spyOn(api, 'exportWorkbookXlsx');
    const mio = vi.spyOn(api, 'exportPedidoXlsx');
    c.wbRows.set([fila('p-1')] as never);
    expect(c.xlsxLabel()).toBe('XLSX sugerido');
    c.xlsxGlobal();
    expect(srv).toHaveBeenCalledTimes(1);
    expect(mio).not.toHaveBeenCalled();
  });

  it('⛔ con productos marcados, el XLSX NO baja el sugerido: baja lo marcado', () => {
    const c = montar(VACIO).componentInstance;
    const api = TestBed.inject(ComprasService);
    const srv = vi.spyOn(api, 'exportWorkbookXlsx');
    Object.defineProperty(c, 'selCount', { value: () => 2 });
    expect(c.xlsxLabel()).toBe('XLSX (2)');
    c.xlsxGlobal();
    expect(srv).not.toHaveBeenCalled();
  });

  // ── [RA-UX.5] descartar pregunta ──
  it('⛔ «Descartar» NO borra al primer clic: pregunta, y sólo el «sí» borra', () => {
    const f = montar(VACIO);
    const c = f.componentInstance;
    const conf = f.debugElement.injector.get(ConfirmationService);
    let aceptar: (() => void) | undefined;
    vi.spyOn(conf, 'confirm').mockImplementation((o) => { aceptar = o.accept as () => void; return conf; });
    c.setDispOf(fila('p-1') as never, suc('01') as never, 4);
    c.pedirDescartar();
    expect(c.qtyOf(fila('p-1') as never, suc('01') as never)).toBe(4);
    aceptar?.();
    expect(c.qtyOf(fila('p-1') as never, suc('01') as never)).toBe(0);
  });

  // ── [RA-UX.6] la cobertura se aplica sin esperar el blur, y no recarga por nada ──
  it('la cobertura recarga si cambió, y no recarga con el mismo valor ni fuera de rango', () => {
    const c = montar(VACIO).componentInstance;
    const wb = vi.spyOn(TestBed.inject(ComprasService), 'workbook');
    c.coberturaYa();                       // mismo valor que la carga inicial
    expect(wb).not.toHaveBeenCalled();
    c.coverage = 0; c.coberturaYa();       // a medio teclear
    expect(wb).not.toHaveBeenCalled();
    c.coverage = 45; c.coberturaYa();
    expect(wb).toHaveBeenCalledTimes(1);
  });

  // ── [RA-UX.8] teclado de la fila ──
  it('Enter y Espacio abren la fila; la tecla que nace en un botón de adentro NO', () => {
    const c = montar(VACIO).componentInstance;
    const tr = document.createElement('tr');
    const btn = document.createElement('button');
    const ev = (key: string, target: EventTarget) =>
      ({ key, target, currentTarget: tr, preventDefault: () => undefined }) as unknown as KeyboardEvent;
    c.onRowKey(ev('Enter', btn), fila('p-1') as never);
    expect(c.isOpen(fila('p-1') as never)).toBe(false);
    c.onRowKey(ev(' ', tr), fila('p-1') as never);
    expect(c.isOpen(fila('p-1') as never)).toBe(true);
    c.onRowKey(ev('Enter', tr), fila('p-1') as never);
    expect(c.isOpen(fila('p-1') as never)).toBe(false);
  });

  it('⛔ NEGATIVA: recargar la tabla ya no cierra lo que estaba abierto', () => {
    const c = montar(VACIO).componentInstance;
    c.toggleRow(fila('p-1') as never);
    c.loadWorkbook();
    expect(c.isOpen(fila('p-1') as never)).toBe(true);
  });

  // ── [RA-UX.7] la ayuda no contradice la pantalla ──
  it('⛔ la ayuda «?» ya no dice que el tránsito se resta, ni describe botones retirados', () => {
    const t = CONTEXT_HELP['pedido-compras'];
    const todo = JSON.stringify(t);
    expect(todo).not.toMatch(/Se restan del pedido/);
    expect(todo).not.toMatch(/Englobar|Desglosar/);
    expect(todo).toMatch(/NO se restan del sugerido/);
  });
});

describe('[RA-UX.1b] el servidor frena el lote repetido y la pantalla deja confirmarlo', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });
  const fila = { product_id: 'p-1', sku: 'p-1', nombre: 'p-1', supplier_id: 's-1', supplier_name: 'DEMO', uxc: 16, caja_cost: 1, cells: {}, signals: null };
  const suc = { code: '01', name: '01', cc: 1, exis: 0, seed: 0, seedUnit: 'caja', rung: null, vta: 0, nat: 0, natu: '', natuRaw: '', hub: false, mx: null, rop: null, added: false };
  const plan = [{ warehouse_id: 'w-01', supplier_id: 's-1', source_type: 'supplier', lines: [{ product_id: 'p-1', supplier_id: 's-1', source_type: 'supplier', final_qty: 3, unit_cost: 1 }] }];
  const conflicto = { status: 409, error: { code: 'LOTE_REPETIDO', message: 'Los 1 renglones ya los generaste hace 1 minuto (RQ-LOTE-2026-00103).' } };

  it('⛔ el 409 NO limpia nada ni cierra el plan: lo dice junto al botón, que pasa a ser la confirmación', () => {
    const c = montar(VACIO).componentInstance;
    const api = TestBed.inject(ComprasService);
    const spy = vi.spyOn(api, 'createRequisitionBatch').mockReturnValueOnce(throwError(() => conflicto));
    c.setDispOf(fila as never, suc as never, 3);
    c.plan.set(plan as never); c.planVisible = true;
    c.confirmarPlan();
    expect(spy).toHaveBeenLastCalledWith(plan, false);
    expect(c.repetido()).toMatch(/RQ-LOTE-2026-00103/);
    expect(c.planVisible).toBe(true);
    expect(c.qtyOf(fila as never, suc as never)).toBe(3);   // nada se armó: nada se quita
    expect(c.selected().has('p-1')).toBe(true);
  });

  it('el segundo clic manda allow_duplicate y, al entrar, limpia como siempre', () => {
    const c = montar(VACIO).componentInstance;
    const api = TestBed.inject(ComprasService);
    const spy = vi.spyOn(api, 'createRequisitionBatch').mockReturnValueOnce(throwError(() => conflicto));
    c.setDispOf(fila as never, suc as never, 3);
    c.plan.set(plan as never);
    c.confirmarPlan();
    c.confirmarPlan();
    expect(spy).toHaveBeenLastCalledWith(plan, true);
    expect(c.repetido()).toBeNull();
    expect(c.selected().has('p-1')).toBe(false);
  });

  it('cancelar el plan olvida el aviso: el próximo plan no nace confirmado', () => {
    const c = montar(VACIO).componentInstance;
    vi.spyOn(TestBed.inject(ComprasService), 'createRequisitionBatch').mockReturnValueOnce(throwError(() => conflicto));
    c.plan.set(plan as never);
    c.confirmarPlan();
    expect(c.repetido()).not.toBeNull();
    c.cancelarPlan();
    expect(c.repetido()).toBeNull();
  });

  it('otro error sigue siendo un error: toast, sin convertirse en «confirmar»', () => {
    const c = montar(VACIO).componentInstance;
    vi.spyOn(TestBed.inject(ComprasService), 'createRequisitionBatch')
      .mockReturnValueOnce(throwError(() => ({ status: 400, error: { message: 'warehouse_id inválido' } })));
    c.plan.set(plan as never);
    c.confirmarPlan();
    expect(c.repetido()).toBeNull();
  });
});

describe('[RA-UX.9] la requisición en armado (el carrito)', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });
  const fila = (pid: string, prov = 's-1', nombre = 'PROV UNO') => ({ product_id: pid, sku: pid, nombre: pid, supplier_id: prov, supplier_name: nombre, uxc: 16, caja_cost: 1, cells: {}, signals: null });
  const suc = { code: '01', name: '01', cc: 1, exis: 0, seed: 0, seedUnit: 'caja', rung: null, vta: 0, nat: 0, natu: '', natuRaw: '', hub: false, mx: null, rop: null, added: false };

  it('«Agregar a la requisición» NO genera nada: sólo agrega, y «quitar» lo saca', () => {
    const c = montar(VACIO).componentInstance;
    const gen = vi.spyOn(TestBed.inject(ComprasService), 'createRequisitionBatch');
    c.agregarARequisicion(fila('p-1') as never);
    expect(c.selected().has('p-1')).toBe(true);
    expect(c.planVisible).toBe(false);
    expect(gen).not.toHaveBeenCalled();
    c.quitarDeRequisicion('p-1');
    expect(c.selected().has('p-1')).toBe(false);
  });

  it('agrupa por proveedor con su subtotal, y cuenta lo que ENTRA (con cantidad) aparte de lo agregado', () => {
    const c = montar(VACIO).componentInstance;
    // Las cuentas por producto son las del desglose (probadas aparte): acá se fijan para probar el AGRUPADO.
    const cj: Record<string, number> = { 'p-1': 10, 'p-2': 5, 'p-3': 0 };
    vi.spyOn(c, 'sumCajas').mockImplementation((r: { product_id: string }) => cj[r.product_id] ?? 0);
    vi.spyOn(c, 'sumValor').mockImplementation((r: { product_id: string }) => (cj[r.product_id] ?? 0) * 100);
    c.agregarARequisicion(fila('p-1') as never);
    c.agregarARequisicion(fila('p-2', 's-2', 'PROV DOS') as never);
    c.agregarARequisicion(fila('p-3') as never);
    const k = c.carrito();
    expect(k.productos).toBe(3);
    expect(k.entran).toBe(2);                       // p-3 está agregado pero en cero: no genera nada
    expect(k.proveedores).toBe(2);
    expect(k.valor).toBe(1500);
    expect(k.grupos.map((g) => [g.nombre, g.valor])).toEqual([['PROV UNO', 1000], ['PROV DOS', 500]]);
    expect(k.grupos[0].items.find((i) => i.r.product_id === 'p-3')?.entra).toBe(false);
  });

  it('⛔ «Vaciar» pregunta primero, y vaciar NO borra lo escrito', () => {
    const f = montar(VACIO);
    const c = f.componentInstance;
    const conf = f.debugElement.injector.get(ConfirmationService);
    let aceptar: (() => void) | undefined;
    vi.spyOn(conf, 'confirm').mockImplementation((o) => { aceptar = o.accept as () => void; return conf; });
    c.setDispOf(fila('p-1') as never, suc as never, 4);
    c.pedirVaciar();
    expect(c.selected().has('p-1')).toBe(true);
    aceptar?.();
    expect(c.selected().size).toBe(0);
    expect(c.qtyOf(fila('p-1') as never, suc as never)).toBe(4);
  });

  it('⭐ lo que la persona quitó a propósito NO se le reclama en el aviso; volver a escribir lo re-agrega', () => {
    const c = montar(VACIO).componentInstance;
    c.setDispOf(fila('p-1') as never, suc as never, 3);
    c.quitarDeRequisicion('p-1');
    expect(c.sinMarcar()).toBeNull();
    c.setDispOf(fila('p-1') as never, suc as never, 5);
    expect(c.selected().has('p-1')).toBe(true);
  });

  it('«Generar» desde el cajón lo cierra y abre el plan (la revisión de siempre)', () => {
    const c = montar(VACIO).componentInstance;
    const build = vi.spyOn(c, 'buildReq').mockImplementation(() => undefined);
    c.carritoAbierto.set(true);
    c.generarDesdeCarrito();
    expect(c.carritoAbierto()).toBe(false);
    expect(build).toHaveBeenCalledWith();
  });
});

describe('[RA-UX.10] la interacción general: lo que decide, a la vista', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });

  it('⛔ las columnas van en orden de decisión: Σ Ped., $ Pedido y Exist. red pegadas a Producto', () => {
    const f = montar(VACIO);
    const ths = [...(f.nativeElement as HTMLElement).querySelectorAll('.pr-wb-scroll table thead th')].map((t) => (t.textContent || '').replace(/\s+/g, ' ').trim());
    expect(ths.length).toBe(16);
    expect(ths[1]).toMatch(/Σ Ped/);
    expect(ths[2]).toMatch(/\$ Pedido/);
    expect(ths[3]).toMatch(/Exist/);
  });

  it('⛔ en celular se esconden por CLASE y quedan justo las que deciden (la lista por posición escondía Σ Ped. y $ Pedido)', () => {
    const f = montar(VACIO);
    const ths = [...(f.nativeElement as HTMLElement).querySelectorAll('.pr-wb-scroll table thead th')];
    const quedan = ths.filter((t) => !t.classList.contains('pr-c-m')).map((t) => (t.textContent || '').replace(/\s+/g, ' ').trim());
    expect(quedan).toHaveLength(4);
    expect(quedan.join(' | ')).toMatch(/Producto.*Σ Ped.*\$ Pedido.*Exist/);
  });

  it('⛔ «Limpiar (n)» se entera de un filtro que NO es signal (antes se quedaba en el primer valor)', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.filtrosActivos()).toBe(0);
    c.fSupplier = 's-1';
    c.loadWorkbook();
    expect(c.filtrosActivos()).toBe(1);
  });

  it('«Más filtros» nace cerrada, se abre sola si hay algo puesto ahí, y respeta si la cierras', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.mostrarMas()).toBe(false);
    c.fBrand = 'b-1'; c.loadWorkbook();
    expect(c.masActivos()).toBe(1);
    expect(c.mostrarMas()).toBe(true);
    c.masFiltrosAbierto.set(false);
    expect(c.mostrarMas()).toBe(false);
    c.limpiarFiltros();
    expect(c.masActivos()).toBe(0);
    expect(c.masFiltrosAbierto()).toBeNull();
  });

  it('el foco vuelve a quien abrió el diálogo', async () => {
    const c = montar(VACIO).componentInstance;
    const btn = document.createElement('button'); document.body.appendChild(btn); btn.focus();
    c.openTransit({ product_id: 'p-1', sku: 'X', nombre: 'X' } as never);
    (document.activeElement as HTMLElement | null)?.blur();
    c.volverFoco();
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(btn);
    btn.remove();
  });

  it('⭐ NEGATIVA: si quien abrió ya no existe, no se intenta enfocar nada (ni revienta)', async () => {
    const c = montar(VACIO).componentInstance;
    const btn = document.createElement('button'); document.body.appendChild(btn); btn.focus();
    c.openTransit({ product_id: 'p-1', sku: 'X', nombre: 'X' } as never);
    btn.remove();
    expect(() => c.volverFoco()).not.toThrow();
  });
});

describe('[SUC.2] la sucursal se nombra, no se numera', () => {
  it('el resolvedor da el NOMBRE: 01 es Padre Hidalgo, 00 es CEDIS, y un código desconocido se deja ver', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.sucNom('01')).toBe('Padre Hidalgo');
    expect(c.sucNom('00')).toBe('CEDIS');
    expect(c.sucNom('ZZ-9')).toBe('ZZ-9');   // NEGATIVA: no inventa un nombre
  });

  it('⛔ el plan de generar dice DÓNDE se entrega por nombre, no «entrega en 01, 08»', () => {
    const ws = FILTROS.warehouses as unknown as Array<Record<string, string>>;
    ws.push({ id: 'w-01', code: '01', name: 'PADRE HIDALGO' }, { id: 'w-08', code: '08', name: 'MORELIA ABASTOS' });
    try {
      const c = montar(VACIO).componentInstance;
      const linea = { product_id: 'p-1', supplier_id: 's-1', source_type: 'supplier', final_qty: 3, unit_cost: 1 };
      c.plan.set([
        { warehouse_id: 'w-08', supplier_id: 's-1', source_type: 'supplier', lines: [linea] },
        { warehouse_id: 'w-01', supplier_id: 's-1', source_type: 'supplier', lines: [linea] },
      ] as never);
      expect(c.planResumen().entregas).toEqual(['Morelia Abastos', 'Padre Hidalgo']);
    } finally { ws.length = 0; }
  });

  it('⛔ la plantilla no pinta códigos de sucursal sueltos (el patrón viejo era la clase pr-mono con el código)', () => {
    const fuente = readFileSync(join(__dirname, 'compras-pedido-real.component.ts'), 'utf8');
    const plantilla = fuente.slice(fuente.indexOf('template: `'), fuente.indexOf('styles: [`'));
    expect(plantilla).not.toMatch(/\{\{\s*(b|e|z|u)\.(code|hubCode|warehouse_code|from_code)\s*\}\}/);
    expect(plantilla).not.toMatch(/todo a \{\{\s*z\.hubCode/);
  });
});

describe('[RA-NEG.2] el desglose compacto: qué hacer, en pocas palabras', () => {
  // Datos de 70056 (prod, 22-oct-2026), recortados a cuatro sucursales. `ped` es el sugerido en cajas.
  const FILA = {
    product_id: 'p-70056', sku: '70056', nombre: 'LA ROSA MAZAPAN GIGANTE 50G /20', supplier_id: 's-1', supplier_name: 'LA ROSA',
    uxc: 16, caja_cost: 1322.88, transito_cajas: '285.0', fill_rate: '0.871', signals: null,
    cells: {
      '01': { vta: 109.2, exis: 77.5, ped: 36, cc: 1322.88 },   // Padre Hidalgo: hoy dura 21.6 d
      '04': { vta: 2.5, exis: 1.6, ped: 1, cc: 1322.88 },       // Yurécuaro: 19.5 d
      '03': { vta: 21.1, exis: 19.7, ped: 2, cc: 1322.88 },     // 8 Esquinas: 28.4 d
      '07': { vta: 41.5, exis: 45.4, ped: 0, cc: 1322.88 },     // Morelia Madero: 33.2 d
    },
  };
  const WB = { ...VACIO, total: 1, rows: [FILA] };
  const tras = (to: string, from: string, cajas: number) => ({
    product_id: 'p-70056', sku: '70056', nombre: 'x', to_code: to, from_code: from, uxc: 16, unit_cost: 1322.88, transfer_cajas: cajas, deficit_cajas: cajas,
  });
  const TRAS = { rows: [tras('04', '01', 1), tras('03', '01', 1)] };
  const DTO = {
    product_id: 'p-70056', sku: '70056', unidad_base: 'PAQ', base_por_caja: 16,
    costo: { estandar_base: 78.595625, reposicion_base: 82.68, precio_ficha: 102.94, impuesto_pct: 8, precio_igual_en_todas: true,
      margen_ficha_pct: 21.27, precio_conserva_margen: 108.29, impacto_30d: 17735.76, sucursales_afectadas: ['01', '03', '07', '08'] },
    pagado: { desde: '2025-10-22', hasta: '2026-10-22',
      meses: [{ mes: '2026-01', base: 2400, promedio: 89, min: 84.88, max: 89.3 }, { mes: '2026-10', base: 6320, promedio: 81.7, min: 78.6, max: 82.68 }],
      ultimo: { fecha: '2026-10-21', sucursal: '06', costo_base: 78.595 }, minimo: { fecha: '2026-06-29', sucursal: '06', costo_base: 72.44, base: 1280 },
      total_base: 52368, total_valor: 4455190.69, renglones: 81, renglones_sin_unidad: 0, renglones_atipicos: 0,
      al_estandar_reciente: [{ sucursal: '06', entradas: 3, base: 1520, costo_base: 78.5956 }], entradas: [] },
    proveedor: { supplier_id: 's-1', nombre: 'DISTRIBUIDORA DE LA ROSA SA DE CV', compras_12m: 81143559.22, recepciones_12m: 618,
      descuento_pago_12m: 3131340.22, descuento_notas_12m: 2092748.91, descuento_pct: 6.44,
      pronto_pago: { tasa: 0.0709, fuente: 'observed', pagos: 136, sin_descuento: 43, monto_sin_descuento: 20049786.69, estimado_perdido: 1421529.88, ultimo_sin_descuento: '2026-09-21', ultimos_sin_descuento: null },
      plazo_dias: 20, plazo_base: 'factura', plazo_kepler: [{ dias: 19, recepciones: 388 }, { dias: 21, recepciones: 230 }], tiempo_entrega_dias: null,
      reclamos: { del_proveedor: 0, en_la_base: 0 } },
    generado_at: '2026-10-22T12:00:00Z',
  };
  const fila = () => FILA as never;
  const sucOf = (c: ComprasPedidoRealComponent, code: string) => c.branchBuys(fila()).find((b) => b.code === code)!;
  const COLS = ['Sucursal', 'Vende 30 d', 'Exist.', 'Hoy dura', 'Traspaso', 'Pedir ✎', 'Queda', 'Valor'];

  it('la lista va en el orden en que se decide: la que menos aguanta HOY, arriba', () => {
    const c = montar(WB, undefined, 'u1', { transferSuggestion: () => of(TRAS) }).componentInstance;
    expect(c.filasDesglose(fila()).map((b) => b.code)).toEqual(['04', '01', '03', '07']);
  });

  it('acciones de la pantalla: revisa lo que viene en camino y no compres donde ya llega traspaso', () => {
    const c = montar(WB, undefined, 'u1', { transferSuggestion: () => of(TRAS) }).componentInstance;
    const a = c.accionesDe(fila());
    expect(a.map((x) => x.clave)).toEqual(['revisa', 'nocompres']);
    expect(a[0].que).toBe('285 cj en camino');
    expect(a[1].que).toBe('para 2 sucursales');
    expect(JSON.stringify(a)).not.toMatch(/\b0[0-9]\b/);   // ninguna sucursal por código
  });

  it('«descontar» resta el traspaso UNA vez y la acción se va (un segundo clic no resta otra vez)', () => {
    const c = montar(WB, undefined, 'u1', { transferSuggestion: () => of(TRAS) }).componentInstance;
    const q = (code: string) => c.qtyOf(fila(), sucOf(c, code));
    const antes = { y: q('04'), e: q('03'), p: q('01') };
    expect(antes.e).toBeGreaterThan(1);                                // control: hay algo que descontar
    c.descontarTraspaso(fila());
    expect(q('04')).toBe(Math.max(0, antes.y - 1));
    expect(q('03')).toBe(antes.e - 1);
    expect(q('01')).toBe(antes.p);                                    // a quien no le llega nada, no se le toca
    expect(c.accionesDe(fila()).map((x) => x.clave)).not.toContain('nocompres');
    c.descontarTraspaso(fila());                                      // ⛔ NEGATIVA: el segundo clic no resta
    expect(q('03')).toBe(antes.e - 1);
  });

  it('«Queda» cuenta el traspaso que llega; «Hoy dura» no cuenta nada que no esté', () => {
    const c = montar(WB, undefined, 'u1', { transferSuggestion: () => of(TRAS) }).componentInstance;
    const y = sucOf(c, '04');
    expect(c.diasHoyDe(y)!).toBeCloseTo(1.6 / (2.5 / 30.4), 1);
    c.setDispOf(fila(), y, 0);
    expect(c.quedaDias(fila(), y)!).toBeCloseTo((1.6 + 1) / (2.5 / 30.4), 1);
  });

  it('al abrir el producto pide su negociación UNA vez, y las acciones del contrato se suman con nombres', () => {
    let llamadas = 0;
    const f = montar(WB, undefined, 'u1', { transferSuggestion: () => of(TRAS), negociacion: () => { llamadas++; return of(DTO); } });
    const c = f.componentInstance;
    c.toggleRow(fila());
    c.toggleRow(fila()); c.toggleRow(fila());                        // cerrar y volver a abrir no vuelve a pedir
    expect(llamadas).toBe(1);
    expect(c.negOf('p-70056')?.estado).toBe('listo');
    const a = c.accionesDe(fila());
    expect(a.map((x) => x.verbo)).toEqual(['Revisa', 'No compres', 'Negocia', 'O sube', 'Pide', 'Confirma']);
    expect(a.find((x) => x.clave === 'confirma')!.que).toBe('el $78.60 de Canindo');
  });

  it('⛔ si la negociación falla se DICE y se puede reintentar (no se pinta un panel vacío)', () => {
    let falla = true;
    const c = montar(WB, undefined, 'u1', { negociacion: () => (falla ? throwError(() => new Error('500')) : of(DTO)) }).componentInstance;
    c.toggleRow(fila());
    expect(c.negOf('p-70056')?.estado).toBe('error');
    expect(c.accionesDe(fila()).some((x) => x.clave === 'negocia')).toBe(false);
    falla = false;
    c.cargarNegociacion('p-70056', true);
    expect(c.negOf('p-70056')?.estado).toBe('listo');
  });

  it('el desglose abierto pinta acciones y el panel, y ya no las pestañas de antes', () => {
    const f = montar(WB, undefined, 'u1', { transferSuggestion: () => of(TRAS), negociacion: () => of(DTO) });
    f.componentInstance.toggleRow(fila());
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.pr-acc').length).toBe(6);
    expect(el.querySelector('app-pedido-negociacion-panel')).not.toBeNull();
    expect(el.querySelector('.pr-det-tabs')).toBeNull();
    const ths = [...el.querySelectorAll('.pr-dx-tbl thead th')].map((t) => (t.textContent || '').trim());
    expect(ths).toEqual(COLS);
  });

  it('[RA-NEG.3] «ver ›» de una acción abre el detalle en el panel lateral, sin salir del pedido', () => {
    const f = montar(WB, undefined, 'u1', { transferSuggestion: () => of(TRAS), negociacion: () => of(DTO) });
    const c = f.componentInstance;
    c.toggleRow(fila());
    f.detectChanges();
    const verPide = [...(f.nativeElement as HTMLElement).querySelectorAll('.pr-acc')].find((li) => li.textContent?.includes('Pide'))!.querySelector('button') as HTMLButtonElement;
    verPide.click();
    expect(c.negDetalle()).toEqual({ pid: 'p-70056', vista: 'descuentos' });
    expect(c.negDetalleTitulo()).toBe('Descuentos del proveedor');
    expect((f.nativeElement as HTMLElement).querySelector('.pr-acc a[href]')).toBeNull();   // ninguna acción es una ruta
  });

  it('[RA-NEG.3] la requisición en armado sobrevive a salir de la pantalla y volver ([RA-UX.9b])', () => {
    try { localStorage.clear(); } catch { /* jsdom */ }
    const f = montar(WB, undefined, 'u1', { transferSuggestion: () => of(TRAS) });
    const c = f.componentInstance;
    c.setDispOf(fila(), sucOf(c, '01'), 7);
    expect(c.selected().has('p-70056')).toBe(true);
    f.destroy();                                   // salir a otra pantalla
    const c2 = montar(VACIO, undefined, 'u1', { transferSuggestion: () => of(TRAS) }).componentInstance;
    expect(c2.selected().has('p-70056')).toBe(true);
    expect(c2.carrito().productos).toBe(1);        // con su renglón, aunque la página nueva no lo traiga
  });

  it('«por sucursal…» abre el detalle con Unidad y Entrega; la unidad del producto se aplica a todas', () => {
    const f = montar(WB, undefined, 'u1', { transferSuggestion: () => of(TRAS) });
    const c = f.componentInstance;
    expect(c.entregaModo(fila())).toBe('directo');
    c.setEntregaModo(fila(), 'mixto');
    expect(c.verDetalle('p-70056')).toBe(true);
    c.toggleRow(fila());
    f.detectChanges();
    const ths = [...(f.nativeElement as HTMLElement).querySelectorAll('.pr-dx-tbl thead th')].map((t) => (t.textContent || '').trim());
    expect(ths).toContain('Unidad');
    expect(ths).toContain('Entrega');
    c.setUnidadModo(fila(), 1);
    expect(c.branchBuys(fila()).every((b) => c.unitOfBranch(fila(), b) === 1)).toBe(true);
    expect(c.unidadModo(fila())).toBe(1);
  });
});

/**
 * `[PQ.5]` El CUÁNDO, enfrente del Pedido. La pestaña Ciclo lo contestaba desde RA-CICLO.1 y
 * nadie entraba (7 hits en 30 d contra 3,734 de Pedido, 637 canales de compra vencidos el
 * 2026-10-23). El aviso vive en Pedido y lleva al Ciclo. Lo que NO puede hacer: dibujar
 * «hoy no toca nadie» sobre una consulta rota (ADR-056).
 */
describe('[PQ.5] «hoy te toca pedirle a…» en la pestaña Pedido', () => {
  const CICLO = { total: 1049, vencidos: 637, hoy: 24, prox7: 89, prov_vencidos: 180, prov_hoy: 12, page: 1, pageSize: 1, rows: [] };

  it('con vencidos, el aviso nombra proveedores y canales, y marca urgencia', () => {
    const fix = montar(VACIO, CICLO);
    const c = fix.componentInstance;
    expect(c.mode()).toBe('pedido');
    expect(c.cicloAviso()?.vencidos).toBe(637);
    expect(c.cicloAvisoProveedores(c.cicloAviso()!)).toBe('192 proveedores');
    const t = fix.nativeElement.textContent as string;
    expect(t).toContain('Hoy te toca pedirle a 192 proveedores');
    expect(t).toContain('637 canales vencidos');
    expect(fix.nativeElement.querySelector('.pr-ciclo-urge')).not.toBeNull();
  });

  it('⛔ si la consulta FALLA dice «no se pudo medir», nunca «no toca nadie»', () => {
    const fix = montar(VACIO, 'error');
    expect(fix.componentInstance.cicloAvisoError()).toBe(true);
    expect(fix.componentInstance.cicloAviso()).toBeNull();
    const t = fix.nativeElement.textContent as string;
    expect(t).toContain('no se pudo medir');
    expect(t).not.toContain('no le toca pedir a nadie');
  });

  it('cero vencidos y cero hoy es un cero MEDIDO: lo dice, con lo que viene', () => {
    const fix = montar(VACIO, { ...CICLO, vencidos: 0, hoy: 0, prov_vencidos: 0, prov_hoy: 0, prox7: 4 });
    const t = fix.nativeElement.textContent as string;
    expect(t).toContain('Hoy no le toca pedir a nadie');
    expect(t).toContain('4 canales tocan');
    expect(fix.nativeElement.querySelector('.pr-ciclo-urge')).toBeNull();
  });

  it('NEGATIVA: un servidor sin proveedores no inventa el N — habla en canales', () => {
    const c = montar(VACIO, { total: 10, vencidos: 3, hoy: 1, prox7: 2, page: 1, pageSize: 1, rows: [] }).componentInstance;
    expect(c.cicloAviso()?.prov_vencidos).toBeNull();
    expect(c.cicloAvisoProveedores(c.cicloAviso()!)).toBe('4 canal(es)');
  });

  it('«Ver el ciclo» lleva a la pestaña Ciclo', () => {
    const fix = montar(VACIO, CICLO);
    const btn = Array.from(fix.nativeElement.querySelectorAll('button')).find((b) => (b as HTMLElement).textContent?.includes('Ver el ciclo')) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(fix.componentInstance.mode()).toBe('ciclo');
  });
});
