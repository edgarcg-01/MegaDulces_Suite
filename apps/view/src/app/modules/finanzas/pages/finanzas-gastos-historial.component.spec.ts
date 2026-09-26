import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FinanzasGastosHistorialComponent } from './finanzas-gastos-historial.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import type { ExpenseProofsReport } from '../comprobaciones.service';

/**
 * `[GX.26]` Candado del **Historial de levantamientos**.
 *
 * Lo que cuida es quién puede ver el gasto **de los demás**. El apartado «Todos» pasó de
 * `FINANCE_EXPENSES_VER` (25 personas, 9 de ellas cuentas de administración) a **god-mode**
 * por pedido del usuario. Si esta distinción se afloja, 16 personas recuperan en silencio
 * el historial de toda la empresa.
 *
 * ⚠️ El candado de verdad está en el servidor (`expense-proofs.controller.ts`): acá se
 * comprueba que la UI **no ofrezca una puerta que devuelve 403**, y que quien no puede
 * mirar lo ajeno no lo pida ni por accidente.
 */

const REPORTE: ExpenseProofsReport = {
  kpis: { total: 1, recibidas: 1, validadas: 0, rechazadas: 0, en_revision: 0 },
  rows: [],
};

describe('FinanzasGastosHistorialComponent', () => {
  let fix: ComponentFixture<FinanzasGastosHistorialComponent>;
  let c: FinanzasGastosHistorialComponent;
  let http: HttpTestingController;
  let perms: PermissionsService;

  /** Monta con un rol y un mapa de permisos dados, y contesta la primera carga. */
  const montar = (rol: string, mapa: Record<string, boolean> = {}) => {
    perms.load(mapa, rol, 'jwt');
    fix = TestBed.createComponent(FinanzasGastosHistorialComponent);
    c = fix.componentInstance;
    const req = http.expectOne((r) => r.url.includes('/finance/expenses/proofs'));
    req.flush(REPORTE);
    fix.detectChanges();
    return req;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FinanzasGastosHistorialComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    perms = TestBed.inject(PermissionsService);
  });

  afterEach(() => http.verify());

  it('arranca en «Míos» y pide lo propio, sea quien sea', () => {
    const req = montar('superadmin');
    expect(c.ambito()).toBe('mios');
    expect(req.request.url).toContain('/mine');
  });

  describe('quién ve el apartado «Todos»', () => {
    it('god-mode lo ve', () => {
      montar('superadmin');
      expect(c.puedeVerTodos()).toBe(true);
      const tabs = [...fix.nativeElement.querySelectorAll('.hist-seg button')]
        .map((b: Element) => b.textContent?.trim());
      expect(tabs).toEqual(['Míos', 'Todos']);
    });

    it('el otro rol de plataforma también', () => {
      montar('admin');
      expect(c.puedeVerTodos()).toBe(true);
    });

    /**
     * ⭐ El corazón del cambio: `FINANCE_EXPENSES_VER` **ya no alcanza**. Son las 16
     * personas de finanzas, contabilidad, crédito, compras y tesorería que antes veían el
     * gasto de toda la empresa.
     */
    it('⛔ FINANCE_EXPENSES_VER ya NO alcanza', () => {
      montar('tesoreria', { [Permission.FINANCE_EXPENSES_VER]: true });
      expect(c.puedeVerTodos()).toBe(false);
      expect(fix.nativeElement.querySelector('.hist-seg')).toBeNull();
    });

    it('quien sólo captura tampoco, y no pierde lo suyo', () => {
      const req = montar('cajero', { [Permission.FINANCE_EXPENSES_CAPTURAR]: true });
      expect(c.puedeVerTodos()).toBe(false);
      expect(req.request.url).toContain('/mine');
      expect(fix.nativeElement.querySelector('.hist-seg')).toBeNull();
    });

    /** El rol viene del token y puede llegar con otra caja; el espejo del servidor también la ignora. */
    it('el rol no distingue mayúsculas', () => {
      montar('SuperAdmin');
      expect(c.puedeVerTodos()).toBe(true);
    });

    it('sin rol cargado, no', () => {
      montar('', {});
      expect(c.puedeVerTodos()).toBe(false);
    });
  });

  describe('lo ajeno no se pide por accidente', () => {
    it('god-mode sí pide el historial completo al cambiar de apartado', () => {
      montar('superadmin');
      c.cambiar('todos');
      const req = http.expectOne((r) => r.url.includes('/finance/expenses/proofs'));
      // La ruta del historial completo es la colección, sin `/mine`.
      expect(req.request.url).not.toContain('/mine');
      req.flush(REPORTE);
    });

    /**
     * ⛔ Aunque alguien fuerce el ámbito —un estado viejo, un clic cuando todavía no había
     * cargado el rol—, la carga se sigue yendo a `/mine`. La UI no le ofrece al servidor una
     * petición que va a rebotar con 403.
     */
    it('sin god-mode, forzar el ámbito a «todos» igual pide /mine', () => {
      montar('tesoreria', { [Permission.FINANCE_EXPENSES_VER]: true });
      c.cambiar('todos');
      const req = http.expectOne((r) => r.url.includes('/finance/expenses/proofs'));
      expect(req.request.url).toContain('/mine');
      req.flush(REPORTE);
    });
  });
});
