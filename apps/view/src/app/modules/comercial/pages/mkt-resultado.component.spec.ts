import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';

import { MktResultadoComponent } from './mkt-resultado.component';
import { ResultadoCanal } from '../promo-sellout.service';
import { environment } from '../../../../environments/environment';

/**
 * `[MKT.6]` — **La pantalla no puede convertir "no se pudo medir" en "$0".**
 *
 * ── Qué defecto vigila ───────────────────────────────────────────────────────────────────────
 * Un canal llega con `monto_ventana: null` en tres situaciones que significan cosas distintas:
 *
 *   · `medicion: 'sin_alcance'`  → *no se pudo mirar* (ningún código ligado al catálogo)
 *   · `medicion: 'sin_venta'`    → *se miró y no vendió*
 *   · `medicion: 'sin_baseline'` → *vendió, pero no hay periodo anterior con qué comparar*
 *
 * Lo natural en Angular —`{{ r.monto_ventana | currency }}`— imprime `$0.00` en los tres casos, y
 * ahí la pantalla afirma que la promoción no vendió nada justo cuando lo que pasa es que nadie
 * ligó los códigos. Es la conclusión contraria a la verdadera (ADR-056), y no es hipotético: los
 * 21 canales del seed de `[MKT.1]` están hoy en `sin_alcance`.
 *
 * El otro defecto, en el KPI: sumar los canales no medidos como cero **diluye** el uplift de los
 * que sí se midieron y no deja rastro de cuántos quedaron fuera.
 *
 * ── Por qué con TestBed y no con una función suelta ─────────────────────────────────────────
 * `tsc` no mira dentro del template de Angular. Montar el componente es lo que fuerza al
 * compilador de Angular a revisarlo — que es donde viven los `NG5002` y los errores de binding
 * que el build de la librería no ve.
 */

const BASE = `${environment.apiUrl}/commercial/promo-sellout`;

/** Un canal con lo mínimo; cada prueba pisa lo que le importa. */
const canal = (over: Partial<ResultadoCanal> = {}): ResultadoCanal => ({
  channel_id: 'c1',
  agreement_id: 'a1',
  folio: 'MK-2026-1013',
  empresa: 'MD',
  proveedor: 'Alteño',
  agreement_status: 'vigente',
  warehouse_code: '01',
  warehouse_name: 'Padre Hidalgo',
  desde: '2026-08-01',
  hasta: '2026-08-14',
  dias_ventana: 14,
  ventana_abierta: false,
  monto_negociado: 50000,
  codigos_total: 2,
  codigos_ligados: 2,
  evidence_required: 1,
  evidence_count: 1,
  dias_con_venta: 12,
  monto_ventana: 1000,
  monto_baseline: 800,
  uplift_monto: 200,
  uplift_pct: 25,
  units_ventana: 100,
  units_baseline: 80,
  unidad_estado: 'unica',
  medicion: 'medida',
  ...over,
});

function montar(filas: ResultadoCanal[]) {
  TestBed.configureTestingModule({
    imports: [MktResultadoComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      MessageService,
    ],
  });
  const fixture = TestBed.createComponent(MktResultadoComponent);
  const http = TestBed.inject(HttpTestingController);
  // El componente carga en el constructor: la petición ya está encolada.
  http.expectOne(BASE).flush(filas);
  fixture.detectChanges();
  return { fixture, http, comp: fixture.componentInstance };
}

