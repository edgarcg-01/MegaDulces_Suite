import { describe, it, expect } from 'vitest';
import { PromoSelloutService, ResultadoCanal, EstadoMedicion } from './promo-sellout.service';

/**
 * `[MKT.6]` — **El rollup no puede sumar lo que no se pudo medir.**
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────────────
 * Un acuerdo tiene N canales y cada uno puede estar en uno de cuatro estados. La tentación
 * evidente al totalizar es `sum(monto ?? 0)` — y eso convierte "no se pudo medir" en "vendió
 * cero", que es la conclusión CONTRARIA. Un acuerdo con seis plazas sin códigos ligados al
 * catálogo se leería como un fracaso comercial cuando lo que hay es un problema de captura.
 *
 * No es hipotético: la Fase MR midió en producción una pantalla que publicaba 100% de cobertura
 * "por construcción", y la VP encontró 21 de 24 píldoras declarando frescura que nadie medía.
 * El patrón siempre es el mismo — el ausente se dibuja como un valor.
 *
 * ── Por qué con dobles y no por HTTP ────────────────────────────────────────────────────────
 * ADR-044 manda probar por HTTP lo que toca Postgres, y la aritmética de la venta vive en la
 * VISTA: eso lo prueba `database/tests/test-newdb-promo-sellout.js`, contra un recálculo
 * independiente. Acá el sujeto es otro: `resumir()` es una función pura de TypeScript, y es
 * justo donde un `?? 0` mete un número inventado sin que ninguna consulta se entere.
 */

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

/** El servicio sin base: `resumir` es puro, así que los dos colaboradores no se usan. */
const svc = () => new PromoSelloutService(null as never, null as never);

describe('[MKT.6] resumir() · no suma lo que no se pudo medir', () => {
  it('⭐ NEGATIVA: un canal sin alcance NO aporta 0 al total — queda fuera y se nombra', () => {
    const r = svc().resumir('a1', [
      canal({ channel_id: 'c1', monto_ventana: 1000, monto_baseline: 800, uplift_monto: 200 }),
      // Sin códigos ligados no hay nada que mirar. Si entrara como 0, el uplift se diluiría.
      canal({
        channel_id: 'c2',
        medicion: 'sin_alcance',
        codigos_ligados: 0,
        monto_ventana: null,
        monto_baseline: null,
        uplift_monto: null,
        uplift_pct: null,
      }),
    ]);

    expect(r.canales_total).toBe(2);
    expect(r.canales_medidos).toBe(1);
    expect(r.no_medidos.sin_alcance).toBe(1);
    // Lo clave: el total es el del canal medido, NO 1000 repartido entre dos.
    expect(r.monto_ventana).toBe(1000);
    expect(r.monto_baseline).toBe(800);
    expect(r.uplift_monto).toBe(200);
    expect(r.uplift_pct).toBe(25);
  });

  it('los no medidos suman exactamente `total − medidos`: ninguno se pierde por el camino', () => {
    const estados: EstadoMedicion[] = ['medida', 'sin_venta', 'sin_baseline', 'sin_alcance', 'sin_venta'];
    const r = svc().resumir(
      'a1',
      estados.map((m, i) => canal({ channel_id: `c${i}`, medicion: m })),
    );
    const sumaNoMedidos =
      r.no_medidos.sin_venta + r.no_medidos.sin_baseline + r.no_medidos.sin_alcance;
    expect(r.canales_total).toBe(5);
    expect(r.canales_medidos).toBe(1);
    expect(sumaNoMedidos).toBe(r.canales_total - r.canales_medidos);
    expect(r.no_medidos).toEqual({ sin_venta: 2, sin_baseline: 1, sin_alcance: 1 });
  });

  it('⭐ sin NINGÚN canal medido, el total es NULL — no 0', () => {
    const r = svc().resumir('a1', [
      canal({ medicion: 'sin_alcance', monto_ventana: null, monto_baseline: null }),
      canal({ channel_id: 'c2', medicion: 'sin_venta', monto_ventana: null, monto_baseline: null }),
    ]);
    // Un 0 acá diría "esta promoción no vendió nada", que es justo lo que NO se sabe.
    expect(r.monto_ventana).toBeNull();
    expect(r.monto_baseline).toBeNull();
    expect(r.uplift_monto).toBeNull();
    expect(r.uplift_pct).toBeNull();
    expect(r.canales_medidos).toBe(0);
  });

  it('⭐ con línea base en 0 no publica porcentaje: no es "+infinito%", es "no había base"', () => {
    const r = svc().resumir('a1', [
      canal({ monto_ventana: 500, monto_baseline: 0, uplift_monto: 500, uplift_pct: null }),
    ]);
    expect(r.uplift_monto).toBe(500);
    expect(r.uplift_pct).toBeNull();
    expect(Number.isFinite(r.uplift_pct as number)).toBe(false);
  });

  it('suma en centavos, sin arrastrar el error binario del punto flotante', () => {
    // 0.1 + 0.2 === 0.30000000000000004. En dinero eso es una diferencia que alguien reporta.
    const r = svc().resumir('a1', [
      canal({ channel_id: 'c1', monto_ventana: 0.1, monto_baseline: 0 }),
      canal({ channel_id: 'c2', monto_ventana: 0.2, monto_baseline: 0 }),
    ]);
    expect(r.monto_ventana).toBe(0.3);
  });

  it('la cobertura de códigos es del ACUERDO: no se subestima con el canal más pobre', () => {
    // Todos los canales del mismo acuerdo traen el mismo par; si una fila llegara en 0,
    // reportarlo haría ver como "nada ligado" un acuerdo que sí lo está.
    const r = svc().resumir('a1', [
      canal({ channel_id: 'c1', codigos_total: 6, codigos_ligados: 4 }),
      canal({ channel_id: 'c2', codigos_total: 6, codigos_ligados: 4 }),
    ]);
    expect(r.codigos_total).toBe(6);
    expect(r.codigos_ligados).toBe(4);
  });

  it('una sola ventana abierta contagia al acuerdo: la cifra completa es provisional', () => {
    const r = svc().resumir('a1', [
      canal({ channel_id: 'c1', ventana_abierta: false }),
      canal({ channel_id: 'c2', ventana_abierta: true }),
    ]);
    // Si el acuerdo dijera "cerrado" con un canal HASTA AGOTAR, mañana el total cambiaría
    // sin que nadie pudiera explicar por qué.
    expect(r.ventana_abierta).toBe(true);
  });

  it('la evidencia se agrega aparte del resultado: ejecutar y vender son dos preguntas', () => {
    const r = svc().resumir('a1', [
      canal({ channel_id: 'c1', evidence_required: 2, evidence_count: 2 }),
      canal({ channel_id: 'c2', evidence_required: 3, evidence_count: 0, medicion: 'sin_venta' }),
    ]);
    expect(r.evidencia_requerida).toBe(5);
    // El canal que no vendió igual cuenta su evidencia: "ejecutó y no vendió" es un hallazgo.
    expect(r.evidencia_subida).toBe(2);
  });
});
