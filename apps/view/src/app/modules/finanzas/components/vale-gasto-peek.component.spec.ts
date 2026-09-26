import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { ValeGastoPeekComponent } from './vale-gasto-peek.component';
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
      const emitidos: ValeGasto[] = [];
      c.aprobar.subscribe((v) => emitidos.push(v));
      const btn = [...fix.nativeElement.querySelectorAll('.vp-act button')]
        .find((b: Element) => b.textContent?.trim() === 'Aprobar') as HTMLButtonElement;
      btn.click();
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
});
