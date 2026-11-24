import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { AutoabastoPedidoLinea } from '@megadulces/contracts';
import { AutoabastoOrdenesComponent } from './autoabasto-ordenes.component';

/**
 * `[AB.NI.5]` El pedido abierto. Lo que estas pruebas cuidan es que **la pantalla no afirme nada
 * que el reparto no diga**: el botón cuenta lo que sale (no el total), lo que no puede salir se
 * nombra, y el aviso de bloqueo NO existe cuando no hay bloqueo.
 *
 * El reparto en sí (unidad → línea → alfabético, corte de 70) está probado aparte, sin DOM, en
 * `libs/contracts/src/http/autoabasto-ordenes.spec.ts` con la forma real de `RQ-2026-03239`.
 *
 * ⛔ **PRUEBAS NEGATIVAS ejercidas al escribirlas:**
 *   · N1 — poner `total()` en el botón en vez de `renglones_que_salen`: cae «el botón cuenta lo que sale».
 *   · N2 — quitar el `@if (armado().fuera.length > 0)` del aviso: cae «sin bloqueo el aviso no existe».
 *   · N3 — devolver `0` en vez de `null` en `valorTotal` cuando nada se valúa: cae «sin costo dice no medido».
 */
class ResizeObserverStub { observe(): void { /* */ } unobserve(): void { /* */ } disconnect(): void { /* */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const linea = (p: Partial<AutoabastoPedidoLinea> = {}): AutoabastoPedidoLinea => ({
  product_id: 'p-1', sku: '70056', nombre: 'MAZAPAN LA ROSA', linea: 'DIST DE LA ROSA SA DE CV',
  venta_30d: 10, existencia: 2, objetivo: 12, falta: 10,
  ya_pedido: 0, atorado: 0, negado_30d: 0, en_camino: 0, planeado_compras: 0, pedido_sucursal: 0, falta_neta: 5,
  a_pedir: { cantidad: 5, unidad: 'CJA', factor: 16, cantidad_base: 80, regla: 'cajas', clase: 'mayor', falta_mayor: 5 } as never,
  ajuste: null, valor: 100, costo_base: 1, posicion: 'bajo_minimo', minimo_menor: 'no_aplica' as never, valor_menor: null,
  estado: 'sin_pedir', surte: { tipo: 'matriz', clave: '08', nombre: '08' },
  ...p,
});

/** Un renglón que Kepler no rotula: `unidad: null`. Es el que tira el documento en el ERP. */
const sinUnidad = (id: string): AutoabastoPedidoLinea => linea({
  product_id: id, sku: id, nombre: `SIN FICHA ${id}`,
  a_pedir: { cantidad: 2, unidad: null, factor: null, cantidad_base: 2, regla: 'sin_escalera', clase: 'sin_unidad', falta_mayor: null } as never,
});

function montar(lineas: AutoabastoPedidoLinea[], destino = 'Morelia Abastos') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AutoabastoOrdenesComponent],
    providers: [provideZonelessChangeDetection()],
  });
  const f = TestBed.createComponent(AutoabastoOrdenesComponent);
  f.componentRef.setInput('lineas', lineas);
  f.componentRef.setInput('destino', destino);
  f.detectChanges();
  return f;
}

const texto = (f: ReturnType<typeof montar>): string => (f.nativeElement as HTMLElement).textContent ?? '';

