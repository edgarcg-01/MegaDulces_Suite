import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Subject, of } from 'rxjs';
import { afterEach, vi } from 'vitest';
import type { AlcanceRenglon, AutoabastoManoProducto, AutoabastoManoRenglon } from '@megadulces/contracts';
import { AutoabastoAManoComponent } from './autoabasto-a-mano.component';
import { AutoabastoService } from '../autoabasto.service';

/**
 * `[AB.PM.4]` La captura del pedido a mano. Los números los pone el servidor (`AB.PM.3`); aquí se prueba
 * lo que la PANTALLA decide: a quién va lo que se agrega, con qué cantidad, qué sale y qué se queda, que
 * nada se mande con un cambio sin guardar, y que la mesa sepa al volver si algo cambió (R1).
 * Datos de la maqueta: Morelia Madero (07) le pide a Morelia Abastos (08).
 */
class ResizeObserverStub { observe(): void { /* */ } unobserve(): void { /* */ } disconnect(): void { /* */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const alc = (p: Partial<AlcanceRenglon> = {}): AlcanceRenglon =>
  ({ estado: 'medible', hoy: 0, con_pedido: 27, pasa_tope: false, tope: 45, objetivo: 21, ...p });
const UNIDADES = [{ unidad: 'CJA', factor: 30 }, { unidad: 'PAQ', factor: 1 }];
const producto = (p: Partial<AutoabastoManoProducto> = {}): AutoabastoManoProducto => ({
  product_id: 'p-28022', sku: '28022', nombre: 'VASO BOLO (68.5GR) / DELICIAS', unidad_base: 'PAQ', unidades: UNIDADES,
  existencia: 0, existencia_origen: 729, viene: 0, venta_30d: 68, alcance: alc(),
  propuesta: { cantidad: 2, unidad: 'CJA', cantidad_base: 60 }, kepler: null, ...p,
});
const renglon = (p: Partial<AutoabastoManoRenglon> = {}): AutoabastoManoRenglon => ({
  product_id: 'p-28022', sku: '28022', nombre: 'VASO BOLO (68.5GR) / DELICIAS', destino: { tipo: 'sucursal', code: '08' },
  origen_nombre: 'Morelia Abastos', cantidad: 2, unidad: 'CJA', cantidad_base: 60, unidad_base: 'PAQ', unidades: UNIDADES,
  existencia: 0, existencia_origen: 729, viene: 0, venta_30d: 68, alcance: alc(), alcance_con_pedido: alc(), kepler: null,
  capturado_por: 'u1', capturado_at: '2026-11-26T18:00:00.000Z', ...p,
});

interface Guardado { product_id: string; cantidad: number; unidad: string; origen_code: string | null }

const respuestaGuardar = (req: Guardado) => ({ pedido_id: 'b-1', renglon: renglon({
  product_id: req.product_id, cantidad: req.cantidad, unidad: req.unidad,
  destino: req.origen_code ? { tipo: 'sucursal', code: req.origen_code } : { tipo: 'compras' } }) });

/**
 * `manual`: el servidor no contesta solo — cada guardado y cada quitar queda «en camino» en `ll.vuelos` hasta
 * que la prueba lo resuelva (`ok()` o `falla()`), para probar lo que pasa mientras viaja.
 */
function montar(o: { renglones?: AutoabastoManoRenglon[]; productos?: AutoabastoManoProducto[]; puede?: boolean;
  manual?: boolean; vieneMedido?: boolean } = {}) {
  const ll = { guardar: [] as Guardado[], buscar: [] as Array<[string, string, string | null]>, enviar: [] as unknown[], mano: 0,
    quitar: [] as string[], vuelos: [] as Array<{ que: 'guardar' | 'quitar'; ok: () => void; falla: (m: string) => void }> };
  const enVuelo = <T>(que: 'guardar' | 'quitar', valor: T) => {
    const s = new Subject<T>();
    ll.vuelos.push({ que, ok: () => { s.next(valor); s.complete(); }, falla: (m) => s.error({ error: { message: m } }) });
    return s.asObservable();
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AutoabastoAManoComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: AutoabastoService, useValue: {
        mano: () => { ll.mano++; return of({ pedido_id: 'b-1', renglones: o.renglones ?? [], grupos: [], viene_medido: o.vieneMedido ?? true }); },
        manoOrigenes: () => of({ origenes: [{ code: '08', name: 'Morelia Abastos' }, { code: '01', name: 'Padre Hidalgo' }] }),
        manoBuscar: (w: string, q: string, origen: string | null) => {
          ll.buscar.push([w, q, origen]);
          return of({ origen: null, productos: o.productos ?? [], viene_medido: true });
        },
        manoGuardar: (req: Guardado) => {
          ll.guardar.push(req);
          return o.manual ? enVuelo('guardar', respuestaGuardar(req)) : of(respuestaGuardar(req));
        },
        manoQuitar: (req: { product_id: string }) => {
          ll.quitar.push(req.product_id);
          const res = { pedido_id: 'b-1', product_id: req.product_id };
          return o.manual ? enVuelo('quitar', res) : of(res);
        },
        manoEnviar: (req: unknown) => {
          ll.enviar.push(req);
          return of({ pendientes: [], requisiciones: [{ id: 'r-1', folio: 'RQ-2026-00001', renglones: 1, total_cajas: 2,
            surte: { tipo: 'matriz', clave: '08', nombre: 'Morelia Abastos' },
            kepler: { estado: 'entregada', sucursal: '08', folio: '0001702' } }] });
        },
      } },
    ],
  });
  const f = TestBed.createComponent(AutoabastoAManoComponent);
  f.componentRef.setInput('almacen', { id: 'w-07', code: '07', name: 'Morelia Madero' });
  f.componentRef.setInput('matriz', '08');
  f.componentRef.setInput('puedeAjustar', o.puede ?? true);
  f.componentRef.setInput('enSugerido', { 'p-28022': { cantidad: 20, unidad: 'PAQ' } });
  f.detectChanges();
  return { f, c: f.componentInstance, ll };
}
const texto = (f: ReturnType<typeof montar>['f']) => ((f.nativeElement as HTMLElement).textContent || '').replace(/\s+/g, ' ');

