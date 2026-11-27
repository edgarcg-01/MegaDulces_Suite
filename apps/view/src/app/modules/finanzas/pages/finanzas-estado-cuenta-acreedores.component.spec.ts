/**
 * `[ECA.9]` **Estado de cuenta de acreedores, montado de verdad.** Ejerce desde el DOM lo que pidió
 * Francisco el 2026-11-20:
 *
 *  1. **El saldo del documento va en su renglón**, bajo «Saldo» (antes esa columna pintaba el estado).
 *  2. **La factura del proveedor se pide en diferido** y SÓLO de lo que tiene saldo, con la llave de
 *     Pagos (`oblig:suc|tipo|sub|folio`). PDF → «Factura» en un clic; sólo UUID → «UUID»; nada → «Sin PDF».
 *  3. ⛔ **Si la búsqueda de facturas falla, se dice** con «Reintentar» — ningún renglón dice «Sin PDF».
 *  4. **Buscar** encuentra la factura por el folio de la transferencia que la pagó, y la cuenta se recorre.
 *  5. **«Agendar»** va al Calendario en su vencimiento, o en hoy si ya venció, con la factura ya buscada;
 *     ⛔ lo que el Calendario ya cubre completo no se vuelve a agendar.
 *  6. **El PDF abre en la pestaña que nació con el clic**; ⛔ una llave del bucket no se abre.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { vi } from 'vitest';
import type {
  AcreedorDocumento, AcreedorEstadoCuentaResponse, AcreedoresResponse, AcreedorResumen, PayableEvidenceRow,
} from '@megadulces/contracts';

import { FinanzasEstadoCuentaAcreedoresComponent } from './finanzas-estado-cuenta-acreedores.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

const HOY = '2026-11-20';

const acreedor: AcreedorResumen = {
  codigo: 'CB005', nombre: 'BOLSAS DE LOS ALTOS', rfc: 'AAA010101AAA', grupo: '002', grupo_nombre: 'Proveedor de plásticos estratégico',
  tipo: 'mercancia', sucursales: ['00', '05'], documentos_pendientes: 3, pendiente: 1536, vencido: 36, pagos_sin_aplicar: 0,
  saldo: 1536, pendiente_sucursal_antes_corte: 0, ultimo_movimiento: '2026-11-01',
};

const lista: AcreedoresResponse = {
  al: HOY,
  totales: [{ tipo: 'mercancia', acreedores: 1, pendiente: 1536, vencido: 36, pagos_sin_aplicar: 0, saldo: 1536, pendiente_sucursal_antes_corte: 0 }],
  acreedores: [acreedor],
};

const doc = (folio: string, extra: Partial<AcreedorDocumento> = {}): AcreedorDocumento => ({
  sucursal: '00', documento: 'Aplica Orden Entrada', tipo_doc: 20, sub: 1, folio, fecha: '2026-10-01', vence: '2026-11-27',
  referencia: null, importe: 1000, aplicado: 0, saldo: 1000, estado: 'pendiente', vencido: false, cancelado: false,
  aplicaciones: [], programado: [], ...extra,
});

/** Vencida y pagada en parte por la transferencia 0001983. */
const VENCIDA = doc('0003499', {
  fecha: '2025-12-27', vence: '2025-12-27', importe: 30540.06, aplicado: 30504.06, saldo: 36, estado: 'parcial', vencido: true,
  aplicaciones: [{ sucursal: '00', documento: 'Transferencia a proveedor', tipo_doc: 26, folio: '0001983', fecha: '2026-03-05', referencia: null, importe: 30504.06, cancelado: false }],
});
/** Por vencer el 27/11, en otra sucursal. */
const POR_VENCER = doc('0003600', { sucursal: '05' });
/** Ya programada completa en el Calendario: no se vuelve a agendar. */
const PROGRAMADA = doc('0003700', {
  saldo: 500, importe: 500, vence: '2026-12-05',
  programado: [{ allocation_id: 'a1', fecha: '2026-12-01', estado: 'pendiente', dia_pasado: false, cubierto: 500, facturas_en_pago: 1, total_pago: 500,
    creado_por: null, pagado_el: null, metodo: null, banco: null, referencia: null, kepler_folio: null, aplicado_en_kepler: false }],
});
/** Pagada: no se le busca factura ni se agenda. */
const PAGADA = doc('0003001', { saldo: 0, aplicado: 1000, estado: 'pagado' });

