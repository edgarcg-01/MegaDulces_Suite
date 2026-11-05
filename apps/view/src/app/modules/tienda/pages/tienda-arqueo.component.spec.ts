import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';
import { of, throwError } from 'rxjs';
import { ArqueoRow, ArqueoService, AvisoDobleCaja, Turno, TurnosResp } from '../arqueo.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { TiendaArqueoComponent } from './tienda-arqueo.component';

// `p-table` observa su tamaño con ResizeObserver, que jsdom no trae.
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe(): void { /* el mock no observa: sólo evita que p-table reviente en jsdom */ }
    unobserve(): void { /* idem */ }
    disconnect(): void { /* idem */ }
  };
}

/**
 * **[SM.40] La pantalla de arqueo, del lado de la cajera: nada la puede dejar sin
 * poder contar.**
 *
 * Esta suite existe por un incidente real (2026-09-29): dos cortes hechos y la
 * pantalla trabada, con la cajera todavía en turno. La causa de fondo fue la
 * ingesta caída 6 días, pero lo que convirtió un atraso de datos en un mostrador
 * parado fueron los tres candados que este cambio retira. Así que lo que se prueba
 * acá no es "el botón se pinta", es **que no existe un estado en el que la persona
 * no pueda registrar su conteo**.
 *
 * Cada `it` es uno de los tres candados, escrito como la situación que lo
 * disparaba en producción.
 */
const turno = (over: Partial<Turno> = {}): Turno => ({
  warehouse_code: '01', warehouse_name: 'PADRE HIDALGO',
  caja: '2', folio: '87', business_date: '2026-09-29',
  hora_apertura: '08:15', hora_cierre: null, cajero_code: '10C02',
  turno: '01', abierto: true,
  ...over,
});

class ArqueoStub {
  resp: TurnosResp = { turnos: [], aviso: null };
  /** Lo último que se mandó a `POST /store/arqueo`. */
  enviado: any = null;
  turnos() { return of(this.resp); }
  rutas() { return of({ warehouse_code: '01', rd: [], rv: [] }); }
  /** [SM.51] Las cajas de la sucursal para el selector. */
  cajasLista: string[] = ['1', '2', '3'];
  cajasDeSucursal(code: string) { return of({ warehouse_code: code, cajas: this.cajasLista }); }
  list() { return of([]); }
  submit(dto: any) { this.enviado = dto; return of({ tipo: dto.tipo, total_contado: 1000, reveal: false }); }
  submitRuta(dto: any) { this.enviado = dto; return of({ tipo: dto.tipo, total_contado: 1000, route_code: dto.route_code, route_label: '', medible: false, motivo_no_medible: 'sin_esperado' }); }
  validar() { return of({}); }
  porCajera() { return of({ cajeras: [], totales: { cajeras: 0, cortes: 0, sin_arqueo: 0 } }); }
}

