import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComercialTicketsComponent, sumarDias } from './comercial-tickets.component';
import type { TicketVenta, TicketVentaLinea, TicketVentaCascada } from '../ticket-venta';
import type { TicketCandidato } from '../tickets.service';

/**
 * `[TK.d1]` La tabla del ticket en pantalla tenía **6 encabezados para 8 columnas**.
 *
 * Las celdas de IEPS e IVA del cuerpo colgaban de `@if (hayImpuesto())` y el encabezado no
 * tenía ese bloque. En todo documento con impuesto desglosado el cuerpo emitía dos `<td>` de
 * más y la tabla quedaba CORRIDA: el rótulo «Importe» caía encima del IEPS, y el IVA y el
 * importe de verdad viajaban sin ningún rótulo. Dos columnas de dinero mal nombradas.
 *
 * No lo atrapó nada porque este componente **no tenía una sola prueba**: `tsc` no entra al
 * template, y el template era sintácticamente perfecto.
 *
 * El candado es de PARIDAD, no de contenido: cuenta `<th>` contra `<td>` en cada combinación de
 * las tres banderas que arman la tabla. Comprobar que existe un `<th>IVA</th>` no habría
 * servido — el defecto era que faltaba, no que dijera otra cosa.
 */

const L = (p: Partial<TicketVentaLinea> = {}): TicketVentaLinea => ({
  linea: 1, sku: '900', descripcion: 'PALETA PAYASO CHICO 20G', unidad: 'PZA',
  cantidad: 12, precio_lista: 6, lista_conocida: true, precio_pagado: 5,
  descuento_unitario: 1, descuento_linea: 12, importe: 60, equivalencia: null,
  iva: 8.28, ieps: 0, impuesto_tipo: 'iva', iva_tasa: 0.16, ieps_tasa: 0,
  precio_neto: 5.17, precio_neto_desc: 4.31, ...p,
});

const CASCADA: TicketVentaCascada = {
  importe_lista: 72, descuento_precio: 12, subtotal: 60,
  descuento_documento: 0, descuento_documento_pct_erp: null,
  iva: 8.28, ieps: 0, total: 60, descuento_total: 12, descuento_total_pct: 16.67,
  lineas_con_lista: 1, lineas_sin_lista: 0,
  impuesto_desglosado: true, iva_lineas: 8.28, ieps_lineas: 0, importe_neto: 51.72,
};

const DOC = (cascada: Partial<TicketVentaCascada> = {}): TicketVenta => ({
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Ticket de mostrador',
  doc_label: null, sucursal: '05', sucursal_nombre: 'Zamora Centro', caja: 5,
  folio: '0006440', fecha: '2026-09-18', hora: null, hora_motivo: null,
  cliente_nombre: null, cliente_rfc: null, atendio: null, atendio_rol: null,
  impuestos_incluidos: true, lineas: [L()], cascada: { ...CASCADA, ...cascada },
  cuadra: true, aviso: null,
});

/**
 * ⚠️ El panel del documento vive DENTRO de `@if (candidatos().length)`: poner sólo `doc` deja
 * la pantalla en su estado inicial y las aserciones pasarían sobre una página vacía.
 */
const CAND: TicketCandidato = {
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Ticket de mostrador',
  sucursal: '05', sucursal_nombre: 'Zamora Centro', caja: 5, folio: '0006440',
  fecha: '2026-09-18', cliente_nombre: null, total: '60.00',
};