describe('[AB.NI.5] El pedido abierto', () => {
  it('⭐ CONTROL · nombra al que surte y dice en cuántas órdenes se arma', () => {
    const f = montar([linea(), linea({ product_id: 'p-2', sku: '70057', nombre: 'BOMBON' })]);
    const t = texto(f);
    expect(t).toContain('Lo que le pides a Morelia Abastos');
    expect(t).toContain('2 renglones');
    expect(f.componentInstance.armado().ordenes).toHaveLength(1);
  });

  it('⛔ el botón cuenta lo que SALE, no el total del pedido', () => {
    const f = montar([linea(), sinUnidad('x-1'), sinUnidad('x-2')]);
    expect(f.componentInstance.total()).toBe(3);
    expect(f.componentInstance.armado().renglones_que_salen).toBe(1);

    const btn = (f.nativeElement as HTMLElement).querySelector('.btn-primario');
    expect(btn?.textContent).toContain('Pedir a Morelia Abastos');
    expect(btn?.textContent).toContain('1');
    expect(btn?.textContent).not.toContain('3');
  });

  it('lo que no puede salir se nombra, con su motivo', () => {
    const f = montar([linea(), sinUnidad('x-1')]);
    expect(texto(f)).toContain('unidad en la ficha de Kepler');

    f.componentInstance.verFuera.set(true);
    f.detectChanges();
    const t = texto(f);
    expect(t).toContain('SIN FICHA x-1');
    expect(t).toContain('Sin unidad en la ficha de Kepler');
  });

  it('⛔ SIN bloqueo, el aviso NO existe en el DOM (no se pinta un «0 bloqueados»)', () => {
    const f = montar([linea()]);
    expect(texto(f)).not.toContain('unidad en la ficha de Kepler');
    expect((f.nativeElement as HTMLElement).querySelector('.ao-fuera')).toBeNull();
    // Y el indicador de bloqueo tampoco aparece en la tira de arriba.
    expect(f.componentInstance.resumen().some((i) => i.label === 'No pueden salir')).toBe(false);
  });

  it('⛔ sin costo en ninguna ficha, el total dice «no medido» — no cero', () => {
    const f = montar([linea({ valor: null }), linea({ product_id: 'p-2', valor: null })]);
    expect(f.componentInstance.valorTotal()).toBeNull();
    const m = f.componentInstance.resumen().find((i) => i.label === 'Lo que sale');
    expect(m?.value).toBe('—');
    expect(m?.state).toBe('no_medido');
  });

  it('un pedido que entero no puede salir lo dice, y el botón queda apagado', () => {
    const f = montar([sinUnidad('x-1'), sinUnidad('x-2')]);
    expect(f.componentInstance.armado().ordenes).toHaveLength(0);
    expect(texto(f)).toContain('No hay nada que armar');
    const btn = (f.nativeElement as HTMLElement).querySelector('.btn-primario') as HTMLButtonElement | null;
    expect(btn?.disabled).toBe(true);
  });

  it('marcar todo sólo toma los renglones que de verdad salen', () => {
    const f = montar([linea(), linea({ product_id: 'p-2' }), sinUnidad('x-1')]);
    f.componentInstance.marcarTodo({ target: { checked: true } } as unknown as Event);
    expect(f.componentInstance.marcados().size).toBe(2);
    expect(f.componentInstance.marcados().has('x-1')).toBe(false);
    expect(f.componentInstance.todoMarcado()).toBe(true);
  });

  it('quitar lo marcado emite los ids una sola vez y limpia la selección', () => {
    const f = montar([linea(), linea({ product_id: 'p-2' })]);
    const visto: string[][] = [];
    f.componentInstance.quitar.subscribe((ids) => visto.push(ids));
    f.componentInstance.marcarTodo({ target: { checked: true } } as unknown as Event);
    f.componentInstance.emitirQuitar();
    expect(visto).toHaveLength(1);
    expect(visto[0].sort()).toEqual(['p-1', 'p-2']);
    expect(f.componentInstance.marcados().size).toBe(0);
    // Sin nada marcado no se emite: un botón que no hace nada no debe parecer que hizo algo.
    f.componentInstance.emitirQuitar();
    expect(visto).toHaveLength(1);
  });

  it('el renglón que bajó de unidad lo dice, y el que no, no', () => {
    const bajo = linea({
      product_id: 'p-9', nombre: 'PULPARINDO',
      a_pedir: { cantidad: 5, unidad: 'PAQ', factor: 24, cantidad_base: 5, regla: 'menor', clase: 'menor', falta_mayor: 0.208 } as never,
    });
    const f = montar([linea(), bajo]);
    expect(f.componentInstance.bajoDeUnidad(bajo)).toBe(true);
    expect(f.componentInstance.bajoDeUnidad(linea())).toBe(false);
    expect(f.componentInstance.bajanDeUnidad()).toBe(1);
    expect(texto(f)).toContain('5 PAQ');
  });

  it('el tránsito se marca, pero NO se pinta su número (su unidad no está verificada)', () => {
    const f = montar([linea({ en_camino: 25.7 })]);
    expect(f.componentInstance.conTransito()).toBe(1);
    const t = texto(f);
    expect(t).toContain('ya viene');
    expect(t).not.toContain('25.7');
  });

  it('un producto sin línea no desaparece: cae en «(sin línea)»', () => {
    const f = montar([linea({ linea: null })]);
    expect(texto(f)).toContain('(sin línea)');
    expect(f.componentInstance.filas()).toHaveLength(1);
  });

  it('⭐ D1 · las unidades chicas comparten documento, y la pantalla dice cuáles', () => {
    // CJA grande (documento propio) + KG 3 + BTO 2: las dos chicas se juntan.
    const cja = Array.from({ length: 14 }, (_, i) =>
      linea({ product_id: `c${i}`, nombre: `CAJA ${i}`, linea: 'LINEA CJA' }));
    const chicas = [
      ...Array.from({ length: 3 }, (_, i) => linea({
        product_id: `k${i}`, nombre: `KILO ${i}`, linea: 'LINEA KG',
        a_pedir: { cantidad: 2, unidad: 'KG', factor: 1, cantidad_base: 2, regla: 'granel', clase: 'unica', falta_mayor: 2 } as never,
      })),
      ...Array.from({ length: 2 }, (_, i) => linea({
        product_id: `b${i}`, nombre: `BULTO ${i}`, linea: 'LINEA BTO',
        a_pedir: { cantidad: 1, unidad: 'BTO', factor: 1, cantidad_base: 1, regla: 'cajas', clase: 'mayor', falta_mayor: 1 } as never,
      })),
    ];
    const f = montar([...cja, ...chicas]);

    const ordenes = f.componentInstance.armado().ordenes;
    expect(ordenes).toHaveLength(2);
    expect(f.componentInstance.hayCola()).toBe(true);
    expect(f.componentInstance.unidadesEnCola()).toBe(2);
    expect(f.componentInstance.renglonesEnCola()).toBe(5);

    const t = texto(f);
    expect(t).toContain('otras unidades');
    // La banda de la orden mixta nombra las unidades que junta, no finge ser una. Van en el
    // mismo orden que sus bandas: alfabetico, para que el rotulo y la tabla no se contradigan.
    expect(t).toContain('BTO, KG');
    expect(t).toContain('no llevan documento propio');
  });

  it('⛔ sin cola, la pantalla NO habla de «otras unidades»', () => {
    const f = montar(Array.from({ length: 14 }, (_, i) =>
      linea({ product_id: `c${i}`, nombre: `CAJA ${i}` })));
    expect(f.componentInstance.hayCola()).toBe(false);
    expect(texto(f)).not.toContain('otras unidades');
    expect(texto(f)).not.toContain('no llevan documento propio');
  });

  it('en la orden mixta, dos unidades con la MISMA línea no se funden en una banda', () => {
    const mismaLinea = 'ACME SA DE CV';
    const f = montar([
      ...Array.from({ length: 14 }, (_, i) => linea({ product_id: `c${i}`, nombre: `CAJA ${i}`, linea: 'OTRA' })),
      linea({ product_id: 'k1', nombre: 'KILO', linea: mismaLinea,
        a_pedir: { cantidad: 2, unidad: 'KG', factor: 1, cantidad_base: 2, regla: 'granel', clase: 'unica', falta_mayor: 2 } as never }),
      linea({ product_id: 'b1', nombre: 'BULTO', linea: mismaLinea,
        a_pedir: { cantidad: 1, unidad: 'BTO', factor: 1, cantidad_base: 1, regla: 'cajas', clase: 'mayor', falta_mayor: 1 } as never }),
    ]);
    const grupos = new Set(f.componentInstance.filas().filter((x) => x.mixta).map((x) => x.grupo));
    expect(grupos.size).toBe(2);
  });

  it('las filas aplanadas abren la banda de orden una sola vez por orden', () => {
    const f = montar([
      linea({ product_id: 'a', nombre: 'A', linea: 'AAA' }),
      linea({ product_id: 'b', nombre: 'B', linea: 'BBB' }),
      linea({ product_id: 'c', nombre: 'C', linea: 'BBB' }),
    ]);
    const abren = f.componentInstance.filas().filter((x) => x.abreOrden);
    expect(abren).toHaveLength(1);
    expect(f.componentInstance.lineasDistintas()).toBe(2);
  });
});
