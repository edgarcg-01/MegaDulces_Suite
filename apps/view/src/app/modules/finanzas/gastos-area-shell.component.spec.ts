import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PermissionsService } from '../../core/services/permissions.service';
import { AuthService } from '../../core/services/auth.service';
import { GastosAreaShellComponent } from './gastos-area-shell.component';

/**
 * `[GX.80]` El shell pinta la barra de pestañas de Gastos sólo cuando hay más de una pestaña
 * que la persona ve. Un selector de una opción no elige: ocupa lugar y sugiere que hay más.
 */
describe('[GX.80] GastosAreaShellComponent', () => {
  async function render(permisos: Record<string, boolean>, admin = false) {
    await TestBed.configureTestingModule({
      imports: [GastosAreaShellComponent],
      providers: [
        provideRouter([]),
        { provide: PermissionsService, useValue: { isAdmin: () => admin, has: () => admin } },
        { provide: AuthService, useValue: { user: () => ({ permissions: permisos }) } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(GastosAreaShellComponent);
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  }
  const etiquetas = (el: HTMLElement) => [...el.querySelectorAll('.gx-area-tabs a')].map((a) => a.textContent?.trim());

  afterEach(() => TestBed.resetTestingModule());

  /** Las cinco, en orden. `[LE.6.19]` quitó «Hoja de zona»: se paga en Caja General, sin aprobarla aparte. */
  const CINCO = ['Aprobación de gastos', 'Mis gastos', 'Expediente', 'Historial', 'Comisiones de logística'];

  it('quien firma ve la barra con las cinco pantallas (EMB.29: + Comisiones de logística)', async () => {
    const el = await render({ FINANCE_EXPENSES_COMPROBAR: true, FINANCE_EXPENSES_VER: true });
    expect(etiquetas(el)).toEqual(CINCO);
  });

  it('con VER (sin firmar) ve Mis gastos e Historial', async () => {
    const el = await render({ FINANCE_EXPENSES_VER: true });
    expect(etiquetas(el)).toEqual(['Mis gastos', 'Historial']);
  });

  /** ⛔ Quien sólo captura tiene UNA pantalla: no hay barra, ni su espacio reservado. */
  it('⛔ quien sólo captura no ve barra', async () => {
    const el = await render({ FINANCE_EXPENSES_CAPTURAR: true });
    expect(el.querySelector('.gx-area-tabs')).toBeNull();
    expect(el.querySelector('router-outlet')).not.toBeNull();
  });

  it('el administrador de plataforma ve las cinco', async () => {
    const el = await render({}, true);
    expect(etiquetas(el)).toEqual(CINCO);
  });

  /** EMB.29: Logística arma los vales de comisiones, pero no ve el resto de Gastos. */
  it('quien sólo gestiona embarques tiene UNA pantalla: sin barra', async () => {
    const el = await render({ LOGISTICS_SHIPMENTS_GESTIONAR: true });
    expect(el.querySelector('.gx-area-tabs')).toBeNull();
  });

  /** `[LE.6.19]` Cerrar la hoja ya no es un acto: ese permiso solo no abre ninguna pestaña de Gastos. */
  it('quien sólo tenía «cerrar la hoja de zona» no ve barra', async () => {
    const el = await render({ FINANCE_HOJA_GASTOS_CERRAR: true });
    expect(el.querySelector('.gx-area-tabs')).toBeNull();
  });

  /** `[LE.6.19]` La caja ya no suma una pestaña de Gastos: la hoja se paga en Caja General. */
  it('con VER y la caja ve Mis gastos e Historial (la hoja está en Caja)', async () => {
    const el = await render({ FINANCE_EXPENSES_VER: true, FINANCE_CAJA_VER: true });
    expect(etiquetas(el)).toEqual(['Mis gastos', 'Historial']);
  });
});
