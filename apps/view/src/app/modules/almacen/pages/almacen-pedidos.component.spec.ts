import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER } from 'rxjs';
import { AlmacenPedidosComponent } from './almacen-pedidos.component';
import { AlmacenPedidosService } from '../almacen-pedidos.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[GP.3]` La puerta a Surtir desde el tablero. `/almacen/surtir` es pantalla de FOCO: su entrada
 * en `almacen-tabs` sólo decide a dónde cae quien abre el área, no pinta ningún botón. Quien ve el
 * tablero y además surte se quedaba sin cómo llegar (lo encontró Francisco en prod, 2026-10-08).
 */
describe('AlmacenPedidosComponent · botón Surtir (GP.3)', () => {
  async function montar(permisos: Record<string, boolean>, rol = 'almacenista'): Promise<HTMLElement> {
    const perms = new PermissionsService();
    perms.load(permisos, rol);
    await TestBed.configureTestingModule({
      imports: [AlmacenPedidosComponent],
      providers: [
        provideRouter([]),
        { provide: AlmacenPedidosService, useValue: { list: () => NEVER, detail: () => NEVER } },
        { provide: PermissionsService, useValue: perms },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(AlmacenPedidosComponent);
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  }

  const surtir = (el: HTMLElement): HTMLAnchorElement | undefined =>
    Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.trim() === 'Surtir') as HTMLAnchorElement | undefined;

  it('⭐ quien ve el tablero y surte tiene el botón, y lleva a /almacen/surtir', async () => {
    const el = await montar({ [Permission.ALMACEN_PEDIDOS_VER]: true, [Permission.COMMERCIAL_PICKING_GESTIONAR]: true });
    const a = surtir(el);
    expect(a).toBeDefined();
    expect(a?.getAttribute('href')).toBe('/almacen/surtir');
  });

  it('prueba negativa: quien sólo ve el tablero no lo tiene (tomar trabajo escribe)', async () => {
    const el = await montar({ [Permission.ALMACEN_PEDIDOS_VER]: true, [Permission.COMMERCIAL_PICKING_VER]: true });
    expect(surtir(el)).toBeUndefined();
  });

  it('un rol de plataforma lo tiene', async () => {
    const el = await montar({}, 'superadmin');
    expect(surtir(el)).toBeDefined();
  });
});
