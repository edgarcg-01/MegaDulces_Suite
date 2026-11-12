import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import type { PresalePickDetail, PresalePickInboxResponse, PresalePickInboxRow, PresaleSubstituteResponse } from '@megadulces/contracts';
import { AlmacenSurtirPreventaComponent } from './almacen-surtir-preventa.component';
import { PresalePickingService } from '../presale-picking.service';
import { AlertsSocketService } from '../../dashboard/command-center/alerts-socket.service';

/**
 * `[MCP.3]` La bandeja del surtidor de preventa, montada de verdad (plantilla + signals) con el
 * servidor simulado. Se recorre como lo hace el surtidor: ver los de hoy, abrir uno desde el aviso,
 * empezar, marcar lo que hubo y cerrar (completo o con reporte a la vendedora).
 */
const fila = (p: Partial<PresalePickInboxRow> = {}): PresalePickInboxRow => ({
  order_id: 'o-rosy', code: 'PD-2026-00072', customer_name: 'ABARROTES ROSY', seller_name: 'Vendedora Prueba',
  warehouse_id: 'w-02', warehouse_name: 'La Piedad Abastos', requested_delivery_date: '2026-10-14',
  bucket: 'hoy', days_late: 0, arrived_at: '2026-10-14T15:42:00.000Z', lines: 2, total: 475.44,
  state: 'nuevo', started: null, finished: null, unseen: true, ...p,
});

const BANDEJA = (): PresalePickInboxResponse => ({
  today: '2026-10-14',
  counts: { hoy: 2, manana: 1, proximos: 0 },
  scope: 'propios',
  data: [
    fila(),
    fila({ order_id: 'o-vero', code: 'PD-2026-00070', customer_name: 'VERO VASCO', days_late: 2, requested_delivery_date: '2026-10-12', unseen: false }),
    fila({ order_id: 'o-esc', code: 'PD-2026-00065', customer_name: 'ESCUELA AMARILLA', bucket: 'manana', requested_delivery_date: '2026-10-15' }),
  ],
});

const DETALLE = (estado: PresalePickInboxRow['state'] = 'nuevo'): PresalePickDetail => ({
  order: fila({
    state: estado,
    started: estado === 'nuevo' ? null : { user_id: 'yo', name: 'Juan Pérez', at: '2026-10-14T15:43:00.000Z' },
  }),
  lines: [
    { line_id: 'l1', product_id: 'p1', sku: '70012', product_name: 'BOMBON GRANDE', qty: 5, unit: 'PAQ', factor: 1, picked: null },
    { line_id: 'l2', product_id: 'p2', sku: '99124', product_name: 'SALSA MAGA 1 1/2', qty: 1, unit: 'CJA', factor: 1, picked: null },
  ],
});

/** `[MCP.13]` Lo que el servidor sugiere en lugar de la SALSA que no hubo. */
const SUGERENCIAS = (): PresaleSubstituteResponse => ({
  for_line_id: 'l2', for_product_name: 'SALSA MAGA 1 1/2', missing: 1, unit: 'CJA',
  data: [
    {
      product_id: 'p9', sku: '61842', product_name: 'SALSA CHAMOY 1L CHILERITO',
      units: [{ unit: 'CJA', factor: 12, price: 455 }, { unit: 'PZA', factor: 1, price: 39.5 }],
      stock_qty: 108, stock_state: 'con_existencia', match: 'nombre',
    },
    {
      product_id: 'p8', sku: '61900', product_name: 'SALSA VALENTINA 1L',
      units: [{ unit: 'PZA', factor: 1, price: 31 }], stock_qty: null, stock_state: 'sin_dato', match: 'nombre_y_proveedor',
    },
  ],
});

