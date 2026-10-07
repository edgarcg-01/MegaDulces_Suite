import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { environment } from '../../../../environments/environment';
import { ComercialReporteClienteComponent } from './comercial-reporte-cliente.component';
import type { ClienteCandidato, ReporteCliente, ReporteDocumento } from '../tickets.service';

/**
 * Candado de la pantalla del reporte por cliente (TK.8).
 *
 * ⚠️ **Este archivo también existe para COMPILAR el template.** `tsc` no mira dentro de una
 * plantilla de Angular — hoy mismo pasó en verde con el template usando tres campos que ya no
 * existían en la interfaz — y `nx build` desde un worktree compila el checkout principal (su
 * `node_modules` es un symlink y Nx deduce la raíz de la ruta real del paquete, no del `cwd`).
 * Montar el componente con `TestBed` es la única compuerta que queda de este lado.
 *
 * Y lo que comprueba de fondo es lo que puede dar un número equivocado: que la selección
 * arranque completa, que el total de la barra sea el de los SELECCIONADOS y no el del periodo,
 * y que una nota de crédito reste también ahí.
 */

const C: ClienteCandidato = {
  cliente_code: '10448', nombre: 'ABARROTES LA ESPERANZA SA DE CV', ciudad: 'Zamora',
  zona: 'CENTRO', plazas: 9, clave_ambigua: false, score: 1,
};

const D = (p: Partial<ReporteDocumento>): ReporteDocumento => ({
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Mostrador', sucursal: '05',
  sucursal_nombre: 'Zamora Centro', caja: 5, folio: '0006440', fecha: '2026-09-18',
  atendio: 'Rosa Maria', descuento: 0, total: 1000, ...p,
});

const REP = (docs: ReporteDocumento[]): ReporteCliente => ({
  cliente: C,
  documentos: docs,
  resumen: {
    documentos: docs.length, importe: docs.reduce((s, d) => s + d.total, 0),
    descuento: 0, promedio: 0, abonos: docs.filter((d) => d.origen === 'abono').length,
    plazas_con_compra: new Set(docs.map((d) => d.sucursal)).size,
  },
  aviso: null,
});

