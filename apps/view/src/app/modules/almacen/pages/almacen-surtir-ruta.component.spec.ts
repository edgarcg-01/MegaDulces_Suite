import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router, UrlTree } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { RouteBatchDetail, RouteBatchFinishResponse, RouteBatchProduct, RouteBatchRow } from '@megadulces/contracts';
import { AlmacenSurtirRutaComponent } from './almacen-surtir-ruta.component';
import { PresalePickingService } from '../presale-picking.service';
import { AuthService } from '../../../core/services/auth.service';
import { PREF_RUTA_BOLSAS, PREF_RUTA_RECOLECTA, acotarCantidad, cuerpoTerminar } from '../surtir-ruta/ruta-surtido.util';

const RUTA = (p: Partial<RouteBatchRow> = {}): RouteBatchRow => ({
  route_day_id: 'rd-1', kind: 'ruta', seller_name: 'Paulina Placencia', work_date: '2026-10-21', state: 'surtiendo',
  started_at: '2026-10-21T14:00:00.000Z', finished_at: '2026-10-21T20:10:00.000Z', orders: 2, products: 3,
  pick_started: { user_id: 'yo', name: 'Ángel Cisneros', at: '2026-10-21T20:15:00.000Z' }, pick_finished: null, ...p,
});

const P = (p: Partial<RouteBatchProduct> = {}): RouteBatchProduct => ({
  product_id: 'p-mazapan', sku: '70012', barcode: null, product_name: 'MAZAPAN DE LA ROSA', brand: 'DE LA ROSA',
  qty: 3, unit: 'CJA', factor: 30, base_qty: 90, clients: [], ...p,
});

const DETALLE = (route: RouteBatchRow = RUTA()): RouteBatchDetail => ({
  route,
  products: [
    P(),
    P({ product_id: 'p-pulpa', product_name: 'PULPARINDO', qty: 5, unit: 'PZA', factor: 1, base_qty: 5 }),
    P({ product_id: 'p-chicle', product_name: 'CHICLE CANEL', brand: 'CANELS', qty: 2.5, unit: 'KG', factor: 1, base_qty: 2.5 }),
  ],
});

const REPARTO = (): RouteBatchFinishResponse => ({
  route_day_id: 'rd-1',
  bags: [
    { order_id: 'o-rosy', code: 'PD-2026-00082', customer_name: 'ABARROTES ROSY', outcome: 'con_faltantes', total_before: 500, total_after: 420,
      lines: [
        { product_name: 'MAZAPAN DE LA ROSA', unit: 'CJA', ordered: 2, picked: 1 },
        { product_name: 'PULPARINDO', unit: 'PZA', ordered: 5, picked: 5 },
      ] },
    { order_id: 'o-vero', code: 'PD-2026-00070', customer_name: 'VERO VASCO', outcome: 'completo', total_before: 90, total_after: 90,
      lines: [{ product_name: 'CHICLE CANEL', unit: 'KG', ordered: 2.5, picked: 2.5 }] },
    { order_id: 'o-esc', code: 'PD-2026-00083', customer_name: 'ESCUELA AMARILLA', outcome: 'sin_mercancia', total_before: 60, total_after: 0,
      lines: [{ product_name: 'MAZAPAN DE LA ROSA', unit: 'CJA', ordered: 1, picked: 0 }] },
  ],
});

/**
 * `[MCP.3.6]` Recolectar + Repartir de una ruta, montado de verdad (plantilla + signals) con el
 * servidor simulado. Se prueba por la PANTALLA: botones, deshabilitados, textos y el cuerpo que se
 * manda — lo que un surtidor de pie con el celular ve y toca.
 */
