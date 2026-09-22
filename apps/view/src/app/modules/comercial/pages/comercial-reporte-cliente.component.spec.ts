import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComercialReporteClienteComponent } from './comercial-reporte-cliente.component';
import type { ClienteCandidato, ReporteCliente, ReporteDocumento } from '../tickets.service';

/**
 * Candado de la pantalla del reporte por cliente (TK.8).
 *
 * ⚠️ **Este archivo también existe para COMPILAR el template.** `tsc` no mira dentro de una
 * plantilla de Angular: los `NG5002` y los errores de binding sólo los ve el compilador de
 * Angular, y `nx build` desde un worktree compila el checkout principal (su `node_modules` es
 * un symlink y Nx deduce la raíz de la ruta real del paquete, no del `cwd`). Un spec que monta
 * el componente es la única compuerta que queda de este lado — y ya costó, hoy mismo, afirmar
 * dos veces que algo compilaba cuando se estaba compilando otra rama.
 *
 * Lo que además comprueba, que es lo que puede dar un número equivocado:
 *  · la selección arranca COMPLETA (el caso normal es el periodo entero),
 *  · el total de la barra es el de los SELECCIONADOS, no el del periodo,
 *  · y las notas de crédito restan también ahí, no sólo en el papel.
 */

const C: ClienteCandidato = {
  id: '05:10448', sucursal: '05', sucursal_nombre: 'Zamora Centro', cliente_code: '10448',
  nombre: 'ABARROTES LA ESPERANZA SA DE CV', ciudad: 'Zamora', vendedor_nombre: null,
  clave_ambigua: false,
};

const D = (p: Partial<ReporteDocumento>): ReporteDocumento => ({
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Mostrador', sucursal: '05',
  caja: 5, folio: '0006440', fecha: '2026-09-18', atendio: 'Rosa Maria', renglones: null,
  descuento: 0, total: 1000, ...p,
});

const REP = (docs: ReporteDocumento[]): ReporteCliente => ({
  cliente: C,
  documentos: docs,
  resumen: {
    documentos: docs.length,
    importe: docs.reduce((s, d) => s + d.total, 0),
    descuento: 0, promedio: 0, abonos: docs.filter((d) => d.origen === 'abono').length,
  },
  aviso: null,
});

describe('ComercialReporteClienteComponent', () => {
  let fix: ComponentFixture<ComercialReporteClienteComponent>;
  let c: ComercialReporteClienteComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ComercialReporteClienteComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    fix = TestBed.createComponent(ComercialReporteClienteComponent);
    c = fix.componentInstance;
    fix.detectChanges();
  });

  /** Si el template tuviera un error, esto no llega acá. */
  it('el template compila y monta', () => {
    expect(c).toBeTruthy();
  });

  it('arranca pidiendo un cliente, no con un reporte vacío', () => {
    expect(c.cliente()).toBeNull();
    expect(c.rep()).toBeNull();
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
