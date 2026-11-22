import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { AvisoDePago } from '@megadulces/contracts/finance/aviso-de-pago';
import { AvisoProveedorDialogComponent } from './aviso-proveedor-dialog.component';

/**
 * `[PGP.194]` El diálogo «Avisar al proveedor». Monta el componente (compila la plantilla) y cuida lo que no se puede
 * mandar mal: un WhatsApp o un correo mal escritos no llegan al servidor, un pago que no se puede avisar no ofrece
 * botones, el contacto recordado llena el formulario y la ventana bloqueada deja la liga a mano.
 *
 * Vectores SINTÉTICOS (el repo es público).
 */
const PAGO = '22222222-2222-2222-2222-222222222222';
const aviso = (o: Partial<AvisoDePago> = {}): AvisoDePago => ({
  pago_id: PAGO, emisor: { nombre: 'EMPRESA DE PRUEBA', rfc: 'EPR010101AAA' }, proveedor: { codigo: 'P01', nombre: 'PROVEEDOR UNO', rfc: null },
  fecha_pago: '2026-11-09', importe: 1000, rastreo: 'RASTREO1', origen: 'BBVA ···4166', destino: '···6033', comprobante_id: 'c1',
  facturas: [{ referencia: 'A-1', documento: 'X-A-20 0000001', uuid: 'abcdef12-0000-0000-0000-000000000000', metodo: 'PPD', fecha: '2026-10-01', total: 1300,
    notas: [{ nombre: 'Nota de crédito', documento: 'X-D-55 0000009', referencia: 'NC-9', fecha: '2026-11-01', importe: 300 }], descuento: 0, pagado: 1000 }],
  contacto: { nombre: 'Cobranza', email: 'cobranza@proveedor.com', whatsapp: '523511234567' }, avisos: [], faltantes: [], se_puede: true, motivo: null, ...o,
});

describe('[PGP.194] AvisoProveedorDialogComponent', () => {
  let fixture: ComponentFixture<AvisoProveedorDialogComponent>;
  let c: AvisoProveedorDialogComponent;
  let http: HttpTestingController;
  const URL_AVISO = `/finance/payment-notices/${PAGO}`;
  const pedir = () => http.expectOne((r) => r.method === 'GET' && r.url.endsWith(URL_AVISO));

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AvisoProveedorDialogComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    fixture = TestBed.createComponent(AvisoProveedorDialogComponent);
    c = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('⭐ al abrir pide el aviso y llena el contacto recordado (el WhatsApp sin la lada)', () => {
    c.abrir(PAGO, 'PROVEEDOR UNO');
    pedir().flush(aviso());
    expect(c.aviso()?.proveedor.nombre).toBe('PROVEEDOR UNO');
    expect([c.nombre, c.whatsapp, c.email]).toEqual(['Cobranza', '3511234567', 'cobranza@proveedor.com']);
    expect(c.notas(c.aviso()!.facturas[0])).toBe(300);
  });

  it('⛔ NEGATIVA: un WhatsApp o un correo mal escritos no llegan al servidor', () => {
    c.abrir(PAGO, 'x');
    pedir().flush(aviso({ contacto: null }));
    c.whatsapp = '12345';
    c.enviar('whatsapp');
    expect(c.mensaje()?.mal).toBe(true);
    c.whatsapp = '';
    c.email = 'no-es-correo';
    c.enviar('correo');
    expect(c.mensaje()?.texto).toMatch(/forma de correo/);
    http.expectNone((r) => r.method === 'POST');
  });

  it('⭐ WhatsApp: manda canal y contacto, abre wa.me y vuelve a leer el aviso (su historial)', () => {
    const abrir = vi.spyOn(window, 'open').mockReturnValue({ opener: {} } as unknown as Window);
    c.abrir(PAGO, 'x');
    pedir().flush(aviso());
    c.enviar('whatsapp');
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith(URL_AVISO));
    expect(post.request.body).toEqual({ canal: 'whatsapp', whatsapp: '3511234567', email: 'cobranza@proveedor.com', nombre: 'Cobranza' });
    post.flush({ aviso_id: 'n1', url: 'https://x/aviso.pdf', whatsapp_url: 'https://wa.me/523511234567?text=hola', mailto: 'mailto:x' });
    expect(abrir).toHaveBeenCalledWith('https://wa.me/523511234567?text=hola', '_blank');
    expect(c.respaldo()).toBeNull();
    pedir().flush(aviso({ avisos: [{ canal: 'whatsapp', destino: '523511234567', por: 'Tesorería', el: '2026-11-21T10:00' }] }));
    expect(c.aviso()?.avisos.length).toBe(1);
    abrir.mockRestore();
  });

  it('⛔ si el navegador bloquea la ventana, queda la liga para abrirla a mano', () => {
    const abrir = vi.spyOn(window, 'open').mockReturnValue(null);
    c.abrir(PAGO, 'x');
    pedir().flush(aviso());
    c.enviar('whatsapp');
    http.expectOne((r) => r.method === 'POST').flush({ aviso_id: 'n1', url: 'u', whatsapp_url: 'https://wa.me/?text=x', mailto: 'mailto:x' });
    expect(c.respaldo()).toEqual({ href: 'https://wa.me/?text=x', texto: 'Abrir WhatsApp' });
    pedir().flush(aviso());
    abrir.mockRestore();
  });

  it('⛔ un pago que no se puede avisar dice por qué y no ofrece botones', () => {
    c.abrir(PAGO, 'x');
    pedir().flush(aviso({ se_puede: false, motivo: 'El pago todavía no está marcado pagado.' }));
    fixture.detectChanges();
    const html = document.body.innerHTML;
    expect(html).toContain('El pago todavía no está marcado pagado.');
    expect(html).not.toContain('Copiar liga');
  });

  it('el error del servidor al armar el aviso se dice, con «Reintentar»', () => {
    c.abrir(PAGO, 'x');
    pedir().flush({ message: 'Ese pago no existe.' }, { status: 404, statusText: 'Not Found' });
    expect(c.error()).toBe('Ese pago no existe.');
  });
});