describe('ComercialReporteClienteComponent', () => {
  let fix: ComponentFixture<ComercialReporteClienteComponent>;
  let c: ComercialReporteClienteComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ComercialReporteClienteComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    fix = TestBed.createComponent(ComercialReporteClienteComponent);
    c = fix.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fix.detectChanges();
  });

  afterEach(() => http.verify());

  /** Si el template tuviera un error, esto no llega acá. */
  it('el template compila y monta', () => {
    expect(c).toBeTruthy();
  });

  it('arranca pidiendo un cliente, no con un reporte vacío', () => {
    expect(c.cliente()).toBeNull();
    expect(c.rep()).toBeNull();
  });

  describe('el buscador', () => {
    it('no pregunta con menos de dos letras: no se manda un ILIKE de una sola', () => {
      c.termino = 'a';
      c.buscarCliente();
      http.expectNone(() => true);
      expect(c.buscando()).toBe(false);
    });

    it('con un solo resultado lo abre solo: no hay ambigüedad que resolver', () => {
      c.termino = 'esperanza';
      c.buscarCliente();
      http.expectOne((r) => r.url === `${environment.apiUrl}/commercial/tickets/clientes`)
        .flush({ candidatos: [C], topado: false });
      expect(c.cliente()?.cliente_code).toBe('10448');
      // Al elegir pide el reporte de una: no hay un segundo clic de por medio.
      http.expectOne((r) => r.url.includes('/clientes/10448/reporte')).flush(REP([D({})]));
      expect(c.rep()?.documentos.length).toBe(1);
    });

    it('con varios NO elige por su cuenta: el primero sería el cliente de otro', () => {
      c.termino = 'abarrotes';
      c.buscarCliente();
      http.expectOne((r) => r.url.endsWith('/clientes'))
        .flush({ candidatos: [C, { ...C, cliente_code: '20415' }], topado: true });
      expect(c.cliente()).toBeNull();
      expect(c.candidatos().length).toBe(2);
      expect(c.topado()).toBe(true);
    });
  });

  describe('los filtros viajan como los espera el backend', () => {
    beforeEach(() => {
      c.cliente.set(C);
    });

    /** ⚠️ Un `''` en el query se lee como un filtro puesto, no como "sin filtro". */
    it('los vacíos NO viajan', () => {
      c.f = { date_from: '', folio: '', min: '', caja: '', solo_con_descuento: false };
      c.cargar();
      const req = http.expectOne((r) => r.url.includes('/clientes/10448/reporte'));
      expect(req.request.params.keys()).toEqual([]);
      req.flush(REP([]));
    });

    it('la sucursal viaja como warehouse_codes, que es lo que interseca ScopeService', () => {
      c.f = { warehouse_codes: '05', folio: '6440' };
      c.cargar();
      const req = http.expectOne((r) => r.url.includes('/clientes/10448/reporte'));
      expect(req.request.params.get('warehouse_codes')).toBe('05');
      expect(req.request.params.get('folio')).toBe('6440');
      req.flush(REP([]));
    });
  });

  describe('la barra simplificada', () => {
    /** El panel arranca CERRADO: la pantalla tiene que poder leerse sin abrirlo. */
    it('el panel de filtros arranca cerrado', () => {
      expect(c.panel()).toBe(false);
    });

    it('elegir un cliente abre el MES EN CURSO, no todo el historico', () => {
      c.elegir(C);
      const req = http.expectOne((r) => r.url.includes('/clientes/10448/reporte'));
      const hoy = new Date();
      const uno = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`;
      expect(req.request.params.get('date_from')).toBe(uno);
      expect(c.periodo()).toBe('mes');
      req.flush(REP([]));
    });

    /**
     * ⚠️ El peor caso de la fecha: `toISOString()` convierte a UTC y en México adelanta el día,
     * así que «este mes» arrancaría el último día del mes anterior. Se arma a mano.
     */
    it('«este mes» arranca el dia 1, nunca el ultimo del mes anterior', () => {
      c.cliente.set(C);
      c.elegirPeriodo('mes');
      const req = http.expectOne((r) => r.url.includes('/reporte'));
      expect(req.request.params.get('date_from')).toMatch(/-01$/);
      req.flush(REP([]));
    });

    it('«mes pasado» termina el ultimo dia de ese mes, no el 1 del actual', () => {
      c.cliente.set(C);
      c.elegirPeriodo('mes-1');
      const req = http.expectOne((r) => r.url.includes('/reporte'));
      const hoy = new Date();
      const fin = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
      expect(req.request.params.get('date_to')).toBe(
        `${fin.getFullYear()}-${String(fin.getMonth() + 1).padStart(2, '0')}-${String(fin.getDate()).padStart(2, '0')}`);
      req.flush(REP([]));
    });

    it('«todo» quita las fechas en vez de mandar un rango enorme', () => {
      c.cliente.set(C);
      c.elegirPeriodo('todo');
      const req = http.expectOne((r) => r.url.includes('/reporte'));
      expect(req.request.params.get('date_from')).toBeNull();
      expect(req.request.params.get('date_to')).toBeNull();
      req.flush(REP([]));
    });

    /** «Otro periodo» abre el panel y NO pide nada: todavía no hay qué pedir. */
    it('«otro periodo» abre el panel sin consultar', () => {
      c.cliente.set(C);
      c.elegirPeriodo('otro');
      expect(c.panel()).toBe(true);
      http.expectNone(() => true);
    });

    /** La fecha del renglón se arma partiendo el string, no con `new Date()`. */
    it('el dia se lee en palabras y NO se corre al mes anterior', () => {
      expect(c.dia('2026-09-18')).toBe('18 de septiembre');
      expect(c.dia('2026-09-01')).toBe('1 de septiembre');
      expect(c.dia('2026-01-01')).toBe('1 de enero');
      expect(c.dia(null)).toBe('sin fecha');
    });
  });

  describe('las etiquetas de filtro activo', () => {
    beforeEach(() => { c.cliente.set(C); });

    /** Sin filtros escondidos no hay etiquetas: no se decora una pantalla limpia. */
    it('sin filtros, ninguna etiqueta', () => {
      c.f = {};
      c.aplicar();
      http.expectOne((r) => r.url.includes('/reporte')).flush(REP([]));
      expect(c.activos()).toEqual([]);
    });

    it('cada filtro escondido se vuelve una etiqueta legible', () => {
      c.f = { folio: '6440', warehouse_codes: '05', caja: '5', solo_con_descuento: true };
      c.aplicar();
      http.expectOne((r) => r.url.includes('/reporte')).flush(REP([]));
      expect(c.activos().map((a) => a.texto)).toEqual([
        'Folio: 6440', 'Sucursal: 05', 'Caja 5', 'Sólo con descuento de cliente',
      ]);
    });

    /**
     * ⚠️ El periodo NO es una etiqueta: ya se ve en su selector. Repetirlo haría leer dos
     * filtros donde hay uno.
     */
    it('el periodo no se duplica como etiqueta', () => {
      c.f = { date_from: '2026-09-01', date_to: '2026-09-30' };
      c.aplicar();
      http.expectOne((r) => r.url.includes('/reporte')).flush(REP([]));
      expect(c.activos()).toEqual([]);
    });

    /** ⚠️ Las etiquetas reflejan lo APLICADO, no lo tecleado: si no, prometen lo que no se ve. */
    it('teclear sin aplicar NO cambia las etiquetas', () => {
      c.f = { folio: '6440' };
      c.aplicar();
      http.expectOne((r) => r.url.includes('/reporte')).flush(REP([]));
      c.f.caja = '9';
      expect(c.activos().map((a) => a.clave)).toEqual(['folio']);
    });

    it('quitar una etiqueta quita el filtro y vuelve a pedir', () => {
      c.f = { folio: '6440', caja: '5' };
      c.aplicar();
      http.expectOne((r) => r.url.includes('/reporte')).flush(REP([]));
      c.quitar('caja');
      const req = http.expectOne((r) => r.url.includes('/reporte'));
      expect(req.request.params.get('caja')).toBeNull();
      expect(req.request.params.get('folio')).toBe('6440');
      req.flush(REP([]));
    });

    it('aplicar cierra el panel: si quedara abierto taparia la respuesta', () => {
      c.panel.set(true);
      c.aplicar();
      expect(c.panel()).toBe(false);
      http.expectOne((r) => r.url.includes('/reporte')).flush(REP([]));
    });
  });

  describe('la selección', () => {
    beforeEach(() => {
      c.cliente.set(C);
      c.rep.set(REP([D({ id: 'A', total: 1000 }), D({ id: 'B', total: 500 })]));
      c.dentro.set(new Set(['A', 'B']));
    });

    /** Quitar dos de cuarenta es menos trabajo que marcar cuarenta. */
    it('todos adentro por default, y el total es el de los seleccionados', () => {
      expect(c.dentro().size).toBe(2);
      expect(c.todosDentro()).toBe(true);
      expect(c.totalDentro()).toBe(1500);
      expect(c.fuera()).toBe(0);
    });

    it('al quitar uno, el total y el conteo de fuera se mueven', () => {
      c.alternar(D({ id: 'B' }));
      expect(c.dentro().size).toBe(1);
      expect(c.totalDentro()).toBe(1000);
      expect(c.fuera()).toBe(1);
      expect(c.todosDentro()).toBe(false);
    });

    it('la casilla del encabezado prende y apaga todo', () => {
      c.alternarTodos();
      expect(c.dentro().size).toBe(0);
      expect(c.fuera()).toBe(2);
      c.alternarTodos();
      expect(c.dentro().size).toBe(2);
    });
  });

  /** ⚠️ El abono RESTA también en la barra, no sólo en el papel. */
  it('una nota de crédito baja el total de lo seleccionado', () => {
    c.cliente.set(C);
    c.rep.set(REP([
      D({ id: 'A', total: 4182.6 }),
      D({ id: 'N', origen: 'abono', origen_label: 'Nota de crédito', total: -1240 }),
    ]));
    c.dentro.set(new Set(['A', 'N']));
    expect(c.totalDentro()).toBeCloseTo(2942.6, 2);
  });

  it('cambiar de cliente deja la pantalla como al principio', () => {
    c.cliente.set(C);
    c.rep.set(REP([D({})]));
    c.dentro.set(new Set(['05UD1005-0006440']));
    c.cambiar();
    expect(c.cliente()).toBeNull();
    expect(c.rep()).toBeNull();
    expect(c.dentro().size).toBe(0);
  });
});
