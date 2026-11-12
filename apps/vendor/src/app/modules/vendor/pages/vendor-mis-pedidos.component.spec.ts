import { RouteDayService } from '../route-day.service';
import { MessageService } from 'primeng/api';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { PresaleSellerOrder, PresaleSellerStatusResponse } from '@megadulces/contracts';
import { VendorMisPedidosComponent } from './vendor-mis-pedidos.component';
import { PresaleStatusService } from '../presale-status.service';
import { VendorService } from '../vendor.service';
import { RecuentoDiaService } from '../recuento-dia.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { Router, provideRouter } from '@angular/router';
import { hoyMx, sumarDias } from '../mis-pedidos-dia';

/**
 * `[MCP.8]` «Mis pedidos» de la vendedora, montada de verdad con el servidor simulado. Lo que
 * importa es que diga la verdad en cada paso: quién lo tomó y a qué hora, qué se quitó del pedido,
 * y que un cobro DETECTADO no se presente como cobro confirmado.
 */
const pedido = (p: Partial<PresaleSellerOrder> = {}): PresaleSellerOrder => ({
  order_id: 'o-rosy', code: 'PD-2026-00072', customer_name: 'ABARROTES ROSY', requested_delivery_date: '2026-10-14',
  total: 1219.26, lines: 6, status: 'confirmed', scheduled_at: '2026-10-14T15:42:00.000Z', warehouse_name: 'La Piedad Abastos',
  started: null, finished: null, report: null, charge: null, delivered_at: null, report_unseen: false, ...p,
});

const SURTIDO_CON_FALTANTES = pedido({
  started: { user_id: 's1', name: 'Juan Pérez', at: '2026-10-14T15:43:00.000Z' },
  finished: { user_id: 's1', name: 'Juan Pérez', at: '2026-10-14T15:47:00.000Z', outcome: 'con_faltantes' },
  report: {
    removed: [{ product_name: 'SALSA MAGA 1 1/2', unit: 'CJA', ordered: 1, picked: 0 }],
    adjusted: [{ product_name: 'FLAN VAINILLA', unit: 'PAQ', ordered: 20, picked: 14 }],
    total_before: 1584.84, total_after: 1219.26,
  },
  report_unseen: true,
});

