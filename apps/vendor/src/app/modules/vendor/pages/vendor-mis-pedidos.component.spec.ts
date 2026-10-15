import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { PresaleSellerOrder, PresaleSellerStatusResponse } from '@megadulces/contracts';
import { VendorMisPedidosComponent } from './vendor-mis-pedidos.component';
import { PresaleStatusService } from '../presale-status.service';

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

  async function montar(resp: PresaleSellerStatusResponse | Error): Promise<void> {
    api = {
      status: vi.fn(() => (resp instanceof Error ? throwError(() => ({ error: { message: resp.message } })) : of(resp))),
      markSeen: vi.fn(() => of({ updated: 1 })),
      unseen: vi.fn(() => of({ unseen_reports: 0 })),
    };
    await TestBed.configureTestingModule({
      imports: [VendorMisPedidosComponent],
      providers: [{ provide: PresaleStatusService, useValue: api }],
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
