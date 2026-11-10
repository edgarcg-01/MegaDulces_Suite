import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { PresaleSellerOrder, PresaleSellerStatusResponse } from '@megadulces/contracts';
import { VendorMisPedidosComponent } from './vendor-mis-pedidos.component';
import { PresaleStatusService } from '../presale-status.service';
import { VendorService } from '../vendor.service';

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

  async function montar(resp: PresaleSellerStatusResponse | Error): Promise<void> {
    api = {
      status: vi.fn(() => (resp instanceof Error ? throwError(() => ({ error: { message: resp.message } })) : of(resp))),
      markSeen: vi.fn(() => of({ updated: 1 })),
      unseen: vi.fn(() => of({ unseen_reports: 0 })),
    };
    await TestBed.configureTestingModule({
      imports: [VendorMisPedidosComponent],
      providers: [{ provide: PresaleStatusService, useValue: api }, { provide: VendorService, useValue: vendor }],
    }).compileComponents();
    fix = TestBed.createComponent(VendorMisPedidosComponent);
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('abre solo el pedido con reporte nuevo y lo marca como visto', async () => {
    await montar({ today: '2026-10-14', data: [SURTIDO_CON_FALTANTES], unseen_reports: 1 });
    fix.detectChanges();
    expect(texto()).toContain('Surtido con faltantes');
    expect(texto()).toContain('Juan Pérez · empezó');
    expect(texto()).toContain('Se quitó del pedido (no hubo):');
    expect(texto()).toContain('SALSA MAGA 1 1/2 · 1 CJA');
    expect(texto()).toContain('FLAN VAINILLA · 20 → 14 PAQ');
    expect(texto()).toContain('$1,584.84');
    expect(api.markSeen).toHaveBeenCalledTimes(1);
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
    expect(texto()).toContain('Esperando a que la caja lo revise');
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
    expect(texto()).toContain('Todavía no tienes pedidos de preventa abiertos.');
  });
});