afterEach(() => vi.useRealTimers());

describe('[AB.PM.4] a quién se le pide', () => {
  it('arranca pidiéndole a la matriz que propone el motor, y busca contra ella', () => {
    const { c, ll } = montar();
    expect(c.origen()).toBe('08');
    expect(ll.buscar.at(-1)).toEqual(['w-07', '', '08']);
  });

  it('cambiar de sucursal vuelve a buscar: la existencia de allá y lo que Kepler rechazaría dependen de ella', () => {
    const { c, ll } = montar();
    c.elegirOrigen('01');
    expect(ll.buscar.at(-1)?.[2]).toBe('01');
  });

  it('la lista nombra a la matriz y ofrece Compras al final', () => {
    const { c } = montar();
    const opts = c.destinoOpts();
    expect(opts[0].label).toBe('Morelia Abastos · tu matriz');
    expect(opts.at(-1)?.label).toBe('Compras · ruta por confirmar');
  });
});

describe('[AB.PM.4] el buscador y agregar', () => {
  it('dice lo que ya va en el sugerido (R1) y lo que tiene la sucursal elegida', () => {
    const { f } = montar({ productos: [producto()] });
    f.detectChanges();
    const t = texto(f);
    expect(t).toContain('ya va en tu pedido sugerido · 20 PAQ');
    expect(t).toContain('Morelia Abastos tiene 729 PAQ');
    expect(t).toContain('CJA de 30');
  });

  it('⭐ pasarlo del sugerido CONSERVA su cantidad y unidad (no la recalcula: el sugerido trae la temporada)', () => {
    const { f, c, ll } = montar({ productos: [producto()] });
    f.detectChanges();
    expect(texto(f)).toContain('Pedirlo aquí · 20 PAQ');
    c.agregar(producto());
    expect(ll.guardar[0]).toMatchObject({ cantidad: 20, unidad: 'PAQ' });
  });

  it('lo que NO va en el sugerido entra con la propuesta de media caja, a la sucursal elegida', () => {
    const { c, ll } = montar();
    c.agregar(producto({ product_id: 'p-otro' }));
    expect(ll.guardar).toEqual([expect.objectContaining({ product_id: 'p-otro', origen_code: '08', cantidad: 2, unidad: 'CJA' })]);
    expect(c.renglones()).toHaveLength(1);
  });

  it('sin propuesta agrega UNO de la unidad más chica (nunca una caja que nadie pidió)', () => {
    const { c, ll } = montar();
    c.agregar(producto({ product_id: 'p-otro', propuesta: null }));
    expect(ll.guardar[0]).toMatchObject({ cantidad: 1, unidad: 'PAQ' });
  });

  it('a Compras se guarda sin sucursal (R7)', () => {
    const { c, ll } = montar();
    c.elegirOrigen('__compras__');
    c.agregar(producto({ product_id: 'p-otro' }));
    expect(ll.guardar[0].origen_code).toBeNull();
  });

  it('⛔ sin escalera de Kepler no se agrega', () => {
    const { c, ll } = montar();
    c.agregar(producto({ unidades: [] }));
    expect(ll.guardar).toHaveLength(0);
  });
});

