import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { VisorEvidenciaComponent, type DocEvidencia } from './visor-evidencia.component';

/**
 * `[GX.99]` **La evidencia en grande.** Pedido del usuario (2026-11-06): que al revisar la evidencia
 * se vea «en ventana», no a lo ancho del panel uno debajo de otro. Lo que se cuida: pasar de un
 * archivo a otro sin salir, acercar y girar sólo lo que se puede, que cada archivo arranque derecho,
 * y que Esc cierre SÓLO el visor (medido en la maqueta: cerraba también el vale).
 */
const DOC = (over: Partial<DocEvidencia> = {}): DocEvidencia => ({
  role: 'comprobante_1', label: 'Comprobante — hoja 1', url: 'https://ejemplo/1.jpg', isPdf: false, esOtro: false,
  safeUrl: null, nota: null, ...over,
});
const DOCS = [
  DOC(),
  DOC({ role: 'cotizacion', label: 'Cotización', url: 'https://ejemplo/2.pdf', isPdf: true }),
  DOC({ role: 'adicional', label: 'Evidencia adicional', url: 'https://ejemplo/3.jpg', nota: '«llegó el ticket» · ana' }),
];

describe('[GX.99] VisorEvidenciaComponent', () => {
  let fix: ComponentFixture<VisorEvidenciaComponent>;
  let c: VisorEvidenciaComponent;

  const montar = (indice = 0) => {
    fix = TestBed.createComponent(VisorEvidenciaComponent);
    c = fix.componentInstance;
    // El PDF llega sanitizado (lo hace el visor del vale): así lo pide el iframe.
    const san = TestBed.inject(DomSanitizer);
    fix.componentRef.setInput('docs', DOCS.map((d) => d.isPdf ? { ...d, safeUrl: san.bypassSecurityTrustResourceUrl(d.url) } : d));
    fix.componentRef.setInput('indice', indice);
    fix.componentRef.setInput('titulo', '0010530 · $1,250.00');
    fix.componentRef.setInput('open', true);
    fix.detectChanges();
  };
  const tecla = (key: string, target: EventTarget = document.body) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    fix.detectChanges();
    return ev;
  };

  beforeEach(() => TestBed.configureTestingModule({ imports: [VisorEvidenciaComponent] }));
  afterEach(() => fix?.destroy());

  it('abre en el archivo pedido', () => {
    montar(2);
    expect(c.actual()?.label).toBe('Evidencia adicional');
  });

  it('las flechas pasan de archivo y dan la vuelta', () => {
    montar(0);
    c.siguiente(); expect(c.indice()).toBe(1);
    c.siguiente(); c.siguiente(); expect(c.indice()).toBe(0);
    c.anterior(); expect(c.indice()).toBe(2);
  });

  it('con el teclado: ← → cambian de archivo', () => {
    montar(0);
    tecla('ArrowRight'); expect(c.indice()).toBe(1);
    tecla('ArrowLeft'); expect(c.indice()).toBe(0);
  });

  it('acercar tiene tope; tamaño normal regresa a 100 %', () => {
    montar(0);
    for (let i = 0; i < 20; i++) c.acercar();
    expect(c.zoom()).toBe(c.zoomMax);
    c.tamanoNormal();
    expect(c.zoom()).toBe(1);
    for (let i = 0; i < 20; i++) c.alejar();
    expect(c.zoom()).toBe(c.zoomMin);
  });

  /** Una foto acercada o girada no arrastra su zoom al siguiente archivo. */
  it('cada archivo arranca derecho y a su tamaño', () => {
    montar(0);
    c.acercar(); c.girar();
    c.siguiente();
    fix.detectChanges();
    expect(c.zoom()).toBe(1);
    expect(c.giro()).toBe(0);
  });

  it('girar da la vuelta completa', () => {
    montar(0);
    for (let i = 0; i < 4; i++) c.girar();
    expect(c.giro()).toBe(0);
  });

  /** ⛔ En un PDF el zoom lo hace el visor de PDF: las teclas + − no fingen hacer algo. */
  it('⛔ en un PDF, + no acerca', () => {
    montar(1);
    tecla('+');
    expect(c.zoom()).toBe(1);
  });

  it('⛔ el teclado no le roba teclas a un campo de texto', () => {
    montar(0);
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      tecla('ArrowRight', input);
      expect(c.indice()).toBe(0);
    } finally { input.remove(); }
  });

  /**
   * ⭐ Esc cierra SÓLO el visor. Medido en la maqueta: el panel del vale también escucha Esc en el
   * documento y se cerraban los dos — la persona perdía el vale que estaba revisando.
   */
  it('⭐ Esc cierra el visor y NO llega a quien escucha después (el panel del vale)', () => {
    montar(0);
    const panel = vi.fn();
    document.addEventListener('keydown', panel);
    try {
      tecla('Escape');
      expect(c.open()).toBe(false);
      expect(panel).not.toHaveBeenCalled();
      // Ya cerrado, Esc vuelve a ser del panel.
      tecla('Escape');
      expect(panel).toHaveBeenCalledTimes(1);
    } finally { document.removeEventListener('keydown', panel); }
  });

  it('dice cuál archivo es y de cuántos', () => {
    montar(1);
    // El encabezado del diálogo vive en el overlay (appendTo body).
    expect(document.body.textContent).toContain('2 de 3');
    expect(document.body.textContent).toContain('0010530 · $1,250.00');
  });

  it('la evidencia adicional dice por qué se agregó', () => {
    montar(2);
    expect(document.body.textContent).toContain('Agregada después: «llegó el ticket» · ana');
  });

  /** ⛔ Que la imagen no cargue NO es que no exista. */
  it('⛔ una imagen que no carga lo dice, con la salida «Abrir aparte»', () => {
    montar(0);
    c.fallo('https://ejemplo/1.jpg');
    fix.detectChanges();
    expect(document.body.textContent).toContain('No se pudo mostrar el archivo. Prueba «Abrir aparte».');
  });
});