describe('ComercialTicketsComponent', () => {
  let fix: ComponentFixture<ComercialTicketsComponent>;
  let c: ComercialTicketsComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ComercialTicketsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    fix = TestBed.createComponent(ComercialTicketsComponent);
    c = fix.componentInstance;
    fix.detectChanges();
  });

  /** Si el template tuviera un error, nada de lo de abajo llega a correr. */
  it('el template compila y monta', () => {
    expect(c).toBeTruthy();
  });

  /** Deja la pantalla con un documento abierto, que es donde se pinta la tabla. */
  const abrir = (cascada: Partial<TicketVentaCascada> = {}): void => {
    c.candidatos.set([CAND]);
    c.seleccionado.set(CAND.id);
    c.doc.set(DOC(cascada));
    fix.detectChanges();
  };

  /** La tabla de partidas: el `<thead>` del `p-table` y el primer renglón del cuerpo. */
  const tabla = (cascada: Partial<TicketVentaCascada> = {}) => {
    abrir(cascada);
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    const ths = Array.from(el.querySelectorAll('thead th'));
    const tds = Array.from(el.querySelectorAll('tbody tr')).at(0)?.querySelectorAll('td') ?? [];
    return { ths, tds: Array.from(tds), texto: ths.map((t) => (t.textContent ?? '').trim()) };
  };

  describe('[TK.d1] la tabla de partidas', () => {
    /**
     * `[TK.13]` Cambió el formato de la tabla (pedido del usuario): lista − descuento = c/desc →
     * sin impuestos + IVA/IEPS = neto, y cada impuesto sale sólo si el documento lo causa. Lo que
     * este candado protege NO cambió: un encabezado por columna, en el orden en que el cuerpo las
     * emite. El documento de prueba sólo trae IVA, así que IEPS no debe aparecer.
     */
    it('con impuesto desglosado hay un encabezado por columna', () => {
      const { ths, tds, texto } = tabla();
      expect(tds.length).toBeGreaterThan(0);
      expect(ths.length).toBe(tds.length);
      expect(texto).toContain('IVA');
      expect(texto).not.toContain('IEPS');
      expect(texto.indexOf('Sin impuestos')).toBeLessThan(texto.indexOf('IVA'));
      expect(texto.at(-1)).toBe('Neto');
    });

    /**
     * ⚠️ La prueba negativa del caso contrario: si los dos `<th>` se pusieran FIJOS en vez de
     * condicionados, la tabla quedaría corrida al revés —dos encabezados de más— en todo
     * documento cuyo impuesto no cuadra, que es el caso más común.
     */
    it('sin impuesto desglosado tampoco sobra ningún encabezado', () => {
      const { ths, tds, texto } = tabla({ impuesto_desglosado: false });
      expect(ths.length).toBe(tds.length);
      expect(texto).not.toContain('IEPS');
      expect(texto).not.toContain('IVA');
    });

    /** Las otras dos banderas mueven columnas también: la paridad vale en las cuatro esquinas. */
    it('la paridad se sostiene con y sin lista, con y sin descuento', () => {
      for (const cascada of [
        { lineas_con_lista: 0, lineas_sin_lista: 1 },
        { descuento_precio: 0, descuento_total: 0 },
        { lineas_con_lista: 0, lineas_sin_lista: 1, impuesto_desglosado: false },
      ] as Partial<TicketVentaCascada>[]) {
        const { ths, tds } = tabla(cascada);
        expect(ths.length).toBe(tds.length);
      }
    });
  });

  describe('[TK.d2] el descuento de cabecera', () => {
    it('se llama «Descuento de cliente» y declara de dónde sale el porcentaje', () => {
      abrir({ descuento_documento: 1.8, descuento_documento_pct_erp: 3, total: 58.2 });
      const t = (fix.nativeElement as HTMLElement).textContent ?? '';
      expect(t).toContain('Descuento de cliente');
      expect(t).toContain('3% declarado en Kepler');
      expect(t).not.toContain('Descuento del documento');
    });

    /** Sin porcentaje declarado no se inventa un «(0%)». */
    it('sin porcentaje el renglón sale sólo con el importe', () => {
      abrir({ descuento_documento: 1.8, descuento_documento_pct_erp: null, total: 58.2 });
      const t = (fix.nativeElement as HTMLElement).textContent ?? '';
      expect(t).toContain('Descuento de cliente');
      expect(t).not.toContain('0% declarado');
    });
  });
  /**
   * `[TK.12]` Revisión del PR #193: el tope de 31 días vivía sólo en el backend, así que elegir 60
   * días en el calendario devolvía un 400. Ahora el calendario no deja elegirlo, y si se TECLEA
   * una fecha fuera de rango la otra punta se recorre.
   */
  describe('[TK.12] el rango de la bandeja respeta los 31 días', () => {
    it('mover «desde» 60 días atrás recorre «hasta» a 31 días', () => {
      c.fDesde.set('2026-09-01');
      c.fHasta.set('2026-09-30');
      c.cambiarDesde('2026-08-01');
      expect(c.fDesde()).toBe('2026-08-01');
      expect(c.fHasta()).toBe('2026-08-31');
    });

    it('mover «hasta» lejos de «desde» recorre «desde»', () => {
      c.fDesde.set('2026-08-01');
      c.fHasta.set('2026-08-10');
      c.cambiarHasta('2026-09-30');
      expect(c.fHasta()).toBe('2026-09-30');
      expect(c.fDesde()).toBe('2026-08-31');
    });

    it('si se cruzan, la otra punta se iguala en vez de mandar un rango al revés', () => {
      c.fDesde.set('2026-09-10');
      c.fHasta.set('2026-09-12');
      c.cambiarDesde('2026-09-20');
      expect(c.fHasta()).toBe('2026-09-20');
    });

    it('un rango dentro de los 31 días no se toca', () => {
      c.fDesde.set('2026-09-01');
      c.fHasta.set('2026-09-15');
      c.cambiarHasta('2026-09-20');
      expect(c.fDesde()).toBe('2026-09-01');
    });

    it('el calendario no ofrece fechas fuera de la ventana de 31 días', () => {
      c.fDesde.set('2026-09-01');
      c.fHasta.set('2026-09-15');
      fix.detectChanges();
      const [desde, hasta] = Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input[type="date"]'));
      expect(hasta.getAttribute('max')).toBe('2026-10-01');
      expect(desde.getAttribute('min')).toBe('2026-08-16');
    });

    it('sumarDias cruza meses y años, y no inventa una fecha de una rota', () => {
      expect(sumarDias('2026-12-15', 30)).toBe('2027-01-14');
      expect(sumarDias('2028-02-28', 1)).toBe('2028-02-29');
      expect(sumarDias('', 30)).toBe('');
      expect(sumarDias('2026-9-1', 30)).toBe('');
    });
  });
});
