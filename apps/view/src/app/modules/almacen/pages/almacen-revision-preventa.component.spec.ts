import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { PresaleReviewDetail, PresaleReviewInboxResponse, PresaleReviewInboxRow } from '@megadulces/contracts';
import { AlmacenRevisionPreventaComponent } from './almacen-revision-preventa.component';
import { PresaleReviewService } from '../presale-review.service';

/**
 * `[MCP.10]` La revisión en caja, montada de verdad (plantilla + signals) con el servidor simulado.
 * Se recorre como lo hace la cajera: ver lo que llegó, abrir un pedido, «Está bien», pedir el
 * faltante y confirmarlo, y terminar con lo que se va a cobrar.
 */
const fila = (p: Partial<PresaleReviewInboxRow> = {}): PresaleReviewInboxRow => ({
  order_id: 'o-carm', code: 'PD-2026-00138', customer_name: 'ABARROTES CARMELITA', seller_name: 'Vendedor PH',
  warehouse_name: 'Padre Hidalgo', requested_delivery_date: '2026-10-29', lines: 3, total: 380,
  finished: { user_id: 's1', name: 'Juan Surtidor', at: '2026-10-29T16:00:00.000Z' },
  pick_outcome: 'con_faltantes', state: 'por_revisar', reviewed: null, group_code: null, instructions: null, ...p,
});

const BANDEJA = (): PresaleReviewInboxResponse => ({
  today: '2026-10-29', pending: 2, truncated: false, scope: 'propios',
  data: [
    fila(),
    fila({ order_id: 'o-lupi', code: 'PD-2026-00140', customer_name: 'MISCELANEA LUPITA', pick_outcome: 'completo', finished: { user_id: 's1', name: 'Juan Surtidor', at: '2026-10-27T16:00:00.000Z' } }),
    fila({ order_id: 'o-rev', code: 'PD-2026-00131', customer_name: 'TIENDA YA REVISADA', state: 'revisado', reviewed: { user_id: 'c1', name: 'María Cajera', at: '2026-10-29T15:00:00.000Z' } }),
  ],
});

const DETALLE = (): PresaleReviewDetail => ({
  order: fila(),
  lines: [
    { key: 'l1', product_id: 'p1', product_name: 'PALETA PAYASO GRANDE', sku: '44340', unit: 'CJA', factor: 24, ordered: 1, picked: 1, restorable: true, stock: { state: 'con_existencia', qty: 14, checked_at: null } },
    { key: 'l2', product_id: 'p2', product_name: 'MAZAPAN GIGANTE 50 G', unit: 'PAQ', factor: 20, ordered: 3, picked: 2, restorable: true, stock: { state: 'con_existencia', qty: 65, checked_at: null } },
    { key: 'borrado:0', product_id: null, product_name: 'SALSA MAGA', unit: 'CJA', factor: 1, ordered: 1, picked: 0, restorable: false, stock: null },
  ],
});

