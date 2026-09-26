import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { FinanzasGastosHistorialComponent } from './finanzas-gastos-historial.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { todayMx } from '../../../core/utils/mx-date';
import type { CalendarioDelMes, ExpenseProofsReport } from '../comprobaciones.service';

/**
 * `[GX.27]` Candado del **Historial como calendario**.
 *
 * Cuida dos cosas distintas:
 *  · **quién ve el gasto ajeno** — «Todos» es god-mode desde `[GX.26]`; aflojarlo le devuelve
 *    en silencio el historial de toda la empresa a 16 personas;
 *  · **que el calendario no afirme lo que no sabe** — un error no puede leerse como «no hubo
 *    gasto», y un día sin movimiento no es lo mismo que un día que no se pudo cargar.
 */

const MES = todayMx().slice(0, 7);
const D1 = `${MES}-01`;
const D2 = `${MES}-02`;

const CAL = (over: Partial<CalendarioDelMes> = {}): CalendarioDelMes => ({
  mes: MES,
  mes_pedido: null,
  dias: [
    { dia: D1, n: 3, monto: 1500.5 },
    { dia: D2, n: 19, monto: 85161.65 },
  ],
  total: { n: 22, monto: 86662.15 },
  alcance: 'mios',
  ...over,
});

const DIA_ROWS: ExpenseProofsReport = {
  kpis: { total: 2, recibidas: 1, validadas: 1, rechazadas: 0, en_revision: 0 },
  rows: [
    {
      id: 'p1', solicitante: 'Leonardo Cazares', departamento: 'LOGISTICA', departamento_code: null,
      sucursal: '00', fecha_gasto: D1, folio_solicitud: '0009901', proveedor: 'CAPUFE',
      importe: 1250.5, files: [{ role: 'comprobante_1', url: 'https://ejemplo/x.jpg' }],
      comentarios: null, status: 'recibida', validated_by: null, validated_at: null,
      motivo_rechazo: null, created_by: 'demo', created_at: `${D1}T15:00:00.000Z`,
    },
    {
      id: 'p2', solicitante: 'Ana Robles', departamento: 'SISTEMAS', departamento_code: null,
      sucursal: '00', fecha_gasto: D1, folio_solicitud: '0009902', proveedor: 'TELMEX',
      importe: 3150, files: [], comentarios: null, status: 'validada',
      validated_by: 'maria', validated_at: null, motivo_rechazo: null,
      created_by: 'demo', created_at: `${D1}T16:00:00.000Z`,
    },
  ],
};

