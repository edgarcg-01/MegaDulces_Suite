import { verdadDeLaDiferencia, difTexto, type ArqueoControlHecho, type HechosVerdad } from './caja-verdad-diferencia.engine';

/** `[CGS.36]` Con los cortes y arqueos reales de prod (leídos con dev_ro el 2026-10-21). */
const ctl = (folio: string, dia: string, hora: string, efectivo: number, caja_fuerte: number, cheques: number): ArqueoControlHecho =>
  ({ folio, dia, hora, efectivo, caja_fuerte, documentos: cheques + 20782 });
const A23641 = ctl('A23641', '2026-10-10', '12:58', 3327.5, 337500, 25840);
const A23648 = ctl('A23648', '2026-10-14', '17:51', 14128.5, 766160, 30602);
const A23655 = ctl('A23655', '2026-10-15', '17:55', 57571, 52420, 239734.8);
const A23665 = ctl('A23665', '2026-10-16', '19:00', 32198.5, 133550, 129891.5);
const A23672 = ctl('A23672', '2026-10-17', '12:57', 618.5, 39300, 25569.7);
const A23677 = ctl('A23677', '2026-10-19', '18:16', 87772.5, 360020, 10121);
const A23683 = ctl('A23683', '2026-10-20', '18:12', 25787, 376470, 10121);

const igual = (ingresos: number, gastos: number) => ({ sellado: { ingresos, gastos, depositos: 0 }, hoy: { ingresos, gastos, depositos: 0 } });
const t = (v: ReturnType<typeof verdadDeLaDiferencia>, id: string) => v.testigos.find((x) => x.id === id)!;