describe('AlmacenRevisionPreventaComponent · revisión en caja (MCP.10)', () => {
  let fix: ComponentFixture<AlmacenRevisionPreventaComponent>;
  let api: Record<'inbox' | 'detail' | 'finish' | 'search', ReturnType<typeof vi.fn>>;

  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: string): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').includes(t)) as HTMLButtonElement | undefined;
  const clic = (t: string): void => {
    const b = boton(t);
    if (!b) throw new Error(`no hay botón «${t}»`);
    b.click();
    fix.detectChanges();
  };

  async function montar(detalle: () => PresaleReviewDetail = DETALLE): Promise<void> {
    try { localStorage.clear(); } catch { /* sin almacenamiento */ }
    api = {
      inbox: vi.fn(() => of(BANDEJA())),
      detail: vi.fn(() => of(detalle())),
      finish: vi.fn(() => of({ order_id: 'o-carm', review: { lines: [], total_before: 380, total_after: 420 } })),
      search: vi.fn((q: string) => of({ q, data: [], truncated: false })),
    };
    await TestBed.configureTestingModule({
      imports: [AlmacenRevisionPreventaComponent],
      providers: [provideRouter([]), { provide: PresaleReviewService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenRevisionPreventaComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  async function abrir(): Promise<void> {
    await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-carm' } });
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('la lista muestra lo que falta por revisar y, aparte, lo ya revisado', async () => {
    await montar();
    // El veredicto primero: cuántos faltan por revisar, cuántos con faltantes, cuántos ya se revisaron.
    expect(texto()).toContain('Por revisar');
    expect(fix.componentInstance.metricas().map((m) => [m.label, m.value])).toEqual([['Por revisar', 2], ['Con faltantes', 1], ['Revisados', 1]]);
    expect(texto()).toContain('ABARROTES CARMELITA');
    expect(texto()).toContain('Faltó algo');
    expect(texto()).toContain('Revisados');
    expect(texto()).toContain('TIENDA YA REVISADA');
  });

  it('[MCP.14] los pedidos a revisar van separados por vendedor y, dentro, en orden de folio', async () => {
    await montar();
    fix.componentInstance.bandeja.set({
      ...BANDEJA(),
      data: [
        fila({ order_id: 'b2', code: 'PD-2026-00399', customer_name: 'TIENDA B2', seller_name: 'Vendedor B', finished: { user_id: 's1', name: 'Surtidor', at: '2026-10-29T17:00:00.000Z' } }),
        fila({ order_id: 'a1', code: 'PD-2026-00376', customer_name: 'TIENDA A1', seller_name: 'Vendedor A', finished: { user_id: 's1', name: 'Surtidor', at: '2026-10-29T15:00:00.000Z' } }),
        fila({ order_id: 'b1', code: 'PD-2026-00377', customer_name: 'TIENDA B1', seller_name: 'Vendedor B', finished: { user_id: 's1', name: 'Surtidor', at: '2026-10-29T16:00:00.000Z' } }),
      ],
    });
    fix.detectChanges();
    const grupos = Array.from(el().querySelectorAll('.rv-grupo')).map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(grupos).toEqual(['Vendedor A · 1 pedido', 'Vendedor B · 2 pedidos']);
    const orden = Array.from(el().querySelectorAll('.rv-card .rv-cliente')).map((c) => c.textContent?.trim());
    expect(orden).toEqual(['TIENDA A1', 'TIENDA B1', 'TIENDA B2']);
  });

  it('[MCP.24] lo que no se revisó no desaparece ni se mezcla: va en un aviso por día y, abierto, dice desde cuándo', async () => {
    await montar();
    const tarjetas = (): string[] => Array.from(el().querySelectorAll('.rv-card')).map((b) => (b.textContent ?? '').replace(/\s+/g, ' '));
    expect(tarjetas().find((t) => t.includes('ABARROTES CARMELITA'))).not.toContain('Sin revisar');
    expect(tarjetas().some((t) => t.includes('MISCELANEA LUPITA'))).toBe(false);
    const aviso = (el().querySelector('.rv-atras')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(aviso).toContain('1 pedido sin revisar de días anteriores');
    expect(aviso).toContain('mar 27 oct · 1');
    api.inbox.mockReturnValueOnce(of({ ...BANDEJA(), date: '2026-10-27', data: [BANDEJA().data[1]] }));
    (el().querySelector('.rv-atras-d') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(api.inbox).toHaveBeenLastCalledWith('2026-10-27');
    expect(tarjetas().find((t) => t.includes('MISCELANEA LUPITA'))).toContain('Sin revisar · hace 2 días');
    expect(tarjetas().some((t) => t.includes('ABARROTES CARMELITA'))).toBe(false);
  });

  describe('[MCP.24] un día a la vez y por vendedor', () => {
    it('⭐ «Ayer» pide lo surtido ayer, revisado o no; «Hoy» regresa sin pedir nada', async () => {
      await montar();
      api.inbox.mockReturnValueOnce(of({ ...BANDEJA(), date: '2026-10-28', data: [
        fila({ order_id: 'y1', code: 'PD-2026-00120', customer_name: 'TIENDA DE AYER', state: 'revisado',
               finished: { user_id: 's1', name: 'Juan Surtidor', at: '2026-10-28T16:00:00.000Z' },
               reviewed: { user_id: 'c1', name: 'María Cajera', at: '2026-10-28T17:00:00.000Z' } }),
      ] }));
      fix.componentInstance.elegirPestana('ayer');
      fix.detectChanges();
      expect(api.inbox).toHaveBeenLastCalledWith('2026-10-28');
      expect(texto()).toContain('TIENDA DE AYER');
      expect(texto()).not.toContain('ABARROTES CARMELITA');
      const n = api.inbox.mock.calls.length;
      fix.componentInstance.elegirPestana('hoy');
      fix.detectChanges();
      expect(api.inbox.mock.calls.length).toBe(n);
      expect(texto()).toContain('ABARROTES CARMELITA');
    });

    it('⭐ la búsqueda en otros pedidos sigue viendo TODO lo pendiente, aunque la vista sea de un día', async () => {
      await montar();
      await abrir();
      expect(fix.componentInstance.otros().map((p) => p.order_id)).toEqual(['o-lupi']);
      // Y la métrica cuenta todo lo que falta, de cualquier día.
      expect(fix.componentInstance.metricas()[0].value).toBe(2);
    });

    it('elegir un vendedor deja sólo sus pedidos (pendientes y revisados)', async () => {
      await montar();
      const comp = fix.componentInstance;
      comp.bandeja.set({ ...BANDEJA(), data: [
        fila({ order_id: 'a1', code: 'PD-1', customer_name: 'TIENDA A1', seller_name: 'Vendedor A' }),
        fila({ order_id: 'b1', code: 'PD-2', customer_name: 'TIENDA B1', seller_name: 'Vendedor B' }),
        fila({ order_id: 'b2', code: 'PD-3', customer_name: 'TIENDA B2 REVISADA', seller_name: 'Vendedor B', state: 'revisado',
               reviewed: { user_id: 'c1', name: 'María Cajera', at: '2026-10-29T17:00:00.000Z' } }),
      ] });
      fix.detectChanges();
      expect(comp.opcionesVendedor().map((o) => o.label)).toEqual(['Todos · 3', 'Vendedor A · 1', 'Vendedor B · 2']);
      comp.vendedor.set('Vendedor A');
      fix.detectChanges();
      expect(texto()).toContain('TIENDA A1');
      expect(texto()).not.toContain('TIENDA B1');
      expect(texto()).not.toContain('TIENDA B2 REVISADA');
    });

    it('prueba negativa: si el día no carga, lo dice (no lo pinta vacío)', async () => {
      await montar();
      api.inbox.mockReturnValueOnce(throwError(() => ({ status: 0 })));
      fix.componentInstance.irADia('2026-10-20');
      fix.detectChanges();
      expect(texto()).not.toContain('Nada surtido');
      expect(texto()).toContain('No se pudieron cargar los pedidos de ese día');
    });
  });

  it('si la lista se cortó en el tope, lo dice con el total real', async () => {
    await montar();
    fix.componentInstance.bandeja.set({ ...BANDEJA(), pending: 340, truncated: true });
    fix.detectChanges();
    expect(texto()).toContain('Hay 340 pedidos sin revisar y aquí se ven los primeros 2');
    expect(fix.componentInstance.metricas()[0].value).toBe(340);
  });

  it('señala un producto a la vez: «Está bien» pasa al siguiente', async () => {
    await montar();
    await abrir();
    expect(api.detail).toHaveBeenCalledWith('o-carm');
    expect(texto()).toContain('Producto 1 de 3');
    expect(texto()).toContain('PALETA PAYASO GRANDE');
    expect(texto()).toContain('Deben ser 1 caja');
    // [VTK.15] El SKU a la vista mientras revisa.
    expect(texto()).toContain('SKU 44340');
    clic('Está bien');
    expect(texto()).toContain('Producto 2 de 3');
    expect(texto()).toContain('faltan 1 paquete');
    expect(texto()).toContain('El sistema dice que sí hay (65 paquetes)');
  });

  it('[MCP.13] el producto que puso el surtidor en lugar de otro lo dice mientras se revisa', async () => {
    await montar(() => ({
      order: fila(),
      lines: [{ key: 'n1', product_id: 'p9', product_name: 'BANDERILLA CHICA', sku: '05190', unit: 'PZA', factor: 1, ordered: 1, picked: 1,
        restorable: true, stock: null, substitutes_for: 'VIT BANDERILLA GRANDE' }],
    }));
    await abrir();
    expect(texto()).toContain('En lugar de VIT BANDERILLA GRANDE · lo cambió el surtidor');
    clic('No coincide');
    // También mientras cuenta: sigue diciendo de dónde salió.
    expect(texto()).toContain('En lugar de VIT BANDERILLA GRANDE');
  });

  it('el faltante se completa con el surtidor; el borrado sin copia sólo deja «No hay»', async () => {
    await montar();
    await abrir();
    clic('Está bien');
    clic('Ya se completó');
    expect(texto()).toContain('SALSA MAGA');
    expect(texto()).toContain('ya no se puede agregar desde aquí');
    expect(boton('Ya se completó')).toBeUndefined();
    // Sin existencia leída se DECLARA, no se dibuja «no hay».
    expect(texto()).toContain('No se pudo saber si hay en el sistema');
    clic('No hay');
    expect(texto()).toContain('Pedido revisado');
    expect(texto()).toContain('No se cobra lo que no hubo: 1 caja de SALSA MAGA');
    clic('Terminar y seguir con el siguiente');
    expect(api.finish).toHaveBeenCalledWith('o-carm', { lines: [
      { key: 'l1', final: 1 }, { key: 'l2', final: 3 }, { key: 'borrado:0', final: 0 },
    ] });
  });

  describe('[MCP.18] el porqué de lo que la caja no cobra', () => {
    const radio = (t: string): HTMLButtonElement =>
      Array.from(el().querySelectorAll('[role="radio"]')).find((b) => (b.textContent ?? '').includes(t)) as HTMLButtonElement;
    /** La PALETA venía completa según el surtidor (1 de 1) y la caja no la encuentra: eso lo decide la caja. */
    async function sinPaleta(): Promise<void> {
      await montar();
      await abrir();
      clic('No coincide');
      (el().querySelector('[aria-label="Uno menos"]') as HTMLButtonElement).click();
      fix.detectChanges();
      clic('Guardar');
      clic('No hay');          // PALETA: la caja deja 0 de 1 surtido
      clic('Ya se completó');  // MAZAPÁN: el surtidor trajo lo que faltó
      clic('No hay');          // SALSA: ya venía quitada del surtido
    }

    it('sólo lo que la CAJA deja por debajo de lo surtido pide motivo, con «No venía en el carrito» ya marcado', async () => {
      await sinPaleta();
      expect(texto()).toContain('Pedido revisado');
      const grupos = Array.from(el().querySelectorAll('.rv-motivo')).map((g) => g.querySelector('b')?.textContent);
      // Negativa: la SALSA ya faltaba al surtir (tiene el motivo del surtidor), no se le pregunta a la caja.
      expect(grupos).toEqual(['PALETA PAYASO GRANDE']);
      expect(radio('No venía en el carrito').getAttribute('aria-checked')).toBe('true');
      clic('Terminar y seguir con el siguiente');
      expect(api.finish).toHaveBeenCalledWith('o-carm', { lines: [
        { key: 'l1', final: 0, reason: 'no_venia' }, { key: 'l2', final: 3 }, { key: 'borrado:0', final: 0 },
      ] });
    });

    it('elegir otro motivo viaja al terminar', async () => {
      await sinPaleta();
      radio('Lo pidió quitar el vendedor o el cliente').click();
      fix.detectChanges();
      clic('Terminar y seguir con el siguiente');
      expect(api.finish.mock.calls[0][1].lines[0]).toEqual({ key: 'l1', final: 0, reason: 'lo_pidio_quitar' });
    });

    it('negativa: «Otro motivo» sin escribir no deja terminar', async () => {
      await sinPaleta();
      radio('Otro motivo').click();
      fix.detectChanges();
      expect(texto()).toContain('Con «Otro motivo» escribe cuál fue.');
      expect(boton('Terminar y seguir con el siguiente')?.disabled).toBe(true);
      boton('Terminar y seguir con el siguiente')?.click();
      expect(api.finish).not.toHaveBeenCalled();
    });

    it('la caja ve por qué cambió el pedido antes de llegarle (vendedora y surtidor)', async () => {
      await montar(() => ({ ...DETALLE(), justifications: [
        { actor: 'seller', action: 'reopened', by_name: 'Vendedor Prueba', at: '2026-10-29T15:00:00.000Z', product_name: null, detail: null, reason: null },
        { actor: 'picker', action: 'removed', by_name: 'Surtidor Prueba', at: '2026-10-29T16:00:00.000Z', product_name: 'SALSA MAGA', detail: '1 CJA', reason: 'Dañado o caducado' },
      ] }));
      await abrir();
      expect(texto()).toContain('Corrigió el pedido. Motivo: Sin motivo registrado');
      expect(texto()).toContain('Surtidor · Surtidor Prueba');
      expect(texto()).toContain('Quitó SALSA MAGA (1 CJA). Motivo: Dañado o caducado');
    });
  });

  it('«No coincide» abre el − / + y lo que falta se vuelve faltante', async () => {
    await montar();
    await abrir();
    clic('No coincide');
    expect(texto()).toContain('¿Cuántos vienen?');
    (el().querySelector('[aria-label="Uno menos"]') as HTMLButtonElement).click();
    fix.detectChanges();
    clic('Guardar');
    expect(texto()).toContain('Se pidieron 1 y vienen 0');
  });

  it('«← Anterior» deshace el último toque', async () => {
    await montar();
    await abrir();
    expect(boton('Anterior')).toBeUndefined();
    clic('Está bien');
    clic('Anterior');
    expect(texto()).toContain('Producto 1 de 3');
    expect(texto()).toContain('Deben ser 1 caja');
  });

  it('[MCP.10.2] se revisa el producto que se tiene en la mano, no sólo el que sigue', async () => {
    await montar();
    await abrir();
    const enGrande = (): string => (el().querySelector('.rv-actual')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(enGrande()).toContain('PALETA PAYASO GRANDE');
    expect(texto()).toContain('Por revisar · 2');
    expect(texto()).toContain('o tócalo aquí');
    // El mazapán viene arriba en el carrito: la cajera lo toca aunque sea el 2º del pedido.
    clic('MAZAPAN GIGANTE 50 G');
    expect(enGrande()).toContain('MAZAPAN GIGANTE 50 G');
    expect(enGrande()).toContain('faltan 1 paquete');
    clic('Ya se completó');
    // Resuelto lo tocado, vuelve al primero pendiente.
    expect(enGrande()).toContain('PALETA PAYASO GRANDE');
    expect(texto()).toContain('Producto 2 de 3');
    // «Anterior» regresa a ESE producto, no al primero de la lista.
    clic('Anterior');
    expect(enGrande()).toContain('MAZAPAN GIGANTE 50 G');
    clic('Ya se completó');
    clic('Está bien');
    // NEGATIVO: lo ya revisado no se puede tocar (se corrige con «Anterior»).
    expect(boton('PALETA PAYASO GRANDE')).toBeUndefined();
    expect(boton('MAZAPAN GIGANTE 50 G')).toBeUndefined();
    expect(enGrande()).toContain('SALSA MAGA');
    // Con uno solo pendiente ya no hay nada más que tocar: el aviso se va; lo revisado queda aparte.
    expect(texto()).not.toContain('Por revisar ·');
    expect(texto()).toContain('Ya revisados · 2');
    // Sin códigos de Kepler se DECLARA: se revisa tocando.
    expect(texto()).toContain('No se pudieron leer los códigos de Kepler');
    expect(el().querySelector('#rv-scan-in')).not.toBeNull(); // se sigue buscando por SKU o nombre
  });

  it('[MCP.10.3] la nota del vendedor ya no se pinta en la revisión (decisión de David, 2026-11-09)', async () => {
    await montar(() => ({ ...DETALLE(), order: fila({ instructions: 'Dejar en la bodega de atrás' }) }));
    await abrir();
    expect(texto()).toContain('PALETA PAYASO GRANDE');
    expect(texto()).not.toContain('Dejar en la bodega de atrás');
  });

  it('[MCP.10.3] sin límites: por SKU, por nombre (filtra la lista y lo dice) y lo de otro pedido lo encuentra y lo abre', async () => {
    await montar();
    api.search.mockImplementation((q: string) => of({ q, truncated: false, data: [
      { order_id: 'o-lupi', code: 'PD-2026-00140', customer_name: 'MISCELANEA LUPITA', seller_name: 'Vendedor PH', product_name: 'CHICLE MOTITA', sku: '55555', match: 'nombre' },
    ] }));
    await abrir();
    const campo = el().querySelector('#rv-scan-in') as HTMLInputElement;
    const escribir = (t: string): void => { campo.value = t; campo.dispatchEvent(new Event('input')); fix.detectChanges(); };
    const enter = (): void => { campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); fix.detectChanges(); };
    const enGrande = (): string => (el().querySelector('.rv-actual')?.textContent ?? '').replace(/\s+/g, ' ');

    // El SKU que se ve en pantalla lo señala (sin confirmarlo: el SKU no dice la unidad).
    escribir('44340'); enter();
    expect(texto()).toContain('PALETA PAYASO GRANDE: revísalo aquí abajo');
    expect(texto()).toContain('Producto 1 de 3');

    // Parte del nombre filtra «Por revisar» mientras se escribe, y lo DICE («1 de 2»).
    escribir('maga');
    expect(texto()).toContain('Por revisar · 1 de 2');
    expect(texto()).toContain('Coinciden con «maga»');
    expect(boton('MAZAPAN GIGANTE 50 G')).toBeUndefined();
    clic('Ver todos');
    expect(texto()).toContain('Por revisar · 2');
    expect(boton('MAZAPAN GIGANTE 50 G')).toBeDefined();
    escribir('maga'); enter();
    expect(enGrande()).toContain('SALSA MAGA');

    // Lo que no es de este pedido se busca en los otros por revisar y se puede abrir desde ahí.
    escribir('chicle'); enter();
    expect(api.search).toHaveBeenCalledWith('chicle');
    expect(texto()).toContain('«chicle» no es de este pedido');
    (el().querySelector('.rv-hit') as HTMLButtonElement).click();
    await fix.whenStable();
    fix.detectChanges();
    expect(api.detail).toHaveBeenLastCalledWith('o-lupi');
  });

  it('[MCP.10.3] con lector: lo de 1 unidad queda bien al escanear, lo demás se señala y lo ajeno se avisa', async () => {
    await montar(() => {
      const d = DETALLE();
      d.lines[0].codes = [{ code: '7501000044340', factor: 1 }, { code: 'C44340', factor: 24 }];
      d.lines[1].codes = [{ code: '7502000000050', factor: 20 }];
      d.lines[2].codes = [];
      return d;
    });
    await abrir();
    const campo = el().querySelector('#rv-scan-in') as HTMLInputElement;
    expect(campo).not.toBeNull();
    const escanear = (codigo: string): void => {
      campo.value = codigo;
      campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fix.detectChanges();
    };
    const enGrande = (): string => (el().querySelector('.rv-actual')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(texto()).toContain('Escanéalo o escríbelo arriba');

    // NEGATIVO: la PIEZA de la paleta (pedido de 1 caja de 24) sólo la señala, no la da por buena.
    escanear('7501000044340');
    expect(texto()).toContain('PALETA PAYASO GRANDE: revísalo aquí abajo');
    expect(texto()).toContain('Producto 1 de 3');
    expect(campo.value).toBe('');

    // La etiqueta de la CAJA sí: 1 de 1, queda bien sin tocar nada.
    escanear('C44340');
    expect(texto()).toContain('PALETA PAYASO GRANDE · bien');
    expect(texto()).toContain('Producto 2 de 3');
    expect(texto()).toContain('Ya revisados · 1');

    escanear('C44340');
    expect(texto()).toContain('ya lo revisaste');

    // Lo que no es del pedido se avisa, y como la salsa no tiene código, dice que puede ser ésa.
    escanear('999');
    expect(api.search).toHaveBeenCalledWith('999');
    expect(texto()).toContain('«999» no está en este pedido ni en los otros por revisar');
    expect(texto()).toContain('Producto 2 de 3');

    // El mazapán (3 paquetes, faltó 1) se señala para resolver el faltante en grande.
    escanear('7502000000050');
    expect(enGrande()).toContain('MAZAPAN GIGANTE 50 G');
    expect(enGrande()).toContain('faltan 1 paquete');
  });

  it('se puede cambiar a otro pedido por revisar', async () => {
    await montar();
    await abrir();
    expect(boton('MISCELANEA LUPITA')).toBeDefined();
    expect(boton('TIENDA YA REVISADA')).toBeUndefined();
  });

  it('si el servidor rechaza el cierre se dice y la revisión NO se pierde', async () => {
    await montar();
    await abrir();
    api.finish.mockReturnValueOnce(throwError(() => ({ error: { message: 'Este pedido ya lo revisó María Cajera a las 10:00.' } })));
    clic('Está bien');
    clic('Ya se completó');
    clic('No hay');
    clic('Terminar y seguir con el siguiente');
    expect(texto()).toContain('Pedido revisado');
    expect(boton('Terminar y seguir con el siguiente')?.disabled).toBe(false);
  });

  it('un error al cargar la lista se muestra como error, no como «no hay pedidos»', async () => {
    await montar();
    api.inbox.mockReturnValueOnce(throwError(() => ({ error: { message: 'boom' } })));
    fix.componentInstance.bandeja.set(null);
    fix.componentInstance.cargar();
    fix.detectChanges();
    expect(texto()).not.toContain('No hay pedidos por revisar');
    expect(texto()).toContain('boom');
  });
});