describe('FinanzasGastosHistorialComponent', () => {
  let fix: ComponentFixture<FinanzasGastosHistorialComponent>;
  let c: FinanzasGastosHistorialComponent;
  let http: HttpTestingController;
  let perms: PermissionsService;

  const montar = (rol: string, mapa: Record<string, boolean> = {}, cal: CalendarioDelMes | null = CAL()) => {
    perms.load(mapa, rol, 'jwt');
    fix = TestBed.createComponent(FinanzasGastosHistorialComponent);
    c = fix.componentInstance;
    const req = http.expectOne((r) => r.url.includes('/finance/expenses/proofs/calendario'));
    if (cal) req.flush(cal); else req.flush('boom', { status: 500, statusText: 'Server Error' });
    fix.detectChanges();
    return req;
  };

  beforeAll(() => registerLocaleData(localeEsMx));

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FinanzasGastosHistorialComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: LOCALE_ID, useValue: 'es-MX' }],
    });
    http = TestBed.inject(HttpTestingController);
    perms = TestBed.inject(PermissionsService);
  });

  afterEach(() => http.verify());

  it('arranca pidiendo el mes actual, en «míos»', () => {
    const req = montar('superadmin');
    expect(req.request.params.get('alcance')).toBe('mios');
    expect(req.request.params.has('mes')).toBe(false);
    expect(c.ambito()).toBe('mios');
  });

  describe('el calendario', () => {
    it('dibuja las semanas con su mini número y su monto', () => {
      montar('superadmin');
      const txt = fix.nativeElement.textContent as string;
      expect(c.semanas().length).toBeGreaterThanOrEqual(4);
      expect(c.semanas()[0]).toHaveLength(7);
      expect(txt).toContain('19');            // el mini número del día 2
      expect(txt).toContain('22 levantamientos en el mes');
      expect(txt).toContain('$86,662.15');
    });

    /** ⭐ Lo que se lee de un vistazo tiene que cuadrar con el encabezado. */
    it('la suma de las celdas del mes es el total que dice arriba', () => {
      montar('superadmin');
      const celdas = c.semanas().flat().filter((x) => x.delMes);
      expect(celdas.reduce((a, x) => a + x.n, 0)).toBe(22);
      expect(Math.round(celdas.reduce((a, x) => a + x.monto, 0) * 100) / 100).toBe(86662.15);
    });

    it('un mes sin movimiento lo dice, en vez de dejar la rejilla muda', () => {
      montar('superadmin', {}, CAL({ dias: [], total: { n: 0, monto: 0 } }));
      expect(fix.nativeElement.textContent).toContain('no tiene levantamientos');
    });

    it('no se puede pasar del mes actual', () => {
      montar('superadmin');
      c.moverMes(1);
      http.expectNone((r) => r.url.includes('/calendario'));
      expect(c.esMesActual()).toBe(true);
    });

    it('el mes anterior se pide por su clave', () => {
      montar('superadmin');
      c.moverMes(-1);
      const req = http.expectOne((r) => r.url.includes('/calendario'));
      expect(req.request.params.get('mes')).toBeTruthy();
      expect(req.request.params.get('mes')).not.toBe(MES);
      req.flush(CAL());
    });

    /** Un parámetro roto no puede verse igual que un mes sin gasto. */
    it('declara cuando el mes pedido era ilegible', () => {
      montar('superadmin', {}, CAL({ mes_pedido: '13-2026' }));
      expect(fix.nativeElement.textContent).toContain('no es un mes');
    });
  });

  describe('abrir un día', () => {
    it('trae los vales de ese día y los lista', () => {
      montar('superadmin');
      const celda = c.semanas().flat().find((x) => x.dia === D1)!;
      c.abrirDia(celda);
      const req = http.expectOne((r) => r.url.includes('/finance/expenses/proofs/mine'));
      expect(req.request.params.get('dia')).toBe(D1);
      req.flush(DIA_ROWS);
      fix.detectChanges();
      expect(c.filasDia().map((r) => r.id)).toEqual(['p1', 'p2']);
      expect(fix.nativeElement.textContent).toContain('0009901');
      expect(c.totalDia()).toBe(4400.5);
    });

    /**
     * ⛔ La ruta cambia con el ámbito y NO es cosmético: `/mine` está acotada por el token y
     * la colección es god-mode. Pedir el día «de todos» por la ruta equivocada devolvería
     * gasto ajeno a quien no puede verlo.
     */
    it('en «todos» pide la colección, no /mine', () => {
      montar('superadmin');
      c.cambiar('todos');
      http.expectOne((r) => r.url.includes('/calendario')).flush(CAL({ alcance: 'todos' }));
      const celda = c.semanas().flat().find((x) => x.dia === D1)!;
      c.abrirDia(celda);
      const req = http.expectOne((r) => r.url.includes('/finance/expenses/proofs') && !r.url.includes('/mine') && !r.url.includes('/calendario'));
      expect(req.request.params.get('dia')).toBe(D1);
      req.flush(DIA_ROWS);
    });

    it('un día sin gasto lo dice; no se queda mudo', () => {
      montar('superadmin');
      const celda = c.semanas().flat().find((x) => x.dia === D1)!;
      c.abrirDia(celda);
      http.expectOne((r) => r.url.includes('/mine')).flush({ kpis: {}, rows: [] });
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('no se levantó ningún gasto');
    });

    /** ⛔ Que falle la consulta NO es que ese día no haya habido gasto. */
    it('un error del día se dice, no se disfraza de día vacío', () => {
      montar('superadmin');
      const celda = c.semanas().flat().find((x) => x.dia === D1)!;
      c.abrirDia(celda);
      http.expectOne((r) => r.url.includes('/mine')).flush('boom', { status: 500, statusText: 'err' });
      fix.detectChanges();
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('No se pudieron traer los vales');
      expect(txt).not.toContain('no se levantó ningún gasto');
    });

    it('cambiar de ámbito cierra el día abierto', () => {
      montar('superadmin');
      const celda = c.semanas().flat().find((x) => x.dia === D1)!;
      c.abrirDia(celda);
      http.expectOne((r) => r.url.includes('/mine')).flush(DIA_ROWS);
      expect(c.diaSel()).toBe(D1);
      c.cambiar('todos');
      // El día era del otro ámbito: dejarlo mostraría vales que ya no corresponden.
      expect(c.diaSel()).toBeNull();
      expect(c.filasDia()).toEqual([]);
      http.expectOne((r) => r.url.includes('/calendario')).flush(CAL());
    });
  });

  describe('abrir un vale', () => {
    it('abre el visor compartido con ese expediente', () => {
      montar('superadmin');
      const celda = c.semanas().flat().find((x) => x.dia === D1)!;
      c.abrirDia(celda);
      http.expectOne((r) => r.url.includes('/mine')).flush(DIA_ROWS);
      fix.detectChanges();
      c.abrirVale(c.filasDia()[0]);
      fix.detectChanges();
      expect(c.valeAbierto()?.id).toBe('p1');
      expect(fix.nativeElement.querySelector('app-vale-gasto-peek')).not.toBeNull();
    });

    /** ⛔ El historial es CONSULTA: quien mira no necesariamente puede firmar. */
    it('el visor no ofrece acciones', () => {
      montar('superadmin');
      const celda = c.semanas().flat().find((x) => x.dia === D1)!;
      c.abrirDia(celda);
      http.expectOne((r) => r.url.includes('/mine')).flush(DIA_ROWS);
      c.abrirVale(c.filasDia()[0]);
      fix.detectChanges();
      expect(fix.nativeElement.querySelectorAll('.vp-act button').length).toBe(0);
    });
  });

  describe('quién ve el gasto ajeno', () => {
    it('god-mode ve el interruptor', () => {
      montar('superadmin');
      expect(c.puedeVerTodos()).toBe(true);
      const tabs = [...fix.nativeElement.querySelectorAll('.hist-seg button')]
        .map((b: Element) => b.textContent?.trim());
      expect(tabs).toEqual(['Míos', 'Todos']);
    });

    /** ⭐ `FINANCE_EXPENSES_VER` ya no alcanza: son las 16 personas de `[GX.26]`. */
    it('⛔ FINANCE_EXPENSES_VER no alcanza', () => {
      montar('tesoreria', { [Permission.FINANCE_EXPENSES_VER]: true });
      expect(c.puedeVerTodos()).toBe(false);
      expect(fix.nativeElement.querySelector('.hist-seg')).toBeNull();
    });

    it('quien sólo captura ve lo suyo y nada más', () => {
      const req = montar('cajero', { [Permission.FINANCE_EXPENSES_CAPTURAR]: true });
      expect(req.request.params.get('alcance')).toBe('mios');
      expect(c.puedeVerTodos()).toBe(false);
    });
  });

  /** ⛔ Un error NO se pinta como mes vacío: eso diría «no se levantó nada». */
  it('un error del mes se dice con todas las letras', () => {
    montar('superadmin', {}, null);
    const txt = fix.nativeElement.textContent as string;
    expect(c.error()).toBeTruthy();
    expect(txt).toContain('No se pudo cargar el mes');
    expect(txt).not.toContain('no tiene levantamientos');
  });
});