describe('verdadDeLaDiferencia', () => {
  const CC4: HechosVerdad = {
    fecha: '2026-10-15', cerrado_dia: '2026-10-16', contado: 11820, fondo_inicial: 24960, diferencia: 80019.86,
    ...igual(102363, 644012.86), dia_anterior: '2026-10-14', control_dia: A23655, control_fondo: A23648,
    caja_fuerte: { desde: A23648, depositado: 47190, dispensado: 495680, vaciado: 293020, dotado: 27770 },
    control_sin_libro: [{ folio: 'A23654', hora: '13:20', monto: 200556, nota: 'TDC 4023 1850 0258 6323 Luis Francisco Lopez Gtz' }],
  };

  it('[negativa] CC-4: el conteo tecleado un día después contradice al arqueo físico → la diferencia se CORRIGE a +$136,602.36', () => {
    const v = verdadDeLaDiferencia(CC4);
    expect(v.estado).toBe('corregida');
    expect(v.publicada).toBe(80019.86);
    expect(v.verdadera).toBe(136602.36);
    expect(t(v, 'conteo')).toMatchObject({ estado: 'contradice', ajuste: 45751 });
    expect(t(v, 'conteo').detalle).toContain('tecleado el 2026-10-16');
    expect(t(v, 'fondo')).toMatchObject({ estado: 'contradice', ajuste: 10831.5 });
    expect(v.resumen).toContain('+$136,602.36 (sobra)');
  });

  it('CC-4: la máquina explica al peso lo que Control vio cambiar en la caja fuerte, con vaciado y dotación', () => {
    const v = verdadDeLaDiferencia(CC4);
    expect(t(v, 'caja_fuerte').estado).toBe('confirma');
    expect(v.pistas.map((p) => p.fuente)).toEqual(['control_movimiento', 'control_cheques', 'caja_fuerte_fuera', 'caja_fuerte_fuera']);
    expect(v.pistas.find((p) => p.fuente === 'control_cheques')!.monto).toBe(209132.8);
  });

  it('CC-5 heredó como fondo el conteo equivocado de CC-4: +$94,830.30 → +$49,079.30', () => {
    const v = verdadDeLaDiferencia({
      fecha: '2026-10-16', cerrado_dia: '2026-10-16', contado: 32198.5, fondo_inicial: 11820, diferencia: 94830.3,
      ...igual(234962.29, 228284.09), dia_anterior: '2026-10-15', control_dia: A23665, control_fondo: A23655,
      caja_fuerte: { desde: A23655, depositado: 168950, dispensado: 87820, vaciado: 0, dotado: 0 }, control_sin_libro: [],
    });
    expect(v).toMatchObject({ estado: 'corregida', verdadera: 49079.3 });
    expect(t(v, 'conteo').estado).toBe('confirma');
    expect(t(v, 'fondo')).toMatchObject({ estado: 'contradice', ajuste: -45751 });
  });

  it('CC-6: los cuatro testigos confirman → +$81,845.77 es REAL', () => {
    const v = verdadDeLaDiferencia({
      fecha: '2026-10-17', cerrado_dia: '2026-10-17', contado: 618.5, fondo_inicial: 32198.5, diferencia: 81845.77,
      ...igual(79503.23, 287179), dia_anterior: '2026-10-16', control_dia: A23672, control_fondo: A23665,
      caja_fuerte: { desde: A23665, depositado: 56480, dispensado: 150730, vaciado: 0, dotado: 0 }, control_sin_libro: [],
    });
    expect(v).toMatchObject({ estado: 'confirmada', publicada: 81845.77, verdadera: 81845.77 });
    expect(v.testigos.every((x) => x.estado === 'confirma')).toBe(true);
    expect(v.resumen).toContain('es real');
  });

  it('[negativa] CC-7: un movimiento cambiado después de sellar mueve la diferencia: −$209,094.59 → −$188,884.59', () => {
    const v = verdadDeLaDiferencia({
      fecha: '2026-10-19', cerrado_dia: '2026-10-19', contado: 87772.5, fondo_inicial: 618.5, diferencia: -209094.59,
      sellado: { ingresos: 827089.59, gastos: 210121, depositos: 0 }, hoy: { ingresos: 816984.59, gastos: 220226, depositos: 0 },
      dia_anterior: '2026-10-17', control_dia: A23677, control_fondo: A23672,
      caja_fuerte: { desde: A23672, depositado: 581830, dispensado: 261110, vaciado: 0, dotado: 0 }, control_sin_libro: [],
    });
    expect(v).toMatchObject({ estado: 'corregida', verdadera: -188884.59 });
    expect(t(v, 'libro')).toMatchObject({ estado: 'contradice', ajuste: 20210 });
    expect(t(v, 'libro').detalle).toContain('ingresos $827,089.59 → $816,984.59');
  });

  it('CC-8: +$1,201.63 confirmada', () => {
    const v = verdadDeLaDiferencia({
      fecha: '2026-10-20', cerrado_dia: '2026-10-21', contado: 25787, fondo_inicial: 87772.5, diferencia: 1201.63,
      ...igual(223695.5, 270432.63), dia_anterior: '2026-10-19', control_dia: A23683, control_fondo: A23677,
      caja_fuerte: { desde: A23677, depositado: 220460, dispensado: 204010, vaciado: 0, dotado: 0 }, control_sin_libro: [],
    });
    expect(v).toMatchObject({ estado: 'confirmada', verdadera: 1201.63 });
  });

  it('[negativa] CC-3: la máquina no explica $5,000 de la caja fuerte → NO se confirma, aunque el conteo coincida', () => {
    const v = verdadDeLaDiferencia({
      fecha: '2026-10-14', cerrado_dia: '2026-10-16', contado: 14128.5, fondo_inicial: 57571, diferencia: -73653.16,
      ...igual(143390.49, 9559.83), dia_anterior: '2026-10-13', control_dia: A23648, control_fondo: null,
      caja_fuerte: { desde: A23641, depositado: 568960, dispensado: 145300, vaciado: 0, dotado: 0 }, control_sin_libro: [],
    });
    expect(v.estado).toBe('sin_confirmar');
    expect(v.verdadera).toBe(-73653.16);
    expect(t(v, 'conteo').estado).toBe('confirma');
    expect(t(v, 'caja_fuerte').estado).toBe('contradice');
    expect(t(v, 'caja_fuerte').detalle).toContain('$5,000.00');
    expect(t(v, 'fondo').estado).toBe('sin_testigo');
  });

  it('[negativa] CC-2: sin arqueo de Control ese día la diferencia NO se afirma, ni en verde ni corregida', () => {
    const v = verdadDeLaDiferencia({
      fecha: '2026-10-13', cerrado_dia: '2026-10-15', contado: 57571, fondo_inicial: 3653.5, diferencia: 207486.32,
      ...igual(273258, 154846.82), dia_anterior: '2026-10-12', control_dia: null, control_fondo: null,
      caja_fuerte: null, control_sin_libro: [],
    });
    expect(v.estado).toBe('sin_confirmar');
    expect(v.testigos.filter((x) => x.estado === 'sin_testigo').map((x) => x.id)).toEqual(['conteo', 'fondo', 'caja_fuerte']);
    expect(v.resumen).toContain('No se puede afirmar');
  });

  it('sin conteo sellado no hay diferencia que arbitrar', () => {
    const v = verdadDeLaDiferencia({
      fecha: '2026-10-21', cerrado_dia: null, contado: null, fondo_inicial: 25787, diferencia: null,
      ...igual(0, 0), dia_anterior: '2026-10-20', control_dia: null, control_fondo: A23683, caja_fuerte: null, control_sin_libro: [],
    });
    expect(v).toMatchObject({ estado: 'sin_confirmar', publicada: null, verdadera: null });
  });

  // ⭐ `[CGS.44]` Control jubilado (2026-10-22): el testigo es el recuento de María en la Suite.
  const recuento = (efectivo: number): ArqueoControlHecho => ({
    folio: 'recuento 1a2b3c4d', dia: '2026-10-23', hora: '08:40', efectivo,
    caja_fuerte: NaN, documentos: NaN, origen: 'suite', quien: 'maria_gutierrez',
  });
  const SIN_CONTROL: HechosVerdad = {
    fecha: '2026-10-22', cerrado_dia: '2026-10-22', contado: 25787, fondo_inicial: 23756.5, diferencia: 1201.63,
    ...igual(223695.5, 270432.63), dia_anterior: '2026-10-21', control_dia: recuento(25787), control_fondo: null,
    caja_fuerte: null, control_sin_libro: [],
  };

  it('[CGS.44] el recuento de María confirma el conteo y lo dice con su nombre', () => {
    const v = verdadDeLaDiferencia(SIN_CONTROL);
    expect(t(v, 'conteo')).toMatchObject({ estado: 'confirma' });
    expect(t(v, 'conteo').detalle).toContain('El recuento de maria_gutierrez contó lo mismo');
  });

  it('[negativa][CGS.44] si el recuento no coincide, manda el recuento y la diferencia se corrige', () => {
    const v = verdadDeLaDiferencia({ ...SIN_CONTROL, control_dia: recuento(25287) });
    expect(v).toMatchObject({ estado: 'corregida', verdadera: 701.63 });
    expect(t(v, 'conteo').detalle).toContain('Manda el recuento');
  });

  it('[CGS.44] un recuento sin cheques ni vales contados no inventa una pista de documentos', () => {
    const v = verdadDeLaDiferencia({
      ...SIN_CONTROL,
      caja_fuerte: { desde: A23683, hasta: { ...recuento(25787), caja_fuerte: 376470 }, depositado: 0, dispensado: 0, vaciado: 0, dotado: 0 },
    });
    expect(t(v, 'caja_fuerte').estado).toBe('confirma');
    expect(v.pistas.filter((p) => p.fuente === 'control_cheques')).toEqual([]);
  });

  // ⭐ `[CGS.51]` La caja entera (cajón + caja fuerte + vales + dólares) entre dos arqueos completos.
  const completo = (c: ArqueoControlHecho, usd = 12059 * 19.101) => ({
    folio: c.folio, dia: c.dia, hora: c.hora, efectivo: c.efectivo, caja_fuerte: c.caja_fuerte, documentos: c.documentos, dolares: usd,
  });

  it('[CGS.51] CC-4: el cajón dice +$136,602.36 y la caja entera +$80,485.16 — el resto se movió de rubro', () => {
    const v = verdadDeLaDiferencia({ ...CC4, caja_entera: { desde: completo(A23648), hasta: completo(A23655), libro_neto: -541649.86 } });
    expect(v.caja_entera).toMatchObject({ cambio: -461164.7, libro: -541649.86, diferencia: 80485.16, desde: 'A23648 · 14/10 17:51', hasta: 'A23655 · 15/10 17:55' });
    expect(v.caja_entera!.rubros.map((r) => [r.rubro, r.cambio])).toEqual([['cajon', 43442.5], ['caja_fuerte', -713740], ['documentos', 209132.8]]);
    expect(v.resumen).toContain('En la caja entera (cajón, caja fuerte, vales y dólares) es +$80,485.16 (sobra)');
  });

  it('[CGS.51] cuando la caja entera da lo mismo que el cajón, lo dice', () => {
    const v = verdadDeLaDiferencia({
      ...SIN_CONTROL, control_dia: recuento(25787),
      // El tramo real 19-oct 18:16 → 20-oct 18:12 (panorama de la caja entera, prod 2026-10-22).
      caja_entera: { desde: completo(A23677), hasta: completo(A23683), libro_neto: -46737.13 },
    });
    expect(v.caja_entera!.diferencia).toBe(1201.63);
    expect(v.resumen).toContain('La caja entera da lo mismo');
  });

  it('[negativa][CGS.51] sin dos arqueos completos no se inventa la caja entera', () => {
    expect(verdadDeLaDiferencia({ ...CC4, caja_entera: null }).caja_entera).toBeNull();
    expect(verdadDeLaDiferencia(CC4).caja_entera).toBeNull();
  });

  it('difTexto dice el signo en palabras', () => {
    expect(difTexto(1201.63)).toBe('+$1,201.63 (sobra)');
    expect(difTexto(-188884.59)).toBe('−$188,884.59 (falta)');
    expect(difTexto(0)).toBe('$0.00 (cuadra)');
  });
});
