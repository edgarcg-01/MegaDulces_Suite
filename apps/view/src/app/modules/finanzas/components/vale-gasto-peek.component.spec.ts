import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { ValeGastoPeekComponent, notaAdicional, type AprobacionVale } from './vale-gasto-peek.component';
import type { ValeGasto } from '../comprobaciones.service';
import type { ComprobacionEnLaCola } from '@megadulces/contracts';

/**
 * `[GX.27]` Candado del **visor del vale**, el panel que comparten Aprobación y el Historial.
 *
 * Es donde alguien mira un gasto **antes de autorizarlo**, así que lo que cuida es que no
 * afirme cosas que no sabe: que un archivo que no carga no se lea como «no hay archivos», que
 * un dato que el endpoint no mandó no se pinte como un guion, y que los botones salgan de lo
 * que la página permite y no de lo que el visor supone.
 */

const V = (over: Partial<ValeGasto> = {}): ValeGasto => ({
  id: 'v1',
  folio_solicitud: '0009678',
  sucursal: '00',
  fecha_gasto: '2026-09-25',
  created_at: '2026-09-25',
  created_hora: '09:41',
  importe: 1234.5,
  departamento: 'LOGISTICA',
  solicitante: 'LEONARDO CAZARES',
  concepto: 'Casetas ruta norte',
  proveedor: 'CAPUFE',
  clasificacion: 'fiscal',
  forma_pago: 'efectivo',
  forma_pago_detalle: 'caja chica',
  comentarios: null,
  created_by: 'maria.tesoreria',
  status: 'recibida',
  motivo_rechazo: null,
  revision_nota: null,
  validated_by: null,
  requiere_evidencia: true,
  tiene_evidencia: false,
  evidencia_en_vivo: true,
  files: [{ role: 'comprobante_1', url: 'https://ejemplo/x.jpg', kind: 'image' }],
  ...over,
});