const estadoCuenta = (docs: AcreedorDocumento[] = [VENCIDA, POR_VENCER, PROGRAMADA, PAGADA]): AcreedorEstadoCuentaResponse => ({
  acreedor: { codigo: 'CB005', nombre: 'BOLSAS DE LOS ALTOS', rfc: 'AAA010101AAA', direccion: null, telefono: null, grupo: '002',
    grupo_nombre: 'Proveedor de plásticos estratégico', zona: null, agente: null, tipo: 'mercancia', dias_credito: 30, limite_credito: null },
  solo_pendientes: true, periodo: null, documentos: docs, pagos_sin_aplicar: [],
  totales: { importe: 0, aplicado: 0, pendiente: 1536, vencido: 36, pagos_sin_aplicar: 0, saldo: 1536 },
  calendario: { medido: true, programado: 500, documentos: 1, sin_programar: 1036 },
  al: HOY,
});

const ev = (d: AcreedorDocumento, evidencia: PayableEvidenceRow['evidencia'], ref: string | null): PayableEvidenceRow => ({
  entity_ref: `oblig:${d.sucursal}|${d.tipo_doc}|${d.sub}|${d.folio}`, sucursal: d.sucursal, doc_tipo: String(d.tipo_doc), doc_sub: String(d.sub),
  folio: d.folio, proveedor: 'CB005', pendiente: d.saldo, evidencia, ref_evidencia: ref, puntaje: 4, senales: [],
  motivo: evidencia === 'ninguna' ? 'Sin comprobante ni CFDI que coincida' : null, rfc: null, rfc_fuente: 'kepler', rfc_discrepa: null,
} as PayableEvidenceRow);

