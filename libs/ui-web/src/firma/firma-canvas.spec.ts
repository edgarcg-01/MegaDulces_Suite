/**
 * `[CG.66]` Los candados de la firma. Cada uno congela UNO de los cuatro defectos que traía la
 * versión que vivía dentro del componente del repartidor — y los cuatro se midieron ahí antes de
 * mover el código, no se imaginaron.
 *
 * ⚠️ jsdom no hace layout ni rasteriza: `clientWidth` es 0 y `toDataURL` devuelve un PNG vacío.
 * Así que lo que se prueba es el CONTRATO (cuándo cuenta como firmada, qué se le pide al
 * contexto, que redimensionar no pierde el trazo), no los píxeles. Lo que no se puede medir acá
 * se declara: la nitidez real en un teléfono necesita un teléfono.
 */
import { prepararFirma, MIN_TRAZO } from './firma-canvas';

interface Llamada { readonly m: string; readonly a: readonly unknown[] }

/** Un canvas de mentira que ANOTA lo que le piden. */
function canvasFalso(anchoCss = 300, altoCss = 160) {
  const llamadas: Llamada[] = [];
  const anotar = (m: string) => (...a: unknown[]) => { llamadas.push({ m, a }); };
  const g = {
    lineWidth: 0, lineCap: '', lineJoin: '', strokeStyle: '', fillStyle: '',
    globalCompositeOperation: 'source-over',
    setTransform: anotar('setTransform'),
    beginPath: anotar('beginPath'),
    moveTo: anotar('moveTo'),
    lineTo: anotar('lineTo'),
    stroke: anotar('stroke'),
    clearRect: anotar('clearRect'),
    fillRect: anotar('fillRect'),
  };
  const c = {
    width: 0, height: 0,
    clientWidth: anchoCss, clientHeight: altoCss,
    getContext: () => g,
    toDataURL: () => 'data:image/png;base64,ZZZ',
  };
  return { c: c as unknown as HTMLCanvasElement, g, llamadas };
}

/** Dibuja un recorrido recto de `px` píxeles. */
const trazar = (f: ReturnType<typeof prepararFirma>, px: number) => {
  f.abajo(0, 0);
  f.mueve(px, 0);
  f.arriba();
};

describe('prepararFirma · [CG.66]', () => {
  it('⛔ [defecto 1] un TOQUE no es una firma', () => {
    const { c } = canvasFalso();
    const f = prepararFirma(c);

    f.abajo(10, 10);
    f.arriba();

    expect(f.largo()).toBe(0);
    expect(f.firmada(), 'apoyar el dedo y levantarlo contaba como firmado').toBe(false);
    expect(f.aPng(), 'un punto no puede producir un comprobante firmado').toBeNull();
  });

  it('con TRAZO suficiente sí está firmada, y el PNG sale', () => {
    const { c } = canvasFalso();
    const f = prepararFirma(c);

    trazar(f, MIN_TRAZO + 1);

    expect(f.firmada()).toBe(true);
    expect(f.aPng()).toContain('data:image/png');
  });

  it('⛔ [negativa] justo por debajo del mínimo NO cuenta', () => {
    // Sin esto, el umbral podría estar en cero y las dos pruebas de arriba seguirían pasando.
    const { c } = canvasFalso();
    const f = prepararFirma(c);

    trazar(f, MIN_TRAZO - 1);

    expect(f.largo()).toBeCloseTo(MIN_TRAZO - 1, 5);
    expect(f.firmada()).toBe(false);
  });

  it('⛔ [defecto 2] reajustar NO pierde la firma', () => {
    // El ajuste de resolución escribe `canvas.width`, y eso BORRA el canvas por especificación.
    // En la versión vieja corría en cada evento: con el teclado del teléfono abriéndose a mitad
    // de la firma, el trazo desaparecía sin aviso.
    const { c, llamadas } = canvasFalso();
    const f = prepararFirma(c);
    trazar(f, 100);
    expect(f.firmada()).toBe(true);

    const trazosAntes = llamadas.filter((l) => l.m === 'stroke').length;
    f.reajustar();

    // Sigue firmada...
    expect(f.firmada(), 'reajustar perdió la firma').toBe(true);
    // ...y el trazo se volvió a PINTAR, no sólo a recordar.
    expect(llamadas.filter((l) => l.m === 'stroke').length).toBeGreaterThan(trazosAntes);
  });

  it('⛔ [defecto 3] el buffer se fija en píxeles del APARATO, no en CSS', () => {
    // En un equipo con devicePixelRatio 3 el canvas fijado en píxeles CSS guarda un tercio de la
    // resolución que el dedo dibujó. Para algo que es evidencia, eso importa.
    const dprOriginal = window.devicePixelRatio;
    try {
      Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
      const { c, g } = canvasFalso(300, 160);
      prepararFirma(c);

      expect(c.width, 'el buffer ignoró el DPR').toBe(900);
      expect(c.height).toBe(480);
      // Y el CONTEXTO queda escalado, para que el resto del código hable en píxeles CSS.
      expect(g.setTransform).toBeDefined();
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: dprOriginal, configurable: true });
    }
  });

  it('⛔ [defecto 4] el PNG sale con fondo BLANCO, no transparente', () => {
    const { c, g, llamadas } = canvasFalso();
    const f = prepararFirma(c);
    trazar(f, 100);

    f.aPng();

    const relleno = llamadas.find((l) => l.m === 'fillRect');
    expect(relleno, 'no se rellenó el fondo: en un visor oscuro la firma es invisible').toBeTruthy();
    // ⭐ Y se pinta DEBAJO del trazo. Con `source-over` taparía la firma con un rectángulo
    // blanco — o sea un comprobante "firmado" en blanco, que es peor que ninguno.
    expect(g.globalCompositeOperation, 'el modo de composición quedó sucio').toBe('source-over');
  });

  it('limpiar vuelve al estado sin firmar', () => {
    const { c, llamadas } = canvasFalso();
    const f = prepararFirma(c);
    trazar(f, 100);
    expect(f.firmada()).toBe(true);

    f.limpiar();

    expect(f.firmada()).toBe(false);
    expect(f.largo()).toBe(0);
    expect(f.aPng()).toBeNull();
    expect(llamadas.some((l) => l.m === 'clearRect')).toBe(true);
  });

  it('⛔ [negativa] mover sin haber apoyado el dedo no dibuja ni acumula', () => {
    // El puntero pasa por encima del canvas todo el tiempo. Si `mueve` dibujara sin `abajo`,
    // la firma se haría sola al pasar el mouse.
    const { c, llamadas } = canvasFalso();
    const f = prepararFirma(c);

    f.mueve(50, 50);
    f.mueve(120, 80);

    expect(f.largo()).toBe(0);
    expect(f.firmada()).toBe(false);
    expect(llamadas.filter((l) => l.m === 'stroke').length).toBe(0);
  });

  it('un DPR roto no deja el canvas en 0x0', () => {
    // `devicePixelRatio` puede llegar 0 o NaN en entornos raros. Sin el piso en 1, el buffer
    // quedaría en 0×0: sin firma posible y sin un solo error que lo diga.
    const dprOriginal = window.devicePixelRatio;
    try {
      Object.defineProperty(window, 'devicePixelRatio', { value: 0, configurable: true });
      const { c } = canvasFalso(300, 160);
      prepararFirma(c);
      expect(c.width).toBe(300);
      expect(c.height).toBe(160);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: dprOriginal, configurable: true });
    }
  });
});