describe('AlmacenSurtirPreventaComponent · la bandeja del surtidor (MCP.3)', () => {
  let fix: ComponentFixture<AlmacenSurtirPreventaComponent>;
  let api: Record<'inbox' | 'detail' | 'start' | 'finish' | 'substitutes', ReturnType<typeof vi.fn>>;
  let alert$: Subject<{ type: string }>;

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

  async function montar(detalle: PresalePickDetail = DETALLE()): Promise<void> {
    api = {
      inbox: vi.fn(() => of(BANDEJA())),
      detail: vi.fn(() => of(detalle)),
      start: vi.fn(() => of(fila({ state: 'surtiendo', started: { user_id: 'yo', name: 'Juan Pérez', at: '2026-10-14T15:43:00.000Z' } }))),
      finish: vi.fn(() => of({ order_id: 'o-rosy', outcome: 'con_faltantes', report: { removed: [], adjusted: [], total_before: 475.44, total_after: 161.4 } })),
      substitutes: vi.fn(() => of(SUGERENCIAS())),
    };
    alert$ = new Subject();
    await TestBed.configureTestingModule({
      imports: [AlmacenSurtirPreventaComponent],
      providers: [
        provideRouter([]),
        { provide: PresalePickingService, useValue: api },
        { provide: AlertsSocketService, useValue: { connect: vi.fn(), alert$, connected: signal(true) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenSurtirPreventaComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('abre en Hoy con lo de hoy y lo vencido, y cuenta lo que falta por día', async () => {
    await montar();
    expect(texto()).toContain('Hoy · 2');
    expect(texto()).toContain('Mañana · 1');
    expect(texto()).toContain('ABARROTES ROSY');
    expect(texto()).toContain('vencido 2 días');
    expect(texto()).not.toContain('ESCUELA AMARILLA');
  });

  it('[MCP.14] separa por vendedor y, dentro, en orden de folio (no por hora de llegada)', async () => {
    await montar();
    const comp = fix.componentInstance;
    comp.bandeja.set({
      ...BANDEJA(),
      data: [
        fila({ order_id: 'b2', code: 'PD-2026-00399', customer_name: 'TIENDA B2', seller_name: 'Vendedor B', arrived_at: '2026-10-14T17:51:00.000Z' }),
        fila({ order_id: 'a1', code: 'PD-2026-00376', customer_name: 'TIENDA A1', seller_name: 'Vendedor A', arrived_at: '2026-10-14T15:34:00.000Z' }),
        fila({ order_id: 'b1', code: 'PD-2026-00377', customer_name: 'TIENDA B1', seller_name: 'Vendedor B', arrived_at: '2026-10-14T16:56:00.000Z' }),
        fila({ order_id: 'a2', code: 'PD-2026-00392', customer_name: 'TIENDA A2', seller_name: 'Vendedor A', arrived_at: '2026-10-14T17:00:00.000Z' }),
      ],
    });
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    const grupos = Array.from(el.querySelectorAll('.sp-grupo')).map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(grupos).toEqual(['Vendedor A · 2 pedidos', 'Vendedor B · 2 pedidos']);
    const orden = Array.from(el.querySelectorAll('.sp-card .sp-cliente')).map((c) => c.textContent?.trim());
    expect(orden).toEqual(['TIENDA A1', 'TIENDA A2', 'TIENDA B1', 'TIENDA B2']);
  });

  it('cambiar a Mañana muestra los de mañana', async () => {
    await montar();
    fix.componentInstance.pestana.set('manana');
    fix.detectChanges();
    expect(texto()).toContain('ESCUELA AMARILLA');
    expect(texto()).not.toContain('VERO VASCO');
  });

  it('el aviso en vivo vuelve a pedir la bandeja sin esperar', async () => {
    await montar();
    expect(api.inbox).toHaveBeenCalledTimes(1);
    alert$.next({ type: 'order_to_pick' });
    expect(api.inbox).toHaveBeenCalledTimes(2);
    alert$.next({ type: 'otra_cosa' });
    expect(api.inbox).toHaveBeenCalledTimes(2);
  });

  it('?pedido= abre el pedido (es a donde lleva la campana) y empezar registra al surtidor', async () => {
    await montar();
    await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
    fix.detectChanges();
    expect(api.detail).toHaveBeenCalledWith('o-rosy');
    expect(texto()).toContain('Al empezar queda registrado quién surte');
    clic('Empezar a surtir');
    expect(api.start).toHaveBeenCalledWith('o-rosy');
    expect(texto()).toContain('Surte: Juan Pérez');
    expect(boton('Completo')).toBeDefined();
  });

  it('no deja terminar sin marcar todo; con un faltante manda el reporte con lo que sí hubo', async () => {
    await montar(DETALLE('surtiendo'));
    await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
    fix.detectChanges();
    expect(boton('Marca todos los productos')?.disabled).toBe(true);

    const completos = Array.from(el().querySelectorAll('button')).filter((b) => b.textContent?.includes('Completo'));
    (completos[0] as HTMLButtonElement).click();
    fix.detectChanges();
    // SALSA: no hubo → baja de 1 a 0.
    (el().querySelector('[aria-label="Menos SALSA MAGA 1 1/2"]') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(texto()).toContain('no hubo');
    clic('Enviar reporte a Vendedora Prueba · faltaron 1');
    // [MCP.18] El faltante viaja con su motivo: sin tocar, el de por omisión («No había en la sucursal»).
    expect(api.finish).toHaveBeenCalledWith('o-rosy', { lines: [{ line_id: 'l1', picked: 5 }, { line_id: 'l2', picked: 0, reason: 'sin_existencia' }] });
  });

  describe('[MCP.18] el porqué de lo que faltó', () => {
    async function conSalsaEnCero(): Promise<void> {
      await montar(DETALLE('surtiendo'));
      await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
      fix.detectChanges();
      (Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.includes('Completo')) as HTMLButtonElement).click();
      fix.detectChanges();
      (el().querySelector('[aria-label="Menos SALSA MAGA 1 1/2"]') as HTMLButtonElement).click();
      fix.detectChanges();
    }
    const radio = (t: string): HTMLButtonElement =>
      Array.from(el().querySelectorAll('[role="radio"]')).find((b) => (b.textContent ?? '').includes(t)) as HTMLButtonElement;

    it('el faltante pregunta «¿Por qué?» con «No había en la sucursal» ya marcado; lo que hubo completo, no', async () => {
      await conSalsaEnCero();
      const grupos = el().querySelectorAll('app-motivo-chips');
      expect(grupos.length).toBe(1);
      expect(radio('No había en la sucursal').getAttribute('aria-checked')).toBe('true');
    });

    it('elegir otro motivo y una nota viaja al terminar', async () => {
      await conSalsaEnCero();
      radio('Dañado o caducado').click();
      fix.detectChanges();
      clic('Agregar nota');
      const nota = el().querySelector('#sp-mot-l2-n') as HTMLInputElement;
      nota.value = 'caja mojada';
      nota.dispatchEvent(new Event('input'));
      fix.detectChanges();
      clic('Enviar reporte');
      expect(api.finish.mock.calls[0][1].lines[1]).toEqual({ line_id: 'l2', picked: 0, reason: 'danado', reason_note: 'caja mojada' });
    });

    it('negativa: «Otro motivo» sin escribir no deja enviar el reporte, y lo dice', async () => {
      await conSalsaEnCero();
      radio('Otro motivo').click();
      fix.detectChanges();
      expect(texto()).toContain('Con «Otro motivo» escribe cuál fue.');
      expect(boton('Enviar reporte')?.disabled).toBe(true);
      boton('Enviar reporte')?.click();
      expect(api.finish).not.toHaveBeenCalled();
      const nota = el().querySelector('#sp-mot-l2-n') as HTMLInputElement;
      nota.value = 'el cliente lo canceló por teléfono';
      nota.dispatchEvent(new Event('input'));
      fix.detectChanges();
      expect(boton('Enviar reporte')?.disabled).toBe(false);
    });

    it('un pedido cerrado dice por qué cambió; lo guardado sin motivo dice «Sin motivo registrado»', async () => {
      const cerrado: PresalePickDetail = {
        order: fila({ state: 'con_faltantes', started: { user_id: 'yo', name: 'Surtidor Prueba', at: '2026-11-10T16:00:00.000Z' }, finished: { user_id: 'yo', name: 'Surtidor Prueba', at: '2026-11-10T16:10:00.000Z' } }),
        lines: [{ line_id: 'l1', product_id: 'p1', sku: '1', product_name: 'BOMBON GRANDE', qty: 5, unit: 'PAQ', factor: 1, picked: 5 }],
        justifications: [
          { actor: 'seller', action: 'reopened', by_name: 'Vendedora Prueba', at: '2026-11-10T15:00:00.000Z', product_name: null, detail: null, reason: 'El cliente quiere agregar productos' },
          { actor: 'picker', action: 'removed', by_name: 'Surtidor Prueba', at: '2026-11-10T16:10:00.000Z', product_name: 'SALSA MAGA', detail: '1 CJA', reason: null },
        ],
      };
      await montar(cerrado);
      await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
      fix.detectChanges();
      expect(texto()).toContain('Por qué cambió este pedido');
      expect(texto()).toContain('Vendedor · Vendedora Prueba');
      expect(texto()).toContain('Corrigió el pedido. Motivo: El cliente quiere agregar productos');
      expect(texto()).toContain('Quitó SALSA MAGA (1 CJA). Motivo: Sin motivo registrado');
    });

    it('negativa: sin cambios no se pinta el recuadro', async () => {
      await montar(DETALLE('nuevo'));
      await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
      fix.detectChanges();
      expect(texto()).not.toContain('Por qué cambió');
    });
  });

  it('si hubo todo, el botón es «Confirmar: hubo todo»', async () => {
    await montar(DETALLE('surtiendo'));
    await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
    fix.detectChanges();
    for (const b of Array.from(el().querySelectorAll('button')).filter((x) => x.textContent?.includes('Completo'))) (b as HTMLButtonElement).click();
    fix.detectChanges();
    expect(boton('Confirmar: hubo todo')).toBeDefined();
    expect(boton('Enviar reporte')).toBeUndefined();
  });

  /** `[MCP.10.1]` La caja completó lo que faltó: el surtidor no debe ver como suyo lo que trajo la caja. */
  it('un pedido revisado en caja dice «Revisado en caja» y separa lo que surtió de lo que quedó', async () => {
    const revisado: PresalePickDetail = {
      order: fila({
        state: 'con_faltantes',
        started: { user_id: 'yo', name: 'Juan Pérez', at: '2026-11-03T18:00:00.000Z' },
        finished: { user_id: 'yo', name: 'Juan Pérez', at: '2026-11-03T18:10:00.000Z' },
        reviewed: { user_id: 'c1', name: 'María Cajera', at: '2026-11-03T18:51:00.000Z' },
      }),
      lines: [
        { line_id: 'l1', product_id: 'p1', sku: '1', product_name: 'SALSA CHAMOY 1L CHILERITO', qty: 2, unit: 'CJA', factor: 12, picked: 1, final: 2 },
        { line_id: 'l2', product_id: 'p2', sku: '2', product_name: 'BOMBON GRANDE', qty: 5, unit: 'PAQ', factor: 1, picked: 5, final: 5 },
      ],
    };
    await montar(revisado);
    api.inbox.mockReturnValue(of({ ...BANDEJA(), data: [revisado.order] }));
    fix.componentInstance.cargar();
    fix.detectChanges();
    expect(texto()).toContain('Revisado en caja');
    await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
    fix.detectChanges();
    expect(texto()).toContain('Surtiste 1 · la caja dejó 2');
    // [VTK.15] El SKU a la vista al surtir.
    expect(texto()).toContain('SKU 1');
    // Lo que no cambió en caja no lleva la nota.
    expect(texto()).not.toContain('Surtiste 5');
    expect(texto()).toContain('Revisado en caja por María Cajera');
  });

  describe('[MCP.13] cambiar lo que faltó por otro producto', () => {
    async function conFaltante(): Promise<void> {
      await montar(DETALLE('surtiendo'));
      await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
      fix.detectChanges();
      const completos = Array.from(el().querySelectorAll('button')).filter((b) => b.textContent?.includes('Completo'));
      (completos[0] as HTMLButtonElement).click();
      fix.detectChanges();
      (el().querySelector('[aria-label="Menos SALSA MAGA 1 1/2"]') as HTMLButtonElement).click();
      fix.detectChanges();
    }

    it('el botón sólo aparece en el renglón que no se surtió completo', async () => {
      await conFaltante();
      expect(Array.from(el().querySelectorAll('button')).filter((b) => b.textContent?.includes('Cambiar por otro producto')).length).toBe(1);
    });

    it('⭐ sugiere con precio y existencia, y elegir uno lo manda al terminar por lo que faltó', async () => {
      await conFaltante();
      clic('Cambiar por otro producto');
      expect(api.substitutes).toHaveBeenCalledWith('o-rosy', 'l2', '');
      expect(texto()).toContain('Faltan 1 CJA');
      expect(texto()).toContain('SALSA CHAMOY 1L CHILERITO');
      expect(texto()).toContain('hay 9 CJA'); // 108 piezas / 12 por caja
      // Lo que no se pudo medir se declara, no se pinta como cero.
      expect(texto()).toContain('existencia sin dato');
      clic('SALSA CHAMOY 1L CHILERITO');
      expect(texto()).toContain('En lugar de lo que faltó');
      expect(texto()).toContain('1 cambiado por otro');
      clic('Enviar reporte');
      expect(api.finish).toHaveBeenCalledWith('o-rosy', {
        lines: [
          { line_id: 'l1', picked: 5 },
          { line_id: 'l2', picked: 0, substitute: { product_id: 'p9', quantity: 1, unit: 'CJA' }, reason: 'sin_existencia' },
        ],
      });
    });

    it('se puede cambiar la unidad y la cantidad del sustituto', async () => {
      await conFaltante();
      clic('Cambiar por otro producto');
      clic('SALSA CHAMOY 1L CHILERITO');
      clic('PZA');
      (el().querySelector('[aria-label="Más SALSA CHAMOY 1L CHILERITO"]') as HTMLButtonElement).click();
      fix.detectChanges();
      clic('Enviar reporte');
      expect(api.finish.mock.calls[0][1].lines[1].substitute).toEqual({ product_id: 'p9', quantity: 2, unit: 'PZA' });
    });

    it('«Quitar el cambio» lo deja como «no hubo»; si al final sí hubo todo, el cambio se va solo', async () => {
      await conFaltante();
      clic('Cambiar por otro producto');
      clic('SALSA CHAMOY 1L CHILERITO');
      clic('Quitar el cambio');
      expect(texto()).not.toContain('En lugar de lo que faltó');
      clic('Cambiar por otro producto');
      clic('SALSA CHAMOY 1L CHILERITO');
      // Ahora sí apareció la salsa: «Completo» en ese renglón.
      const completos = Array.from(el().querySelectorAll('button')).filter((b) => b.textContent?.includes('Completo'));
      (completos[1] as HTMLButtonElement).click();
      fix.detectChanges();
      expect(texto()).not.toContain('En lugar de lo que faltó');
      clic('Confirmar: hubo todo');
      expect(api.finish.mock.calls[0][1].lines[1]).toEqual({ line_id: 'l2', picked: 1 });
    });

    it('buscar pide al servidor con lo tecleado', async () => {
      vi.useFakeTimers();
      try {
        await conFaltante();
        clic('Cambiar por otro producto');
        const q = el().querySelector('input[type="search"]') as HTMLInputElement;
        q.value = 'valentina';
        q.dispatchEvent(new Event('input'));
        vi.advanceTimersByTime(350);
        expect(api.substitutes).toHaveBeenLastCalledWith('o-rosy', 'l2', 'valentina');
      } finally {
        vi.useRealTimers();
      }
    });

    it('un pedido cerrado dice qué renglón se puso en lugar de cuál', async () => {
      const cerrado: PresalePickDetail = {
        order: fila({ state: 'con_faltantes', finished: { user_id: 'yo', name: 'Juan Pérez', at: '2026-11-04T18:10:00.000Z' } }),
        lines: [{ line_id: 'n1', product_id: 'p9', sku: '61842', product_name: 'SALSA CHAMOY 1L CHILERITO', qty: 1, unit: 'CJA', factor: 12, picked: 1,
          substitutes: { product_name: 'SALSA MAGA 1 1/2', sku: '99124' } }],
      };
      await montar(cerrado);
      await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
      fix.detectChanges();
      expect(texto()).toContain('En lugar de SALSA MAGA 1 1/2');
    });
  });

  it('sin sucursal asignada lo dice en vez de mostrar una bandeja vacía muda', async () => {
    await montar();
    api.inbox.mockReturnValue(of({ today: '2026-10-14', counts: { hoy: 0, manana: 0, proximos: 0 }, data: [], scope: 'ninguno' }));
    fix.componentInstance.cargar();
    fix.detectChanges();
    expect(texto()).toContain('no tiene una sucursal asignada');
  });
});