/** Los microtask de `firstValueFrom` (la evidencia es async/await). */
const tick = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe('[ECA.9] FinanzasEstadoCuentaAcreedoresComponent', () => {
  let fix: ComponentFixture<FinanzasEstadoCuentaAcreedoresComponent>;
  let c: FinanzasEstadoCuentaAcreedoresComponent;
  let http: HttpTestingController;
  /** `FINANCE_PAYMENTS_GESTIONAR`: lo que pide agregar facturas al Calendario. */
  const gestiona = signal(true);

  const txt =(): string => (fix.nativeElement.textContent as string).replace(/\s+/g, ' ');
  const renglon = (folio: string): HTMLElement => {
    const tr = (Array.from(fix.nativeElement.querySelectorAll('tr.ec-doc-row')) as HTMLElement[]).find((r) => r.textContent?.includes(folio));
    if (!tr) throw new Error(`no hay renglón ${folio}`);
    return tr;
  };
  // `[PGP.231]` POST con las llaves en el cuerpo: en la URL, con el token de un superadmin, daba 431.
  const pideEvidencia = () => http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/finance/payment-calendar/evidencia/consulta'));

  /** Monta, elige al acreedor y entrega su estado de cuenta. Devuelve la petición de evidencia pendiente. */
  const abrir = (docs?: AcreedorDocumento[], calendarioMedido = true) => {
    fix = TestBed.createComponent(FinanzasEstadoCuentaAcreedoresComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    http.expectOne((r) => r.url.endsWith('/finance/creditor-statements')).flush(lista);
    c.pick(acreedor);
    const ec = estadoCuenta(docs);
    http.expectOne((r) => r.url.includes('/finance/creditor-statements/CB005'))
      .flush(calendarioMedido ? ec : { ...ec, calendario: { medido: false, programado: 0, documentos: 0, sin_programar: 0 } });
    fix.detectChanges();
    return pideEvidencia();
  };

  beforeEach(() => {
    gestiona.set(true);
    TestBed.configureTestingModule({
      imports: [FinanzasEstadoCuentaAcreedoresComponent],
      providers: [
        provideZonelessChangeDetection(), provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => true, has$: () => gestiona } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('el saldo del documento va en su renglón, bajo «Saldo», y ya no hay renglón «Saldo documento»', () => {
    abrir().flush([]);
    const celdas = Array.from(renglon('0003499').querySelectorAll('td')) as HTMLElement[];
    expect(celdas[5].textContent).toContain('$30,540.06'); // «Importe»: una sola columna (antes «Cargo» y «Abono»)
    expect(celdas[7].textContent).toContain('$36.00');
    // Lo aplicado va en la MISMA columna, con signo menos.
    const ap = fix.nativeElement.querySelector('tr.ec-ap-row') as HTMLElement;
    expect((Array.from(ap.querySelectorAll('td')) as HTMLElement[])[5].textContent).toContain('−$30,504.06');
    expect(celdas[1].textContent).toContain('Parcial'); // el estado, junto al nombre del documento
    expect(txt()).not.toContain('Saldo documento');
    // «Vencida» no va sólo en color (alto contraste): icono + texto para lector de pantalla. ⛔ La por vencer no lo lleva.
    expect(celdas[6].querySelector('.ec-venc-i')).not.toBeNull();
    expect(celdas[6].textContent).toContain('vencida el');
    expect(renglon('0003600').querySelector('.ec-venc-i')).toBeNull();
    // Sucursal por nombre, nunca el código.
    expect(celdas[0].textContent?.trim()).not.toBe('00');
  });

  it('pide la factura SÓLO de lo que tiene saldo, con la llave de Pagos', () => {
    const req = abrir();
    const refs = (req.request.body as { refs: string[] }).refs;
    expect(refs).toEqual(['oblig:00|20|1|0003499', 'oblig:05|20|1|0003600', 'oblig:00|20|1|0003700']);
    // ⛔ NEGATIVA [PGP.231]: nada viaja en la URL.
    expect(req.request.params.keys()).toEqual([]);
    expect(req.request.urlWithParams).not.toContain('oblig');
    // ⛔ NEGATIVA: la pagada no se busca.
    expect(refs.some((r) => r.endsWith('0003001'))).toBe(false);
    req.flush([]);
  });

  it('PDF → «Factura»; sólo UUID → «UUID»; nada → «Sin PDF», y la cuenta se dice una vez', async () => {
    abrir().flush([ev(VENCIDA, 'pdf', 'p-1'), ev(POR_VENCER, 'uuid', '1A2B3C4D-0000-0000-0000-000000000000'), ev(PROGRAMADA, 'ninguna', null)]);
    await tick();
    fix.detectChanges();
    expect(renglon('0003499').querySelector('button[aria-label="Abrir el PDF de la factura 0003499"]')).not.toBeNull();
    expect(renglon('0003600').textContent).toContain('UUID');
    expect(renglon('0003700').textContent).toContain('Sin PDF');
    expect(renglon('0003001').querySelector('.ec-acts')).toBeNull(); // pagada: nada que abrir ni agendar
    expect(fix.nativeElement.querySelector('#ec-doc-dice').textContent).toContain('1 de 3 con factura en PDF');
  });

  it('⛔ si la búsqueda de facturas falla, lo dice con «Reintentar» y ningún renglón afirma «Sin PDF»', async () => {
    abrir().flush('boom', { status: 500, statusText: 'Server Error' });
    await tick();
    fix.detectChanges();
    expect(txt()).toContain('No se pudieron buscar las facturas');
    expect(txt()).not.toContain('Sin PDF');
    // Ni «Sin PDF» ni el «—» de «no hay nada»: lo no medido no se dibuja como medido.
    expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row .ec-ev-nm').length).toBe(0);
    c.reintentarEvid();
    pideEvidencia().flush([ev(VENCIDA, 'pdf', 'p-1')]);
    await tick();
    fix.detectChanges();
    expect(txt()).not.toContain('No se pudieron buscar las facturas');
    expect(renglon('0003499').querySelector('button[aria-label="Abrir el PDF de la factura 0003499"]')).not.toBeNull();
  });

  it('«Actualizar» vuelve a preguntar por las facturas del mismo acreedor (la que se subió mientras tanto sale)', async () => {
    abrir().flush([ev(PROGRAMADA, 'ninguna', null)]);
    await tick();
    c.reload();
    http.expectOne((r) => r.url.endsWith('/finance/creditor-statements')).flush(lista);
    http.expectOne((r) => r.url.includes('/finance/creditor-statements/CB005')).flush(estadoCuenta());
    // ⛔ Sin esto, las 3 llaves ya respondidas no se volvían a pedir y el renglón seguía en «Sin PDF».
    pideEvidencia().flush([ev(PROGRAMADA, 'pdf', 'p-9')]);
    await tick();
    fix.detectChanges();
    expect(renglon('0003700').querySelector('button[aria-label="Abrir el PDF de la factura 0003700"]')).not.toBeNull();
  });

  it('⛔ la respuesta lenta de una lectura anterior no pisa a la última (alternar «Sólo con saldo»)', async () => {
    abrir().flush([]);
    await tick();
    c.setSoloPendientes(false);
    const vieja = http.expectOne((r) => r.url.includes('/finance/creditor-statements/CB005') && r.url.includes('pendientes=false'));
    c.setSoloPendientes(true);
    const nueva = http.expectOne((r) => r.url.includes('/finance/creditor-statements/CB005') && !r.url.includes('pendientes=false'));
    nueva.flush(estadoCuenta());
    vieja.flush({ ...estadoCuenta([PAGADA]), solo_pendientes: false, periodo: { from: '2026-09-01', to: HOY } });
    fix.detectChanges();
    expect(c.det()?.solo_pendientes).toBe(true);
    expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row').length).toBe(4);
    expect(c.detLoading()).toBe(false);
  });

  it('buscar por el folio de la TRANSFERENCIA encuentra la factura que pagó, y la cuenta se recorre', () => {
    vi.useFakeTimers();
    abrir().flush([]);
    c.alEscribirDoc('0001983');
    vi.advanceTimersByTime(250);
    fix.detectChanges();
    expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row').length).toBe(1);
    expect(fix.nativeElement.querySelector('#ec-doc-dice').textContent).toContain('1 de 4 documentos con saldo con «0001983»');
    // Por importe con y sin formato.
    c.alEscribirDoc('30,540'); vi.advanceTimersByTime(250); fix.detectChanges();
    expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row').length).toBe(1);
    c.alEscribirDoc('30540'); vi.advanceTimersByTime(250); fix.detectChanges();
    expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row').length).toBe(1);
    // Un importe redondo escrito con sus centavos: «1000.00» (antes 0 — `String(1000)` da «1000»).
    c.alEscribirDoc('1000.00'); vi.advanceTimersByTime(250); fix.detectChanges();
    expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row').length).toBe(2); // 0003600 y la pagada 0003001
    // Una fecha con el año completo, como se escribe a mano o se copia de otro sistema.
    for (const f of ['27/12/2025', '2025-12-27', '27/12/25']) {
      c.alEscribirDoc(f); vi.advanceTimersByTime(250); fix.detectChanges();
      expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row').length, f).toBe(1);
    }
  });

  it('sin coincidencias entre lo que tiene saldo, ofrece buscar también en los pagados (misma búsqueda)', () => {
    vi.useFakeTimers();
    abrir().flush([]);
    c.alEscribirDoc('9999999'); vi.advanceTimersByTime(250); fix.detectChanges();
    const btn = (Array.from(fix.nativeElement.querySelectorAll('button')) as HTMLButtonElement[]).find((b) => b.textContent?.includes('Buscar también en los pagados'));
    expect(btn).toBeTruthy();
    btn!.click();
    const req = http.expectOne((r) => r.url.includes('/finance/creditor-statements/CB005'));
    expect(req.request.url).toContain('pendientes=false');
    // 12 meses, no los 3 del interruptor: quien busca algo concreto no busca sólo en lo reciente.
    expect(req.request.url).toContain(`from=${new Date().getFullYear() - 1}-`);
    expect(c.qDoc()).toBe('9999999');
    req.flush({ ...estadoCuenta([]), solo_pendientes: false, periodo: { from: '2026-09-01', to: HOY } });
  });

  it('«Agendar»: vencida → hoy; por vencer → su vencimiento; con la factura ya buscada en el Calendario', () => {
    abrir().flush([]);
    const a1 = renglon('0003499').querySelector('a.ec-act') as HTMLAnchorElement;
    expect(a1.textContent).toContain('Agendar hoy');
    expect(a1.getAttribute('href')).toContain(`fecha=${HOY}`);
    expect(decodeURIComponent(a1.getAttribute('href') ?? '').replace(/\+/g, ' ')).toContain('buscar=CB005 0003499');
    expect(a1.getAttribute('aria-label')).toContain('venció el 27/12/25');
    const a2 = renglon('0003600').querySelector('a.ec-act') as HTMLAnchorElement;
    expect(a2.textContent).toContain('Agendar 27/11');
    expect(a2.getAttribute('href')).toContain('fecha=2026-11-27');
  });

  it('⛔ lo que el Calendario ya cubre completo no se vuelve a agendar', () => {
    abrir().flush([]);
    expect(renglon('0003700').querySelector('a.ec-act')).toBeNull();
    expect(c.puedeAgendar(PROGRAMADA)).toBe(false);
    expect(c.puedeAgendar(POR_VENCER)).toBe(true);
  });

  it('⛔ sin el Calendario leído no se ofrece «Agendar» (no se sabe qué está programado) y se dice', () => {
    abrir(undefined, false).flush([]);
    expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row a.ec-act').length).toBe(0);
    expect(txt()).toContain('no se pudo leer');
    expect(txt()).toContain('ni se ofrece «Agendar»');
  });

  it('⛔ quien sólo puede VER no recibe «Agendar» (agregar al Calendario pide GESTIONAR)', () => {
    gestiona.set(false);
    abrir().flush([]);
    expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row a.ec-act').length).toBe(0);
    gestiona.set(true);
    fix.detectChanges();
    expect(fix.nativeElement.querySelectorAll('tr.ec-doc-row a.ec-act').length).toBe(2); // vencida y por vencer
  });

  it('el PDF abre en la pestaña que nació con el clic; ⛔ una llave del bucket no se abre y se dice', async () => {
    abrir().flush([ev(VENCIDA, 'pdf', 'p-1')]);
    await tick();
    fix.detectChanges();
    const win = { document: { write: vi.fn(), close: vi.fn() }, location: { href: '' }, closed: false, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    (renglon('0003499').querySelector('button.ec-act') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledTimes(1); // dentro del clic, antes de que conteste el servidor
    http.expectOne((r) => r.url.endsWith('/evidencia/archivo/p-1')).flush([{ url: 'https://s3/f.pdf', name: 'f.pdf', role: 'factura', kind: 'pdf' }]);
    await tick();
    expect(win.location.href).toBe('https://s3/f.pdf');

    (renglon('0003499').querySelector('button.ec-act') as HTMLButtonElement).click();
    http.expectOne((r) => r.url.endsWith('/evidencia/archivo/p-1')).flush([{ url: 'finance/t/goods-receipts/x.pdf', name: 'x.pdf', role: 'factura', kind: 'pdf' }]);
    await tick();
    fix.detectChanges();
    expect(win.close).toHaveBeenCalled();
    expect(txt()).toContain('no pudo generar su enlace de lectura');
  });
});
