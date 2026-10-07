/**
 * `[CXC.26]` **La agenda de cobranza por día, montada de verdad.**
 *
 * ⛔ Este spec ejerce el GESTO, no las piezas: monta el componente real, hace CLIC en un día,
 * CLIC en un cliente, y exige ver sus FACTURAS en el DOM. Es la regla que salió de tirar
 * producción con 16 pruebas en verde — *«que el servicio devuelva el valor correcto no es que el
 * botón sirva»*.
 *
 * Lo que se afirma:
 *  1. **Los tres lados del eje** salen del servidor y la pantalla los muestra sin recalcularlos.
 *  2. **El orden de la tabla pone HOY arriba**: por distancia a hoy, no por fecha. Ordenar por
 *     fecha ascendente encabezaría la tabla con una factura de hace un año.
 *  3. **El monto del cliente es la suma de SUS facturas**, no un número que venga aparte: por
 *     construcción no puede discrepar del desglose que se abre debajo.
 *  4. **Clic en el día → clientes. Clic en el cliente → sus facturas** (y cierran igual).
 *  5. ⛔ **Plaza y zona se muestran con NOMBRE.** Y un código que el catálogo no tiene se muestra
 *     **marcado**, no escondido: ocultarlo sería esconder dinero que nadie puede ubicar. Un
 *     cliente sin zona dice «Sin zona», que no es lo mismo que una zona sin nombre.
 *  6. **El cliente avisa lo que debe en OTROS días**, o el que llama lo llama dos veces.
 *  7. ⛔ **El error se VE.** Un `subscribe(next)` a secas dejaría la pantalla como estaba y nadie
 *     se entera de que el servidor falló.
 *  8. **El CSV exporta una fila por FACTURA**, sólo lo que está en pantalla, con los nombres.
 *  9. **Cambiar de día cierra las facturas abiertas**: si sobrevivieran, un cliente con la misma
 *     llave en el día nuevo aparecería desplegado sin que nadie lo pidiera.
 * 10. **El día de la semana no se corre**: `new Date('2026-09-25')` es medianoche UTC y en México
 *     `getDay()` devuelve el día anterior.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';

import { FinanzasCarteraDiaComponent } from './finanzas-cartera-dia.component';
import { CarteraService, PorDiaResp, DiaCartera, DiaDocumento, DiaClienteRef } from '../cartera.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

const dia = (fecha: string, off: number, monto: number, clientes = 1, docs = 1): DiaCartera => ({
  fecha, estado: off < 0 ? 'vencido' : off === 0 ? 'hoy' : 'futuro',
  dias_offset: off, monto, docs, clientes,
});

const doc = (fecha: string, off: number, k: string, folio: string, saldo: number): DiaDocumento => ({
  fecha, dias_offset: off, estado: off < 0 ? 'vencido' : off === 0 ? 'hoy' : 'futuro',
  k, folio_digital: folio, doc_label: 'Venta crédito',
  fecha_doc: '2026-09-01', importe: saldo, saldo,
});

const ref = (k: string, nombre: string, extra: Partial<DiaClienteRef> = {}): DiaClienteRef => ({
  k, sucursal: k.split('|')[0], sucursal_nombre: 'La Piedad',
  cliente_code: k.split('|')[1], cliente_nombre: nombre,
  telefono: null, zona: '10000', zona_nombre: 'CLIENTES ZONA LA PIEDAD',
  vendedor: '7', vendedor_nombre: 'Ana', cuenta_kind: 'cliente_final', dias_credito: 15,
  ...extra,
});

/** Agenda chica con los tres lados del eje y los tres casos de nombre que importan. */
const RESP: PorDiaResp = {
  hoy: '2026-09-25',
  freshness: { status: 'fresh', stale: false, age_human: '2 min', data_as_of: '2026-09-25T10:00:00Z' } as never,
  dias: [
    dia('2025-07-05', -447, 300, 1, 1),   // el más viejo: NO debe encabezar la tabla
    dia('2026-09-24', -1, 1000, 2, 3),
    dia('2026-09-25', 0, 500, 1, 1),
    dia('2026-09-30', 5, 200, 1, 1),
  ],
  documentos: [
    doc('2025-07-05', -447, '01|VIEJO', 'F-VIEJO', 300),
    doc('2026-09-24', -1, '01|A', 'F-A1', 400),
    doc('2026-09-24', -1, '01|A', 'F-A2', 200),
    doc('2026-09-24', -1, '02|B', 'F-B1', 400),
    doc('2026-09-25', 0, '01|C', 'F-C1', 500),
    doc('2026-09-30', 5, '01|A', 'F-A3', 200),   // A también debe en otro día
  ],
  clientes: [
    ref('01|VIEJO', 'Cliente Viejo'),
    ref('01|A', 'Abarrotes Alfa'),
    // Plaza sin nombre en catálogo + cliente sin zona: los dos casos de ausencia, distintos.
    ref('02|B', 'Bodega Beta', { sucursal_nombre: null, zona: null, zona_nombre: null }),
    ref('01|C', 'Comercial Ceta'),
  ],
  totales: { vencido: 1300, hoy: 500, futuro: 200, dias_vencidos: 2, dias_futuros: 1 },
  cobertura: { canonico: 2100, repartible: 2000, sin_documento: 100, sin_vencimiento: 0, clientes: 4 },
  filtros: { sucursales: [], grupos: [], zonas: [], vendedores: [], cuentas: [] },
  catalogos: { zonas: [{ code: '10000', nombre: 'CLIENTES ZONA LA PIEDAD', ambigua: false }] },
};

