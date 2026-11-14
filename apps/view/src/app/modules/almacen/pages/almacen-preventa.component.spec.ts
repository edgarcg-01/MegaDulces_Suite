import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';
import type { PresaleDetail, PresaleListResponse, PresaleOrderRow } from '@megadulces/contracts';
import { AlmacenPreventaComponent } from './almacen-preventa.component';
import { AlmacenPreventaService } from '../almacen-preventa.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[GP.10.4a]` El Tablero de pedidos abre un `PD-` en la Mesa con `?pedido=<id>`: el documento de
 * Kepler, el cobro y el recorrido viven aquí y no se copian allá. Si el pedido ya no está en la lista
 * (cerrado hace más de lo que se muestra), se abre igual desde su detalle.
 */
describe('AlmacenPreventaComponent · abrir un pedido desde el Tablero (GP.10.4a)', () => {
  const fila = (id: string, code: string): PresaleOrderRow => ({ id, code } as unknown as PresaleOrderRow);
  const LISTA: PresaleListResponse = { data: [fila('a1', 'PD-000001'), fila('a2', 'PD-000002')] } as unknown as PresaleListResponse;

  async function montar(pedido: string | null) {
    const perms = new PermissionsService();
    perms.load({ [Permission.ALMACEN_PEDIDOS_VER]: true }, 'encargado_tienda');
    const detail = vi.fn((id: string) => of({ order: fila(id, 'PD-VIEJO'), history: [], compare: [], links: [] } as unknown as PresaleDetail));
    const api = { list: vi.fn(() => of(LISTA)), detail, candidates: vi.fn(() => NEVER) };
    await TestBed.configureTestingModule({
      imports: [AlmacenPreventaComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(pedido ? { pedido } : {}) } } },
        { provide: AlmacenPreventaService, useValue: api },
        { provide: PermissionsService, useValue: perms },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(AlmacenPreventaComponent);
    fix.detectChanges();
    return { c: fix.componentInstance, detail };
  }

  it('⭐ abre el pedido pedido cuando está en la lista', async () => {
    const { c } = await montar('a2');
    expect(c.sel()?.code).toBe('PD-000002');
  });

  it('⭐ si no está en la lista, lo abre desde su detalle', async () => {
    const { c, detail } = await montar('zz');
    expect(detail).toHaveBeenCalledWith('zz');
    expect(c.sel()?.id).toBe('zz');
  });

  it('NEGATIVA: sin ?pedido no abre ninguno', async () => {
    const { c } = await montar(null);
    expect(c.sel()).toBeNull();
  });
});