describe('VendorMisPedidosComponent · el avance de la vendedora (MCP.8)', () => {
  let fix: ComponentFixture<VendorMisPedidosComponent>;
  let api: { status: ReturnType<typeof vi.fn>; markSeen: ReturnType<typeof vi.fn>; unseen: ReturnType<typeof vi.fn> };
  const texto = (): string => (fix.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';

  // [MCP.15] Las líneas vivas del pedido (para «lo que pediste y lo que surtieron»).
  const vendor = { orderById: vi.fn(() => of({ id: 'o-rosy', lines: [
    { id: 'l1', product_name: 'PALETA PRUEBA', quantity: 48, qty_unit: 'CJA', qty_factor: 24 },
    { id: 'l2', product_name: 'FLAN VAINILLA', quantity: 168, qty_unit: 'PAQ', qty_factor: 12 },
  ] })) };

  let recuentoApi: { dia: ReturnType<typeof vi.fn> };

  async function montar(resp: PresaleSellerStatusResponse | Error): Promise<void> {
    recuentoApi = { dia: vi.fn(() => throwError(() => ({ error: { message: 'sin servidor en la prueba' } }))) };
    api = {
      status: vi.fn(() => (resp instanceof Error ? throwError(() => ({ error: { message: resp.message } })) : of(resp))),
      markSeen: vi.fn(() => of({ updated: 1 })),
      unseen: vi.fn(() => of({ unseen_reports: 0 })),
    };
    // [MCP.16] La pestaña Pedidos | Cotizaciones sale de la URL: la pantalla necesita el router.
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    await TestBed.configureTestingModule({
      imports: [VendorMisPedidosComponent],
      providers: [
        { provide: PresaleStatusService, useValue: api }, { provide: VendorService, useValue: vendor },
        // [MCP.19] El recuento del día y la cola del celular viven arriba de la lista: aquí no se miden (ver vendor-recuento-dia.spec.ts).
        { provide: RecuentoDiaService, useValue: recuentoApi },
        { provide: OfflineOrderService, useValue: { pendingSummaries: vi.fn(() => Promise.resolve([])) } },
        // [MCP.21] Corregir/cancelar avisan con el toast; «Terminar mi día» lee la ruta del día.
        { provide: MessageService, useValue: { add: vi.fn() } },
        { provide: RouteDayService, useValue: { today: vi.fn(() => of({ state: 'sin_iniciar' })) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(VendorMisPedidosComponent);
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('abre solo el pedido con reporte nuevo y lo marca como visto', async () => {
    await montar({ today: '2026-10-14', data: [SURTIDO_CON_FALTANTES], unseen_reports: 1 });
    fix.detectChanges();
    expect(texto()).toContain('Surtido con faltantes');
    expect(texto()).toContain('Juan Pérez · terminó'); // [MCP.21] una línea: lo último que pasó, con quién y a qué hora
    expect(texto()).not.toContain('Lo tomó el surtidor');
    expect(texto()).toContain('Se quitó del pedido (no hubo):');
    expect(texto()).toContain('SALSA MAGA 1 1/2 · 1 CJA');
    expect(texto()).toContain('FLAN VAINILLA · 20 → 14 PAQ');
    expect(texto()).toContain('$1,584.84');
    expect(api.markSeen).toHaveBeenCalledTimes(1);
  });

  describe('[MCP.21] modificar y cancelar desde la tarjeta', () => {
    const el = (): HTMLElement => fix.nativeElement as HTMLElement;
    const botonEn = (raiz: Element | null, t: string): HTMLButtonElement | undefined =>
      Array.from(raiz?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((b) => (b.getAttribute('aria-label') || b.textContent?.replace(/\s+/g, ' ').trim()) === t);
    const tarjeta = (id: string) => el().querySelector(`#mp-${id}`);
    const v = vendor as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const clic = (b: HTMLButtonElement | undefined) => { expect(b).toBeTruthy(); b?.click(); fix.detectChanges(); };
    const radio = (valor: string) => Array.from(el().querySelectorAll<HTMLInputElement>('input[type=radio]')).find((r) => r.value === valor);
    beforeEach(() => {
      v['reopenOrder'] = vi.fn(() => of({ id: 'o-rosy' }));
      v['modificarPedido'] = vi.fn(() => of({ id: 'o-rosy', total: 999.5, status: 'confirmed' }));
      v['cancelarConMotivo'] = vi.fn(() => of({ id: 'o-rosy', status: 'cancelled' }));
    });
    /** Abre la tarjeta en modo edición (las líneas vienen del doble: PALETA 2 CJA de 24 · FLAN 14 PAQ de 12). */
    async function abrir(): Promise<void> {
      await montar({ today: '2026-10-14', data: [pedido({ customer_id: 'c-1' })], unseen_reports: 0 });
      fix.detectChanges();
      clic(botonEn(tarjeta('o-rosy'), 'Modificar'));
      await fix.whenStable();
      fix.detectChanges();
    }

    it('un agendado que nadie surte trae Modificar y Cancelar; uno que el surtidor ya tomó, no (no promete lo que no hay)', async () => {
      const tomado = pedido({ order_id: 'o-2', started: { user_id: 's1', name: 'Juan Pérez', at: '2026-10-14T15:43:00.000Z' } });
      await montar({ today: '2026-10-14', data: [pedido({ customer_id: 'c-1' }), tomado], unseen_reports: 0 });
      fix.detectChanges();
      expect(botonEn(tarjeta('o-rosy'), 'Modificar')).toBeTruthy();
      expect(botonEn(tarjeta('o-rosy'), 'Cancelar')).toBeTruthy();
      expect(botonEn(tarjeta('o-2'), 'Modificar')).toBeUndefined();
      expect(botonEn(tarjeta('o-2'), 'Cancelar')).toBeUndefined();
    });

    it('Modificar abre sus productos en su unidad, sin los seis pasos: una línea dice lo que sigue', async () => {
      await abrir();
      expect(texto()).toContain('Esperando a que el surtidor empiece');
      expect(texto()).not.toContain('Revisado en caja');
      expect(texto()).toContain('PALETA PRUEBA');
      expect(texto()).toContain('2 CJA');
      expect(texto()).toContain('14 PAQ');
      expect(botonEn(tarjeta('o-rosy'), 'Guardar cambios')?.disabled).toBe(true);
    });

    it('⭐ + y Guardar: el motivo viene sugerido («agregar») y se manda TODO junto, en su unidad y con su sello', async () => {
      await abrir();
      clic(botonEn(tarjeta('o-rosy'), 'Uno más de PALETA PRUEBA'));
      expect(texto()).toContain('3 CJA');
      expect(texto()).toContain('1 cambio sin guardar');
      clic(botonEn(tarjeta('o-rosy'), 'Guardar cambios'));
      expect(texto()).toContain('¿Por qué cambian los productos?');
      expect(radio('agregar')?.checked).toBe(true);
      const n = api.status.mock.calls.length;
      clic(botonEn(el().querySelector('app-vendor-motivo-sheet'), 'Guardar cambios'));
      expect(v['modificarPedido']).toHaveBeenCalledWith('o-rosy', { reason_code: 'agregar' },
        [{ line_id: 'l1', quantity: 3, qty_unit: 'CJA', qty_factor: 24 }], false);
      expect(v['reopenOrder']).not.toHaveBeenCalled();
      expect(api.status.mock.calls.length).toBeGreaterThan(n);
    });

    it('negativa: si el servidor dice que no (el surtidor lo tomó), lo cambiado se queda en pantalla y lo dice', async () => {
      v['modificarPedido'] = vi.fn(() => throwError(() => ({ error: { message: 'Ya lo está surtiendo Juan desde las 10:42' } })));
      await abrir();
      const toast = TestBed.inject(MessageService) as unknown as { add: ReturnType<typeof vi.fn> };
      clic(botonEn(tarjeta('o-rosy'), 'Quitar FLAN VAINILLA'));
      expect(texto()).toContain('Se quita');
      clic(botonEn(tarjeta('o-rosy'), 'Guardar cambios'));
      expect(radio('quitar')?.checked).toBe(true);
      clic(botonEn(el().querySelector('app-vendor-motivo-sheet'), 'Guardar cambios'));
      expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Ya lo está surtiendo Juan desde las 10:42' }));
      expect(fix.componentInstance.nCambios(fix.componentInstance.pedidos()[0])).toBe(1);
    });

    it('«Agregar otro producto» guarda lo cambiado dejándolo abierto y abre la captura de ESE pedido', async () => {
      await abrir();
      const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      clic(botonEn(tarjeta('o-rosy'), 'Agregar otro producto'));
      expect(radio('agregar')?.checked).toBe(true);
      clic(botonEn(el().querySelector('app-vendor-motivo-sheet'), 'Seguir y agregar'));
      expect(v['modificarPedido']).toHaveBeenCalledWith('o-rosy', { reason_code: 'agregar' }, [], true);
      expect(nav).toHaveBeenCalledWith(['/vendor/take-order', 'c-1'], { queryParams: { order: 'o-rosy' } });
    });

    it('cancelar es directo y con UN motivo: no reabre, manda el motivo y vuelve a pedir la lista', async () => {
      await montar({ today: '2026-10-14', data: [pedido({ customer_id: 'c-1' })], unseen_reports: 0 });
      fix.detectChanges();
      clic(botonEn(tarjeta('o-rosy'), 'Cancelar'));
      expect(texto()).toContain('¿Por qué lo cancelas?');
      const n = api.status.mock.calls.length;
      radio('duplicado')?.dispatchEvent(new Event('change'));
      fix.detectChanges();
      clic(botonEn(el(), 'Cancelar el pedido'));
      expect(v['cancelarConMotivo']).toHaveBeenCalledWith('o-rosy', expect.objectContaining({ reason_code: 'duplicado' }));
      expect(v['reopenOrder']).not.toHaveBeenCalled();
      expect(api.status.mock.calls.length).toBeGreaterThan(n);
      expect(texto()).not.toContain('¿Por qué lo cancelas?');
    });
  });

  describe('[MCP.20] un día a la vez', () => {
    const boton = (t: string): HTMLButtonElement | undefined =>
      Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === t);
    const hoy = hoyMx();
    const ayer = sumarDias(hoy, -1);

    it('por omisión pide hoy: la lista y el recuento del mismo día, y lo dice', async () => {
      await montar({ today: hoy, date: hoy, data: [pedido()], unseen_reports: 0, unseen_days: [] });
      fix.detectChanges();
      expect(api.status).toHaveBeenCalledWith(hoy);
      expect(recuentoApi.dia).toHaveBeenCalledWith(hoy);
      expect(texto()).toContain('Pedidos que levantaste hoy');
      expect(boton('Hoy')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('al tocar «Ayer» pide ayer (lista y recuento) y dice que no hubo, sin dibujar la lista de hoy', async () => {
      await montar({ today: hoy, date: hoy, data: [pedido()], unseen_reports: 0, unseen_days: [] });
      api.status.mockImplementation(() => of({ today: hoy, date: ayer, data: [], unseen_reports: 0, unseen_days: [] }));
      boton('Ayer')?.click();
      fix.detectChanges();
      expect(api.status).toHaveBeenLastCalledWith(ayer);
      expect(recuentoApi.dia).toHaveBeenLastCalledWith(ayer);
      expect(boton('Ayer')?.getAttribute('aria-pressed')).toBe('true');
      expect(texto()).toContain('No levantaste pedidos de preventa ayer.');
      expect(texto()).not.toContain('ABARROTES ROSY');
    });

    it('marca vistos SÓLO los reportes del día en pantalla; un día con reporte nuevo lo dice en su botón', async () => {
      await montar({ today: hoy, date: hoy, data: [SURTIDO_CON_FALTANTES, pedido({ order_id: 'o-2' })], unseen_reports: 1, unseen_days: [hoy, ayer] });
      fix.detectChanges();
      expect(api.markSeen).toHaveBeenCalledWith(['o-rosy']);
      const b = Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.mp-dia'))
        .find((x) => x.getAttribute('aria-label')?.startsWith('Ayer'));
      expect(b?.getAttribute('aria-label')).toBe('Ayer, con un reporte de surtido nuevo');
    });

    it('un reporte nuevo de hace más de una semana se avisa con su liga al día', async () => {
      const viejo = sumarDias(hoy, -12);
      await montar({ today: hoy, date: hoy, data: [], unseen_reports: 0, unseen_days: [viejo] });
      fix.detectChanges();
      expect(texto()).toContain('Tienes reportes de surtido nuevos de');
      api.status.mockImplementation(() => of({ today: hoy, date: viejo, data: [], unseen_reports: 0, unseen_days: [viejo] }));
      const liga = (fix.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.mp-aviso .mp-art-re');
      liga?.click();
      fix.detectChanges();
      expect(api.status).toHaveBeenLastCalledWith(viejo);
    });

    it('negativa: un día futuro o vacío desde el calendario no pide nada', async () => {
      await montar({ today: hoy, date: hoy, data: [], unseen_reports: 0, unseen_days: [] });
      const n = api.status.mock.calls.length;
      fix.componentInstance.elegirDia(sumarDias(hoy, 3));
      fix.componentInstance.elegirDia('');
      expect(api.status.mock.calls.length).toBe(n);
    });
  });

  it('un cobro detectado se dice «por confirmar», no como hecho', async () => {
    const det = pedido({
      ...SURTIDO_CON_FALTANTES, report_unseen: true,
      charge: { source: 'detectado', folio_digital: '02UD1002-0004901', fecha: '2026-10-14', total: 1219.26, shared_products: 6, order_products: 6 },
    });
    await montar({ today: '2026-10-14', data: [det], unseen_reports: 1 });
    fix.detectChanges();
    expect(texto()).toContain('Cobrado (por confirmar)');
    expect(texto()).toContain('Parece que Kepler ya lo cobró');
    expect(texto()).toContain('Lo confirma quien entrega');
  });

  it('un cobro ligado se dice «Cobrado»', async () => {
    const lig = pedido({
      ...SURTIDO_CON_FALTANTES, report_unseen: true,
      charge: { source: 'liga', folio_digital: '02UD1002-0004901', fecha: '2026-10-14', total: 1219.26, shared_products: 6, order_products: 6 },
    });
    await montar({ today: '2026-10-14', data: [lig], unseen_reports: 1 });
    fix.detectChanges();
    expect(texto()).toContain('Kepler cobró este pedido');
    expect(texto()).not.toContain('por confirmar');
  });

  it('un pedido recién agendado espera al surtidor y no marca nada como visto', async () => {
    await montar({ today: '2026-10-14', data: [pedido()], unseen_reports: 0 });
    fix.detectChanges();
    expect(texto()).toContain('Agendado');
    expect(api.markSeen).not.toHaveBeenCalled();
  });

  /** `[MCP.10.1]` El caso de PD-2026-00203: el surtidor sacó 1 de 2 salsas y la caja completó la otra. */
  it('si la caja revisó, dice cómo QUEDÓ el pedido y no el reporte viejo del surtido', async () => {
    const revisado = pedido({
      total: 1773.6,
      started: { user_id: 's1', name: 'Juan Pérez', at: '2026-11-03T18:00:00.000Z' },
      finished: { user_id: 's1', name: 'Juan Pérez', at: '2026-11-03T18:10:00.000Z', outcome: 'con_faltantes' },
      report: {
        removed: [],
        adjusted: [{ product_name: 'SALSA CHAMOY 1L CHILERITO', unit: 'CJA', ordered: 2, picked: 1, line_id: 'l1' }],
        total_before: 1773.6, total_after: 1431.84,
      },
      reviewed: { user_id: 'c1', name: 'María Cajera', at: '2026-11-03T18:51:00.000Z' },
      review: {
        lines: [
          { key: 'l1', product_name: 'SALSA CHAMOY 1L CHILERITO', unit: 'CJA', ordered: 2, picked: 1, final: 2, returned: 0, resolution: 'completo' },
          { key: 'l2', product_name: 'SALSA CHAMOY 355ML CHILERITO', unit: 'CJA', ordered: 1, picked: 1, final: 1, returned: 0, resolution: 'bien' },
        ],
        total_before: 1431.84, total_after: 1773.6,
      },
      report_unseen: true,
    });
    await montar({ today: '2026-11-03', data: [revisado], unseen_reports: 1 });
    fix.detectChanges();
    expect(texto()).toContain('Revisado en caja');
    expect(texto()).toContain('María Cajera');
    expect(texto()).toContain('la caja completó 1');
    expect(texto()).toContain('SALSA CHAMOY 1L CHILERITO · pediste 2 → surtió 1 → quedó 2 CJA (lo completó la caja)');
    // Lo que llegó igual no se lista, y el reporte viejo («2 → 1», «$1,431.84» como final) ya no se pinta.
    expect(texto()).not.toContain('355ML CHILERITO · pediste');
    expect(texto()).not.toContain('Se ajustó a lo que hubo');
    expect(texto()).toContain('$1,773.60');
  });

  /** `[MCP.13]` El surtidor cambió la banderilla que faltó por otro producto. */
  describe('[MCP.13] lo que el surtidor cambió por otro producto', () => {
    const conCambio = (extra: Partial<PresaleSellerOrder> = {}) => pedido({
      started: { user_id: 's1', name: 'Juan Pérez', at: '2026-11-04T18:00:00.000Z' },
      finished: { user_id: 's1', name: 'Juan Pérez', at: '2026-11-04T18:10:00.000Z', outcome: 'con_faltantes' },
      report: {
        removed: [],
        adjusted: [{ product_name: 'VIT BANDERILLA GRANDE', unit: 'PZA', ordered: 2, picked: 1, line_id: 'l1' }],
        substituted: [{ line_id: 'n1', for_line_id: 'l1', for_product_name: 'VIT BANDERILLA GRANDE', for_sku: '05189',
          product_id: 'p9', product_name: 'BANDERILLA CHICA', sku: '05190', quantity: 1, unit: 'PZA', line_total: 18 }],
        total_before: 186.7, total_after: 182.3,
      },
      report_unseen: true,
      ...extra,
    });

    it('sin revisión: el reporte dice qué se cambió por qué y cuánto faltó', async () => {
      await montar({ today: '2026-11-04', data: [conCambio()], unseen_reports: 1 });
      fix.detectChanges();
      expect(texto()).toContain('Se cambió por otro producto (lo eligió el surtidor)');
      expect(texto()).toContain('VIT BANDERILLA GRANDE · faltó 1 PZA → BANDERILLA CHICA · 1 PZA');
    });

    it('revisado: el sustituto no se lista como algo que «pediste»; si la caja lo quitó, se dice', async () => {
      const revisado = conCambio({
        reviewed: { user_id: 'c1', name: 'María Cajera', at: '2026-11-04T18:51:00.000Z' },
        review: {
          lines: [
            { key: 'l1', product_name: 'VIT BANDERILLA GRANDE', unit: 'PZA', ordered: 1, picked: 1, final: 1, returned: 0, resolution: 'bien' },
            { key: 'n1', product_name: 'BANDERILLA CHICA', unit: 'PZA', ordered: 1, picked: 1, final: 0, returned: 0, resolution: 'no_hubo' },
          ],
          total_before: 182.3, total_after: 164.3,
        },
      });
      await montar({ today: '2026-11-04', data: [revisado], unseen_reports: 1 });
      fix.detectChanges();
      expect(texto()).toContain('Cómo quedó el pedido');
      expect(texto()).toContain('VIT BANDERILLA GRANDE · faltó 1 PZA → BANDERILLA CHICA · 1 PZA (la caja lo quitó)');
      expect(texto()).not.toContain('BANDERILLA CHICA · pediste');
    });
  });

  it('sin revisión, sigue mostrando el reporte del surtido y espera a la caja', async () => {
    await montar({ today: '2026-10-14', data: [SURTIDO_CON_FALTANTES], unseen_reports: 1 });
    fix.detectChanges();
    expect(texto()).toContain('Se ajustó a lo que hubo');
    expect(texto()).toContain('sigue: esperando a que la caja lo revise'); // [MCP.21] en la línea única
  });

  describe('[MCP.15] en orden de captura y con lo que pidió contra lo que surtieron', () => {
    it('la lista va por folio y se filtra por surtir / surtidos', async () => {
      await montar({ today: '2026-10-14', unseen_reports: 0, data: [
        pedido({ order_id: 'b', code: 'PD-2026-00080', customer_name: 'TIENDA B' }),
        { ...SURTIDO_CON_FALTANTES, report_unseen: false },
        pedido({ order_id: 'c', code: 'PD-2026-00075', customer_name: 'TIENDA C' }),
      ] });
      const el = fix.nativeElement as HTMLElement;
      const orden = () => Array.from(el.querySelectorAll('.mp-card strong')).map((s) => s.textContent?.trim());
      expect(orden()).toEqual(['ABARROTES ROSY', 'TIENDA C', 'TIENDA B']);
      expect(texto()).toContain('Todos · 3');
      expect(texto()).toContain('Por surtir · 2');
      expect(texto()).toContain('Surtidos · 1');
      (Array.from(el.querySelectorAll('.mp-f')).find((b) => b.textContent?.includes('Surtidos')) as HTMLButtonElement).click();
      fix.detectChanges();
      expect(orden()).toEqual(['ABARROTES ROSY']);
    });

    it('al abrir un pedido surtido: todos los artículos, lo que llegó completo y lo que no', async () => {
      await montar({ today: '2026-10-14', unseen_reports: 0, data: [{ ...SURTIDO_CON_FALTANTES, report_unseen: false }] });
      const el = fix.nativeElement as HTMLElement;
      (el.querySelector('.mp-card-h') as HTMLButtonElement).click();
      fix.detectChanges();
      expect(vendor.orderById).toHaveBeenCalledWith('o-rosy');
      const filas = Array.from(el.querySelectorAll('.mp-art-t tbody tr'))
        .map((r) => Array.from(r.querySelectorAll('td')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()).join(' | '));
      expect(filas).toEqual([
        'PALETA PRUEBA | 2 CJA | 2 CJA',
        'FLAN VAINILLA | 20 PAQ | 14 PAQ',
        'SALSA MAGA 1 1/2 | 1 CJA | 0 CJA',
      ]);
      expect(el.querySelectorAll('.mp-art-cambio')).toHaveLength(2);
    });

    it('⛔ [negativa] si las líneas no se pudieron leer, lo dice y deja reintentar (no pinta una tabla vacía)', async () => {
      vendor.orderById.mockReturnValueOnce(throwError(() => ({ status: 0 })));
      await montar({ today: '2026-10-14', unseen_reports: 0, data: [{ ...SURTIDO_CON_FALTANTES, report_unseen: false }] });
      const el = fix.nativeElement as HTMLElement;
      (el.querySelector('.mp-card-h') as HTMLButtonElement).click();
      fix.detectChanges();
      expect(texto()).toContain('No se pudieron cargar los artículos');
      expect(el.querySelector('.mp-art-t')).toBeNull();
    });
  });

  it('separa el error del vacío', async () => {
    await montar(new Error('Sin conexión con el servidor'));
    fix.detectChanges();
    expect(texto()).toContain('Sin conexión con el servidor');
    expect(texto()).toContain('Reintentar');
    TestBed.resetTestingModule();
    await montar({ today: '2026-10-14', data: [], unseen_reports: 0 });
    fix.detectChanges();
    // [MCP.20] El vacío es del día: el «hoy» del servidor (2026-10-14) manda sobre el del reloj del equipo.
    expect(texto()).toContain('Todavía no levantas pedidos de preventa hoy.');
    expect(api.status).toHaveBeenLastCalledWith('2026-10-14');
  });
});