describe('AlmacenSurtirRutaComponent · recolectar y repartir una ruta (MCP.3.6)', () => {
  let fix: ComponentFixture<AlmacenSurtirRutaComponent>;
  let c: AlmacenSurtirRutaComponent;
  let api: Record<'routeDetail' | 'routeStart' | 'routeFinish', ReturnType<typeof vi.fn>>;

  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: string): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').includes(t)) as
      | HTMLButtonElement
      | undefined;
  const clic = (t: string): void => {
    const b = boton(t);
    if (!b) throw new Error(`no hay botón «${t}»`);
    b.click();
    fix.detectChanges();
  };
  const terminar = (): HTMLButtonElement => boton('Ya junté todo')!;

  async function montar(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [AlmacenSurtirRutaComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'rd-1' }) } } },
        { provide: PresalePickingService, useValue: api },
        { provide: AuthService, useValue: { user: () => ({ sub: 'yo' }) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenSurtirRutaComponent);
    c = fix.componentInstance;
    fix.detectChanges();
  }

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* sin almacenamiento */
    }
    api = {
      routeDetail: vi.fn(() => of(DETALLE())),
      routeStart: vi.fn(() => of(RUTA())),
      routeFinish: vi.fn(() => of(REPARTO())),
    };
  });

  afterEach(() => TestBed.resetTestingModule());

  // ── Recolectar ──────────────────────────────────────────────────────────────────────────

  it('abre en Recolectar: encabezado, avance 0/3, agrupado por marca en el orden en que llega', async () => {
    await montar();
    expect(c.fase()).toBe('recolectar');
    expect(texto()).toContain('Recolectar · Ruta de Paulina Placencia');
    expect(texto()).toContain('0/3');
    expect(Array.from(el().querySelectorAll('.rr-marca')).map((n) => n.textContent?.trim())).toEqual(['DE LA ROSA', 'CANELS']);
  });

  it('[MCP.3.13] con partes en otra sucursal, Recolectar avisa que aquí va sólo lo propio; sin partes, nada', async () => {
    api.routeDetail = vi.fn(() => of(DETALLE(RUTA({ group_other_warehouses: ['PH'] }))));
    await montar();
    expect(texto()).toContain('Pedidos agrupados · también surte PH: aquí va sólo lo de tu sucursal');
    TestBed.resetTestingModule();
    api.routeDetail = vi.fn(() => of(DETALLE(RUTA({ group_other_warehouses: [] }))));
    await montar();
    expect(el().querySelector('.rr-parte')).toBeNull();
  });

  it('el producto actual va en grande: «3 CJA = 90 piezas», con «Lo tomé» y «Hay menos»; no dice a quién le toca', async () => {
    await montar();
    const a = el().querySelector('.rr-actual')!;
    expect(a.querySelector('.rr-cant')!.getAttribute('aria-label')).toBe('Tomar 3 CJA');
    expect(a.textContent).toContain('= 90 piezas');
    expect(boton('Lo tomé')).toBeTruthy();
    expect(boton('Hay menos')).toBeTruthy();
    expect(texto()).not.toContain('ABARROTES');
  });

  it('con factor 1 no dice «= N piezas» (sería ruido)', async () => {
    await montar();
    clic('Lo tomé');
    expect(el().querySelector('.rr-actual')!.textContent).not.toContain('piezas');
  });

  it('⭐ «Ya junté todo» está apagado hasta marcar TODOS, y dice cuántos faltan (prueba negativa)', async () => {
    await montar();
    expect(terminar().disabled).toBe(true);
    expect(texto()).toContain('3 productos sin marcar');
    clic('Lo tomé');
    clic('Lo tomé');
    expect(terminar().disabled).toBe(true);
    expect(texto()).toContain('1 producto sin marcar');
    terminar().click();
    expect(api.routeFinish).not.toHaveBeenCalled();
    clic('Lo tomé');
    expect(terminar().disabled).toBe(false);
    expect(texto()).toContain('3/3');
  });

  it('⭐ «Hay menos» no deja pasar de lo pedido: «+» se apaga en qty y lo tecleado se acota', async () => {
    await montar();
    clic('Hay menos');
    expect(c.borrador()).toBe(3);
    expect(boton('Uno más')).toBeUndefined(); // aria-label, no texto
    const mas = el().querySelector('[aria-label="Uno más"]') as HTMLButtonElement;
    const menos = el().querySelector('[aria-label="Uno menos"]') as HTMLButtonElement;
    expect(mas.disabled).toBe(true);
    mas.click();
    expect(c.borrador()).toBe(3);
    menos.click();
    fix.detectChanges();
    expect(c.borrador()).toBe(2);
    expect(texto()).toContain('de 3 CJA');
    // Tecleado de más, negativo o con decimales en cajas: se acota.
    const p = c.productos()[0];
    c.teclear(p, 99);
    expect(c.borrador()).toBe(3);
    c.teclear(p, -4);
    expect(c.borrador()).toBe(0);
    c.teclear(p, 1.7);
    expect(c.borrador()).toBe(1);
    clic('Guardar');
    expect(c.recolectado()['p-mazapan']).toBe(1);
    expect(texto()).toContain('1 de 3 CJA');
  });

  it('en KG sí admite decimales, y tampoco pasa de lo pedido', () => {
    expect(acotarCantidad(1.25, 2.5, 'KG')).toBe(1.25);
    expect(acotarCantidad(9, 2.5, 'kg')).toBe(2.5);
    expect(acotarCantidad('abc', 3, 'CJA')).toBe(0);
  });

  it('un recolectado se encoge a una línea con ✓ y se toca para corregir', async () => {
    await montar();
    clic('Lo tomé');
    const hecho = el().querySelector('.rr-hecho') as HTMLButtonElement;
    expect(hecho.textContent).toContain('MAZAPAN DE LA ROSA');
    expect(hecho.querySelector('.pi-check')).toBeTruthy();
    hecho.click();
    fix.detectChanges();
    expect(el().querySelector('.rr-actual')!.textContent).toContain('MAZAPAN DE LA ROSA');
    clic('Hay menos');
    c.teclear(c.productos()[0], 0);
    clic('Guardar');
    expect(c.recolectado()['p-mazapan']).toBe(0);
  });

  it('⭐ el cuerpo de «Ya junté todo» lleva cada producto UNA vez, con lo encontrado', async () => {
    api.routeDetail = vi.fn(() => of({ ...DETALLE(), products: [...DETALLE().products, P()] })); // repetido a propósito
    await montar();
    clic('Hay menos');
    c.teclear(c.productos()[0], 2);
    clic('Guardar');
    clic('Lo tomé');
    clic('Lo tomé');
    clic('Ya junté todo');
    expect(api.routeFinish).toHaveBeenCalledTimes(1);
    const [id, body] = api.routeFinish.mock.calls[0];
    expect(id).toBe('rd-1');
    expect(body).toEqual({ products: [
      { product_id: 'p-mazapan', picked: 2 },
      { product_id: 'p-pulpa', picked: 5 },
      { product_id: 'p-chicle', picked: 2.5 },
    ] });
    const ids = (body as { products: Array<{ product_id: string }> }).products.map((x) => x.product_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cuerpoTerminar no repite aunque el detalle traiga el producto dos veces', () => {
    const b = cuerpoTerminar([P(), P()], { 'p-mazapan': 3 });
    expect(b.products).toEqual([{ product_id: 'p-mazapan', picked: 3 }]);
  });

  it('⭐ si «Ya junté todo» falla, lo dice, conserva lo marcado y NO avanza a Repartir', async () => {
    api.routeFinish = vi.fn(() => throwError(() => ({ status: 500, error: { message: 'Se cayó la conexión.' } })));
    await montar();
    clic('Lo tomé');
    clic('Lo tomé');
    clic('Lo tomé');
    clic('Ya junté todo');
    expect(c.fase()).toBe('recolectar');
    expect(texto()).toContain('Se cayó la conexión.');
    expect(texto()).toContain('Lo que marcaste sigue guardado');
    expect(c.hechos()).toBe(3);
    expect(terminar().disabled).toBe(false);
    expect(JSON.parse(localStorage.getItem(PREF_RUTA_RECOLECTA + 'rd-1') || '{}')).toEqual({ 'p-mazapan': 3, 'p-pulpa': 5, 'p-chicle': 2.5 });
  });

  it('lo marcado sobrevive a una recarga del celular', async () => {
    await montar();
    clic('Lo tomé');
    TestBed.resetTestingModule();
    await montar();
    expect(c.recolectado()).toEqual({ 'p-mazapan': 3 });
    expect(texto()).toContain('1/3');
  });

  it('si la ruta la está recolectando OTRA persona, no deja recolectar ni cerrar', async () => {
    api.routeDetail = vi.fn(() => of(DETALLE(RUTA({ pick_started: { user_id: 'otro', name: 'Félix Herrera', at: '2026-10-21T17:00:00.000Z' } }))));
    await montar();
    expect(c.fase()).toBe('bloqueada');
    expect(texto()).toContain('Félix Herrera');
    expect(boton('Ya junté todo')).toBeUndefined();
    expect(boton('Lo tomé')).toBeUndefined();
  });

  it('si llega directo con la ruta «lista», la arranca a su nombre antes de recolectar', async () => {
    api.routeDetail = vi.fn(() => of(DETALLE(RUTA({ state: 'lista', pick_started: null }))));
    await montar();
    expect(api.routeStart).toHaveBeenCalledWith('rd-1');
    expect(c.fase()).toBe('recolectar');
  });

  it('error al abrir la ruta ≠ ruta vacía: lo dice con Reintentar', async () => {
    api.routeDetail = vi.fn(() => throwError(() => ({ status: 0 })));
    await montar();
    expect(texto()).toContain('No se pudo abrir la ruta');
    clic('Reintentar');
    expect(api.routeDetail).toHaveBeenCalledTimes(2);
  });

  // ── Repartir ────────────────────────────────────────────────────────────────────────────

  async function aRepartir(): Promise<void> {
    await montar();
    clic('Lo tomé');
    clic('Lo tomé');
    clic('Lo tomé');
    clic('Ya junté todo');
  }

  it('Repartir: encabezado, avance de bolsas y una bolsa por cliente con su folio', async () => {
    await aRepartir();
    expect(c.fase()).toBe('repartir');
    expect(texto()).toContain('Repartir · Ruta de Paulina Placencia');
    expect(texto()).toContain('0/2');
    expect(texto()).toContain('Pedido 1 · ABARROTES ROSY');
    expect(texto()).toContain('PD-2026-00082');
    expect(texto()).toContain('Pedido 2 · VERO VASCO');
  });

  it('⭐ una línea con faltante sale en ROJO con «Pidió X; no alcanzó» y el nombre de la vendedora', async () => {
    await aRepartir();
    const rosy = el().querySelector('[data-pedido="o-rosy"]')!;
    const lineas = Array.from(rosy.querySelectorAll('.rr-bl'));
    const mazapan = lineas.find((l) => l.textContent?.includes('MAZAPAN'))!;
    const pulpa = lineas.find((l) => l.textContent?.includes('PULPARINDO'))!;
    expect(mazapan.classList).toContain('rr-bl-falta');
    expect(mazapan.textContent!.replace(/\s+/g, ' ')).toContain('Pidió 2 CJA; no alcanzó. Paulina Placencia ya tiene el aviso.');
    expect(pulpa.classList).not.toContain('rr-bl-falta');
    expect(pulpa.textContent).not.toContain('no alcanzó');
  });

  it('[MCP.3.13] la bolsa de una parte de pedido agrupado se rotula; la suelta no', async () => {
    const r = REPARTO();
    r.bags[0] = { ...r.bags[0], group_code: 'P-10482', group_parts: 2, group_other_warehouses: ['PH'] };
    r.bags[2] = { ...r.bags[2], group_code: 'P-10482', group_parts: 2, group_other_warehouses: ['PH'] };
    api.routeFinish = vi.fn(() => of(r));
    await aRepartir();
    const de = (id: string): string => (el().querySelector(`[data-pedido="${id}"]`)?.textContent ?? '').replace(/\s+/g, ' ');
    expect(de('o-rosy')).toContain('Parte de P-10482 · también surte PH');
    expect(de('o-esc')).toContain('Parte de P-10482 · también surte PH');
    // Prueba negativa: la bolsa de un pedido suelto no lleva rótulo.
    expect(de('o-vero')).not.toContain('Parte de');
  });

  it('una bolsa sin mercancía se dice como tal y no cuenta como bolsa por armar', async () => {
    await aRepartir();
    const esc = el().querySelector('[data-pedido="o-esc"]')!;
    expect(esc.textContent!.replace(/\s+/g, ' ')).toContain('No hubo nada de este pedido: avísale a Paulina Placencia para cancelarlo.');
    expect(esc.querySelector('button')).toBeNull();
    expect(texto()).toContain('2 pedidos por armar');
  });

  it('«Pedido listo» lo encoge con ✓; «Terminé» se habilita al final y vuelve a Surtir limpiando el celular', async () => {
    await aRepartir();
    const terminado = (): HTMLButtonElement => boton('Terminé · lista para la caja')!;
    expect(terminado().disabled).toBe(true);
    clic('Pedido listo');
    expect(texto()).toContain('1/2');
    expect(el().querySelector('.rr-hecho')!.textContent).toContain('Pedido 1 · ABARROTES ROSY');
    expect(terminado().disabled).toBe(true);
    clic('Pedido listo');
    expect(terminado().disabled).toBe(false);
    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    terminado().click();
    expect(router.serializeUrl(nav.mock.calls[0][0] as UrlTree)).toBe('/almacen/surtir');
    expect(localStorage.getItem(PREF_RUTA_BOLSAS + 'rd-1')).toBeNull();
  });

  it('si se recarga a media repartición, vuelve a Repartir con las bolsas listas que ya llevaba', async () => {
    await aRepartir();
    clic('Pedido listo');
    TestBed.resetTestingModule();
    api.routeDetail = vi.fn(() => of(DETALLE(RUTA({ state: 'surtida' }))));
    await montar();
    expect(c.fase()).toBe('repartir');
    expect(api.routeDetail).not.toHaveBeenCalled();
    expect(texto()).toContain('1/2');
  });
});
