import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { TicketsService } from './tickets.service';

/**
 * Candado del servicio HTTP de tickets (TK.8) — **qué viaja en la URL**.
 *
 * Lo que se prueba es el borde: un parámetro que se manda vacío, un nombre de parámetro
 * equivocado o una clave sin escapar **no fallan con un error** — devuelven otro conjunto de
 * documentos, y el reporte que se imprime queda mal sin que nadie lo note.
 *
 * ⚠️ En particular `warehouse_codes`: es la llave canónica que `ScopeService.readParam()`
 * interseca con el alcance del usuario. Si el front mandara `sucursal`, el backend **ignoraría
 * el filtro en silencio** y el reporte saldría con todas las plazas.
 */

const BASE = `${environment.apiUrl}/commercial/tickets`;

describe('TicketsService', () => {
  let svc: TicketsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    svc = TestBed.inject(TicketsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('clientes()', () => {
    it('pega al buscador de clientes con el término tal cual', () => {
      svc.clientes('abarrotes').subscribe();
      const req = http.expectOne((r) => r.url === `${BASE}/clientes`);
      expect(req.request.params.get('q')).toBe('abarrotes');
      req.flush({ candidatos: [], topado: false });
    });

    /** El acento no se normaliza acá: lo hace `unaccent()` en la base, en los dos lados. */
    it('manda el acento sin tocarlo', () => {
      svc.clientes('MARÍA').subscribe();
      const req = http.expectOne((r) => r.url === `${BASE}/clientes`);
      expect(req.request.params.get('q')).toBe('MARÍA');
      req.flush({ candidatos: [], topado: false });
    });
  });

  describe('reporte()', () => {
    /** ⚠️ Un `''` en el query se lee como filtro puesto, no como "sin filtro". */
    it('los vacíos, los nulos y el false NO viajan', () => {
      svc.reporte('10448', {
        date_from: '', folio: '', min: '', max: '', caja: '',
        atendio: '', warehouse_codes: '', solo_con_descuento: false,
      }).subscribe();
      const req = http.expectOne((r) => r.url.includes('/clientes/10448/reporte'));
      expect(req.request.params.keys()).toEqual([]);
      req.flush(null);
    });

    it('lo que sí tiene valor viaja con su nombre', () => {
      svc.reporte('10448', {
        date_from: '2026-09-01', date_to: '2026-09-30', folio: '6440',
        min: '1000', caja: '5', atendio: 'RT01', solo_con_descuento: true,
      }).subscribe();
      const p = http.expectOne((r) => r.url.includes('/clientes/10448/reporte')).request.params;
      expect(p.get('date_from')).toBe('2026-09-01');
      expect(p.get('date_to')).toBe('2026-09-30');
      expect(p.get('folio')).toBe('6440');
      expect(p.get('min')).toBe('1000');
      expect(p.get('caja')).toBe('5');
      expect(p.get('atendio')).toBe('RT01');
      expect(p.get('solo_con_descuento')).toBe('true');
      http.expectNone(() => true);
    });

    /**
     * ⛔ El nombre importa: `ScopeService` sólo reconoce la llave canónica. Con otro nombre el
     * backend ignoraría el filtro EN SILENCIO y el reporte traería todas las plazas.
     */
    it('la sucursal viaja como warehouse_codes, no como "sucursal"', () => {
      svc.reporte('10448', { warehouse_codes: '05' }).subscribe();
      const p = http.expectOne((r) => r.url.includes('/clientes/10448/reporte')).request.params;
      expect(p.get('warehouse_codes')).toBe('05');
      expect(p.get('sucursal')).toBeNull();
    });

    /** El cero es un importe legítimo: no puede caer en el mismo saco que el vacío. */
    it('un mínimo de 0 sí viaja', () => {
      svc.reporte('10448', { min: '0' }).subscribe();
      const p = http.expectOne((r) => r.url.includes('/reporte')).request.params;
      expect(p.get('min')).toBe('0');
    });

    /** La clave viene del ERP; si trajera `/` o `#` partiría la URL. */
    it('la clave del cliente va escapada en la ruta', () => {
      svc.reporte('10/448#a', {}).subscribe();
      const req = http.expectOne((r) => r.url.includes('/clientes/'));
      expect(req.request.url).toContain('10%2F448%23a');
      expect(req.request.url).not.toContain('10/448#a');
      req.flush(null);
    });
  });

  describe('lo que ya existía sigue igual', () => {
    it('buscar un folio no cambió de ruta', () => {
      svc.buscar('0006440').subscribe();
      const req = http.expectOne((r) => r.url === BASE);
      expect(req.request.params.get('q')).toBe('0006440');
      req.flush({ candidatos: [], truncado: false });
    });

    /** El PDF va como blob: la ruta lleva Bearer y una pestaña nueva no lleva el token. */
    it('la carta se pide como blob', () => {
      svc.cartaPdf('05UD1005-0006440').subscribe();
      const req = http.expectOne((r) => r.url.includes('/carta.pdf'));
      expect(req.request.responseType).toBe('blob');
      req.flush(new Blob());
    });
  });
});
