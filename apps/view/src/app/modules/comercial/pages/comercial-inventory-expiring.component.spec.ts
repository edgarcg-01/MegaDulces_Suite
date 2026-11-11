import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { NEVER, Observable, of, throwError } from 'rxjs';
import { ComercialInventoryExpiringComponent } from './comercial-inventory-expiring.component';
import { ComercialService, ExpiringLot } from '../comercial.service';
import { JuicioLotes, LoteCaducidad, ProductosFlujoService } from '../../compras/productos-flujo.service';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * `[CE.1.4]` + `[CE.3.1]` «Por vencer» declara el lote que puede estar ya vendido y dice qué hacer con el
 * juicio de `juzgarLotes`. Monta en JIT (atrapa bindings rotos, NO tipos: eso lo atrapa el CI).
 */
const LOTE = (over: Partial<ExpiringLot> = {}): ExpiringLot => ({
  id: 'lot-a', lot_code: 'L1', expiry_date: '2026-11-30', quantity: '300', warehouse_id: 'w1', warehouse_code: '01',
  product_id: 'p1', sku: '70001', product_name: 'LA ROSA MAZAPAN /30', days_to_expiry: 19, value_at_cost: '1200',
  plaza: '01', na_qty: '1250', dated_may_be_stale: true, ...over,
});
const JUICIO: LoteCaducidad = {
  lot_id: 'lot-a', plaza: '01', nombre: 'Padre Hidalgo', lote: 'L1', caduca: '2026-11-30', dias: 19, registrado: 300,
  en_existencia: 300, se_vende_antes: 200, queda: 100, estado: 'no_alcanza',
  accion: 'Aquí no se alcanza a vender antes de que caduque: moverlo a donde sí se vende',
  mover_a: [{ plaza: '02', nombre: 'La Piedad Abastos', cantidad: 100 }], sin_destino: 0, escalera: null,
};
const RESP = (lotes: LoteCaducidad[]): JuicioLotes => ({
  periodos: { hoy: '2026-11-11', mesIni: '2026-11-01', dias: 11, prevIni: '2026-10-01', prevFin: '2026-10-12', desde30: '2026-10-12', desdeHistoria: '2026-08-01' },
  corte: '2026-11-10', en_vivo_al: '2026-11-11T12:00:00Z', caducidad_aviso: 15, productos: [{ product_id: 'p1', lotes }],
});

async function montar(opts: { lots: ExpiringLot[]; juicio: Observable<JuicioLotes>; pedido?: boolean }) {
  const juicioLotes = vi.fn(() => opts.juicio);
  await TestBed.configureTestingModule({
    imports: [ComercialInventoryExpiringComponent],
    providers: [
      provideRouter([]),
      MessageService,
      { provide: ComercialService, useValue: { listWarehouses: () => of([{ id: 'w1', code: '01', name: 'Padre Hidalgo' }]), listExpiringLots: () => of(opts.lots) } },
      { provide: ProductosFlujoService, useValue: { juicioLotes } },
      { provide: PermissionsService, useValue: { has: () => opts.pedido ?? true } },
    ],
  }).compileComponents();
  const fix = TestBed.createComponent(ComercialInventoryExpiringComponent);
  fix.detectChanges();
  return { fix, el: fix.nativeElement as HTMLElement, juicioLotes };
}

describe('ComercialInventoryExpiringComponent · [CE.1.4] y [CE.3.1]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ el lote con NA dice que puede estar ya vendido, y la lista cuenta cuántos', async () => {
    const { el } = await montar({ lots: [LOTE(), LOTE({ id: 'lot-b', dated_may_be_stale: false, na_qty: '0' })], juicio: of(RESP([JUICIO])) });
    const texto = el.textContent ?? '';
    expect(texto).toContain('Puede estar ya vendido: hay 1,250 sin fecha de este producto en este almacén');
    expect(texto).toContain('1 de 2 lotes pueden estar ya vendidos');
    expect(el.querySelectorAll('.ex-sub.ex-warn').length).toBeGreaterThanOrEqual(2); // «sin confirmar» + la frase
  });

  it('⭐ dice qué hacer con el juicio de juzgarLotes, nombra la sucursal y lleva a Pedido con el SKU', async () => {
    const { el, juicioLotes } = await montar({ lots: [LOTE()], juicio: of(RESP([JUICIO])) });
    expect(juicioLotes).toHaveBeenCalledWith(['p1']);
    const texto = el.textContent ?? '';
    expect(texto).toContain('No alcanza a venderse');
    expect(texto).toContain('Mover 100 a La Piedad Abastos');
    const a = el.querySelector('a.ex-ir') as HTMLAnchorElement;
    expect(a?.getAttribute('href')).toBe('/compras/pedido?search=70001');
  });

  it('sin permiso de Pedido no ofrece la liga (dice qué hacer, no promete a dónde)', async () => {
    const { el } = await montar({ lots: [LOTE()], juicio: of(RESP([JUICIO])), pedido: false });
    expect(el.querySelector('a.ex-ir')).toBeNull();
    expect(el.textContent).toContain('Mover 100 a La Piedad Abastos');
  });

  it('mientras calcula lo dice; si falla, lo dice — nunca una celda vacía', async () => {
    const cargando = await montar({ lots: [LOTE()], juicio: NEVER });
    expect(cargando.el.textContent).toContain('Calculando si alcanza a venderse');
    TestBed.resetTestingModule();
    const falla = await montar({ lots: [LOTE()], juicio: throwError(() => new Error('500')) });
    expect(falla.el.textContent).toContain('No se pudo calcular qué hacer');
  });

  it('⛔ el almacén se nombra, jamás «01», ni en el selector', async () => {
    const { fix, el } = await montar({ lots: [LOTE({ dated_may_be_stale: false })], juicio: of(RESP([JUICIO])) });
    expect(fix.componentInstance.warehouseOptions().map((o) => o.label)).toEqual(['Todos los almacenes', 'Padre Hidalgo']);
    const celda = el.querySelector('tbody tr td') as HTMLElement;
    expect(celda.textContent?.trim()).toBe('Padre Hidalgo');
  });
});
