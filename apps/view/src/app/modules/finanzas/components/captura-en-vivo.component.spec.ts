import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CapturaEnVivoComponent } from './captura-en-vivo.component';

/**
 * `[GX.14]` La cámara es lo que hace cumplir «la foto se toma en el momento». Lo que estas
 * pruebas defienden no es que se vea linda: es que **no exista un segundo camino**.
 *
 * El caso que más importa es el negativo: cuando el navegador niega la cámara, este
 * componente NO puede caer a subir un archivo. Si algún día alguien agrega ese respaldo
 * «para no bloquear al usuario», la regla entera queda decorativa — y esa prueba se pone
 * roja. Un gate sin prueba negativa es una intención (ADR-056).
 */

/** Un `MediaStream` de mentira que recuerda si le pidieron soltar la cámara. */
function streamFalso() {
  const track = { stop: vi.fn(), kind: 'video' };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

/** Deja `navigator.mediaDevices.getUserMedia` respondiendo lo que diga `impl`. */
function conCamara(impl: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(impl) },
    configurable: true,
  });
}

/** Saca `mediaDevices` del navegador, que es lo que pasa de verdad sobre HTTP. */
function sinApiDeCamara() {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
}

describe('[GX.14] CapturaEnVivoComponent', () => {
  let fixture: ComponentFixture<CapturaEnVivoComponent>;
  let comp: CapturaEnVivoComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [CapturaEnVivoComponent] }).compileComponents();
    fixture = TestBed.createComponent(CapturaEnVivoComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('arranca cerrado, mostrando sólo el botón de capturar', () => {
    expect(comp.estado()).toBe('idle');
    const html = fixture.nativeElement as HTMLElement;
    expect(html.querySelector('.cv-abrir')).toBeTruthy();
    expect(html.querySelector('video')).toBeNull();
  });

  /** ⭐ La prueba que sostiene la regla. */
  it('NUNCA ofrece un input de archivo — ni cerrado, ni en error', async () => {
    const html = fixture.nativeElement as HTMLElement;
    expect(html.querySelector('input[type=file]')).toBeNull();

    sinApiDeCamara();
    await comp.abrir();
    fixture.detectChanges();

    expect(comp.estado()).toBe('error');
    expect(html.querySelector('input[type=file]')).toBeNull();
    // Tampoco por la puerta de atrás: nada de arrastrar y soltar.
    expect(html.querySelector('[dragover], [drop]')).toBeNull();
  });

  it('sin API de cámara avisa que hace falta una conexión segura', async () => {
    sinApiDeCamara();
    await comp.abrir();
    expect(comp.estado()).toBe('error');
    expect(comp.error()).toContain('segura');
  });

  /**
   * Los tres motivos se dicen distinto porque la acción de la persona es distinta: dar
   * permiso, usar el celular, o reintentar. Un mensaje genérico los vuelve el mismo callejón.
   */
  it('distingue permiso negado de equipo sin cámara', async () => {
    conCamara(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
    await comp.abrir();
    expect(comp.error()).toContain('permiso');

    conCamara(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotFoundError' })));
    await comp.abrir();
    expect(comp.error()).toContain('no tiene cámara');
  });

  /**
   * ⭐⭐ **La asercion que faltaba, y por eso el bug llegó a produccion.**
   *
   * Las pruebas de arriba comprobaban que el <video> EXISTE y que dice EN VIVO. Las dos
   * cosas eran ciertas con la camara desenchufada: el enganche se hacia en un
   * `queueMicrotask` disparado antes de que Angular pintara la rama, asi que `srcObject`
   * se quedaba en null. En pantalla: recuadro NEGRO y el boton sin efecto, porque
   * `videoWidth` nunca pasaba de 0 y `disparar()` hacia `return` en silencio.
   *
   * Que el elemento este en el DOM no prueba que la camara este conectada a el.
   */
  it('engancha la camara al <video>: srcObject queda con el stream', async () => {
    const { stream } = streamFalso();
    conCamara(() => Promise.resolve(stream));
    await comp.abrir();
    fixture.detectChanges();

    const video = (fixture.nativeElement as HTMLElement).querySelector('video') as HTMLVideoElement;
    expect(video).toBeTruthy();
    expect(video.srcObject).toBe(stream);
  });

  /** Un disparador vivo sobre un visor negro es una promesa que no se cumple. */
  it('el disparador esta apagado hasta que hay imagen', async () => {
    const { stream } = streamFalso();
    conCamara(() => Promise.resolve(stream));
    await comp.abrir();
    fixture.detectChanges();

    const html = fixture.nativeElement as HTMLElement;
    const boton = html.querySelector('.cv-disparar') as HTMLButtonElement;
    expect(comp.listo()).toBe(false);
    expect(boton.disabled).toBe(true);

    const video = html.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    comp.marcarListo();
    fixture.detectChanges();

    expect(comp.listo()).toBe(true);
    expect((html.querySelector('.cv-disparar') as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * No alcanza con no entregar una foto negra: hay que DECIRLO. Callado, la persona
   * concluye que el boton no sirve -- que fue exactamente lo que se reportó.
   */
  it('sin cuadro lo dice, en vez de no hacer nada', async () => {
    const { stream } = streamFalso();
    conCamara(() => Promise.resolve(stream));
    await comp.abrir();
    fixture.detectChanges();

    const video = (fixture.nativeElement as HTMLElement).querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'videoWidth', { value: 0, configurable: true });

    comp.disparar();
    fixture.detectChanges();

    expect(comp.aviso()).not.toBe('');
    expect((fixture.nativeElement as HTMLElement).querySelector('.cv-aviso')?.textContent).toContain('imagen');
  });

  it('abre el visor y enciende el sello EN VIVO', async () => {
    const { stream } = streamFalso();
    conCamara(() => Promise.resolve(stream));
    await comp.abrir();
    fixture.detectChanges();

    expect(comp.estado()).toBe('viva');
    const html = fixture.nativeElement as HTMLElement;
    expect(html.querySelector('video')).toBeTruthy();
    expect(html.querySelector('.cv-live')?.textContent).toContain('EN VIVO');
  });

  it('al disparar entrega la foto con la hora, y suelta la cámara', async () => {
    const { stream, track } = streamFalso();
    conCamara(() => Promise.resolve(stream));
    await comp.abrir();
    fixture.detectChanges();

    const html = fixture.nativeElement as HTMLElement;
    const video = html.querySelector('video') as HTMLVideoElement;
    // jsdom no reproduce video: se le dice que ya hay un cuadro de 640×480.
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');

    const emitidas: { dataUrl: string; capturedAt: string }[] = [];
    comp.capturada.subscribe((e) => emitidas.push(e));

    comp.disparar();

    expect(emitidas).toHaveLength(1);
    expect(emitidas[0].dataUrl).toContain('data:image/jpeg');
    // La hora es la del disparo, en ISO: es lo que viaja como `captured_at` del archivo.
    expect(new Date(emitidas[0].capturedAt).toISOString()).toBe(emitidas[0].capturedAt);
    // Soltar la cámara no es cosmético: si no, el indicador del equipo queda encendido.
    expect(track.stop).toHaveBeenCalled();
    expect(comp.estado()).toBe('idle');
  });

  /** Sin cuadro todavía, `toDataURL` devolvería un rectángulo negro y nadie lo notaría. */
  it('no entrega nada si el video todavía no tiene cuadro', async () => {
    const { stream } = streamFalso();
    conCamara(() => Promise.resolve(stream));
    await comp.abrir();
    fixture.detectChanges();

    const video = (fixture.nativeElement as HTMLElement).querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'videoWidth', { value: 0, configurable: true });

    const emitidas: unknown[] = [];
    comp.capturada.subscribe((e) => emitidas.push(e));
    comp.disparar();

    expect(emitidas).toHaveLength(0);
    expect(comp.estado()).toBe('viva'); // sigue abierto: no se pierde lo que estaba encuadrando
  });

  /**
   * [GX.17] **«Pidiendo permiso…» era un callejon sin salida.**
   *
   * `getUserMedia` puede no resolver NUNCA: mientras el dialogo de permiso siga abierto la
   * promesa queda pendiente, y si nadie lo contesta -- o el navegador ni lo muestra, como
   * pasa en uno sin camara -- la pantalla se quedaba en ese mensaje **sin boton, sin error
   * y sin salida salvo recargar**. Medido con el navegador de las pruebas end-to-end.
   */
  describe('mientras pide permiso', () => {
    /** Una promesa que se resuelve cuando la prueba quiera: el dialogo de permiso abierto. */
    function pendiente() {
      let resolver: (s: MediaStream) => void = () => undefined;
      const promesa = new Promise<MediaStream>((r) => { resolver = r; });
      return { promesa, resolver: (s: MediaStream) => resolver(s) };
    }

    it('ofrece Cancelar, y cancelar devuelve al inicio', async () => {
      const { promesa } = pendiente();
      conCamara(() => promesa);
      void comp.abrir();
      await Promise.resolve();
      fixture.detectChanges();

      expect(comp.estado()).toBe('pidiendo');
      const html = fixture.nativeElement as HTMLElement;
      const cancelar = [...html.querySelectorAll('button')].find((b) => b.textContent?.includes('Cancelar'));
      expect(cancelar).toBeTruthy();

      cancelar?.click();
      fixture.detectChanges();
      expect(comp.estado()).toBe('idle');
    });

    it('si nadie contesta el permiso, lo declara en vez de colgarse', async () => {
      vi.useFakeTimers();
      try {
        const { promesa } = pendiente();
        conCamara(() => promesa);
        void comp.abrir();
        await Promise.resolve();
        expect(comp.estado()).toBe('pidiendo');

        vi.advanceTimersByTime(20_000);
        expect(comp.estado()).toBe('error');
        expect(comp.error()).toContain('no respondió');
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * ⭐ La carrera: la persona cancela y el permiso se concede DESPUES. Sin el numero de
     * apertura, ese stream tardio encendia la camara sola -- la luz del equipo prendida
     * sobre una pantalla que ya no muestra nada.
     */
    it('un permiso que llega DESPUES de cancelar no enciende la camara', async () => {
      const { promesa, resolver } = pendiente();
      const { stream, track } = streamFalso();
      conCamara(() => promesa);

      void comp.abrir();
      await Promise.resolve();
      comp.cerrar();
      expect(comp.estado()).toBe('idle');

      resolver(stream);
      await promesa;
      await Promise.resolve();
      fixture.detectChanges();

      expect(comp.estado()).toBe('idle');
      expect(track.stop).toHaveBeenCalled();
    });
  });

  it('cancelar suelta la cámara y vuelve al inicio', async () => {
    const { stream, track } = streamFalso();
    conCamara(() => Promise.resolve(stream));
    await comp.abrir();
    comp.cerrar();
    expect(track.stop).toHaveBeenCalled();
    expect(comp.estado()).toBe('idle');
  });

  it('destruir la pantalla suelta la cámara', async () => {
    const { stream, track } = streamFalso();
    conCamara(() => Promise.resolve(stream));
    await comp.abrir();
    fixture.destroy();
    expect(track.stop).toHaveBeenCalled();
  });
});
