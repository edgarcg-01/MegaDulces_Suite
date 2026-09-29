import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { ValeGastoPeekComponent, type AprobacionVale } from './vale-gasto-peek.component';
import type { ValeGasto } from '../comprobaciones.service';

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

    it('con «aprobar» ofrece Aprobar y Rechazar', () => {
      montar(V(), ['aprobar', 'rechazar']);
      const botones = [...fix.nativeElement.querySelectorAll('.vp-act button')]
        .map((b: Element) => b.textContent?.trim());
      expect(botones).toEqual(['Rechazar', 'Aprobar']);
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
        .find((b: Element) => b.textContent?.trim() === 'Aprobar') as HTMLButtonElement;
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

      /** La fecha aparece recién al marcar: sin marca no significa nada. */
      it('la fecha esperada aparece al marcar', () => {
        montar(V(), ['aprobar', 'rechazar']);
        expect(fix.nativeElement.querySelector('#vp-esperado')).toBeNull();
        marcar();
        expect(fix.nativeElement.querySelector('#vp-esperado')).not.toBeNull();
      });

      it('marcada, el botón lo dice y la marca viaja', () => {
        montar(V(), ['aprobar', 'rechazar']);
        marcar();
        const emitidos: AprobacionVale[] = [];
        c.aprobar.subscribe((a) => emitidos.push(a));
        const btn = [...fix.nativeElement.querySelectorAll('.vp-act button')]
          .find((b: Element) => b.textContent?.trim() === 'Aprobar como provisional') as HTMLButtonElement;
        expect(btn).toBeTruthy();
        btn.click();
        expect(emitidos[0].provisional).toBe(true);
      });

      it('la fecha que se escribe es la que viaja', () => {
        montar(V(), ['aprobar', 'rechazar']);
        marcar();
        c.esperado.set('2026-10-15');
        const emitidos: AprobacionVale[] = [];
        c.aprobar.subscribe((a) => emitidos.push(a));
        c.emitirAprobacion(c.vale()!);
        expect(emitidos[0].comprobante_esperado_at).toBe('2026-10-15');
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
});