describe('[CXC.26] FinanzasCarteraDiaComponent', () => {
  let porDia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    porDia = vi.fn(() => of(RESP));
    TestBed.configureTestingModule({
      imports: [FinanzasCarteraDiaComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: CarteraService, useValue: { porDia } },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => true } },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  function crear() {
    const f = TestBed.createComponent(FinanzasCarteraDiaComponent);
    f.detectChanges();
    return { f, c: f.componentInstance, txt: () => (f.nativeElement as HTMLElement).textContent || '' };
  }

  it('carga la agenda al abrir y publica los tres lados del eje tal como llegan', () => {
    const { c } = crear();
    expect(porDia).toHaveBeenCalledTimes(1);
    expect(c.data()!.totales).toEqual({ vencido: 1300, hoy: 500, futuro: 200, dias_vencidos: 2, dias_futuros: 1 });
  });

  it('⛔ la tabla pone HOY arriba, no la fecha más vieja', () => {
    const { c } = crear();
    expect(c.filas().map((x) => x.fecha)).toEqual([
      '2026-09-25', '2026-09-24', '2026-09-30', '2025-07-05',
    ]);
  });

  it('el acumulado sigue el orden de la tabla', () => {
    const { c } = crear();
    expect(c.acumulado()['2026-09-25']).toBe(500);
    expect(c.acumulado()['2026-09-24']).toBe(1500);
    expect(c.acumulado()['2025-07-05']).toBe(2000);
  });

  it('⭐ el monto del cliente es la SUMA DE SUS FACTURAS, no un número aparte', () => {
    const { c } = crear();
    c.seleccionar('2026-09-24');
    const alfa = c.clientesDelDia().find((x) => x.ref.cliente_code === 'A')!;
    expect(alfa.docs.map((d) => d.folio_digital)).toEqual(['F-A1', 'F-A2']);
    expect(alfa.monto).toBe(600);                                   // 400 + 200
    expect(alfa.monto).toBe(alfa.docs.reduce((s, d) => s + d.saldo, 0));
  });

  it('⭐ EL GESTO: clic en el día → clientes; clic en el cliente → SUS FACTURAS en el DOM', () => {
    const { f, c, txt } = crear();

    c.seleccionar('2026-09-24');
    f.detectChanges();
    expect(c.clientesDelDia().map((x) => x.ref.cliente_code)).toEqual(['A', 'B']);
    expect(txt()).toContain('Abarrotes Alfa');
    expect(txt()).not.toContain('Cliente Viejo');
    // Todavía NO se ven los folios: hace falta el segundo clic.
    expect(txt()).not.toContain('F-A1');

    c.alternarCliente('01|A');
    f.detectChanges();
    expect(c.facturasAbiertas('01|A')).toBe(true);
    expect(txt()).toContain('F-A1');
    expect(txt()).toContain('F-A2');
    expect(txt()).not.toContain('F-B1');          // sólo las de ese cliente

    c.alternarCliente('01|A');
    f.detectChanges();
    expect(c.facturasAbiertas('01|A')).toBe(false);
    expect(txt()).not.toContain('F-A1');
  });

  it('«Ver todas las facturas» abre todos los clientes del día de una', () => {
    const { f, c, txt } = crear();
    c.seleccionar('2026-09-24');
    c.alternarTodasLasFacturas();
    f.detectChanges();
    expect(txt()).toContain('F-A1');
    expect(txt()).toContain('F-B1');
    // Y un clic individual con el modo global prendido apaga SÓLO ése, sin que el botón mienta.
    c.alternarCliente('01|A');
    f.detectChanges();
    expect(c.todasFacturas()).toBe(false);
    expect(c.facturasAbiertas('01|A')).toBe(false);
    expect(c.facturasAbiertas('02|B')).toBe(true);
  });

  it('⛔ plaza y zona salen con NOMBRE, no con número', () => {
    const { f, c, txt } = crear();
    c.seleccionar('2026-09-24');
    f.detectChanges();
    expect(txt()).toContain('La Piedad');
    expect(txt()).toContain('CLIENTES ZONA LA PIEDAD');
  });

  it('⛔ un código SIN nombre se muestra marcado, y «sin zona» no es lo mismo que «zona sin nombre»', () => {
    const { f, c } = crear();
    c.seleccionar('2026-09-24');
    f.detectChanges();
    const html = (f.nativeElement as HTMLElement).innerHTML;
    // La sucursal 02 no está en el catálogo: se muestra el código, marcado, no escondido.
    expect(html).toContain('cd-sinnombre');
    expect((f.nativeElement as HTMLElement).textContent).toContain('Sin zona');
  });

  it('⭐ el cliente avisa lo que debe en OTROS días', () => {
    const { f, c, txt } = crear();
    c.seleccionar('2026-09-24');
    const alfa = c.clientesDelDia().find((x) => x.ref.cliente_code === 'A')!;
    expect(alfa.otros_dias_monto).toBe(200);   // su factura del 30-sep
    expect(alfa.otros_dias_docs).toBe(1);
    const beta = c.clientesDelDia().find((x) => x.ref.cliente_code === 'B')!;
    expect(beta.otros_dias_docs).toBe(0);
    c.alternarCliente('01|A');
    f.detectChanges();
    expect(txt()).toContain('además debe');
  });

  it('⚠️ cambiar de día cierra las facturas abiertas', () => {
    const { c } = crear();
    c.seleccionar('2026-09-24');
    c.alternarCliente('01|A');
    expect(c.facturasAbiertas('01|A')).toBe(true);
    c.seleccionar('2026-09-25');
    expect(c.facturasAbiertas('01|A')).toBe(false);
  });

  it('abrir un día o un cliente NO dispara otro request: todo vino en la respuesta', () => {
    const { c } = crear();
    porDia.mockClear();
    c.seleccionar('2026-09-24');
    c.alternarCliente('01|A');
    c.alternarTodasLasFacturas();
    expect(porDia).not.toHaveBeenCalled();
  });

  it('filtrar por un lado del eje recorta la tabla y cierra lo abierto', () => {
    const { c } = crear();
    c.seleccionar('2026-09-24');
    c.alternarCliente('01|A');
    c.verLado('futuro');
    expect(c.diaSel()).toBeNull();
    expect(c.facturasAbiertas('01|A')).toBe(false);
    expect(c.filas().map((x) => x.fecha)).toEqual(['2026-09-30']);
    c.verLado('futuro');
    expect(c.filas()).toHaveLength(4);
  });

  it('⛔ el error del servidor se VE: banner puesto y pantalla no muda', () => {
    porDia.mockReturnValue(throwError(() => ({ error: { message: 'la pirámide explotó' } })));
    const { c, txt } = crear();
    expect(c.error()).toBe('la pirámide explotó');
    expect(c.loading()).toBe(false);
    expect(txt()).toContain('No se pudo cargar la agenda por día');
  });

  it('si al recargar el día abierto ya no existe, se cierra en vez de quedar vacío', () => {
    const { c } = crear();
    c.seleccionar('2026-09-24');
    porDia.mockReturnValue(of({ ...RESP, dias: [dia('2026-09-30', 5, 200)], documentos: [], clientes: [] }));
    c.load();
    expect(c.diaSel()).toBeNull();
  });

  it('⭐ el CSV exporta una fila por FACTURA, sólo lo que está en pantalla, con nombres', () => {
    const { c } = crear();
    let csv = '';
    const blobReal = globalThis.Blob;
    // @ts-expect-error doble mínimo para leer lo que se serializa
    globalThis.Blob = class { constructor(p: string[]) { csv = p.join(''); } };
    const url = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    c.verLado('vencido');
    c.exportCsv();

    const lineas = csv.trim().split('\n');
    expect(lineas[0]).toContain('folio');
    // 2 días vencidos: el 24-sep (3 facturas) y el 05-jul (1) = 4 facturas + encabezado.
    expect(lineas).toHaveLength(5);
    expect(csv).toContain('F-A1');
    expect(csv).toContain('La Piedad');
    expect(csv).toContain('CLIENTES ZONA LA PIEDAD');
    expect(csv).not.toContain('F-C1');          // el 25-sep no es «vencido»
    expect(csv).not.toContain('F-A3');          // el 30-sep tampoco

    globalThis.Blob = blobReal;
    url.mockRestore();
  });

  it('⚠️ el día de la semana no se corre por zona horaria', () => {
    const { c } = crear();
    // 2026-09-25 es viernes. Con `new Date(fecha).getDay()` en México daría jueves.
    expect(c.diaSemana('2026-09-25')).toBe('vie');
    expect(c.diaSemana('2026-09-27')).toBe('dom');
  });

  it('«cuándo» se redacta del lado que toca', () => {
    const { c } = crear();
    expect(c.cuando(dia('2026-09-25', 0, 1))).toBe('Vence hoy');
    expect(c.cuando(dia('2026-09-26', 1, 1))).toBe('Vence mañana');
    expect(c.cuando(dia('2026-09-24', -1, 1))).toBe('Venció ayer');
    expect(c.cuando(dia('2026-09-20', -5, 1))).toBe('Venció hace 5 días');
  });

  it('declara al pie lo que ningún día puede mostrar', () => {
    const { txt } = crear();
    expect(txt()).toContain('no tienen');
    expect(txt()).toMatch(/\$100/);
  });
});
