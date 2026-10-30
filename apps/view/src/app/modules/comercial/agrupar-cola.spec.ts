import { agruparCola } from './agrupar-cola';
import type { ColaRow } from './motor-margen.service';

/** Mínimo viable: sólo los campos que la agrupación mira. */
const fila = (p: Partial<ColaRow>): ColaRow => ({
  sucursal: '01', sku: '10411', nombre: 'PAPS', precio_actual: '15.06', venta_30d: null,
  accion: 'subir_precio', certeza: 'efecto_no_medido',
  monto_en_juego_mxn: '100', monto_unidad: 'flujo_30d', monto_motivo: null,
  capital_inmovilizado_mxn: null, e3_existencia: null,
  bloqueos: [], accionable: true,
  s1_senal: null, s1_mxn: null, s2_senal: null, s2_mxn: null, s3_senal: null, s3_mxn: null,
  margen_realizado_pct: null, meta_margen_pct: null, dif_vs_meta_pp: null,
  a1_costo_hoy: null, a2_costo_ficha: null, a6_deriva_costo_pct: null,
  d1_terminacion: null, d1_candidato_99: null, d1_alza_99_pct: null, d4_umbral_percepcion: null,
  e3_estado_inventario: null, g2_clase_abc: null, d8_prima_caja_pct: null,
  familias_con_evidencia: 0, familias_totales: 0, calculado_al: null,
  ...p,
});

describe('[PR.V3] agruparCola — la cola se junta sólo cuando la decisión es LA MISMA', () => {
  it('junta el mismo SKU cuando acción y precio coinciden, y suma el dinero', () => {
    const r = agruparCola([
      fila({ sucursal: '06', monto_en_juego_mxn: '17469' }),
      fila({ sucursal: '01', monto_en_juego_mxn: '12480' }),
      fila({ sucursal: '08', monto_en_juego_mxn: '7503' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].plazas).toBe(3);
    expect(r[0].monto).toBe(37452);
    // La representativa es la de MAYOR monto: es la que el ojo lee primero.
    expect(r[0].row.sucursal).toBe('06');
  });

  it('NO junta si la acción difiere: no son la misma decisión', () => {
    const r = agruparCola([
      fila({ sucursal: '06', accion: 'aterrizar_precio' }),
      fila({ sucursal: '01', accion: 'subir_precio' }),
    ]);
    expect(r).toHaveLength(2);
    expect(r.every((f) => f.plazas === 1)).toBe(true);
  });

  it('NO junta si el precio difiere, aunque la acción sea la misma', () => {
    const r = agruparCola([
      fila({ sucursal: '06', precio_actual: '15.06' }),
      fila({ sucursal: '01', precio_actual: '14.50' }),
    ]);
    expect(r).toHaveLength(2);
  });

  it('⛔ si NINGUNA fila tiene monto, el grupo vale null y NO cero', () => {
    const r = agruparCola([
      fila({ sucursal: '06', monto_en_juego_mxn: null }),
      fila({ sucursal: '01', monto_en_juego_mxn: null }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].monto).toBeNull();
    expect(r[0].monto).not.toBe(0);
  });

  it('⭐ un NULL entre medibles no contamina la suma: se ignora, no se cuenta como 0', () => {
    const r = agruparCola([
      fila({ sucursal: '06', monto_en_juego_mxn: '500' }),
      fila({ sucursal: '01', monto_en_juego_mxn: null }),
    ]);
    expect(r[0].monto).toBe(500);
    // …pero la plaza sin medir SIGUE contando como plaza: existe, sólo no se pudo valuar.
    expect(r[0].plazas).toBe(2);
  });

  it('una celda sola no es grupo: hijos vacío', () => {
    const r = agruparCola([fila({ sucursal: '06' })]);
    expect(r[0].plazas).toBe(1);
    expect(r[0].hijos).toEqual([]);
  });

  it('el orden final es por dinero, no por el orden de llegada', () => {
    const r = agruparCola([
      fila({ sku: 'A', monto_en_juego_mxn: '10' }),
      fila({ sku: 'B', monto_en_juego_mxn: '900' }),
      fila({ sku: 'C', monto_en_juego_mxn: '300' }),
    ]);
    expect(r.map((f) => f.row.sku)).toEqual(['B', 'C', 'A']);
  });

  it('un monto negativo pesa por su magnitud: una pérdida grande no se va al fondo', () => {
    const r = agruparCola([
      fila({ sku: 'A', monto_en_juego_mxn: '100' }),
      fila({ sku: 'B', monto_en_juego_mxn: '-900' }),
    ]);
    expect(r[0].row.sku).toBe('B');
  });

  // ── [PR.V10] La unidad viaja con el dato, y el grupo suma EN su unidad ──────────────────
  const saldo = (p: Partial<ColaRow>) => fila({
    accion: 'liberar_capital', certeza: 'regla_de_operacion', monto_unidad: 'saldo_existencia',
    monto_en_juego_mxn: null, ...p,
  });

  it('⛔ [PR.V10] un grupo de liberar_capital suma el SALDO de sus plazas, no el de una sola', () => {
    const r = agruparCola([
      saldo({ sucursal: '01', capital_inmovilizado_mxn: '212563.80' }),
      saldo({ sucursal: '08', capital_inmovilizado_mxn: '222467.64' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].unidad).toBe('saldo_existencia');
    expect(r[0].monto).toBeCloseTo(435031.44, 2);
    expect(r[0].row.sucursal).toBe('08');
  });

  it('⛔ [PR.V10] un saldo grande NO se sube arriba de un flujo chico: no se ordenan juntos', () => {
    const r = agruparCola([
      saldo({ sku: 'S', capital_inmovilizado_mxn: '212564' }),
      fila({ sku: 'F', monto_en_juego_mxn: '5000' }),
    ]);
    expect(r.map((f) => f.row.sku)).toEqual(['F', 'S']);
  });

  it('[PR.V10] la escalera vale su VENTA expuesta, no un flujo', () => {
    const r = agruparCola([fila({
      accion: 'corregir_escalera', certeza: 'aritmetica', monto_unidad: 'venta_expuesta_30d',
      monto_en_juego_mxn: null, venta_30d: '4765.43',
    })]);
    expect(r[0].unidad).toBe('venta_expuesta_30d');
    expect(r[0].monto).toBeCloseTo(4765.43, 2);
  });

  it('una acción sin unidad (precio atípico) no tiene monto: null, no cero', () => {
    const r = agruparCola([fila({ accion: 'precio_atipico', monto_unidad: null, monto_en_juego_mxn: null })]);
    expect(r[0].monto).toBeNull();
  });
});
