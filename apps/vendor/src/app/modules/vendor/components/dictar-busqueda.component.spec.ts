import { TestBed } from '@angular/core/testing';
import { DictarBusquedaComponent } from './dictar-busqueda.component';

/**
 * `[MCP.26]` El micrófono de los buscadores de producto: lo dicho sale CONVERTIDO (lo que la búsqueda
 * encuentra), nunca se queda callado y sin reconocimiento de voz no se pinta.
 */

/** Un reconocedor falso: al empezar «escucha» `frase` (o falla con `error`) y termina. */
function vozFalsa(frase: string, error?: string) {
  return class {
    lang = ''; interimResults = false; continuous = false;
    onresult: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error?: string }) => void) | null = null;
    start(): void {
      if (error) this.onerror?.({ error });
      else this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: frase }, isFinal: true }] });
      this.onend?.();
    }
    stop(): void { this.onend?.(); }
  };
}

/** Uno que se queda escuchando hasta que lo paran (para probar el segundo toque). */
class VozQueEspera {
  static paradas = 0;
  lang = ''; interimResults = false; continuous = false;
  onresult: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  start(): void { /* escucha */ }
  stop(): void { VozQueEspera.paradas++; this.onend?.(); }
}

const ventana = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };

function montar() {
  TestBed.configureTestingModule({ imports: [DictarBusquedaComponent] });
  const fix = TestBed.createComponent(DictarBusquedaComponent);
  const salidas: string[] = [];
  fix.componentInstance.texto.subscribe((t) => salidas.push(t));
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  return { fix, cmp: fix.componentInstance, el, salidas, boton: () => el.querySelector<HTMLButtonElement>('button.db-btn') };
}

describe('[MCP.26] app-dictar-busqueda · buscar un producto dictando', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    delete ventana.SpeechRecognition;
    delete ventana.webkitSpeechRecognition;
  });

  it('sin reconocimiento de voz en el navegador no pinta el botón', () => {
    const { boton } = montar();
    expect(boton()).toBeNull();
  });

  it('⭐ lo dicho sale convertido en la búsqueda que lo encuentra, no la frase tal cual', () => {
    ventana.SpeechRecognition = vozFalsa('Bombón de la Rosa de un kilo');
    const { boton, salidas, cmp } = montar();
    boton()!.click();
    expect(salidas).toEqual(['bombón rosa 1 k']);
    expect(cmp.escuchando()).toBe(false);
    expect(cmp.error()).toBeNull();
  });

  it('el botón dice qué hace y, mientras escucha, cómo pararlo (no sólo el color)', () => {
    ventana.SpeechRecognition = VozQueEspera;
    const { boton, fix } = montar();
    expect(boton()!.getAttribute('aria-label')).toBe('Buscar dictando el producto');
    expect(boton()!.getAttribute('aria-pressed')).toBe('false');
    boton()!.click();
    fix.detectChanges();
    expect(boton()!.getAttribute('aria-pressed')).toBe('true');
    expect(boton()!.getAttribute('aria-label')).toBe('Escuchando: toca para parar');
    expect(boton()!.querySelector('i')!.classList.contains('pi-stop-circle')).toBe(true);
  });

  it('un segundo toque para el micrófono', () => {
    VozQueEspera.paradas = 0;
    ventana.SpeechRecognition = VozQueEspera;
    const { boton, cmp } = montar();
    boton()!.click();
    expect(cmp.escuchando()).toBe(true);
    boton()!.click();
    expect(VozQueEspera.paradas).toBe(1);
    expect(cmp.escuchando()).toBe(false);
  });

  it('⛔ sin permiso del micrófono lo dice y no busca nada', () => {
    ventana.SpeechRecognition = vozFalsa('', 'not-allowed');
    const { boton, salidas, cmp } = montar();
    boton()!.click();
    expect(salidas).toEqual([]);
    expect(cmp.error()).toBe('El navegador no dio permiso para usar el micrófono.');
  });

  it('⛔ si sólo se oyeron palabras de enlace no se queda callado', () => {
    ventana.SpeechRecognition = vozFalsa('de la');
    const { boton, salidas, cmp } = montar();
    boton()!.click();
    expect(salidas).toEqual([]);
    expect(cmp.error()).toContain('No se escuchó ningún producto');
  });

  it('volver a tocar borra el aviso anterior', () => {
    ventana.SpeechRecognition = vozFalsa('de la');
    const { boton, cmp } = montar();
    boton()!.click();
    expect(cmp.error()).not.toBeNull();
    ventana.SpeechRecognition = vozFalsa('cajeta un kilo');
    boton()!.click();
    expect(cmp.error()).toBeNull();
  });
});