describe('[MKT.6] MktResultadoComponent · un nulo no es un cero', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  /**
   * ⚠️ `p-table` con `[scrollable]="true"` monta el cuerpo en un ciclo posterior: con un solo
   * `detectChanges()` la cabecera y los KPIs ya están y las FILAS todavía no. Hay que esperar a
   * que se estabilice, o la aserción de la fila falla por la mecánica del componente y no por
   * un defecto de la pantalla.
   */
  it('monta y pinta la tabla (esto es lo que compila el template — tsc no lo hace)', async () => {
    const { fixture } = montar([canal()]);
    await fixture.whenStable();
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(texto).toContain('Resultado de la activación');
    expect(texto).toContain('Alteño');
    // La plaza y el folio también: son las dos columnas con las que alguien ubica la fila.
    expect(texto).toContain('Padre Hidalgo');
    expect(texto).toContain('MK-2026-1013');
  });

  it('⭐ NEGATIVA: un canal sin medir se dibuja con guion, NUNCA con $0.00', () => {
    const { comp } = montar([
      canal({ medicion: 'sin_alcance', monto_ventana: null, monto_baseline: null, uplift_monto: null, uplift_pct: null }),
    ]);
    // `dinero()` es el único lugar por el que pasa todo importe de la pantalla.
    expect(comp.dinero(null)).toBe('—');
    expect(comp.dinero(undefined)).toBe('—');
    expect(comp.dinero(null)).not.toContain('0');
    // Y el cero de verdad sí se dibuja como cero: si todo fuera guion, no se podría distinguir
    // "vendió cero" de "no se midió", que es justo el defecto al revés.
    expect(comp.dinero(0)).toContain('0');
  });

  it('⭐ el KPI se calcula SÓLO sobre los medidos y dice sobre cuántos', () => {
    const { comp } = montar([
      canal({ channel_id: 'c1', monto_ventana: 1000, monto_baseline: 800 }),
      canal({ channel_id: 'c2', medicion: 'sin_alcance', monto_ventana: null, monto_baseline: null }),
      canal({ channel_id: 'c3', medicion: 'sin_venta', monto_ventana: null, monto_baseline: null }),
    ]);
    const kpis = comp.kpis();
    // Venta = 1000, no 1000 repartido entre tres ni diluido por dos ceros inventados.
    expect(kpis[0].value).toBe(1000);
    expect(kpis[0].sub).toBe('sobre 1 de 3 canales');
    expect(kpis[2].value).toBe(200);
    expect(comp.noMedidos()).toBe(2);
  });

  it('⭐ sin NINGÚN canal medido el KPI dice guion, no $0', () => {
    const { comp } = montar([
      canal({ medicion: 'sin_alcance', monto_ventana: null, monto_baseline: null }),
    ]);
    const kpis = comp.kpis();
    expect(kpis[0].value).toBe('—');
    expect(kpis[2].sub).toBe('nada que se haya podido medir');
  });

  it('con línea base en 0 el KPI no publica porcentaje', () => {
    const { comp } = montar([canal({ monto_ventana: 500, monto_baseline: 0, uplift_pct: null })]);
    expect(comp.kpis()[2].sub).toBe('sin base para el %');
  });

  it('el aviso de arriba desglosa POR MOTIVO, no un total mudo', () => {
    const { fixture, comp } = montar([
      canal({ channel_id: 'c1', medicion: 'sin_alcance' }),
      canal({ channel_id: 'c2', medicion: 'sin_alcance' }),
      canal({ channel_id: 'c3', medicion: 'sin_venta' }),
    ]);
    fixture.detectChanges();
    expect(comp.cuenta('sin_alcance')).toBe(2);
    expect(comp.cuenta('sin_venta')).toBe(1);
    const texto = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(texto).toContain('sin códigos ligados al catálogo');
    expect(texto).toContain('sin ventas en la vigencia');
  });

  it('`sin_alcance` es aviso (warn), no fracaso (danger): es captura, no resultado', () => {
    const { comp } = montar([canal()]);
    expect(comp.tono('sin_alcance')).toBe('warn');
    expect(comp.tono('sin_venta')).toBe('danger');
    expect(comp.tono('medida')).toBe('success');
    // Cada estado tiene su propia etiqueta legible: dos estados con el mismo texto serían uno.
    const etiquetas = (['medida', 'sin_venta', 'sin_baseline', 'sin_alcance'] as const)
      .map((e) => comp.etiqueta(e));
    expect(new Set(etiquetas).size).toBe(4);
  });

  it('los filtros particionan: la suma de los cuatro estados es el total', () => {
    const { comp } = montar([
      canal({ channel_id: 'c1', medicion: 'medida' }),
      canal({ channel_id: 'c2', medicion: 'sin_venta' }),
      canal({ channel_id: 'c3', medicion: 'sin_baseline' }),
      canal({ channel_id: 'c4', medicion: 'sin_alcance' }),
    ]);
    const suma = (['medida', 'sin_venta', 'sin_baseline', 'sin_alcance'] as const)
      .reduce((a, e) => a + comp.conteoFiltro(e), 0);
    expect(suma).toBe(comp.conteoFiltro('todos'));
    comp.setFiltro('sin_alcance');
    expect(comp.visibles().length).toBe(1);
  });

  /**
   * `[UIM.2]` — **La tabla tiene que decir algo en un teléfono, y el rótulo tiene que viajar.**
   *
   * Ocho columnas no entran en 390 px. La salida del repo es `.dt-scope` en el contenedor +
   * `.dt-stack` en la tabla, y entonces cada celda baja como un renglón propio.
   *
   * ⚠️ Por qué esto necesita una prueba y no alcanza con `check:tables`: esa compuerta sólo mira
   * que las DOS CLASES estén en el archivo. Con las clases puestas y las celdas sin `data-label`,
   * el gate se pone verde y el teléfono muestra una columna de valores pelados —ocho números sin
   * decir cuál es la venta y cuál la base—, que es peor que el scroll. El rótulo se pinta con
   * `::before { content: attr(data-label) }`: si el atributo falta, no hay rótulo y nada falla.
   *
   * Y `role="cell"` no es adorno: al dejar de ser `display: table-cell` la celda PIERDE su rol
   * implícito, y el lector de pantalla encuentra filas sin celdas adentro.
   */
  it('⭐ apilada en teléfono: cada celda baja CON su rótulo y con su rol', async () => {
    const { fixture } = montar([canal()]);
    await fixture.whenStable();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // 1. El contenedor establece la consulta. Sin esto el CSS entero es inerte.
    expect(host.querySelector('.res-tabla.dt-scope')).toBeTruthy();
    // 2. La tabla declara que apila.
    expect(host.querySelector('.dt-stack')).toBeTruthy();

    // 3. Cada celda del cuerpo: rol explícito, y rótulo salvo la que ES la identidad.
    const celdas = Array.from(host.querySelectorAll('tbody > tr > td'));
    expect(celdas.length).toBe(8);
    for (const td of celdas) {
      expect(td.getAttribute('role')).toBe('cell');
      // `.dt-id` sube al tope sin rótulo porque se explica solo (el nombre del proveedor).
      const rotulada = td.classList.contains('dt-id') || !!td.getAttribute('data-label');
      expect(rotulada).toBe(true);
    }

    // 4. Los rótulos son los del encabezado, no un invento: si alguien renombra una columna y
    //    olvida el data-label, el teléfono rotula con el nombre viejo y nadie se entera.
    const encabezados = Array.from(host.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
    const rotulos = celdas.map((td) => td.getAttribute('data-label')).filter((x): x is string => !!x);
    for (const r of rotulos) expect(encabezados).toContain(r);
  });

  it('abrir una fila pide su cobertura y su conciliación; cerrarla las limpia', () => {
    const { comp, http } = montar([canal()]);
    comp.abrir(canal());
    http.expectOne(`${BASE}/acuerdo/a1/cobertura`)
      .flush({ codigos_total: 6, ligados: 2, sin_ligar_resolubles: 4, sin_ligar_sin_match: 0 });
    http.expectOne(`${BASE}/acuerdo/a1/conciliacion`).flush({
      agreement_id: 'a1', folio: null, proveedor: 'Alteño', monto_negociado: 50000,
      monto_acreditado: null, documentos: 0, metodo: 'sin_liga',
      estado: 'fuente_vacia', nota: 'El espejo está vacío.',
    });
    expect(comp.cobertura()?.sin_ligar_resolubles).toBe(4);
    // Fuente vacía: la pantalla muestra el motivo, y el monto acreditado sigue siendo nulo.
    expect(comp.conciliacion()?.estado).toBe('fuente_vacia');
    expect(comp.dinero(comp.conciliacion()?.monto_acreditado ?? null)).toBe('—');
    comp.cerrar();
    expect(comp.cobertura()).toBeNull();
    expect(comp.seleccion).toBeNull();
  });
});