describe('ValeGastoPeekComponent', () => {
  let fix: ComponentFixture<ValeGastoPeekComponent>;
  let c: ValeGastoPeekComponent;

  const montar = (vale: ValeGasto | null = V(), acciones: readonly string[] = []) => {
    fix = TestBed.createComponent(ValeGastoPeekComponent);
    c = fix.componentInstance;
    fix.componentRef.setInput('vale', vale);
    fix.componentRef.setInput('acciones', acciones);
    fix.componentRef.setInput('open', true);
    fix.detectChanges();
  };

  beforeAll(() => registerLocaleData(localeEsMx));

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ValeGastoPeekComponent],
      providers: [{ provide: LOCALE_ID, useValue: 'es-MX' }],
    });
  });

  it('monta y muestra el vale completo', () => {
    montar();
    const txt = fix.nativeElement.textContent as string;
    expect(txt).toContain('$1,234.50');
    expect(txt).toContain('0009678');
    expect(txt).toContain('CAPUFE');
    expect(txt).toContain('Casetas ruta norte');
  });

  describe('los documentos', () => {
    it('un PDF se sanitiza una sola vez; una imagen no se sanitiza', () => {
      montar(V({ files: [
        { role: 'comprobante_1', url: 'https://ejemplo/t.jpg', kind: 'image' },
        { role: 'evidencia_1', url: 'https://ejemplo/f.pdf', kind: 'pdf' },
      ] }));
      const docs = c.docs();
      expect(docs.map((d) => d.label)).toEqual(['Comprobante — hoja 1', 'Evidencia 1']);
      expect(docs[0].isPdf).toBe(false);
      expect(docs[0].safeUrl).toBeNull();
      expect(docs[1].isPdf).toBe(true);
      expect(docs[1].safeUrl).not.toBeNull();
      // ⚠️ La MISMA referencia entre lecturas: si cambiara, el iframe se recrearía en cada
      // ciclo de detección y el PDF se recargaría solo, sin parar.
      expect(c.docs()[1].safeUrl).toBe(docs[1].safeUrl);
    });

    it('un PDF se reconoce por la extensión aunque no venga el `kind`', () => {
      montar(V({ files: [{ role: 'evidencia_1', url: 'https://ejemplo/f.pdf?firma=abc' }] }));
      expect(c.docs()[0].isPdf).toBe(true);
    });

    /** ⭐ Un archivo que no carga NO es un vale sin archivos: son dos cosas distintas. */
    it('«no se pudo mostrar» se dice aparte de «no hay archivos»', () => {
      montar();
      c.fallo('https://ejemplo/x.jpg');
      fix.detectChanges();
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('No se pudo mostrar el archivo');
      expect(txt).not.toContain('no trae ningún archivo');
    });

    it('un vale sin archivos lo dice con todas las letras', () => {
      montar(V({ files: [] }));
      expect(c.docs()).toEqual([]);
      expect(fix.nativeElement.textContent).toContain('no trae ningún archivo');
    });
  });

  describe('lo que el visor no puede inventar', () => {
    /**
     * ⭐ `created_hora` y `concepto` llegan `undefined` desde los endpoints que no los
     * seleccionan. Un guion afirmaría que el expediente no los tiene — y eso sería falso.
     */
    it('lo que el endpoint no mandó se omite, no se pinta como guion', () => {
      montar(V({ created_hora: undefined, concepto: undefined }));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('maria.tesoreria');       // sí muestra lo que sí vino
      expect(txt).not.toContain('Casetas ruta norte');
    });

    /**
     * ⭐ Medido en pantalla: el visor decía «sin clasificar» en un vale que SÍ estaba
     * clasificado, porque el endpoint del Historial no seleccionaba la columna. Afirmar que
     * un gasto no tiene tipo es peor que no decir nada — y las dos ausencias se ven igual si
     * no se distinguen.
     */
    it('«no vino el dato» no se afirma como «no hay dato»', () => {
      montar(V({ clasificacion: undefined, forma_pago: undefined, forma_pago_detalle: undefined }));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).not.toContain('sin clasificar');
      expect(txt).not.toContain('sin forma de pago');
    });

    /** Pero si el dato SÍ vino y está vacío, eso sí se dice: es un hueco real del expediente. */
    it('un dato que vino vacío sí se declara', () => {
      montar(V({ clasificacion: null, forma_pago: null }));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('sin clasificar');
      expect(txt).toContain('sin forma de pago');
    });

    it('la fecha no se corre de día', () => {
      // `new Date('2026-09-25')` es medianoche UTC: en México sería «24 sep».
      montar(V({ fecha_gasto: '2026-09-25', created_at: '2026-09-25' }));
      expect(c.diaLocal('2026-09-25')?.getDate()).toBe(25);
      expect(c.diaLocal('2026-09-25')?.getMonth()).toBe(8);
    });

    it('lo que no es una fecha devuelve null en vez de una fecha inventada', () => {
      montar();
      for (const v of ['', 'hoy', '25/09/2026', 'Thu Sep 24', null]) expect(c.diaLocal(v)).toBeNull();
    });

    it('el estado y el tipo se dicen en palabras, no con la clave cruda', () => {
      montar(V({ status: 'no_existe_este_estado', clasificacion: 'no_fiscal_comprobable' }));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('Sólo ticket o recibo');
      // Un estado que no conocemos se muestra tal cual: inventarle un nombre sería peor.
      expect(txt).toContain('no_existe_este_estado');
    });
  });

  describe('las acciones las decide la página, no el visor', () => {
    it('sin acciones es de sólo lectura', () => {
      montar(V(), []);
      expect(fix.nativeElement.querySelectorAll('.vp-act button').length).toBe(0);
      expect(fix.nativeElement.textContent).toContain('no hay nada que decidir');
    });

    /**
     * `[GX.58]` El botón dice **«Revisado»** desde el 2026-10-01 (pedido del usuario).
     *
     * ⚠️ Cambió la PALABRA, no la acción: sigue emitiendo `aprobar` y el vale sigue
     * quedando en estado `aprobada`. Esta prueba fija el texto; las de más abajo fijan que
     * el botón siga haciendo lo mismo.
     */
    it('con «aprobar» ofrece Revisado y Rechazar', () => {
      montar(V(), ['aprobar', 'rechazar']);
      const botones = [...fix.nativeElement.querySelectorAll('.vp-act button')]
        .map((b: Element) => b.textContent?.trim());
      // [PGP.122.9] La firma repite la cifra: no se firma «a ciegas» un vale abierto por error.
      expect(botones).toEqual(['Rechazar', 'Revisado · $1,234.50']);
    });

    /** ⛔ Y la palabra vieja no puede quedar en ningún botón: serían dos nombres para lo mismo. */
    it('[GX.58] ningún botón dice ya «Aprobar»', () => {
      montar(V(), ['aprobar', 'rechazar']);
      const botones = [...fix.nativeElement.querySelectorAll('.vp-act button')]
        .map((b: Element) => b.textContent?.trim() || '');
      expect(botones.some((t) => t.startsWith('Aprobar'))).toBe(false);
    });

    it('con «comprobar» ofrece Dar por comprobado', () => {
      montar(V({ status: 'aprobada' }), ['comprobar', 'rechazar']);
      const botones = [...fix.nativeElement.querySelectorAll('.vp-act button')]
        .map((b: Element) => b.textContent?.trim());
      expect(botones).toEqual(['Rechazar', 'Dar por comprobado']);
    });

    /** El visor NO resuelve: avisa. Quien llama al servidor es la página. */
    it('el botón emite el vale, no hace nada por su cuenta', () => {
      montar(V(), ['aprobar', 'rechazar']);
      const emitidos: AprobacionVale[] = [];
      c.aprobar.subscribe((a) => emitidos.push(a));
      const btn = [...fix.nativeElement.querySelectorAll('.vp-act button')]
        .find((b: Element) => (b.textContent?.trim() ?? '').startsWith('Revisado ·')) as HTMLButtonElement;
      btn.click();
      expect(emitidos).toHaveLength(1);
      expect(emitidos[0].vale.id).toBe('v1');
      // Sin marcar nada, la aprobación es la de siempre.
      expect(emitidos[0].provisional).toBe(false);
      expect(emitidos[0].comprobante_esperado_at).toBeNull();
    });

    /**
     * `[GX.30]` **La marca provisional.** Quien firma dice que lo que está viendo es una
     * prefactura o una cotización, no el comprobante definitivo.
     */
    describe('la marca provisional', () => {
      const marcar = () => {
        const chk = fix.nativeElement.querySelector('.vp-prov-chk input') as HTMLInputElement;
        chk.checked = true;
        chk.dispatchEvent(new Event('change'));
        fix.detectChanges();
      };

      it('sólo se ofrece cuando se puede aprobar', () => {
        montar(V({ status: 'aprobada' }), ['comprobar', 'rechazar']);
        expect(fix.nativeElement.querySelector('.vp-prov-chk')).toBeNull();
        montar(V(), ['aprobar', 'rechazar']);
        expect(fix.nativeElement.querySelector('.vp-prov-chk')).not.toBeNull();
      });

      /**
       * ⭐ `[GX.51]` **Ya NO hay fecha límite.** Se retiró por pedido del usuario: la factura
       * del pago llega cuando llega y no depende de nadie de la casa, así que ponerle
       * vencimiento era inventar un plazo que nadie podía cumplir ni hacer cumplir.
       *
       * En su lugar, al marcar aparece la nota de que **queda abierto**. La marca sigue: lo
       * que se quita es el plazo, no la deuda.
       */
      it('[GX.51] al marcar dice que queda abierto, y NO pide fecha', () => {
        montar(V(), ['aprobar', 'rechazar']);
        expect(fix.nativeElement.querySelector('.vp-prov-libre')).toBeNull();
        marcar();
        expect(fix.nativeElement.querySelector('#vp-esperado')).toBeNull();
        const nota = fix.nativeElement.querySelector('.vp-prov-libre') as HTMLElement;
        expect(nota).not.toBeNull();
        expect(nota.textContent).toMatch(/sin fecha l[ií]mite/i);
      });

      /** ⛔ Y el texto del default de 15 días se fue con ella: ya no hay tal cosa. */
      it('[GX.51] no queda rastro de los 15 días', () => {
        montar(V(), ['aprobar', 'rechazar']);
        marcar();
        expect(fix.nativeElement.textContent).not.toContain('15 días');
      });

      it('marcada, el botón lo dice y la marca viaja', () => {
        montar(V(), ['aprobar', 'rechazar']);
        marcar();
        const emitidos: AprobacionVale[] = [];
        c.aprobar.subscribe((a) => emitidos.push(a));
        const btn = [...fix.nativeElement.querySelectorAll('.vp-act button')]
          .find((b: Element) => (b.textContent?.trim() ?? '').startsWith('Revisado como provisional ·')) as HTMLButtonElement;
        expect(btn).toBeTruthy();
        btn.click();
        expect(emitidos[0].provisional).toBe(true);
      });

      /**
       * ⛔ `[GX.51]` **Nunca viaja una fecha**, ni aunque el signal traiga algo de antes. El
       * campo se conserva en el contrato porque hay expedientes viejos que la tienen y
       * borrarlo del tipo los volvería ilegibles — pero ya no se manda.
       */
      it('[GX.51] la aprobación provisional viaja SIN fecha', () => {
        montar(V(), ['aprobar', 'rechazar']);
        marcar();
        c.esperado.set('2026-10-15');   // residuo: aunque esté, no debe viajar
        const emitidos: AprobacionVale[] = [];
        c.aprobar.subscribe((a) => emitidos.push(a));
        c.emitirAprobacion(c.vale()!);
        expect(emitidos[0].provisional).toBe(true);
        expect(emitidos[0].comprobante_esperado_at).toBeNull();
      });

      /**
       * ⭐ La prueba que sostiene la regla: **la marca no se pega de un vale al otro.**
       * Quien aprueba uno con prefactura y abre el de al lado se lo encontraría tildado,
       * y firmaría una deuda documental que nunca declaró.
       */
      it('al abrir otro vale, la marca se limpia', () => {
        montar(V(), ['aprobar', 'rechazar']);
        marcar();
        c.esperado.set('2026-10-15');
        expect(c.provisional()).toBe(true);
        fix.componentRef.setInput('vale', V({ id: 'v2' }));
        fix.detectChanges();
        expect(c.provisional()).toBe(false);
        expect(c.esperado()).toBe('');
      });
    });

    /**
     * `[GX.29]` El capturista no reabre su vale: **pide** que se lo reabran, y decide
     * quien lo aprobó. Por eso acá no hay ni «Rechazar» ni «Aprobar».
     */
    it('con «pedir_reapertura» ofrece sólo ese botón', () => {
      montar(V({ status: 'validada' }), ['pedir_reapertura']);
      const botones = [...fix.nativeElement.querySelectorAll('.vp-act button')]
        .map((b: Element) => b.textContent?.trim());
      expect(botones).toEqual(['Pedir que lo reabran']);
      const emitidos: ValeGasto[] = [];
      c.pedirReapertura.subscribe((v) => emitidos.push(v));
      (fix.nativeElement.querySelector('.vp-act button') as HTMLButtonElement).click();
      expect(emitidos).toHaveLength(1);
      expect(emitidos[0].id).toBe('v1');
    });

    it('mientras la página resuelve, los botones se bloquean', () => {
      montar(V(), ['aprobar', 'rechazar']);
      fix.componentRef.setInput('ocupado', true);
      fix.detectChanges();
      const rechazar = [...fix.nativeElement.querySelectorAll('.vp-act button')]
        .find((b: Element) => b.textContent?.trim() === 'Rechazar') as HTMLButtonElement;
      expect(rechazar.disabled).toBe(true);
    });
  });

  it('sin vale no pinta nada', () => {
    montar(null);
    expect(c.docs()).toEqual([]);
    expect(fix.nativeElement.querySelector('.vp')).toBeNull();
  });

  /**
   * `[GX.48]` — **La constancia de autorización de Kepler, dentro del expediente.**
   *
   * Pedido del usuario: que al autorizarse en Kepler, esa autorización quede pegada al vale.
   *
   * ⛔ **Kepler no genera ningún documento al autorizar.** Se midió de cinco formas (las 200
   * columnas de `kdm1` comparando `N` contra `A`/`F`, `kdm2`, las columnas binarias de las 241
   * tablas del ODS, `kdlogmov`, y los 16 doctypes del género X): lo único que cambia es `c43`,
   * de `N` a `A`. Una letra. Así que la constancia se **genera** con lo que Kepler sí tiene.
   *
   * Lo que estas pruebas vigilan es que esa constancia **no afirme de más**: que aparezca sólo
   * cuando hay autorización, que diga lo que Kepler no registra, y que un endpoint que no la
   * manda no se lea como «este vale no está autorizado».
   */
  describe('[GX.48] la constancia de autorización', () => {
    const AUT = (over: Record<string, unknown> = {}) => ({
      documento: 'XA1501-0009008',
      autorizado: 'A',
      autorizado_label: 'Autorizado',
      monto: 224.4,
      fecha_documento: '2026-09-04',
      destinatario: 'BBVA MEXICO SA',
      concepto: 'COMISION',
      area_autoriza: 'FINANZAS',
      no_consta: ['La fecha y hora en que se autorizó', 'Quién la autorizó (sólo queda el área)'],
      ...over,
    });

    it('muestra la fila que se ve en «Autorización de Sol Gasto»', () => {
      montar(V({ autorizacion_kepler: AUT() } as Partial<ValeGasto>));
      const bloque = fix.nativeElement.querySelector('.vp-aut') as HTMLElement;
      expect(bloque).toBeTruthy();
      const txt = bloque.textContent || '';
      expect(txt).toContain('XA1501-0009008');
      expect(txt).toContain('Autorizado');
      expect(txt).toContain('BBVA MEXICO SA');
      expect(txt).toContain('FINANZAS');
    });

    /**
     * ⭐ **La prueba que sostiene el bloque.** Kepler no guarda ni cuándo ni quién autorizó.
     * Una constancia que los omitiera en silencio se leería como completa, y alguien podría
     * citarla como prueba de algo que la base no respalda.
     */
    it('DECLARA lo que Kepler no registra', () => {
      montar(V({ autorizacion_kepler: AUT() } as Partial<ValeGasto>));
      const falta = fix.nativeElement.querySelector('.vp-aut-falta') as HTMLElement;
      expect(falta).toBeTruthy();
      expect(falta.textContent).toContain('Kepler no registra');
      expect(falta.textContent).toMatch(/fecha/i);
      expect(falta.textContent).toMatch(/qui[eé]n/i);
    });

    /** ⛔ Sin autorización no hay bloque: uno vacío se lee como que sí la hubo. */
    it('no aparece cuando el vale no está autorizado', () => {
      montar(V({ autorizacion_kepler: null } as Partial<ValeGasto>));
      expect(fix.nativeElement.querySelector('.vp-aut')).toBeNull();
      expect(fix.nativeElement.textContent).not.toContain('Autorización de gasto');
    });

    /**
     * ⚠️ `undefined` = «este endpoint no la manda» (la bandeja de Aprobación arma el vale con
     * otras columnas). No es lo mismo que `null` = «no está autorizado» — pero para la
     * pantalla el resultado es el mismo: no se inventa un bloque.
     */
    it('un endpoint que no la manda tampoco la pinta', () => {
      montar(V());
      expect(fix.nativeElement.querySelector('.vp-aut')).toBeNull();
    });

    /** Va ANTES de la evidencia: primero por qué se pudo gastar, después en qué. */
    it('se muestra antes del bloque de evidencia', () => {
      montar(V({ autorizacion_kepler: AUT() } as Partial<ValeGasto>));
      const h = [...fix.nativeElement.querySelectorAll('.vp-h')].map((e) => (e as HTMLElement).textContent || '');
      const iAut = h.findIndex((x) => x.includes('Autorización de gasto'));
      const iEv = h.findIndex((x) => x.includes('Evidencia'));
      expect(iAut).toBeGreaterThanOrEqual(0);
      expect(iEv).toBeGreaterThanOrEqual(0);
      expect(iAut).toBeLessThan(iEv);
    });

    /** Lo que Kepler puede traer vacío se dice, no se deja en blanco. */
    it('los campos vacíos se declaran, no quedan mudos', () => {
      montar(V({
        autorizacion_kepler: AUT({ destinatario: null, concepto: null, area_autoriza: null, fecha_documento: null }),
      } as Partial<ValeGasto>));
      const txt = (fix.nativeElement.querySelector('.vp-aut') as HTMLElement).textContent || '';
      expect(txt).toContain('no declarado');
      expect(txt).toContain('no declarada');
    });

    /** La `F` dice además que el dinero salió: es otra cosa que estar sólo autorizado. */
    it('la F se lee como autorizado Y aplicado', () => {
      montar(V({
        autorizacion_kepler: AUT({ autorizado: 'F', autorizado_label: 'Autorizado y aplicado — el dinero salió' }),
      } as Partial<ValeGasto>));
      expect((fix.nativeElement.querySelector('.vp-aut') as HTMLElement).textContent).toContain('dinero salió');
    });
  });

  /**
   * `[GX.87]` **Agregar evidencia** con su porqué. No es una decisión: el botón vive junto a
   * «Evidencia», no en el pie, y su presencia no puede encender el pie de decisión.
   */
  describe('[GX.87] agregar evidencia', () => {
    const botonAgregar = () => [...fix.nativeElement.querySelectorAll('.vp-h-row button')]
      .find((b: Element) => b.textContent?.includes('Agregar evidencia')) as HTMLButtonElement | undefined;

    it('se ofrece cuando la página lo permite, y emite el vale', () => {
      montar(V({ status: 'validada' }), ['agregar_evidencia']);
      const emitidos: ValeGasto[] = [];
      c.agregarEvidencia.subscribe((v) => emitidos.push(v));
      botonAgregar()!.click();
      expect(emitidos.map((v) => v.id)).toEqual(['v1']);
    });

    it('⛔ sola, NO enciende el pie de decisión con un «Rechazar» que nadie ofreció', () => {
      montar(V({ status: 'validada' }), ['agregar_evidencia']);
      expect(fix.nativeElement.querySelectorAll('.vp-act button').length).toBe(0);
      expect(fix.nativeElement.textContent).toContain('no hay nada que decidir');
    });

    it('junto a las decisiones, el pie sigue igual', () => {
      montar(V(), ['aprobar', 'rechazar', 'agregar_evidencia']);
      const pie = [...fix.nativeElement.querySelectorAll('.vp-act button')].map((b: Element) => b.textContent?.trim());
      expect(pie).toEqual(['Rechazar', 'Revisado · $1,234.50']);
      expect(botonAgregar()).toBeTruthy();
    });

    it('sin la acción no aparece, y en un rechazado tampoco aunque la página la mande', () => {
      montar(V({ status: 'validada' }), []);
      expect(botonAgregar()).toBeUndefined();
      montar(V({ status: 'rechazada' }), ['agregar_evidencia']);
      expect(botonAgregar()).toBeUndefined();
    });

    it('la evidencia adicional se rotula y dice su porqué, quién y cuándo', () => {
      montar(V({ files: [
        { role: 'comprobante_1', url: 'https://ejemplo/x.jpg', kind: 'image' },
        { role: 'adicional', url: 'https://ejemplo/f.pdf', kind: 'pdf', motivo: 'Llegó la factura',
          agregado_por: 'NOMBRE APELLIDO', agregado_at: '2026-10-29T18:05:00.000Z' },
      ] }));
      const [comp, adic] = c.docs();
      expect(comp.nota).toBeNull();
      expect(adic.label).toBe('Evidencia adicional');
      expect(adic.nota).toContain('«Llegó la factura»');
      expect(adic.nota).toContain('NOMBRE APELLIDO');
      expect(adic.nota).toContain('29/10/26'); // hora de México
      expect(fix.nativeElement.querySelector('.vp-doc-nota')?.textContent).toContain('Llegó la factura');
    });

    it('lo que no vino se omite, sin separadores sueltos', () => {
      expect(notaAdicional({ role: 'adicional', url: 'x', motivo: 'Factura' })).toBe('«Factura»');
      expect(notaAdicional({ role: 'adicional', url: 'x', agregado_at: 'no-es-fecha' })).toBe('');
    });

    it('mientras la página resuelve, también se bloquea', () => {
      montar(V({ status: 'validada' }), ['agregar_evidencia']);
      fix.componentRef.setInput('ocupado', true);
      fix.detectChanges();
      expect(botonAgregar()!.disabled).toBe(true);
    });
  });

  /**
   * `[GX.99]` La evidencia se ve ENTERA en el panel, sin scroll, y tocarla abre el visor grande
   * (pedido del usuario, 2026-11-06).
   */
  describe('[GX.99] la evidencia en el panel', () => {
    it('cada archivo es un botón que abre el visor grande en ESE archivo', () => {
      montar(V({ files: [
        { role: 'comprobante_1', url: 'https://ejemplo/1.jpg', kind: 'image' },
        { role: 'cotizacion', url: 'https://ejemplo/2.pdf', kind: 'pdf' },
      ] } as Partial<ValeGasto>));
      const botones = fix.nativeElement.querySelectorAll('button.vp-mini') as NodeListOf<HTMLButtonElement>;
      expect(botones.length).toBe(2);
      botones[1].click();
      fix.detectChanges();
      expect(c.visorAbierto()).toBe(true);
      expect(c.visorIndice()).toBe(1);
    });

    it('el PDF se muestra con su página entera, sin barras (y sólo se sanitiza una vez)', () => {
      montar(V({ files: [{ role: 'cotizacion', url: 'https://ejemplo/f.pdf?firma=1', kind: 'pdf' }] } as Partial<ValeGasto>));
      const d = c.docs()[0];
      expect(String((d.safeUrlVista as { changingThisBreaksApplicationSecurity?: string })?.changingThisBreaksApplicationSecurity))
        .toBe('https://ejemplo/f.pdf?firma=1#view=Fit&toolbar=0&navpanes=0&scrollbar=0');
      expect(c.docs()[0]).toBe(d);
    });

    it('al cambiar de vale, el visor grande se cierra (era del vale anterior)', () => {
      montar();
      c.verEvidencia(0);
      fix.componentRef.setInput('vale', V({ id: 'otro' }));
      fix.detectChanges();
      expect(c.visorAbierto()).toBe(false);
    });
  });

  /** `[GX.98]` El departamento es el de Kepler; el capturado decía «Sucursal NN» en todos los vales. */
  describe('[GX.98] el departamento del vale', () => {
    const texto = () => fix.nativeElement.textContent as string;
    it('uno solo: su nombre', () => {
      montar(V({ departamento: 'Sucursal 00', departamentos: [{ clave: 'A', nombre: 'MORELIA ABASTOS', importe: 1234.5 }] }));
      expect(texto()).toContain('MORELIA ABASTOS');
      expect(texto()).not.toContain('Sucursal 00');
    });

    it('repartido: cada uno con su parte', () => {
      montar(V({ departamentos: [{ clave: 'A', nombre: 'MORELIA ABASTOS', importe: 750 }, { clave: 'B', nombre: 'CANINDO', importe: 484.5 }] }));
      expect(texto()).toContain('Departamentos');
      expect(texto()).toContain('CANINDO');
      expect(texto()).toContain('$484.50');
      expect(c.subtituloPeek()).toContain('MORELIA ABASTOS y 1 más');
    });

    it('⛔ sin departamento en Kepler y sin leer se dicen distinto', () => {
      montar(V({ departamentos: [] }));
      expect(texto()).toContain('sin departamento en Kepler');
      fix.componentRef.setInput('vale', V({ departamentos: null }));
      fix.detectChanges();
      expect(texto()).toContain('sin leer en Kepler');
    });

    /**
     * `[PGP.122.12]` La solicitud nacida en la Suite, ANTES de firmar (sin folio): quien firma veía «aún no está en
     * Kepler» en vez del departamento (observación de usuario, 01/0000223, 2026-11-21). El servidor ya manda el de sus
     * renglones; la pantalla lo muestra y dice que todavía no está en Kepler.
     */
    it('[PGP.122.12] sin folio: el departamento que eligió quien la pidió, y que todavía no está en Kepler', () => {
      montar(V({ folio_solicitud: '', departamentos: [{ clave: '1-01-10-00', nombre: 'PADRE HIDALGO PISO', importe: 200 }] }));
      expect(texto()).toContain('PADRE HIDALGO PISO');
      expect(texto()).toContain('Lo eligió quien la pidió; se escribe en Kepler al firmarse');
      expect(texto()).not.toContain('aún no está en Kepler (se escribe al firmarse)');
      expect(c.subtituloPeek()).toContain('PADRE HIDALGO PISO');
    });

    it('[PGP.122.12] con folio (ya en Kepler) no se dice nada de eso: el departamento ya es el de Kepler', () => {
      montar(V({ folio_solicitud: '0000223', departamentos: [{ clave: '1-01-10-00', nombre: 'PADRE HIDALGO PISO', importe: 200 }] }));
      expect(texto()).toContain('PADRE HIDALGO PISO');
      expect(texto()).not.toContain('se escribe en Kepler al firmarse');
    });
  });

  /**
   * `[PGP.123]` G.UI.5 — El eslabón del gasto (X-A-10). Antes la cadena se cortaba en «Solicitud · Kepler: autorizada»
   * y remataba «no hay nada que decidir», aunque el gasto seguía pendiente.
   */
  describe('[PGP.123] G.UI.5 el gasto en Kepler', () => {
    const texto = () => fix.nativeElement.textContent as string;
    const CERRADA = { abierta: false, motivo: 'La escritura de gastos a Kepler todavía está apagada en esta base', detalle: 'interruptor' };
    const ABIERTA = { abierta: true, motivo: null, detalle: null };
    const GASTO = { id: 'v1', status: null, folio: null, poliza: null, fecha: null, nota: null, intentos: 0, siguiente: null };
    const conGasto = (g: ComprobacionEnLaCola | null | undefined, puede = false) => {
      montar(V({ status: 'validada' }));
      fix.componentRef.setInput('gastoKepler', g);
      fix.componentRef.setInput('puedeReintentarGasto', puede);
      fix.detectChanges();
    };
    const boton = () => [...fix.nativeElement.querySelectorAll('button')].find((b: Element) => /^\s*Generar (gasto|otra vez) · /.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

    it('sin el dato (el vale no espera su gasto) el eslabón no se pinta', () => {
      conGasto(undefined);
      expect(texto()).not.toContain('Gasto en Kepler (X-A-10)');
    });

    it('⛔ esperando, pero sin calcular: lo dice; no se calla ni dice «nada que decidir» a secas', () => {
      conGasto(null);
      expect(texto()).toContain('Gasto en Kepler (X-A-10)');
      expect(texto()).toContain('No se pudo calcular si se comprueba sola: revísalo en Kepler');
    });

    it('escrito por la Suite: folio, póliza como se busca en Kepler y fecha del gasto', () => {
      conGasto({ comprobacion: { listo: true, fecha: '2026-11-10' }, escritura: ABIERTA,
        gasto: { ...GASTO, status: 'written', folio: '0000123', poliza: 'kdc22611/D/4', fecha: '2026-11-10' } }, true);
      expect(texto()).toContain('Escrito por la Suite: X-A-10 0000123 · póliza D 4 (nov 2026)');
      expect(texto()).toContain('Fecha del gasto en Kepler: 10/11/26');
      expect(boton()).toBeUndefined();
    });

    it('con motivo: el motivo y a quién le toca, sin botón', () => {
      conGasto({ comprobacion: { listo: false, motivo: 'total_distinto', quien: 'sucursal', texto: 'El vale es por $347.59 y la solicitud por $518.00: se comprueba en Kepler' },
        escritura: CERRADA, gasto: null }, true);
      expect(texto()).toContain('El vale es por $347.59 y la solicitud por $518.00: se comprueba en Kepler');
      expect(texto()).toContain('Le toca a la sucursal, en Kepler.');
      expect(boton()).toBeUndefined();
    });

    it('G.14: listo en una base que escribe: «Generar gasto · $importe»; atorado: «Generar otra vez»; sólo si la página lo ofrece', () => {
      conGasto({ comprobacion: { listo: true, fecha: '2026-11-10' }, escritura: ABIERTA, gasto: null }, true);
      const emitido: string[] = [];
      c.reintentarGasto.subscribe((id) => emitido.push(id));
      expect(boton()?.textContent).toMatch(/Generar gasto · \$[\d,]+\.\d{2}/);
      boton()!.click();
      expect(emitido).toEqual(['v1']);
      fix.componentRef.setInput('gastoKepler', { comprobacion: { listo: true, fecha: '2026-11-10' }, escritura: ABIERTA,
        gasto: { ...GASTO, status: 'stuck', nota: 'Kepler no contestó (3 intentos: lo reintenta una persona)' } });
      fix.detectChanges();
      expect(texto()).toContain('No se pudo escribir: Kepler no contestó');
      expect(boton()?.textContent).toMatch(/Generar otra vez · \$[\d,]+\.\d{2}/);
      fix.componentRef.setInput('puedeReintentarGasto', false);
      fix.detectChanges();
      expect(boton()).toBeUndefined();
    });
  });

  describe('[PGP.122] F3 · «Cancelar en Kepler…» (DS40)', () => {
    const K = (status: string) => ({ estado: 'A', solicitud: '0000082', nace_en_la_suite: { status, nota: null, siguiente: null, intentos: 1 } }) as never;
    const botones = () => Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button')) as HTMLButtonElement[];
    const abrir = () => botones().find((b) => (b.textContent ?? '').includes('Cancelar en Kepler…'));
    // [PGP.122.9] El botón final nombra QUÉ cancela: «Cancelar <folio> ($cifra) en Kepler».
    const final = () => botones().find((b) => /^Cancelar .+ en Kepler$/.test((b.textContent ?? '').trim()) && !(b.textContent ?? '').includes('…'));

    it('sólo con la solicitud ya escrita y el vale firmado; pide motivo (mínimo 10) y lo emite', () => {
      montar(V({ status: 'validada' }));
      fix.componentRef.setInput('puedeReintentar', true);
      fix.componentRef.setInput('kepler', K('pending'));
      fix.detectChanges();
      expect(abrir()).toBeUndefined(); // todavía no está en Kepler: se rechaza aquí, no se cancela allá
      fix.componentRef.setInput('kepler', K('seen_in_ods'));
      fix.detectChanges();
      abrir()!.click();
      fix.detectChanges();
      const ta = (fix.nativeElement as HTMLElement).querySelector('#vp-cancelar-m') as HTMLTextAreaElement;
      expect(ta).toBeTruthy();
      // [PGP.122.9] modern-web-guidance (forms): el botón no se bloquea por validación; nombra folio y cifra.
      expect(final()!.disabled).toBe(false);
      expect(final()!.textContent).toContain('$1,234.50');
      // Sin tocar el campo no se regaña.
      expect(ta.getAttribute('aria-invalid')).toBeNull();
      expect((fix.nativeElement as HTMLElement).querySelector('#vp-cancelar-err')).toBeNull();
      const emitido: unknown[] = [];
      c.cancelarKepler.subscribe((e) => emitido.push(e));
      ta.value = 'corto';
      ta.dispatchEvent(new Event('input'));
      fix.detectChanges();
      final()!.click();
      fix.detectChanges();
      // Corto: no se manda nada, se marca el campo, se dice cuánto falta y el foco vuelve al motivo.
      expect(emitido).toEqual([]);
      expect(ta.getAttribute('aria-invalid')).toBe('true');
      expect((fix.nativeElement as HTMLElement).querySelector('#vp-cancelar-err')?.textContent).toContain('faltan 5 caracteres');
      expect(ta.getAttribute('aria-describedby')).toContain('vp-cancelar-err');
      expect(document.activeElement).toBe(ta);
      ta.value = 'Se capturó dos veces';
      ta.dispatchEvent(new Event('input'));
      fix.detectChanges();
      final()!.click();
      expect(emitido).toEqual([{ id: 'v1', motivo: 'Se capturó dos veces' }]);
      // El formulario se queda (no tira el foco) y, ocupado, no se puede mandar dos veces.
      fix.componentRef.setInput('ocupado', true);
      fix.detectChanges();
      expect(final()!.disabled).toBe(true);
      final()!.click();
      expect(emitido).toHaveLength(1);
    });

    /**
     * `[PGP.122.6]` «Cancela sol gasto» también para la solicitud CAPTURADA en Kepler (pedido de Edgar, 2026-11-19):
     * en A o N, con el vale vivo, y sólo en una sucursal con el interruptor `cancela_solicitud_gasto` encendido.
     */
    it('[PGP.122.6] la capturada en Kepler: en A/N, vale vivo y sucursal encendida; si no, no se ofrece', () => {
      const KK = (estado: string) => ({ estado, solicitud: 'XA1501-0000077', suite: null }) as never;
      montar(V({ status: 'validada', sucursal: '05', folio_solicitud: '0000077' }));
      fix.componentRef.setInput('puedeReintentar', true);
      fix.componentRef.setInput('kepler', KK('A'));
      fix.detectChanges();
      expect(abrir()).toBeUndefined(); // ninguna sucursal encendida
      fix.componentRef.setInput('cancelaSucursales', ['05']);
      fix.detectChanges();
      expect(abrir()).toBeTruthy();
      fix.componentRef.setInput('kepler', KK('N'));
      fix.detectChanges();
      expect(abrir()).toBeTruthy(); // nueva: Kepler también la cancela
      for (const e of ['F', 'C']) {
        fix.componentRef.setInput('kepler', KK(e));
        fix.detectChanges();
        expect(abrir()).toBeUndefined(); // ejecutada o ya cancelada: no
      }
      fix.componentRef.setInput('kepler', KK('A'));
      fix.componentRef.setInput('cancelaSucursales', ['08']);
      fix.detectChanges();
      expect(abrir()).toBeUndefined(); // otra sucursal encendida, ésta no
      fix.componentRef.setInput('cancelaSucursales', ['05']);
      fix.componentRef.setInput('vale', V({ status: 'rechazada', sucursal: '05', folio_solicitud: '0000077' }));
      fix.detectChanges();
      expect(abrir()).toBeUndefined(); // el vale ya está cerrado
      fix.componentRef.setInput('vale', V({ status: 'recibida', sucursal: '05', folio_solicitud: '0000077' }));
      fix.detectChanges();
      expect(abrir()).toBeTruthy(); // por firmar también: se cancela la solicitud y el vale se cierra con el motivo
      fix.componentRef.setInput('puedeReintentar', false);
      fix.detectChanges();
      expect(abrir()).toBeUndefined(); // la página no dio COMPROBAR
    });

    it('⛔ sin el permiso de la página o con el vale por firmar no se ofrece', () => {
      montar(V({ status: 'validada' }));
      fix.componentRef.setInput('kepler', K('written'));
      fix.detectChanges();
      expect(abrir()).toBeUndefined(); // la página no dio COMPROBAR
      fix.componentRef.setInput('puedeReintentar', true);
      fix.componentRef.setInput('vale', V({ status: 'recibida' }));
      fix.detectChanges();
      expect(abrir()).toBeUndefined();
    });
  });

  describe('[PGP.122.17] la compra de un activo, a la vista de quien firma', () => {
    const K = { estado: null, solicitud: null, nace_en_la_suite: { status: 'pending', nota: null, siguiente: null, intentos: 0 } } as never;
    const REN = (over: object = {}) => ({ linea: 1, concepto: '240', nombre: 'MANTENIMIENTO VEHICULAR.', cuenta: '602-008', proyecto: 'P1', departamento: 'D1', importe: 100, ...over });
    const D = (renglones: object[]) => ({ id: 'v1', sucursal: '00', acreedor: { clave: 'A1', nombre: 'PROVEEDOR' }, renglones, iva: 16, total: 116,
      documento: { tipo: 'ticket', folio: '1', fecha: '2026-11-21', uuid: null }, fecha_solicitud: '2026-11-22' }) as never;
    const lineas = () => Array.from((fix.nativeElement as HTMLElement).querySelectorAll('.vp-ren-a')).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());

    it('el renglón de activo dice qué es, cuántas unidades y dónde; el de gasto, nada', () => {
      montar(V({ status: 'recibida' }));
      fix.componentRef.setInput('kepler', K);
      fix.componentRef.setInput('solicitudSuite', D([
        REN(),
        REN({ linea: 2, concepto: '364', nombre: 'PC VERIFICADOR DE PRECIO.', cuenta: '150-002', importe: 9000,
          activo: { descripcion: 'PC verificador de precio, marca X', cantidad: 1, lugar: 'Piso de venta' } }),
        REN({ linea: 3, concepto: '213', nombre: 'MOBILIARIO.', cuenta: '150-001', importe: 18000,
          activo: { descripcion: 'Silla ejecutiva', cantidad: 3, lugar: null } }),
      ]));
      fix.detectChanges();
      expect((fix.nativeElement as HTMLElement).textContent).toContain('Al firmarla se escribe en Kepler así:');
      expect(lineas()).toEqual([
        'Compra de activo: PC verificador de precio, marca X · 1 unidad · Piso de venta',
        'Compra de activo: Silla ejecutiva · 3 unidades de $6,000.00',
      ]);
    });
  });
});
