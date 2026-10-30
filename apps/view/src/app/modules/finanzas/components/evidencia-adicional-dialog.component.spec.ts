import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { EvidenciaAdicionalDialogComponent, type EvidenciaAgregada } from './evidencia-adicional-dialog.component';
import { ComprobacionesService, type ValeGasto } from '../comprobaciones.service';

/**
 * `[GX.87]` El diálogo que SUMA evidencia a un vale ya capturado, con su porqué.
 *
 * Lo que cuida: que no se pueda enviar sin archivo o sin porqué (la misma regla que el
 * servidor), que un archivo de más de 20 MB no entre, que una subida fallida no registre nada
 * a medias ni re-suba lo que ya subió, y que lo que avisa al terminar sea el expediente firmado
 * que devolvió el servidor.
 */
const MB = 1024 * 1024;
const MOTIVO = 'Llegó la factura definitiva';

function archivo(nombre: string, mb = 1): File {
  const f = new File(['%PDF-1.4'], nombre, { type: 'application/pdf' });
  Object.defineProperty(f, 'size', { value: mb * MB });
  return f;
}

describe('[GX.87] EvidenciaAdicionalDialogComponent', () => {
  let c: EvidenciaAdicionalDialogComponent;

  /**
   * `FileReader` es asíncrono: se espera a que TERMINE de leer lo elegido, no un tiempo fijo.
   * ⛔ Con `setTimeout(20)` pasaba en una laptop y en el runner del CI (más lento) la lectura no
   * había terminado: la prueba medía el reloj de la máquina, no el diálogo.
   */
  const leer = () => vi.waitFor(() => {
    if (c.elegidos().some((e) => !e.subido && !e.dataUri)) throw new Error('todavía leyendo');
  }, { timeout: 5000, interval: 5 });
  let svc: { uploadFile: ReturnType<typeof vi.fn>; agregarEvidenciaAdicional: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    svc = {
      uploadFile: vi.fn((_d: string, role: string) => of({ role, url: 'k/subido.pdf', public_id: 'k/subido.pdf', kind: 'pdf' })),
      agregarEvidenciaAdicional: vi.fn(() => of({ id: 'v1', agregados: 1, files: [{ role: 'adicional', url: 'https://firmada' }] })),
    };
    await TestBed.configureTestingModule({
      imports: [EvidenciaAdicionalDialogComponent],
      providers: [{ provide: ComprobacionesService, useValue: svc }],
    }).compileComponents();
    const fix = TestBed.createComponent(EvidenciaAdicionalDialogComponent);
    c = fix.componentInstance;
    fix.componentRef.setInput('vale', { id: 'v1', folio_solicitud: '0009678', importe: 100, status: 'validada' } as ValeGasto);
    fix.detectChanges();
  });

  const escribir = (m: string) => { c.motivoV = m; c.motivo.set(m); };

  it('sin archivo o sin porqué no se puede enviar, y dice qué falta', async () => {
    expect(c.falta()).toMatch(/al menos un archivo/);
    c.onFilePicked({ currentFiles: [archivo('f.pdf')] });
    await leer();
    expect(c.falta()).toMatch(/por qué/);
    escribir(MOTIVO);
    expect(c.falta()).toBeNull();
  });

  it('⛔ mientras un archivo se lee, no se puede enviar y lo dice — no sube nada', async () => {
    escribir(MOTIVO);
    c.onFilePicked({ currentFiles: [archivo('f.pdf')] });
    // Síncrono, recién elegido: el navegador todavía no terminó de leerlo.
    expect(c.falta()).toBe('Todavía se está leyendo un archivo.');
    c.enviar();
    expect(svc.uploadFile).not.toHaveBeenCalled();
    await leer();
    expect(c.falta()).toBeNull();
  });

  it('⛔ uno de más de 20 MB no entra, y lo dice', () => {
    c.onFilePicked({ currentFiles: [archivo('grande.pdf', 21)] });
    expect(c.elegidos()).toHaveLength(0);
    expect(c.error()).toMatch(/supera 20 MB/);
  });

  it('⛔ no pasa del tope de archivos por envío', async () => {
    c.onFilePicked({ currentFiles: Array.from({ length: 7 }, (_, i) => archivo(`f${i}.pdf`)) });
    await leer();
    expect(c.elegidos()).toHaveLength(5);
    expect(c.error()).toMatch(/máximo/);
  });

  it('sube cada archivo con el rol «adicional», registra con el porqué y avisa con lo firmado', async () => {
    const avisos: EvidenciaAgregada[] = [];
    c.agregado.subscribe((e) => avisos.push(e));
    c.onFilePicked({ currentFiles: [archivo('factura.pdf')] });
    await leer();
    escribir(`  ${MOTIVO}  `);
    c.enviar();
    expect(svc.uploadFile).toHaveBeenCalledWith(expect.stringMatching(/^data:/), 'adicional');
    expect(svc.agregarEvidenciaAdicional).toHaveBeenCalledWith('v1',
      [expect.objectContaining({ url: 'k/subido.pdf', public_id: 'k/subido.pdf', name: 'factura.pdf' })], MOTIVO);
    expect(avisos).toEqual([{ id: 'v1', files: [{ role: 'adicional', url: 'https://firmada' }] }]);
    expect(c.elegidos()).toHaveLength(0); // se cerró y quedó limpio
  });

  it('⛔ si una subida falla no registra nada; al reintentar no re-sube lo que ya subió', async () => {
    let n = 0;
    svc.uploadFile.mockImplementation(() => (n++ === 1 ? throwError(() => new Error('red')) : of({ role: 'adicional', url: `k/${n}.pdf` })));
    c.onFilePicked({ currentFiles: [archivo('a.pdf'), archivo('b.pdf')] });
    await leer();
    escribir(MOTIVO);
    c.enviar();
    expect(svc.agregarEvidenciaAdicional).not.toHaveBeenCalled();
    expect(c.error()).toMatch(/No se pudieron subir 1/);
    expect(c.saving()).toBe(false);
    c.enviar();
    expect(svc.uploadFile).toHaveBeenCalledTimes(3); // 2 la primera vez + sólo el que faltaba
    expect(svc.agregarEvidenciaAdicional).toHaveBeenCalledTimes(1);
  });

  it('si el servidor lo rechaza, el mensaje del servidor se muestra y no se cierra', async () => {
    svc.agregarEvidenciaAdicional.mockReturnValue(throwError(() => ({ error: { message: 'A un vale rechazado no se le agrega evidencia: se vuelve a capturar.' } })));
    c.onFilePicked({ currentFiles: [archivo('a.pdf')] });
    await leer();
    escribir(MOTIVO);
    c.enviar();
    expect(c.error()).toMatch(/rechazado/);
    expect(c.elegidos()).toHaveLength(1);
  });

  it('el doble clic no envía dos veces', async () => {
    svc.agregarEvidenciaAdicional.mockReturnValue(new Subject()); // el servidor no contesta todavía
    c.onFilePicked({ currentFiles: [archivo('a.pdf')] });
    await leer();
    escribir(MOTIVO);
    c.enviar();
    c.enviar();
    expect(svc.agregarEvidenciaAdicional).toHaveBeenCalledTimes(1);
  });

  it('cancelar con algo elegido pregunta antes de tirarlo', async () => {
    c.onFilePicked({ currentFiles: [archivo('a.pdf')] });
    await leer();
    c.pedirCerrar();
    expect(c.confirmClose()).toBe(true);
    expect(c.elegidos()).toHaveLength(1);
    c.descartar();
    expect(c.elegidos()).toHaveLength(0);
  });
});