describe('TiendaArqueoComponent · [SM.40] la cajera siempre puede contar', () => {
  let fix: ComponentFixture<TiendaArqueoComponent>;
  let cmp: TiendaArqueoComponent;
  let svc: ArqueoStub;

  const html = (): string => (fix.nativeElement as HTMLElement).textContent ?? '';
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  /** Los botones de turno que la persona puede realmente pulsar. */
  const turnosPulsables = (): HTMLButtonElement[] =>
    Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button.arq-turno'))
      .filter((b) => !b.disabled);

  beforeEach(async () => {
    svc = new ArqueoStub();
    await TestBed.configureTestingModule({
      imports: [TiendaArqueoComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        MessageService,
        { provide: ArqueoService, useValue: svc },
        // Cajera: captura, NO revela. Es el caso que los candados castigaban.
        {
          provide: AuthService,
          useValue: {
            user: () => ({ username: '10c02', warehouse_code: '01', role_name: 'cajero', permissions: { STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true } }),
            token: () => null,
          },
        },
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false } },
        { provide: DataScopeService, useValue: { warehouses: () => of([{ value: '01', label: 'PADRE HIDALGO' }]) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaArqueoComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
    // [SM.49] La pantalla abre en «Retiro · elige el concepto» y un retiro sin concepto no
    // se guarda. Estas pruebas son de la captura en general y se escribieron con el cierre
    // como tipo inicial: se elige explícito. Lo del retiro tiene su propio bloque [SM.49].
    cmp.elegirMenu('cierre');
    await tick();
  });

  /** Teclea un conteo cualquiera para que el botón de guardar tenga sentido. */
  const contar = async (): Promise<void> => {
    cmp.denomCount['1000'] = 1;
    cmp.recalc();
    await tick();
  };




  // ── `[SM.41]` La frescura del DATO, no la del fetch ─────────────────────────────────────
  //
  // Con la ingesta caída la lista se vacía y la pantalla decía «No tienes cortes por
  // arquear», que se lee igual que «ya contaste todo». Pasó seis días en septiembre de
  // 2026 con 25 cajeras y el turno congelado. Lo que se prueba acá es que la pantalla
  // NUNCA se pinta fresca por omisión: sin latido lo declara, y con el dato viejo lo grita.


  // ── `[SM.41]` Una alarma que grita en falso enseña a ignorar el tablero ──────────────────
  //
  // El backend aplastaba los TRES estados del carril (`running`/`ok`/`error`) en dos y
  // mandaba a «error» todo lo que no fuera «ok». Medido en prod el 2026-10-05: el carril
  // arranca cada 35 s y tarda ~20, o sea que vive el **56.9 % del tiempo** en `running`,
  // con **2,690 corridas buenas contra 2 fallidas** en 24 h. La franja roja «la ingesta de
  // Kepler está fallando» quedaba encendida más de media jornada sobre un carril que
  // acierta el 99.93 %, y las dos fallas reales eran indistinguibles del ruido.


  // ── `[SM.41]` `dirty` significaba dos cosas y apagaba tres ──────────────────────────────
  it('⭐ cambiar de pestaña NO cuenta como dinero sin guardar; teclear un billete SÍ', async () => {
    svc.resp = { turnos: [turno()], aviso: null };
    cmp.ngOnInit();
    await tick();

    // NEGATIVA: tocar el tipo de arqueo no puede bloquear la navegación ni congelar
    // el refresco de 45 s, que es la promesa de ir a la par de Kepler.
    cmp.elegirTipo('retiro');
    expect(cmp.hasUnsavedChanges()).toBe(false);

    // CONTROL POSITIVO: con un billete contado, sí hay algo que perder.
    await contar();
    expect(cmp.hasUnsavedChanges()).toBe(true);
  });

  // ── `[SM.41]` «Conté y había $0» es un hecho ────────────────────────────────────────────
  it('⭐ el cajón vacío se puede declarar — antes el botón quedaba apagado para siempre', async () => {
    // [SM.51] Ya no se elige un turno: se elige la caja.
    cmp.elegirCaja('2');
    await tick();

    // NEGATIVA: sin contar nada y sin declararlo, no se sella.
    expect(cmp.canSubmit()).toBe(false);

    cmp.declararVacio();
    await tick();
    expect(cmp.vacio()).toBe(true);
    expect(cmp.canSubmit()).toBe(true);
    expect(html()).toContain('Es distinto de no contar');
  });

  // ── [SM.41] El buscador tiene que DESPERTAR cuando se elige la sucursal ────────────────
  //
  // `sucursalActiva` nacio como un `computed()` sobre `aSuc`, que entonces era un campo
  // plano con ngModel. Un computed solo se recalcula cuando cambia una dependencia
  // REACTIVA, asi que para un supervisor con varias sucursales y sin turno el valor se
  // quedaba congelado en null y la tarjeta de precios y faltantes no despertaba nunca --
  // visto en una captura de la pantalla corriendo, deshabilitada de por vida.
  //
  // Se arreglo pasando `aSuc` a signal. Esta prueba fija el COMPORTAMIENTO, no esa
  // implementacion: si alguien vuelve a desreactivar el campo, o cambia el computed por
  // algo que no observe la sucursal, se pone roja igual.
  it('⭐ el buscador toma la sucursal del turno, y sin turno la que se elige a mano', async () => {
    svc.resp = { turnos: [turno()], aviso: null };
    cmp.ngOnInit();
    await tick();

    // Con turno: manda el turno, sin tocar nada.
    expect(cmp.sucursalActiva()).toBe('01');

    // Sin turno y con varias sucursales alcanzables: arranca en null — es el caso que
    // dejaba el buscador muerto — y DESPIERTA al elegir una a mano.
    cmp.turnos.set([]);
    cmp.sucursales.set([
      { value: '01', label: 'PADRE HIDALGO' },
      { value: '03', label: '8 ESQUINAS' },
    ]);
    cmp.aSuc.set('');
    await tick();
    expect(cmp.sucursalActiva()).toBeNull();

    cmp.aSuc.set('03');
    await tick();
    expect(cmp.sucursalActiva()).toBe('03');
  });

  it('el código de cajera no se puede escribir a nombre de otra persona', async () => {
    svc.resp = { turnos: [], aviso: null };
    cmp.ngOnInit();
    await tick();
    cmp.manual.set(true);
    await tick();

    const campo = (fix.nativeElement as HTMLElement)
      .querySelector<HTMLInputElement>('input.arq-fld-cajero');
    expect(campo).toBeTruthy();
    // Quitar los candados de horario no es quitar la identidad del conteo.
    expect(campo!.readOnly).toBe(true);
    expect(cmp.aCajero).toBe('10C02');
  });

  // ── `[FLT.29]` El selector de sucursal y la cadena de teclado del encabezado ──────────────
  //
  // El selector sólo se dibuja con MÁS DE UNA tienda alcanzable: con una sola no es una opción,
  // es un hecho de la sesión. Lo que esta prueba protege de verdad es el efecto colateral:
  // `onHeadKey(ev, idx)` indexa un `ViewChildren`, así que esconder el selector corre las
  // posiciones de Caja y Cajero. Estaban escritas a mano (1 y 2) y con una sola sucursal
  // quedaban corridas — ArrowLeft desde Caja se enfocaba a sí misma y ArrowRight hacia Cajero
  // caía fuera de rango y **no hacía nada, en silencio**. Si alguien las vuelve a fijar, esto
  // se pone rojo antes de que las flechas dejen de servirle a la cajera.
  it('⭐ con UNA sola tienda no hay selector, y los índices del encabezado se corren', async () => {
    cmp.manual.set(true);
    await tick();

    const root = fix.nativeElement as HTMLElement;
    // El stub de alcance devuelve una sola sucursal: es el caso de la cajera.
    expect(cmp.variasSucursales()).toBe(false);
    expect(root.querySelector('.arq-fld-suc')).toBeNull();
    expect(root.querySelector('.arq-suc-val')?.textContent).toContain('PADRE HIDALGO');
    expect(cmp.idxCaja()).toBe(0);
    expect(cmp.idxCajero()).toBe(1);
  });

  it('⭐ con varias tiendas vuelve el selector, y los índices vuelven a su lugar', async () => {
    cmp.manual.set(true);
    cmp.sucursales.set([
      { value: '01', label: 'PADRE HIDALGO' },
      { value: '03', label: '8 ESQUINAS' },
    ]);
    await tick();

    const root = fix.nativeElement as HTMLElement;
    expect(cmp.variasSucursales()).toBe(true);
    expect(root.querySelector('.arq-suc-val')).toBeNull();
    expect(cmp.idxCaja()).toBe(1);
    expect(cmp.idxCajero()).toBe(2);
  });

  // ── `[SM.42]` El efectivo se cuenta en UNA lista, de mayor a menor ────────────────────────
  //
  // Es el formato de la hoja de arqueo de la operacion: «Monedas / billetes», de $1,000 a
  // 50¢ (billetes y luego monedas), consecutivas, con el total en efectivo al pie, en
  // TODAS las pestanas. Lo que cambia por tipo es la columna de al lado: el retiro muestra sus retiros del turno (no
  // lleva medios), el cierre y las rutas sus medios de pago, el relevo nada.
  const retiroListo = async (): Promise<void> => {
    // [SM.51] Sin turno de Kepler: la cajera elige su caja.
    cmp.elegirCaja('2');
    await tick();
    // [SM.49] Un retiro se guarda con concepto: el normal es «Retiro de caja».
    cmp.elegirMenu('retiro:retiro_caja');
    await tick();
  };
  const casillasRetiro = (): HTMLInputElement[] =>
    Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('.arq-lista input'));

  it('⭐ la lista va de $1,000 a 50¢ (billetes y luego monedas) con el total en efectivo, en todas las pestañas', async () => {
    await retiroListo();
    const root = fix.nativeElement as HTMLElement;
    const etiquetas = (): string[] =>
      Array.from(root.querySelectorAll('.arq-lista-row:not(.arq-lista-head):not(.arq-lista-foot) .arq-lista-den'))
        .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());

    expect(etiquetas()).toHaveLength(12);
    expect(etiquetas()[0]).toBe('$1,000');
    expect(etiquetas()[11]).toBe('50¢');
    // La de $20 existe dos veces; el billete va primero (de mayor a menor, billetes antes que monedas).
    expect(etiquetas()[5]).toContain('billete');
    expect(etiquetas()[6]).toContain('moneda');
    expect(html()).toContain('Total en efectivo');
    // Las dos columnas de antes ya no existen en ninguna pestaña.
    expect(html()).not.toContain('Registro detallado de billetes');
    // El retiro: sus retiros del turno, y NO medios de pago.
    expect(html()).toContain('Retiros de este turno');
    expect(html()).not.toContain('Medios de pago y movimientos');

    // El cierre: la MISMA lista, y al lado sus medios de pago como siempre.
    cmp.elegirTipo('cierre');
    await tick();
    expect(etiquetas()).toHaveLength(12);
    expect(etiquetas()[0]).toBe('$1,000');
    expect(html()).toContain('Medios de pago y movimientos');
    expect(html()).not.toContain('Retiros de este turno');

    // El relevo: la lista sola (nunca llevó medios).
    cmp.elegirTipo('relevo');
    await tick();
    expect(etiquetas()).toHaveLength(12);
    expect(html()).not.toContain('Medios de pago y movimientos');
    expect(html()).not.toContain('Retiros de este turno');
  });

  it('⭐ en el cierre, → pasa de la lista a los medios en el mismo renglón', async () => {
    svc.resp = { turnos: [turno()], aviso: null };
    cmp.ngOnInit();
    await tick();
    cmp.elegirTipo('cierre');
    await tick();
    const root = fix.nativeElement as HTMLElement;
    const lista = Array.from(root.querySelectorAll<HTMLInputElement>('.arq-lista input'));
    const medios = Array.from(root.querySelectorAll<HTMLInputElement>('.arq-col--medios input'));
    expect(lista).toHaveLength(12);
    expect(medios).toHaveLength(5);

    lista[1].focus();
    cmp.onCellKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }), 0, 1);
    expect(document.activeElement).toBe(medios[1]);
    // ← regresa al mismo renglón de la lista.
    cmp.onCellKey(new KeyboardEvent('keydown', { key: 'ArrowLeft' }), 1, 1);
    expect(document.activeElement).toBe(lista[1]);
    // Desde un renglón más abajo que el último medio, cae en el último medio, no al vacío.
    cmp.onCellKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }), 0, 9);
    expect(document.activeElement).toBe(medios[4]);
  });

  it('⭐ ↓ recorre la lista entera sin cortarse en $20, y la última casilla baja al botón', async () => {
    await retiroListo();
    await contar();   // con dinero contado el botón está habilitado y puede recibir el foco
    const casillas = casillasRetiro();
    expect(casillas).toHaveLength(12);

    casillas[0].focus();
    cmp.onCellKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }), 0, 0);
    expect(document.activeElement).toBe(casillas[1]);

    // La prueba que importa: del $20 billete al $20 moneda. Partida en billetes|monedas
    // (como era la grilla cuando eran dos bloques), la columna se cortaba aquí y Enter
    // saltaba al botón con medio conteo sin capturar.
    cmp.onCellKey(new KeyboardEvent('keydown', { key: 'Enter' }), 0, 5);
    expect(document.activeElement).toBe(casillas[6]);

    cmp.onCellKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }), 0, 11);
    expect(document.activeElement?.tagName).toBe('BUTTON');
    expect(document.activeElement?.closest('.arq-bar')).toBeTruthy();
  });

  it('⭐ un medio escrito en el cierre NO se cuela al retiro', async () => {
    cmp.elegirCaja('2');
    await tick();
    cmp.elegirTipo('cierre');
    cmp.onMedioInput('tarjeta', { target: { value: '500' } } as unknown as Event);
    await contar();
    // CONTROL: en el cierre la tarjeta sí suma al total del turno.
    expect(cmp.totalTurno()).toBe(1500);

    cmp.elegirMenu('retiro:retiro_caja');
    await tick();
    expect(cmp.totalTurno()).toBe(1000);
    expect(cmp.mediosDeclarados()).toEqual([]);

    cmp.submit();
    await tick();
    expect(svc.enviado.tipo).toBe('retiro');
    expect(svc.enviado.concepto).toBe('retiro_caja');
    expect(svc.enviado.medios).toBeUndefined();
    expect(svc.enviado.denominations).toEqual({ '1000': 1 });
  });

  it('⭐ al lado de la lista van los retiros que ya guardó en ESTE turno, y nada más', async () => {
    await retiroListo();
    const d = new Date();
    const hoy = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const fila = (over: Partial<ArqueoRow>): ArqueoRow => ({
      id: 'r', tipo: 'retiro', warehouse_code: '01', caja: '2', business_date: hoy, turno: '01',
      cajero_code: '10C02', cajero_entrante: null, cajero_nombre: null, total_contado: 0,
      captured_by: '10c02', captured_at: '2026-09-29T15:00:00.000Z', nota: null, incidencia_tipo: null,
      cash_cut_folio: null,
      ...over,
    });
    cmp.rows.set([
      fila({ id: 'b', secuencia: 2, total_contado: 10500, captured_at: '2026-09-29T16:31:00.000Z' }),
      fila({ id: 'a', secuencia: 1, total_contado: 8000, captured_at: '2026-09-29T15:12:00.000Z' }),
      // NEGATIVAS: otra caja, otro día y un cierre no son retiros de esta caja hoy.
      fila({ id: 'x', caja: '7', total_contado: 999 }),
      fila({ id: 'y', business_date: '2026-01-02', total_contado: 555 }),
      fila({ id: 'z', tipo: 'cierre', total_contado: 777 }),
    ]);
    await tick();

    expect(cmp.retirosDelTurno().map((r) => r.n)).toEqual([1, 2]);
    expect(cmp.retiradoDelTurno()).toBe(18500);
    // El que se está contando es el siguiente.
    expect(html()).toContain('Retiro 3');
  });

  // ── `[SM.43]` Buscador y reimpresión en «Arqueos recientes» ─────────────────────────────
  const filaH = (over: Partial<ArqueoRow>): ArqueoRow => ({
    id: 'h', tipo: 'cierre', warehouse_code: '01', caja: '2', business_date: '2026-10-07', turno: '01',
    cajero_code: '10C02', cajero_entrante: null, cajero_nombre: 'LUPITA PEREZ', total_contado: 0,
    captured_by: '10c02', captured_at: '2026-10-07T15:12:00.000Z', nota: null, incidencia_tipo: null,
    ...over,
  });
  const historial = async (rows: ArqueoRow[]): Promise<void> => {
    svc.resp = { turnos: [turno()], aviso: null };
    cmp.ngOnInit();
    await tick();
    cmp.rows.set(rows);
    await tick();
  };



  // ── `[SM.44]` La confirmación del corte desglosa pieza por pieza ─────────────────────────
  it('⭐ la confirmación lista cada denominación con piezas e importe, y omite las que van en cero', async () => {
    svc.resp = { turnos: [turno()], aviso: null };
    cmp.ngOnInit();
    await tick();
    cmp.denomCount['1000'] = 2;
    cmp.denomCount['20'] = 1;
    cmp.denomCount['20m'] = 3;
    cmp.denomCount['0.5'] = 9;
    cmp.recalc();

    const billetes = cmp.desgloseFamilia('billete');
    expect(billetes.map((d) => [d.label, d.cantidad, d.importe])).toEqual([['$1,000', 2, 2000], ['$20 billete', 1, 20]]);
    const monedas = cmp.desgloseFamilia('moneda');
    expect(monedas.map((d) => [d.label, d.cantidad, d.importe])).toEqual([['$20 moneda', 3, 60], ['50¢', 9, 4.5]]);

    cmp.confirmar();
    await tick();
    // Solo el diálogo: la tabla de captura de atrás sí lista todas las denominaciones.
    const texto = document.querySelector('.arq-cfm')?.textContent ?? '';
    expect(texto).not.toBe('');
    expect(texto).toContain('Total billetes');
    expect(texto).toContain('Total monedas');
    expect(texto).toContain('$2,000.00');
    expect(texto).toContain('× 9');
    // NEGATIVA: lo que va en cero no aparece.
    expect(texto).not.toContain('$500');
  });
});

