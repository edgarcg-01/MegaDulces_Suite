/**
 * `[CXC.26]` **La agenda de cobranza por día, montada de verdad.**
 *
 * ⛔ Este spec ejerce el GESTO, no las piezas: monta el componente real, hace CLIC en el renglón
 * de un día y exige que se abra su desglose con los clientes correctos. Es la regla que salió de
 * tirar producción con 16 pruebas en verde — *«que el servicio devuelva el valor correcto no es
 * que el botón sirva»*.
 *
 * Lo que se afirma:
 *  1. **Los tres lados del eje** salen del servidor y la pantalla los muestra sin recalcularlos.
 *  2. **El orden de la tabla pone HOY arriba**: por distancia a hoy, no por fecha. Ordenar por
 *     fecha ascendente encabezaría la tabla con una factura de hace un año.
 *  3. **El clic abre el día y el desglose es el de ESE día** (y vuelve a cerrarlo).
 *  4. **Filtrar por un lado del eje** recorta la tabla y limpia el día abierto.
 *  5. ⛔ **El error se VE.** Un `subscribe(next)` a secas dejaría la pantalla como estaba y nadie
 *     se entera de que el servidor falló — es el defecto que ya costó una entrega («Build verde ≠
 *     endpoint vivo»). Acá se exige el banner.
 *  6. **El CSV exporta lo que está EN PANTALLA**, no todo: si exportara todo, el archivo no
 *     coincidiría con lo que la persona acaba de mirar.
 *  7. **El día de la semana no se corre**: `new Date('2026-09-25')` es medianoche UTC y en México
 *     `getDay()` devuelve el día anterior.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';

import { FinanzasCarteraDiaComponent } from './finanzas-cartera-dia.component';
import { CarteraService, PorDiaResp, DiaCartera, DiaCliente } from '../cartera.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

const dia = (fecha: string, off: number, monto: number, clientes = 1, docs = 1): DiaCartera => ({
  fecha, estado: off < 0 ? 'vencido' : off === 0 ? 'hoy' : 'futuro',
  dias_offset: off, monto, docs, clientes,
});

const cli = (fecha: string, code: string, monto: number, off: number): DiaCliente => ({
  fecha, sucursal: '01', cliente_code: code, cliente_nombre: `Cliente ${code}`,
  telefono: null, zona: 'Z1', vendedor: '7', vendedor_nombre: 'Ana',
  cuenta_kind: 'cliente_final', dias_credito: 15, monto, docs: 1, dias_offset: off,
});

/** Una agenda chica pero con los tres lados del eje y el reparto desbalanceado de verdad. */
const RESP: PorDiaResp = {
  hoy: '2026-09-25',
  freshness: { status: 'fresh', stale: false, age_human: '2 min', data_as_of: '2026-09-25T10:00:00Z' } as never,
  dias: [
    dia('2025-07-05', -447, 300, 1, 1),   // el más viejo: NO debe encabezar la tabla
    dia('2026-09-24', -1, 1000, 2, 3),
    dia('2026-09-25', 0, 500, 1, 1),
    dia('2026-09-30', 5, 200, 1, 1),
  ],
  detalle: [
    cli('2025-07-05', 'VIEJO', 300, -447),
    cli('2026-09-24', 'A', 600, -1),
    cli('2026-09-24', 'B', 400, -1),
    cli('2026-09-25', 'C', 500, 0),
    cli('2026-09-30', 'D', 200, 5),
  ],
  totales: { vencido: 1300, hoy: 500, futuro: 200, dias_vencidos: 2, dias_futuros: 1 },
  cobertura: { canonico: 2100, repartible: 2000, sin_documento: 100, sin_vencimiento: 0, clientes: 5 },
  filtros: { sucursales: [], grupos: [], zonas: [], vendedores: [], cuentas: [] },
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
    return { f, c: f.componentInstance };
  }

  it('carga la agenda al abrir y publica los tres lados del eje tal como llegan', () => {
    const { c } = crear();
    expect(porDia).toHaveBeenCalledTimes(1);
    expect(c.data()!.totales).toEqual({ vencido: 1300, hoy: 500, futuro: 200, dias_vencidos: 2, dias_futuros: 1 });
  });

  it('⛔ la tabla pone HOY arriba, no la fecha más vieja', () => {
    const { c } = crear();
    expect(c.filas().map((x) => x.fecha)).toEqual([
      '2026-09-25',  // hoy
      '2026-09-24',  // venció ayer
      '2026-09-30',  // vence en 5
      '2025-07-05',  // venció hace 447
    ]);
  });

  it('el acumulado sigue el orden de la tabla', () => {
    const { c } = crear();
    expect(c.acumulado()['2026-09-25']).toBe(500);
    expect(c.acumulado()['2026-09-24']).toBe(1500);
    expect(c.acumulado()['2025-07-05']).toBe(2000);
  });

  it('⭐ EL GESTO: hacer clic en un día abre SU desglose, y el segundo clic lo cierra', () => {
    const { f, c } = crear();

    c.seleccionar('2026-09-24');
    f.detectChanges();
    expect(c.diaSel()).toBe('2026-09-24');
    // Sólo los de ese día, y de mayor a menor.
    expect(c.clientesDelDia().map((x) => x.cliente_code)).toEqual(['A', 'B']);
    // Y está en el DOM, no sólo en la señal.
    const html = (f.nativeElement as HTMLElement).textContent || '';
    expect(html).toContain('Cliente A');
    expect(html).not.toContain('Cliente VIEJO');

    c.seleccionar('2026-09-24');
    f.detectChanges();
    expect(c.diaSel()).toBeNull();
    expect(c.clientesDelDia()).toEqual([]);
  });

  it('abrir un día NO dispara otro request: el desglose ya vino', () => {
    const { c } = crear();
    porDia.mockClear();
    c.seleccionar('2026-09-24');
    c.seleccionar('2026-09-30');
    expect(porDia).not.toHaveBeenCalled();
  });

  it('filtrar por un lado del eje recorta la tabla y cierra el día abierto', () => {
    const { c } = crear();
    c.seleccionar('2026-09-24');
    c.verLado('futuro');
    expect(c.diaSel()).toBeNull();
    expect(c.filas().map((x) => x.fecha)).toEqual(['2026-09-30']);
    c.verLado('futuro');                       // el mismo botón lo apaga
    expect(c.filas()).toHaveLength(4);
  });

  it('⛔ el error del servidor se VE: banner puesto y pantalla no muda', () => {
    porDia.mockReturnValue(throwError(() => ({ error: { message: 'la pirámide explotó' } })));
    const { f, c } = crear();
    expect(c.error()).toBe('la pirámide explotó');
    expect(c.loading()).toBe(false);
    expect((f.nativeElement as HTMLElement).textContent).toContain('No se pudo cargar la agenda por día');
  });

  it('si al recargar el día abierto ya no existe, se cierra en vez de quedar vacío', () => {
    const { c } = crear();
    c.seleccionar('2026-09-24');
    porDia.mockReturnValue(of({ ...RESP, dias: [dia('2026-09-30', 5, 200)], detalle: [] }));
    c.load();
    expect(c.diaSel()).toBeNull();
  });

  it('el CSV exporta lo que está en pantalla, no toda la agenda', () => {
    const { c } = crear();
    let csv = '';
    const blobReal = globalThis.Blob;
    // @ts-expect-error doble mínimo para leer lo que se serializa
    globalThis.Blob = class { constructor(p: string[]) { csv = p.join(''); } };
    const url = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    c.verLado('futuro');
    c.exportCsv();

    expect(csv).toContain('Cliente D');
    expect(csv).not.toContain('Cliente A');
    expect(csv).toContain('Vence en 5 días');

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
    const { f } = crear();
    const txt = (f.nativeElement as HTMLElement).textContent || '';
    expect(txt).toContain('no tienen');       // la frase del sin_documento
    expect(txt).toMatch(/\$100/);             // su monto, no escondido
  });
});
