/**
 * CG.20 — Pruebas del lote y de los frecuentes (ADR-070).
 *
 * Las dos que definen la fase son negativas:
 *   · una ruta sin cuenta declarada **NO** se puede confirmar en lote — cae a captura manual, y
 *     nunca a una cuenta adivinada;
 *   · una fila que falla **NO** tumba a las demás — si el lote fuera todo-o-nada, la persona
 *     volvería a capturar de a una y toda la fase sería inútil.
 */
import {
  esConfirmable, resumirLote, evaluarDescuadre, rankearFrecuentes,
  TEXTO_NO_CONFIRMABLE, FRECUENTE_MIN_USOS, LOTE_EPSILON,
  type MapaRuta, type FilaLote, type UsoGasto,
} from './caja-lote.engine';

const ok: MapaRuta = {
  cliente_code: 'RD 21', confirmed_at: '2026-09-01T00:00:00Z',
  kepler_cuenta: '41000001', kepler_concepto: '001',
};
const ent = (monto = 1000, ref = '00|0027628') => ({ origen_ref: ref, cliente_code: 'RD 21', monto });

describe('esConfirmable — nada se elige a mano, o no se confirma', () => {
  it('con la ruta declarada y firmada, devuelve la cuenta lista', () => {
    const r = esConfirmable(ent(), ok);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.kepler_cuenta).toBe('41000001'); expect(r.kepler_concepto).toBe('001'); }
  });

  it('⛔ [negativa] SIN CUENTA declarada no se confirma — y NO se inventa una', () => {
    const r = esConfirmable(ent(), { ...ok, kepler_cuenta: null, kepler_concepto: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('sin_cuenta');
  });

  it('⛔ [negativa] una propuesta SIN FIRMAR no alcanza para aplicar dinero', () => {
    const r = esConfirmable(ent(), { ...ok, confirmed_at: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('sin_confirmar');
  });

  it('una ruta que ni existe en el mapa se distingue de una sin firmar', () => {
    const a = esConfirmable(ent(), null);
    const b = esConfirmable(ent(), { ...ok, confirmed_at: null });
    expect(a.ok).toBe(false); expect(b.ok).toBe(false);
    // Los dos son "no", pero uno lo arregla el capturista y el otro no. No pueden ser el mismo.
    if (!a.ok && !b.ok) expect(a.motivo).not.toBe(b.motivo);
  });

  it('un cobro sin importe no es confirmable (y lo dice)', () => {
    const r = esConfirmable(ent(0), ok);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('sin_monto');
  });

  it('cada motivo tiene un texto propio: un motivo sin frase no le sirve a nadie', () => {
    const motivos = ['sin_mapa', 'sin_confirmar', 'sin_cuenta', 'sin_monto'] as const;
    motivos.forEach((m) => expect(TEXTO_NO_CONFIRMABLE[m].length).toBeGreaterThan(20));
  });
});

describe('resumirLote — una fila que falla no tumba a las demás', () => {
  const montos = new Map([['a', 100], ['b', 200], ['c', 300], ['d', 400]]);
  const filas: FilaLote[] = [
    { origen_ref: 'a', estado: 'guardado', folio: 'CI-2026-00001' },
    { origen_ref: 'b', estado: 'duplicado', motivo: 'ya estaba aplicado' },
    { origen_ref: 'c', estado: 'guardado', folio: 'CI-2026-00002' },
    { origen_ref: 'd', estado: 'no_confirmable', motivo: 'sin_cuenta' },
  ];

  it('⭐ los que sí entraron se guardan aunque otros fallen', () => {
    const r = resumirLote(filas, montos);
    expect(r.guardados).toBe(2);
    expect(r.duplicados).toBe(1);
    expect(r.no_confirmables).toBe(1);
  });

  it('⭐ el total suma SÓLO lo guardado — un total optimista es una mentira', () => {
    const r = resumirLote(filas, montos);
    expect(r.monto_guardado).toBe(400);   // 100 + 300, NO los 1,000 del lote
  });

  it('el duplicado se cuenta aparte del rechazo: no es un error de nadie', () => {
    const r = resumirLote(filas, montos);
    expect(r.duplicados).toBe(1);
    expect(r.rechazados).toBe(0);
  });

  it('un lote vacío no rompe ni inventa totales', () => {
    const r = resumirLote([], new Map());
    expect(r.guardados).toBe(0);
    expect(r.monto_guardado).toBe(0);
  });
});

describe('evaluarDescuadre — se guarda lo contado y se levanta el hallazgo', () => {
  it('lo que cuadra al centavo no levanta nada', () => {
    expect(evaluarDescuadre('00|1', 23658, 23658).hay).toBe(false);
    expect(evaluarDescuadre('00|1', 23658, 23658.004).hay).toBe(false);   // dentro de epsilon
  });

  it('⭐ si falta, lo dice con el signo y el monto', () => {
    const d = evaluarDescuadre('00|0027628', 23658, 23400);
    expect(d.hay).toBe(true);
    expect(d.diferencia).toBe(-258);
    expect(d.resumen).toContain('falta');
    expect(d.resumen).toContain('258.00');
  });

  it('si sobra también, con el otro signo', () => {
    const d = evaluarDescuadre('00|1', 100, 150);
    expect(d.diferencia).toBe(50);
    expect(d.resumen).toContain('sobra');
  });

  it('⛔ la llave es ESTABLE: correrlo dos veces no puede crear dos hallazgos', () => {
    const a = evaluarDescuadre('00|0027628', 100, 90);
    const b = evaluarDescuadre('00|0027628', 100, 80);   // otro conteo, MISMO documento
    expect(a.dedup_key).toBe(b.dedup_key);
    expect(a.dedup_key).toBe('caja_entrega|00|0027628');
  });

  it('la tolerancia es un centavo, la misma del arqueo', () => {
    expect(LOTE_EPSILON).toBe(0.005);
    expect(evaluarDescuadre('00|1', 100, 100.01).hay).toBe(true);
  });
});

describe('rankearFrecuentes — lo que se repite se ofrece, la casualidad no', () => {
  const u = (cuenta: string, concepto: string, usos: number, glosa = '', ultimo = '2026-09-01'): UsoGasto =>
    ({ kepler_cuenta: cuenta, kepler_concepto: concepto, glosa, beneficiario: null, usos, ultimo_uso: ultimo });

  it('ordena por uso y numera el rango', () => {
    const r = rankearFrecuentes([u('1005', '1', 26, 'bot pau'), u('1010', '1', 27, 'nom 35 efectivo')]);
    expect(r[0].glosa).toBe('nom 35 efectivo');
    expect(r[0].rango).toBe(1);
    expect(r[1].rango).toBe(2);
  });

  it('⛔ [negativa] lo que no llega al mínimo NO se ofrece', () => {
    const r = rankearFrecuentes([u('1005', '1', FRECUENTE_MIN_USOS - 1, 'casualidad')]);
    expect(r).toHaveLength(0);
  });

  it('⭐ el orden es ESTABLE: dos cargas ofrecen lo mismo en el mismo lugar', () => {
    // Mismo uso y misma fecha: sin desempate total, el orden bailaría entre cargas y la persona
    // tocaría el chip equivocado por memoria muscular — mandando dinero a otra cuenta.
    const base = [u('1010', '2', 20, 'zzz'), u('1005', '1', 20, 'aaa'), u('1005', '1', 20, 'bbb')];
    const a = rankearFrecuentes(base).map((x) => x.kepler_cuenta + '/' + x.glosa);
    const b = rankearFrecuentes([...base].reverse()).map((x) => x.kepler_cuenta + '/' + x.glosa);
    expect(a).toEqual(b);
  });

  it('a igual uso, gana el más reciente', () => {
    const r = rankearFrecuentes([u('1005', '1', 10, 'viejo', '2026-01-01'), u('1010', '1', 10, 'nuevo', '2026-09-20')]);
    expect(r[0].glosa).toBe('nuevo');
  });

  it('un par a medias (sin concepto) no se ofrece: media cuenta no contabiliza', () => {
    const r = rankearFrecuentes([{ ...u('1005', '', 40, 'x'), kepler_concepto: '' }]);
    expect(r).toHaveLength(0);
  });

  it('respeta el límite y no rompe con lista vacía', () => {
    const muchos = Array.from({ length: 30 }, (_, i) => u('100' + i, '1', 10 + i));
    expect(rankearFrecuentes(muchos, 5)).toHaveLength(5);
    expect(rankearFrecuentes([])).toEqual([]);
  });
});