describe('[AB.PM.4] lo que sale y lo que se queda', () => {
  const tres = () => [
    renglon(),
    renglon({ product_id: 'p-99948', sku: '99948', nombre: 'LITTLE BABY', kepler: 'factor_distinto' }),
    renglon({ product_id: 'p-28002', sku: '28002', nombre: 'MINI GUMMY', destino: { tipo: 'compras' }, origen_nombre: null }),
  ];

  it('sale sólo lo que Kepler acepta y no va a Compras; el botón NOMBRA la sucursal', () => {
    const { c } = montar({ renglones: tres() });
    expect(c.sale()).toEqual({ sucursales: 1, renglones: 1 });
    expect(c.etiquetaPedir()).toBe('Pedir a Morelia Abastos');
    expect(c.seQuedan().map((r) => r.sku)).toEqual(['99948', '28002']);
  });

  it('el renglón que Kepler rechazaría lo dice con su palabra, no sólo con un color', () => {
    const { f } = montar({ renglones: tres() });
    f.detectChanges();
    expect(texto(f)).toContain('Kepler lo rechazaría: la caja de la Suite no es la de la ficha de la sucursal que surte. Se queda fuera del envío.');
  });

  it('⭐ los grupos salen en el orden de partirCaptura: la sucursal antes que Compras', () => {
    const { c } = montar({ renglones: tres() });
    const bandas = [...new Set(c.filas().map((x) => x.banda))];
    expect(bandas).toEqual(['Morelia Abastos · tu matriz', 'Compras']);
    // La llave por la que agrupa la tabla ordena igual (sin el número, «compras» < «s:08»).
    const llaves = [...new Set(c.filas().map((x) => x.grupo))];
    expect([...llaves].sort()).toEqual(llaves);
  });

  it('⛔ el resultado sólo es verde si TODO quedó en Kepler; guardado sin salir es aviso', () => {
    const { c } = montar();
    const q = (estado: 'entregada' | 'no_salio') => ({ id: 'r', folio: 'RQ', renglones: 1, total_cajas: 1,
      surte: { tipo: 'matriz' as const, clave: '08', nombre: 'Morelia Abastos' },
      kepler: estado === 'entregada' ? { estado, sucursal: '08', folio: '1' } : { estado, motivo: 'apagado' } });
    expect(c.todoEnKepler({ requisiciones: [q('entregada')], pendientes: [] })).toBe(true);
    expect(c.todoEnKepler({ requisiciones: [q('entregada'), q('no_salio')], pendientes: [] })).toBe(false);
    expect(c.todoEnKepler({ requisiciones: [], pendientes: [] })).toBe(false);
  });

  it('⛔ un cambio sin guardar frena el envío; al guardarse, se libera', () => {
    vi.useFakeTimers();
    const { c, ll } = montar({ renglones: [renglon()] });
    c.cambiar(c.renglones()[0], { cantidad: 3 });
    expect(c.sinGuardar()).toBe(1);
    expect(c.porQueNoSale()).toContain('Espera');
    vi.advanceTimersByTime(700);
    expect(ll.guardar.at(-1)).toMatchObject({ cantidad: 3, unidad: 'CJA', origen_code: '08' });
    expect(c.sinGuardar()).toBe(0);
  });

  it('mandar lleva la nota, dice el folio de Kepler y vuelve a leer el pedido', () => {
    const { f, c, ll } = montar({ renglones: [renglon()] });
    const antes = ll.mano;
    c.nota.set('para el viernes');
    c.enviar();
    f.detectChanges();
    expect(ll.enviar).toEqual([{ warehouse_id: 'w-07', nota: 'para el viernes' }]);
    expect(ll.mano).toBe(antes + 1);
    expect(texto(f)).toContain('quedó en su Kepler como pedido 0001702');
  });
});

describe('[AB.PM.4] permiso y vuelta a la mesa', () => {
  it('sin permiso se ve lo pedido, pero no se busca ni se manda', () => {
    const { f } = montar({ puede: false, renglones: [renglon()] });
    f.detectChanges();
    const t = texto(f);
    expect(t).toContain('te falta el permiso');
    expect(t).not.toContain('Agrega productos');
    expect(t).toContain('VASO BOLO');
  });

  it('al volver dice si algo cambió: así la mesa sabe si rearmarse (R1)', () => {
    const { c } = montar();
    const salio: boolean[] = [];
    c.cerrar.subscribe((v) => salio.push(v));
    c.salir();
    c.agregar(producto());
    c.salir();
    expect(salio).toEqual([false, true]);
  });
});