/**
 * `[SM.45]` Las rutas de la pestaña RD/RV se piden CON la sucursal.
 *
 * Caso real (2026-10-21): `luis_munoz`, `auxiliar_tienda` sin sucursal fija, eligió
 * Padre Hidalgo y la pantalla dijo «Tu sucursal no tiene rutas de reparto». En prod
 * Padre Hidalgo tiene 7 RD y 2 RV: la pantalla pedía las rutas sin sucursal, el
 * servidor respondía 400 «Elige la sucursal» y el error se pintaba como lista vacía.
 */
describe('TiendaArqueoComponent · [SM.45] rutas por sucursal', () => {
  let fix: ComponentFixture<TiendaArqueoComponent>;
  let cmp: TiendaArqueoComponent;
  const pedidas: (string | null | undefined)[] = [];
  /** Qué responde el servidor por sucursal; `'error'` = la llamada falla. */
  let respuesta: Record<string, 'error' | { rd: { route_code: string; label: string }[]; rv: { route_code: string; label: string }[] }> = {};

  const svc = {
    turnos: () => of({ turnos: [], aviso: null }),
    cajasDeSucursal: (code: string) => of({ warehouse_code: code, cajas: ['1', '2'] }),
    list: () => of([]),
    porCajera: () => of({ cajeras: [], totales: { cajeras: 0, cortes: 0, sin_arqueo: 0 } }),
    rutas: (code?: string | null) => {
      pedidas.push(code);
      const r = respuesta[code ?? ''];
      // Sin sucursal, el servidor real responde 400 «Elige la sucursal».
      if (!code || r === 'error' || !r) return throwError(() => new Error('400 Elige la sucursal'));
      return of({ warehouse_code: code, rd: r.rd, rv: r.rv });
    },
  };
  const html = (): string => (fix.nativeElement as HTMLElement).textContent ?? '';
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  beforeEach(async () => {
    pedidas.length = 0;
    respuesta = {
      '01': { rd: [{ route_code: '21', label: 'RUTA 21' }, { route_code: '22', label: 'RUTA 22' }], rv: [{ route_code: '1V001', label: '1V001' }] },
      '03': { rd: [], rv: [] },
    };
    await TestBed.configureTestingModule({
      imports: [TiendaArqueoComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(), MessageService,
        { provide: ArqueoService, useValue: svc },
        {
          provide: AuthService,
          useValue: {
            user: () => ({ username: 'luis_munoz', warehouse_code: null, role_name: 'auxiliar_tienda',
              permissions: { STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true, STORE_ARQUEO_RUTA_CAPTURAR: true } }),
            token: () => null,
          },
        },
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false } },
        { provide: DataScopeService, useValue: { warehouses: () => of([{ value: '01', label: 'PADRE HIDALGO' }, { value: '03', label: '8 ESQUINAS' }]) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaArqueoComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
    cmp.manual.set(true);
    cmp.elegirTipo('rd');
    await tick();
  });

  it('⭐ sin sucursal elegida NO afirma que no haya rutas: pide elegirla', async () => {
    expect(cmp.rutasEstado()).toBe('sin_sucursal');
    expect(html()).toContain('Elige la sucursal para ver sus rutas');
    // NEGATIVA: el mensaje falso del incidente no aparece.
    expect(html()).not.toContain('no tiene rutas');
  });

  it('⭐ al elegir la sucursal pide SUS rutas, y al cambiarla las vuelve a pedir', async () => {
    cmp.aSuc.set('01');
    await tick();
    expect(pedidas).toContain('01');
    expect(cmp.rutasEstado()).toBe('ok');
    expect(cmp.rutasDelTipo().map((r) => r.route_code)).toEqual(['21', '22']);
    expect(html()).not.toContain('no tiene rutas');

    cmp.aSuc.set('03');
    await tick();
    expect(pedidas[pedidas.length - 1]).toBe('03');
    // Vacío de verdad: ahora sí se dice, y con el nombre de la sucursal.
    expect(cmp.rutasDelTipo()).toEqual([]);
    expect(html()).toContain('no tiene rutas de reparto');
  });

  it('⭐ un error del servidor se dice como error, no como «no tiene rutas»', async () => {
    respuesta['01'] = 'error';
    cmp.aSuc.set('01');
    await tick();
    expect(cmp.rutasEstado()).toBe('error');
    expect(html()).toContain('No se pudieron consultar las rutas');
    expect(html()).not.toContain('no tiene rutas');

    // Reintentar vuelve a preguntar, y si ya responde, se ven las rutas.
    respuesta['01'] = { rd: [{ route_code: '21', label: 'RUTA 21' }], rv: [] };
    cmp.cargarRutas('01', true);
    await tick();
    expect(cmp.rutasEstado()).toBe('ok');
    expect(cmp.rutasDelTipo().map((r) => r.route_code)).toEqual(['21']);
  });

  /** [SM.46] RD/RV se arquean por RUTA: el campo Caja no se pide ni se exige. */
  const etiquetasHead = () => Array.from((fix.nativeElement as HTMLElement).querySelectorAll('.arq-head .arq-lbl'))
    .map((l) => (l.textContent || '').trim().split(/\s+/)[0]);

  it('⭐ [SM.46] en RD y RV no hay campo Caja; en cierre sí', async () => {
    expect(etiquetasHead()).not.toContain('Caja');
    cmp.elegirTipo('rv');
    await tick();
    expect(etiquetasHead()).not.toContain('Caja');
    // NEGATIVA: fuera de ruta el campo sigue ahí (no se quitó para todos).
    cmp.elegirTipo('cierre');
    await tick();
    expect(etiquetasHead()).toContain('Caja');
  });

  it('⭐ [SM.46] RD se sella con sucursal + ruta, sin caja', async () => {
    cmp.aSuc.set('01');
    await tick();
    cmp.vacio.set(true);
    cmp.aCaja = '';
    expect(cmp.canSubmit()).toBe(false);          // falta la ruta
    cmp.aRuta = '21';
    expect(cmp.canSubmit()).toBe(true);           // sin caja: ya se puede
    expect(cmp.rutaLabel()).toBe('RUTA 21');
    // NEGATIVA: en cierre, sin caja, NO se puede (la regla de caja sigue viva).
    cmp.elegirTipo('cierre');
    await tick();
    cmp.vacio.set(true);
    cmp.aCaja = '';
    expect(cmp.canSubmit()).toBe(false);
  });
});

/**
 * `[SM.47]` Dos mejoras pedidas por la operación:
 *
 *  1. **Total billetes y Total monedas** al cerrar cada familia en la tabla de captura (en
 *     todas las pestañas) y en el detalle de un arqueo guardado. No son casillas: Enter y las
 *     flechas los saltan.
 *  2. **«Conteo de efectivo»**: un arqueo SIN caja (sucursal + quién cuenta + motivo
 *     obligatorio) con permiso propio, para encargada, Finanzas y jefe de zona.
 */
describe('TiendaArqueoComponent · [SM.47] totales por familia y conteo de efectivo sin caja', () => {
  let fix: ComponentFixture<TiendaArqueoComponent>;
  let cmp: TiendaArqueoComponent;
  let svc: ArqueoStub & { turnosPedidos: number; sinCaja: any; submitSinCaja: (dto: any) => any };

  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  const montar = async (username: string, permissions: Record<string, boolean>, sucursales = [{ value: '04', label: 'PADRE HIDALGO' }]) => {
    const base = new ArqueoStub();
    svc = Object.assign(base, {
      turnosPedidos: 0,
      sinCaja: null as any,
      turnos(this: any) { this.turnosPedidos++; return of(this.resp); },
      submitSinCaja(this: any, dto: any) { this.sinCaja = dto; return of({ tipo: 'sin_caja', secuencia: 1, total_contado: 2000, medible: false, motivo_no_medible: 'sin_esperado' }); },
    });
    await TestBed.configureTestingModule({
      imports: [TiendaArqueoComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(), MessageService,
        { provide: ArqueoService, useValue: svc },
        { provide: AuthService, useValue: { user: () => ({ username, warehouse_code: null, role_name: 'x', permissions }), token: () => null } },
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false } },
        { provide: DataScopeService, useValue: { warehouses: () => of(sucursales) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaArqueoComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
  };

  const etiquetasHead = () => Array.from(el().querySelectorAll('.arq-head .arq-lbl'))
    .map((l) => (l.textContent || '').trim());

  describe('totales de billetes y de monedas', () => {
    beforeEach(async () => {
      await montar('10c02', { STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true });
      cmp.manual.set(true);
      await tick();
    });

    const filas = () => Array.from(el().querySelectorAll('.arq-lista > .arq-lista-row'));

    it('⭐ «Total billetes» cierra los billetes y «Total monedas» cierra las monedas', async () => {
      cmp.denomCount['1000'] = 2; cmp.denomCount['20'] = 1; cmp.denomCount['20m'] = 3; cmp.denomCount['0.5'] = 4;
      cmp.recalc();
      await tick();
      const r = filas();
      const iBil = r.findIndex((x) => x.getAttribute('data-sub') === 'billetes');
      const iMon = r.findIndex((x) => x.getAttribute('data-sub') === 'monedas');
      // Justo después del billete de $20 y justo antes del pie.
      expect(r[iBil - 1].textContent).toContain('billete');
      expect(r[iBil + 1].textContent).toContain('moneda');
      expect(r[iMon + 1].classList.contains('arq-lista-foot')).toBe(true);
      // El billete y la moneda de $20 caen cada uno en SU familia (SM.39).
      expect(r[iBil].textContent).toContain('3 pzas');
      expect(r[iBil].textContent).toContain('$2,020.00');
      expect(r[iMon].textContent).toContain('7 pzas');
      expect(r[iMon].textContent).toContain('$62.00');
      expect(el().querySelector('.arq-lista-foot')?.textContent).toContain('$2,082.00');
    });

    it('sin captura los totales dicen $0.00, no NaN', async () => {
      const t = el().querySelector('[data-sub="billetes"]')?.textContent ?? '';
      expect(t).toContain('$0.00');
      expect(t).not.toContain('NaN');
    });

    it('⭐ NO son casillas: siguen siendo 12 entradas y Enter del billete de $20 baja a la moneda de $20', async () => {
      const inputs = Array.from(el().querySelectorAll<HTMLInputElement>('.arq-lista input.arq-num'));
      expect(inputs.length).toBe(12);
      expect(el().querySelectorAll('.arq-lista-sub input').length).toBe(0);
      inputs[5].focus();
      cmp.onCellKey(new KeyboardEvent('keydown', { key: 'Enter' }), 0, 5);
      expect(document.activeElement).toBe(inputs[6]);
      expect(inputs[6].getAttribute('aria-label')).toContain('monedas de $20');
    });

    it('aparecen también en Retiro y Relevo', async () => {
      for (const t of ['retiro', 'relevo']) {
        cmp.elegirTipo(t);
        await tick();
        expect(el().querySelector('[data-sub="billetes"]')).not.toBeNull();
        expect(el().querySelector('[data-sub="monedas"]')).not.toBeNull();
      }
    });
  });

  describe('«Conteo de efectivo» (sin caja)', () => {
    it('⭐ Finanzas (solo el permiso nuevo) abre directo en su pestaña: sin turnos, sin Caja, firma propia', async () => {
      await montar('ana_fin', { STORE_ARQUEO_SIN_CAJA_CAPTURAR: true });
      expect(cmp.aTipo()).toBe('sin_caja');
      expect(cmp.tipoOptions().map((o) => o.value)).toEqual(['sin_caja']);
      expect(cmp.tipoOptions()[0].label).toBe('Conteo de efectivo');
      // No pide turnos de Kepler: no tiene permiso para eso y le daria 403.
      expect(svc.turnosPedidos).toBe(0);
      const lbls = etiquetasHead();
      expect(lbls.some((l) => l.startsWith('Caja'))).toBe(false);
      expect(lbls.some((l) => l.startsWith('Quién hace el arqueo'))).toBe(true);
      const quien = el().querySelector<HTMLInputElement>('input.arq-fld-cajero');
      expect(quien?.value).toBe('ANA_FIN');
      expect(quien?.readOnly).toBe(true);
      expect(el().textContent).toContain('Motivo del conteo');
    });

    it('⭐ sin motivo no se guarda; con motivo sale por SU endpoint con sucursal y motivo', async () => {
      await montar('ana_fin', { STORE_ARQUEO_SIN_CAJA_CAPTURAR: true });
      cmp.denomCount['1000'] = 2; cmp.recalc();
      cmp.aMotivo = '   ';
      expect(cmp.canSubmit()).toBe(false);
      cmp.aMotivo = 'Caja fuerte';
      expect(cmp.canSubmit()).toBe(true);
      cmp.submit();
      expect(svc.sinCaja).toMatchObject({ warehouse_code: '04', motivo: 'Caja fuerte', denominations: { 1000: 2 } });
      expect(svc.sinCaja.caja).toBeUndefined();
      // NEGATIVA: no se fue por la puerta de la cajera.
      expect(svc.enviado).toBeNull();
    });

    it('con varias sucursales hay que elegir una antes de guardar', async () => {
      await montar('ana_fin', { STORE_ARQUEO_SIN_CAJA_CAPTURAR: true },
        [{ value: '01', label: 'MATRIZ' }, { value: '04', label: 'PADRE HIDALGO' }]);
      cmp.denomCount['1000'] = 1; cmp.recalc(); cmp.aMotivo = 'fondo';
      expect(cmp.canSubmit()).toBe(false);
      cmp.aSuc.set('01');
      expect(cmp.canSubmit()).toBe(true);
    });

    it('la encargada la ve AL FINAL, junto a las pestañas de siempre', async () => {
      await montar('enc', { STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true, STORE_ARQUEO_SIN_CAJA_CAPTURAR: true });
      expect(cmp.tipoOptions().map((o) => o.value)).toEqual(['retiro', 'cierre', 'relevo', 'sin_caja']);
      // CONTROL: sigue pidiendo sus turnos.
      expect(svc.turnosPedidos).toBeGreaterThan(0);
    });

    it('NEGATIVA: la cajera sin el permiso NO ve la pestaña', async () => {
      await montar('10c02', { STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true });
      expect(cmp.tipoOptions().map((o) => o.value)).not.toContain('sin_caja');
    });
  });
});

/** [SM.48] «Sucursales y sus cajas» trae el esperado: es de quien valida, nunca de la cajera. */
describe('TiendaArqueoComponent · [SM.48] quién ve las cajas', () => {
  const montar = async (permissions: Record<string, boolean>) => {
    const svc = Object.assign(new ArqueoStub(), {
      cajas: () => of({ fecha: '2026-10-26', umbral: 50, sucursales: [] }),
    });
    await TestBed.configureTestingModule({
      imports: [TiendaArqueoComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(), MessageService,
        { provide: ArqueoService, useValue: svc },
        { provide: AuthService, useValue: { user: () => ({ username: 'x', warehouse_code: '01', role_name: 'x', permissions }), token: () => null } },
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false } },
        { provide: DataScopeService, useValue: { warehouses: () => of([{ value: '01', label: 'PADRE HIDALGO' }]) } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(TiendaArqueoComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  };

  it('⭐ quien valida la ve en lugar de «Arqueos recientes»', async () => {
    const el = await montar({ STORE_ARQUEO_VER: true, STORE_ARQUEO_CAPTURAR: true, RECONCILIATION_VER: true });
    expect(el.querySelector('app-arqueo-cajas')).not.toBeNull();
    expect(el.textContent).not.toContain('Arqueos recientes');
  });

  it('⭐ NEGATIVA: la cajera NO la ve (el arqueo es ciego)', async () => {
    const el = await montar({ STORE_ARQUEO_VER: true, STORE_ARQUEO_CAPTURAR: true });
    expect(el.querySelector('app-arqueo-cajas')).toBeNull();
  });
});

/**
 * [SM.49] La barra de pestañas entra a UN menú, y el retiro lleva su concepto.
 * Arriba los conceptos (Pago a proveedor, Gasto de la sucursal, Depósito al banco,
 * Otro…); abajo «Otros arqueos» con «Retiro de caja» primero.
 */
describe('TiendaArqueoComponent · [SM.49] menú del tipo de arqueo y concepto del retiro', () => {
  let fix: ComponentFixture<TiendaArqueoComponent>;
  let cmp: TiendaArqueoComponent;
  let svc: ArqueoStub;
  const tick = async (): Promise<void> => { await fix.whenStable(); await new Promise((r) => setTimeout(r, 0)); fix.detectChanges(); };

  const montar = async (permissions: Record<string, boolean>) => {
    svc = new ArqueoStub();
    await TestBed.configureTestingModule({
      imports: [TiendaArqueoComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(), MessageService,
        { provide: ArqueoService, useValue: svc },
        { provide: AuthService, useValue: { user: () => ({ username: '10c02', warehouse_code: '01', role_name: 'x', permissions }), token: () => null } },
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false } },
        { provide: DataScopeService, useValue: { warehouses: () => of([{ value: '01', label: 'PADRE HIDALGO' }]) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaArqueoComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
    cmp.manual.set(true);
    cmp.aCaja = '2';
    await tick();
  };
  const cajera = { STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true };
  const contar = () => { cmp.denomCount['1000'] = 1; cmp.recalc(); };

  it('⭐ ya no hay barra de pestañas: un solo menú, que abre en «Retiro · elige el concepto»', async () => {
    await montar(cajera);
    const el = fix.nativeElement as HTMLElement;
    expect(el.querySelector('app-segmented')).toBeNull();
    expect(el.querySelector('.arq-tipo-sel')).not.toBeNull();
    expect(cmp.aTipo()).toBe('retiro');
    expect(cmp.menuValor()).toBeNull();
    expect(el.textContent).toContain('Retiro · elige el concepto');
  });

  it('⭐ el menú: conceptos arriba, y «Retiro de caja» primero en «Otros arqueos»', async () => {
    await montar(cajera);
    const g = cmp.menuTipos();
    expect(g.map((x) => x.label)).toEqual(['Retiro', 'Otros arqueos']);
    expect(g[0].items.map((i) => i.label)).toEqual(['Pago a proveedor', 'Pago de nómina', 'Gasto de la sucursal (caja chica)', 'Depósito al banco', 'Otro…']);
    expect(g[1].items.map((i) => i.label)).toEqual(['Retiro de caja', 'Cierre de día', 'Relevo']);
    // NEGATIVA: ni «sin concepto» ni «Cambio / feria» (se quitaron a pedido).
    const todo = JSON.stringify(g);
    expect(todo).not.toContain('sin concepto');
    expect(todo).not.toContain('feria');
  });

  it('⭐ un retiro NO se guarda sin concepto; con concepto sí, y viaja al servidor', async () => {
    await montar(cajera);
    contar();
    expect(cmp.canSubmit()).toBe(false);
    cmp.elegirMenu('retiro:pago_proveedor');
    expect(cmp.canSubmit()).toBe(true);
    cmp.submit();
    expect(svc.enviado).toMatchObject({ tipo: 'retiro', concepto: 'pago_proveedor' });
    expect(svc.enviado.motivo).toBeUndefined();
  });

  it('⭐ «Otro» exige escribir el motivo, y lo manda', async () => {
    await montar(cajera);
    contar();
    cmp.elegirMenu('retiro:otro');
    await tick();
    const el = fix.nativeElement as HTMLElement;
    expect(el.textContent).toContain('¿Por qué es el retiro?');
    expect(cmp.canSubmit()).toBe(false);
    // El aviso rojo NO sale antes de que la cajera escriba o salga del recuadro.
    expect(el.querySelector('.arq-motivo-err')).toBeNull();
    cmp.motivoTocado.set(true); await tick();
    expect(el.querySelector('.arq-motivo-err')).not.toBeNull();
    cmp.aMotivo = 'se pagó el gas';
    expect(cmp.canSubmit()).toBe(true);
    cmp.submit();
    expect(svc.enviado).toMatchObject({ tipo: 'retiro', concepto: 'otro', motivo: 'se pagó el gas' });
  });

  it('elegir otro tipo de arqueo deja de pedir concepto y no lo manda', async () => {
    await montar(cajera);
    cmp.elegirMenu('retiro:pago_proveedor');
    cmp.elegirMenu('cierre');
    contar();
    expect(cmp.aTipo()).toBe('cierre');
    expect(cmp.menuValor()).toBe('cierre');
    expect(cmp.canSubmit()).toBe(true);
    cmp.submit();
    expect(svc.enviado.concepto).toBeUndefined();
  });

  it('cuando Kepler pide la sangría, el menú queda en «Retiro de caja»', async () => {
    await montar(cajera);
    svc.resp = { turnos: [turno({ pide_retiro: true } as Partial<Turno>)], aviso: null };
    cmp.manual.set(false);
    cmp.ngOnInit();
    await tick();
    cmp.elegirTurno('87');   // sugerirTipo corre al elegir el turno
    await tick();
    expect(cmp.aTipo()).toBe('retiro');
    expect(cmp.menuValor()).toBe('retiro:retiro_caja');
  });

  it('con permiso de rutas aparecen RD y RV en «Otros arqueos»', async () => {
    await montar({ ...cajera, STORE_ARQUEO_RUTA_CAPTURAR: true });
    expect(cmp.menuTipos()[1].items.map((i) => i.value)).toEqual(['retiro:retiro_caja', 'cierre', 'relevo', 'rd', 'rv']);
  });

  it('Finanzas (solo conteo sin caja) ve un menú con esa única opción', async () => {
    await montar({ STORE_ARQUEO_SIN_CAJA_CAPTURAR: true });
    const g = cmp.menuTipos();
    expect(g.length).toBe(1);
    expect(g[0].items.map((i) => i.label)).toEqual(['Conteo de efectivo']);
  });
});

/**
 * [SM.51] La cajera elige SU caja y el arqueo se guarda con ella. Se quitaron la lista de
 * turnos de Kepler, los avisos de arriba y su historial.
 */
describe('TiendaArqueoComponent · [SM.51] la caja la elige la cajera', () => {
  let fix: ComponentFixture<TiendaArqueoComponent>;
  let cmp: TiendaArqueoComponent;
  let svc: ArqueoStub;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const tick = async (): Promise<void> => { await fix.whenStable(); await new Promise((r) => setTimeout(r, 0)); fix.detectChanges(); };

  const montar = async (resp: TurnosResp = { turnos: [], aviso: null }, cajas = ['1', '2', '3']) => {
    svc = new ArqueoStub();
    svc.resp = resp;
    svc.cajasLista = cajas;
    await TestBed.configureTestingModule({
      imports: [TiendaArqueoComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(), MessageService,
        { provide: ArqueoService, useValue: svc },
        { provide: AuthService, useValue: { user: () => ({ username: '10c02', warehouse_code: '01', role_name: 'cajero', permissions: { STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true } }), token: () => null } },
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false } },
        { provide: DataScopeService, useValue: { warehouses: () => of([{ value: '01', label: 'PADRE HIDALGO' }]) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaArqueoComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
  };
  beforeEach(() => { try { localStorage.clear(); } catch { /* sin almacenamiento */ } });

  it('⭐ la caja se elige de las que Kepler usó en la sucursal, y el arqueo se guarda con ESA caja', async () => {
    await montar();
    expect(cmp.cajasOpciones().map((c) => c.label)).toEqual(['Caja 1', 'Caja 2', 'Caja 3']);
    cmp.elegirCaja('3');
    cmp.elegirMenu('retiro:retiro_caja');
    cmp.denomCount['1000'] = 1; cmp.recalc();
    expect(cmp.canSubmit()).toBe(true);
    cmp.submit();
    expect(svc.enviado).toMatchObject({ caja: '3', warehouse_code: '01' });
    // NEGATIVA: no viaja un folio de Kepler elegido en pantalla (lo pone el servidor por caja + hora).
    expect(svc.enviado.cash_cut_folio).toBeUndefined();
  });

  it('⭐ sin caja elegida no se guarda', async () => {
    await montar();
    cmp.elegirMenu('retiro:retiro_caja');
    cmp.denomCount['1000'] = 1; cmp.recalc();
    expect(cmp.canSubmit()).toBe(false);
  });

  it('⭐ el equipo recuerda la última caja elegida en esa sucursal', async () => {
    await montar();
    cmp.elegirCaja('2');
    TestBed.resetTestingModule();
    await montar();
    expect(cmp.aCaja).toBe('2');
  });

  it('NEGATIVA: una caja recordada que ya no existe en la sucursal NO se preselecciona', async () => {
    try { localStorage.setItem('arqueo.caja.01', '9'); } catch { /* idem */ }
    await montar();
    expect(cmp.aCaja).toBe('');
  });

  it('si no se pudo traer la lista de cajas, la caja se teclea', async () => {
    await montar(undefined, []);
    expect(el().querySelector('input.arq-fld-sm')).not.toBeNull();
  });

  it('⭐ con turnos de Kepler pendientes, NO se ven ni la lista ni los avisos, y no se preselecciona turno', async () => {
    await montar({
      turnos: [turno(), turno({ folio: '88', caja: '3' })],
      aviso: { cajas: [{ warehouse_code: '01', caja: '1', folio: '1', business_date: '2026-09-29', hora_apertura: '08:00', dias_abierta: 0 }], arrastradas: [{ warehouse_code: '01', caja: '4', folio: '2', business_date: '2026-09-20', hora_apertura: '08:00', dias_abierta: 9 }] },
    });
    const t = el().textContent ?? '';
    expect(t).not.toContain('cortes');
    expect(t).not.toContain('sin arquear');
    expect(t).not.toContain('Tienes dos cajas abiertas');
    expect(t).not.toContain('días anteriores');
    expect(el().querySelectorAll('button.arq-turno').length).toBe(0);
    expect(cmp.turnoSel()).toBeNull();
  });

  it('⭐ la cajera NO tiene historial (ni «Tus cortes de hoy» ni buscador)', async () => {
    await montar();
    cmp.rows.set([{ id: 'a', tipo: 'cierre', warehouse_code: '01', caja: '2', business_date: '2026-11-05', turno: null,
      cajero_code: '10C02', cajero_entrante: null, cajero_nombre: null, total_contado: 500, captured_by: '10c02',
      captured_at: '2026-11-05T15:00:00.000Z', nota: null, incidencia_tipo: null } as ArqueoRow]);
    await tick();
    expect(el().textContent).not.toContain('Tus cortes de hoy');
    expect(el().querySelector('.arq-hist-bar')).toBeNull();
    expect(el().querySelector('p-table')).toBeNull();
  });
});
