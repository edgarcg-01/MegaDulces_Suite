import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import { ComercialDocumentosComponent } from './comercial-documentos.component';
import { SalesDocumentsService, type SalesDocDetail } from '../sales-documents.service';
import { DataScopeService } from '../../../core/services/data-scope.service';

/**
 * `[OBS.15.7]` El panel de un documento que llegó SIN renglones.
 *
 * Con la cola de cambios (OBS.15) la cabecera y sus renglones llegan al ODS juntos en menos de 1 s,
 * así que «cabecera sin renglones» al abrir el panel es o una carrera muy corta o un hueco real. El
 * panel vuelve a consultar UNA vez a los 3 s, sin vaciarse, y lo dice. Antes afirmaba «Kepler tiene
 * los renglones», que nadie había medido, y no volvía a mirar.
 *
 * Lo que puede salir mal y cada caso lo prueba: reintentar sin parar · reintentar un documento
 * completo · que la respuesta del reintento pise OTRO documento abierto mientras tanto · que el
 * temporizador dispare con el panel cerrado o con la vista ya destruida.
 */

const DOC = (folio: string, over: Partial<SalesDocDetail> = {}) => ({
  folio_digital: folio, sucursal: '01', doc_prefix: 'UD0801', folio: folio.slice(-7),
  cliente_nombre: 'ALBAGRO', total: 20234.12, cancelada: false, sin_detalle: false,
  detalle_ausente: false, lineas: [],
  // `[AX.17]` el backend siempre lo manda; sin él el panel no se puede pintar.
  embarque: { status: 'sin_backpointer', origen: null }, ...over,
}) as unknown as SalesDocDetail;

describe('ComercialDocumentosComponent · reintento del detalle sin renglones', () => {
  let fix: ComponentFixture<ComercialDocumentosComponent>;
  let c: ComercialDocumentosComponent;
  let detail: ReturnType<typeof vi.fn>;
  // `abrirPorFolio` es privado: se llama como lo hacen la tabla y el deep-link.
  const abrir = (f: string) => (c as unknown as { abrirPorFolio(f: string): void }).abrirPorFolio(f);
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  // El panel formatea el total con el pipe `currency` en es-MX, como en la app.
  beforeAll(() => registerLocaleData(localeEsMx));

  beforeEach(async () => {
    vi.useFakeTimers();
    detail = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ComercialDocumentosComponent],
      providers: [
        provideRouter([]),
        MessageService,
        // La lista y los filtros no importan acá: nunca responden, y la pantalla queda «cargando».
        { provide: SalesDocumentsService, useValue: { detail, list: () => NEVER, filtros: () => NEVER } },
        { provide: DataScopeService, useValue: { warehouses: () => of([]) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ComercialDocumentosComponent);
    c = fix.componentInstance;
  });

  afterEach(() => { vi.useRealTimers(); });

  it('llega sin renglones → avisa que vuelve a consultar, y a los 3 s consulta UNA vez más', () => {
    detail.mockReturnValueOnce(of(DOC('01UD0801-0001853', { detalle_ausente: true })))
      .mockReturnValueOnce(of(DOC('01UD0801-0001853', { detalle_ausente: false })));
    abrir('01UD0801-0001853');
    fix.detectChanges();
    expect(c.detReintento()).toBe('pendiente');
    expect(texto()).toContain('Volviendo a consultar');
    expect(texto()).not.toContain('Kepler tiene los renglones');
    expect(detail).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    fix.detectChanges();
    expect(detail).toHaveBeenCalledTimes(2);
    expect(c.detReintento()).toBe('hecho');
    expect(c.det()?.detalle_ausente).toBe(false);
    expect(texto()).not.toContain('Renglones sin llegar');

    vi.advanceTimersByTime(60_000);
    expect(detail).toHaveBeenCalledTimes(2); // ⛔ una sola vez, no en bucle
  });

  it('si al segundo intento siguen sin llegar, lo dice (y ya no reintenta)', () => {
    detail.mockReturnValue(of(DOC('01UD0801-0001853', { detalle_ausente: true })));
    abrir('01UD0801-0001853');
    vi.advanceTimersByTime(3000);
    fix.detectChanges();
    expect(texto()).toContain('Volvimos a consultar');
    vi.advanceTimersByTime(60_000);
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: un documento completo NO se vuelve a consultar', () => {
    detail.mockReturnValue(of(DOC('01UD0801-0001853')));
    abrir('01UD0801-0001853');
    vi.advanceTimersByTime(10_000);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(c.detReintento()).toBeNull();
  });

  it('⛔ con el panel cerrado antes de los 3 s, no reintenta', () => {
    detail.mockReturnValue(of(DOC('01UD0801-0001853', { detalle_ausente: true })));
    abrir('01UD0801-0001853');
    c.peek.set(false);
    vi.advanceTimersByTime(3000);
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it('⛔ si se abrió OTRO documento, el reintento del primero se cancela y no lo pisa', () => {
    detail.mockReturnValueOnce(of(DOC('01UD0801-0001853', { detalle_ausente: true })))
      .mockReturnValueOnce(of(DOC('06UD0801-0001131')));
    abrir('01UD0801-0001853');
    abrir('06UD0801-0001131');
    vi.advanceTimersByTime(3000);
    expect(detail).toHaveBeenCalledTimes(2);
    expect(detail.mock.calls.map((a) => a[0])).toEqual(['01UD0801-0001853', '06UD0801-0001131']);
    expect(c.det()?.folio_digital).toBe('06UD0801-0001131');
  });

  it('⛔ con la vista destruida antes de los 3 s, el temporizador no dispara', () => {
    detail.mockReturnValue(of(DOC('01UD0801-0001853', { detalle_ausente: true })));
    abrir('01UD0801-0001853');
    fix.destroy();
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    expect(detail).toHaveBeenCalledTimes(1);
  });
});