/**
 * Revisión del PR (2026-11-27): el guardado con pausa podía perder lo tecleado — «Volver» tiraba lo que
 * esperaba su pausa, un error volvía a la cantidad vieja y dos guardados del mismo renglón viajaban a la vez.
 */
describe('[AB.PM.4] nada de lo tecleado se pierde', () => {
  it('⛔ «Volver» con un cambio en su pausa lo GUARDA antes de salir (antes lo tiraba)', () => {
    vi.useFakeTimers();
    const { c, ll } = montar({ renglones: [renglon()] });
    const salio: boolean[] = [];
    c.cerrar.subscribe((v) => salio.push(v));
    c.cambiar(c.renglones()[0], { cantidad: 4 });
    c.salir();
    expect(ll.guardar.at(-1)).toMatchObject({ cantidad: 4 });
    expect(salio).toEqual([true]);
  });

  it('⛔ «Volver» espera al guardado que viaja; si falla, NO sale, lo dice, y un segundo «Volver» lo descarta', () => {
    vi.useFakeTimers();
    const { f, c, ll } = montar({ renglones: [renglon()], manual: true });
    const salio: boolean[] = [];
    c.cerrar.subscribe((v) => salio.push(v));
    c.cambiar(c.renglones()[0], { cantidad: 4 });
    c.salir();
    expect(c.saliendo()).toBe(true);
    expect(salio).toEqual([]);
    ll.vuelos[0].falla('sin red');
    f.detectChanges();
    expect(salio).toEqual([]);
    expect(c.sinGuardarAlSalir()).toBe(1);
    expect(texto(f)).toContain('Un cambio no se pudo guardar');
    c.salir();
    expect(salio).toEqual([false]);
  });

  it('⛔ dos guardados del mismo renglón no viajan a la vez; un error NO pisa lo tecleado después', () => {
    vi.useFakeTimers();
    const { c, ll } = montar({ renglones: [renglon()], manual: true });
    const r = c.renglones()[0];
    c.cambiar(r, { cantidad: 5 });
    vi.advanceTimersByTime(700);
    expect(ll.guardar.map((g) => g.cantidad)).toEqual([5]);
    c.cambiar(r, { cantidad: 7 });
    vi.advanceTimersByTime(700);
    expect(ll.guardar.map((g) => g.cantidad)).toEqual([5]);   // espera a que vuelva el primero
    ll.vuelos[0].falla('se cayó');
    expect(c.cantidadDe(r)).toBe(7);                          // antes volvía a 5
    expect(ll.guardar.map((g) => g.cantidad)).toEqual([5, 7]); // y manda lo más nuevo
    ll.vuelos[1].ok();
    expect(c.sinGuardar()).toBe(0);
  });

  it('⛔ quitar con un guardado en camino espera a que vuelva: el guardado tardío no revive el renglón', () => {
    vi.useFakeTimers();
    const { c, ll } = montar({ renglones: [renglon()], manual: true });
    const r = c.renglones()[0];
    c.cambiar(r, { cantidad: 5 });
    vi.advanceTimersByTime(700);
    c.quitar(r);
    expect(ll.quitar).toEqual([]);
    ll.vuelos[0].ok();
    expect(ll.quitar).toEqual(['p-28022']);
    ll.vuelos[1].ok();
    expect(c.renglones()).toHaveLength(0);
  });
});

describe('[AB.PM.4] lo que no se midió se dice', () => {
  it('«ya viene» sin medir: el aviso arriba y la cuenta del alcance dicen que cuenta cero', () => {
    const { f, c } = montar({ renglones: [renglon({ viene: null })], vieneMedido: false });
    f.detectChanges();
    expect(texto(f)).toContain('«Ya viene» no se pudo medir para tu sucursal');
    expect(c.cuentaAlcance(c.renglones()[0])).toContain('lo que ya viene (sin medir: cuenta 0)');
    expect(c.cuentaAlcance(renglon({ viene: 12 }))).toContain('12 que ya viene');
  });

  it('la ✕ del diálogo llega a --tap-min por el pt de PrimeNG (sin ::ng-deep)', () => {
    const { f, c } = montar({ renglones: [renglon()] });
    c.confirmar.set(true);
    f.detectChanges();
    const x = document.querySelector<HTMLElement>('.p-dialog-close-button');
    expect(x).not.toBeNull();
    expect(x?.getAttribute('style') ?? '').toContain('min-height: var(--tap-min)');
  });
});
