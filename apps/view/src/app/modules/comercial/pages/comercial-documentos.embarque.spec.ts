import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import { ComercialDocumentosComponent } from './comercial-documentos.component';
import { SalesDocumentsService, type SalesDocDetail, type SalesDocEmbarque } from '../sales-documents.service';
import { DataScopeService } from '../../../core/services/data-scope.service';

/**
 * `[AX.17]` La factura de telemarketing con su embarque.
 *
 * El panel decía «Pedido» sobre un folio que en el 100 % de los casos es el EMBARQUE (`UD4101`).
 * Lo que se fija acá: el rótulo correcto, que lo no resuelto se DECLARE (nunca un embarque vacío),
 * que el chofer asignado a la unidad no se presente como quien manejó, y que las notas de «no
 * cuadra» salgan sólo cuando algo no cuadra — con los casos medidos en prod el 2026-10-29.
 */

const RESUELTO: SalesDocEmbarque = {
  status: 'resuelto', origen: 'UD4101-0000863', folio_digital: '08UD4101-0000863', fecha: '2026-10-28',
  guia: '0001692', transporte: 'NISSAN 2016', placas: 'GC-2559-C', transporte_metodo: 'exacto',
  chofer: null, chofer_sin_capturar: true, chofer_asignado: null,
  total: '1000.00', diferencia: 0.66, total_facturas: '1000.66',
  cliente_distinto: false, destino: 'ABARROTES X', facturas: ['08UD0801-0000614'],
};

const DOC = (embarque: SalesDocEmbarque) => ({
  folio_digital: '08UD0801-0000614', sucursal: '08', doc_prefix: 'UD0801', folio: '0000614',
  cliente_nombre: 'ABARROTES X', total: 1000.66, cancelada: false, sin_detalle: false,
  detalle_ausente: false, lineas: [], embarque,
}) as unknown as SalesDocDetail;

describe('[AX.17] ComercialDocumentosComponent · el embarque de la factura', () => {
  let fix: ComponentFixture<ComercialDocumentosComponent>;
  let c: ComercialDocumentosComponent;
  let detail: ReturnType<typeof vi.fn>;
  const abrir = (f: string) => (c as unknown as { abrirPorFolio(f: string): void }).abrirPorFolio(f);
  const texto = () => ((fix.nativeElement as HTMLElement).textContent ?? '').replace(/\s+/g, ' ');
  const pintar = (e: SalesDocEmbarque) => {
    detail.mockReturnValue(of(DOC(e)));
    abrir('08UD0801-0000614');
    fix.detectChanges();
  };

  beforeAll(() => registerLocaleData(localeEsMx));

  beforeEach(async () => {
    detail = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ComercialDocumentosComponent],
      providers: [
        provideRouter([]),
        MessageService,
        { provide: SalesDocumentsService, useValue: { detail, list: () => NEVER, filtros: () => NEVER, embarquesSinFactura: () => NEVER } },
        { provide: DataScopeService, useValue: { warehouses: () => of([]) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ComercialDocumentosComponent);
    c = fix.componentInstance;
  });

  it('rotula EMBARQUE (no «Pedido») y muestra viaje y unidad', () => {
    pintar(RESUELTO);
    const t = texto();
    expect(t).toContain('Embarque');
    expect(t).toContain('UD4101-0000863');
    expect(t).toContain('guía 0001692');
    expect(t).toContain('NISSAN 2016');
    expect(t).toContain('GC-2559-C');
    expect(t).not.toContain('Pedido');
  });

  it('chofer sin capturar se DECLARA; el asignado a la unidad va rotulado como asignado', () => {
    pintar({ ...RESUELTO, chofer: 'CESAR CASAS MENDOZA', chofer_sin_capturar: true, chofer_asignado: 'CESAR CASAS MENDOZA' });
    const t = texto();
    expect(t).toContain('no capturado en Kepler');
    expect(t).toContain('asignado a la unidad: CESAR CASAS MENDOZA');
  });

  it('CONTROL: con todo cuadrando no sale ninguna nota de «no cuadra»', () => {
    pintar(RESUELTO); // diferencia $0.66: redondeo
    const t = texto();
    expect(t).not.toContain('de lo embarcado');
    expect(t).not.toContain('facturas:');
    expect(t).not.toContain('otro cliente');
  });

  it('dos facturas en un embarque: compara la SUMA, no la factura sola', () => {
    // Medido: 01 emb 0000280 → 0000142 + 0000352. Por factura, la segunda «difería $32,803».
    pintar({ ...RESUELTO, origen: 'UD4101-0000280', total: '32846.19', total_facturas: '32891.40', diferencia: 45.21,
      facturas: ['01UD0801-0000142', '01UD0801-0000352'] });
    const t = texto();
    expect(t).toContain('El embarque tiene 2 facturas: 01UD0801-0000142, 01UD0801-0000352');
    expect(t).toContain('Las facturas suman');
    expect(t).toContain('más de lo embarcado');
    expect(t).not.toContain('32,803');
  });

  it('a nombre de otro cliente: lo nombra', () => {
    pintar({ ...RESUELTO, cliente_distinto: true, destino: 'DULCERIA LA PERLA' });
    expect(texto()).toContain('El embarque está a nombre de otro cliente: DULCERIA LA PERLA');
  });

  it('sin back-pointer se declara (las 2 de 5,929 medidas), nunca en blanco', () => {
    pintar({ status: 'sin_backpointer', origen: null });
    expect(texto()).toContain('Kepler no registra de qué embarque salió');
  });

  it('back-pointer que no está en la réplica se declara con su folio', () => {
    pintar({ status: 'no_en_ods', origen: 'UD4101-0009999' });
    const t = texto();
    expect(t).toContain('UD4101-0009999');
    expect(t).toContain('no llegó a la réplica');
  });
});
