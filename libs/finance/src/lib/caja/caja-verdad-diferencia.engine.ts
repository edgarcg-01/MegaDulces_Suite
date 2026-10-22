import type { EstadoVerdad, PistaDiferencia, TestigoDiferencia, VerdadDiferencia } from '@megadulces/contracts';

/**
 * ⭐⭐ `[CGS.36]` — **La verdad de cada diferencia, antes de que la firme la supervisora.**
 *
 * La diferencia es `contado − (fondo + ingresos − gastos − depósitos + dispensó − depositó)`. Este
 * motor no la recalcula de otra forma: **audita cada entrada contra un testigo que no tecleó la
 * misma persona en el mismo sistema**, y dice cuánto la mueve cada uno.
 *
 * | Entrada | Testigo | Medido en prod el 2026-10-21 |
 * |---|---|---|
 * | el conteo | el arqueo físico de Control del mismo día | coincide al peso en 6 de 7 días; CC-4 no ($11,820 tecleado el 16-oct contra $57,571) |
 * | el fondo | el arqueo de Control del día del corte anterior | CC-4 abrió con $24,960 y Control había contado $14,128.50 |
 * | el libro | lo que se selló contra lo que suma hoy | CC-7: CI-2026-00063 pasó de ingreso a gasto después de sellar (−$20,210) |
 * | la caja fuerte | lo que cambió entre dos arqueos de Control contra lo que registró la máquina | residuo 0 en 5 de 6 tramos |
 *
 * ⛔ **Cuando el conteo de la Suite y el de Control no coinciden, manda el arqueo físico.** No es
 * una regla nueva: es la que ya se aplicó en los dos reconteos de prod (CC-3 y CC-7, «Manda el
 * arqueo físico»). Pero NO se reescribe el corte firmado: la verdadera se publica AL LADO de la
 * publicada, con el porqué.
 *
 * ⚠️ Las pistas no se suman a nada. Un movimiento de Control es un paquete de efectivo contado,
 * sin signo: no dice si entró o salió. Sumarlas para «explicar» la diferencia sería inventar el
 * signo, y con 39 paquetes cualquier cifra se arma con alguna combinación.
 */

const EPS = 0.005;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const mx = (n: number): string => `$${Math.abs(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** `+$1,201.63 (sobra)` · `−$188,884.59 (falta)`. */
export const difTexto = (n: number): string =>
  Math.abs(n) <= EPS ? '$0.00 (cuadra)' : `${n > 0 ? '+' : '−'}${mx(n)} (${n > 0 ? 'sobra' : 'falta'})`;

export interface ArqueoControlHecho {
  folio: string;
  /** `YYYY-MM-DD`. */
  dia: string;
  /** `HH:MM`. */
  hora: string | null;
  efectivo: number;
  /** El rubro «tarjeta» de Control: es la caja fuerte (CGS.35, verificado contra la máquina). */
  caja_fuerte: number;
  /** Cheques más papeles (vales, comprobantes) que Control cuenta en caja. */
  documentos: number;
  /**
   * `[CGS.44]` Quién contó: el Access de Control (histórico, jubilado el 2026-10-22) o el recuento
   * de la Suite. Ausente = Control (la forma anterior).
   */
  origen?: 'control' | 'suite';
  quien?: string | null;
}

/** «Control» o «el recuento de maria_gutierrez», para las frases. */
const quienContó = (c: ArqueoControlHecho): string =>
  c.origen === 'suite' ? `el recuento de ${c.quien ?? 'otra persona'}` : 'Control';
const Mayus = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

export interface MovimientoControlHecho {
  folio: string;
  hora: string | null;
  monto: number;
  nota: string | null;
}

export interface TotalesLibro {
  ingresos: number;
  gastos: number;
  depositos: number;
}

export interface HechosVerdad {
  /** El día del corte, `YYYY-MM-DD`. */
  fecha: string;
  /** El día (México) en que se cerró. */
  cerrado_dia: string | null;
  contado: number | null;
  fondo_inicial: number | null;
  diferencia: number | null;
  /** Los totales que se sellaron al cerrar. */
  sellado: TotalesLibro;
  /** Lo que suman HOY los movimientos del corte que no están cancelados. */
  hoy: TotalesLibro;
  /** El día del corte anterior de la misma caja. `null` = es el primero. */
  dia_anterior: string | null;
  /** El último arqueo de Control del día del corte. */
  control_dia: ArqueoControlHecho | null;
  /** El último arqueo de Control del día del corte anterior: con eso debió abrir. */
  control_fondo: ArqueoControlHecho | null;
  /**
   * Lo que pasó en la caja fuerte entre el arqueo de Control anterior y el del día, según la
   * MÁQUINA. `null` = falta alguno de los dos arqueos.
   */
  caja_fuerte: {
    desde: ArqueoControlHecho; depositado: number; dispensado: number; vaciado: number; dotado: number;
    /** `[CGS.44]` El arqueo con caja fuerte que cierra el tramo. Ausente = `control_dia`. */
    hasta?: ArqueoControlHecho;
  } | null;
  /** Movimientos que Control registró ese día y no casan con nada del libro ni de la máquina. */
  control_sin_libro: MovimientoControlHecho[];
}

function testigoConteo(h: HechosVerdad): TestigoDiferencia {
  const pregunta = 'El conteo es el que se contó';
  if (h.contado == null) return { id: 'conteo', pregunta, estado: 'sin_testigo', detalle: 'No hay conteo sellado.', ajuste: 0 };
  const c = h.control_dia;
  if (!c) {
    return { id: 'conteo', pregunta, estado: 'sin_testigo', ajuste: 0,
      detalle: `Nadie más contó el cajón del ${h.fecha} (ni Control ni un recuento): el conteo de ${mx(h.contado)} no tiene segundo testigo.` };
  }
  const dif = r2(c.efectivo - h.contado);
  const donde = `${c.folio}, ${c.dia}${c.hora ? ` ${c.hora}` : ''}`;
  if (Math.abs(dif) <= EPS) {
    return { id: 'conteo', pregunta, estado: 'confirma', ajuste: 0, detalle: `${Mayus(quienContó(c))} contó lo mismo: ${mx(c.efectivo)} (${donde}).` };
  }
  const tarde = h.cerrado_dia && h.cerrado_dia > h.fecha ? ` tecleado el ${h.cerrado_dia}` : '';
  return {
    id: 'conteo', pregunta, estado: 'contradice', ajuste: dif,
    detalle: `La Suite selló ${mx(h.contado)}${tarde}; ${c.origen === 'suite' ? quienContó(c) : 'el arqueo físico de Control'} contó ${mx(c.efectivo)} (${donde}). Manda ${c.origen === 'suite' ? 'el recuento' : 'el arqueo físico'}: la diferencia se mueve ${dif > 0 ? '+' : '−'}${mx(dif)}.`,
  };
}

function testigoFondo(h: HechosVerdad): TestigoDiferencia {
  const pregunta = 'Abrió con lo que de verdad había';
  if (h.fondo_inicial == null) return { id: 'fondo', pregunta, estado: 'sin_testigo', detalle: 'El corte no tiene fondo medido.', ajuste: 0 };
  if (!h.dia_anterior) {
    return { id: 'fondo', pregunta, estado: 'sin_testigo', ajuste: 0, detalle: 'Es el primer corte de esta caja: no hay cierre anterior contra qué comparar.' };
  }
  const c = h.control_fondo;
  if (!c) {
    return { id: 'fondo', pregunta, estado: 'sin_testigo', ajuste: 0,
      detalle: `Nadie volvió a contar el cajón del ${h.dia_anterior} (el día del corte anterior): el fondo de ${mx(h.fondo_inicial)} no tiene testigo.` };
  }
  const dif = r2(c.efectivo - h.fondo_inicial);
  if (Math.abs(dif) <= EPS) {
    return { id: 'fondo', pregunta, estado: 'confirma', ajuste: 0, detalle: `Abrió con ${mx(h.fondo_inicial)}, lo que ${quienContó(c)} contó al cerrar el ${c.dia} (${c.folio}).` };
  }
  // Un fondo más alto que lo que había infla el esperado: la diferencia baja en lo mismo, y al revés.
  return {
    id: 'fondo', pregunta, estado: 'contradice', ajuste: r2(-dif),
    detalle: `Abrió con ${mx(h.fondo_inicial)} y al cerrar el ${c.dia} ${quienContó(c)} contó ${mx(c.efectivo)} (${c.folio}): el esperado arrastra ${mx(dif)} que no estaban.`,
  };
}

function testigoLibro(h: HechosVerdad): TestigoDiferencia {
  const pregunta = 'El libro es el que se selló';
  const s = h.sellado;
  const d = h.hoy;
  // Lo que movería el esperado si se recalculara con el libro de hoy.
  const cambioEsperado = r2((d.ingresos - s.ingresos) - (d.gastos - s.gastos) - (d.depositos - s.depositos));
  if (Math.abs(cambioEsperado) <= EPS
    && Math.abs(d.ingresos - s.ingresos) <= EPS && Math.abs(d.gastos - s.gastos) <= EPS && Math.abs(d.depositos - s.depositos) <= EPS) {
    return { id: 'libro', pregunta, estado: 'confirma', ajuste: 0, detalle: 'Los movimientos del corte suman hoy lo mismo que se selló.' };
  }
  const partes: string[] = [];
  if (Math.abs(d.ingresos - s.ingresos) > EPS) partes.push(`ingresos ${mx(s.ingresos)} → ${mx(d.ingresos)}`);
  if (Math.abs(d.gastos - s.gastos) > EPS) partes.push(`gastos ${mx(s.gastos)} → ${mx(d.gastos)}`);
  if (Math.abs(d.depositos - s.depositos) > EPS) partes.push(`depósitos ${mx(s.depositos)} → ${mx(d.depositos)}`);
  return {
    id: 'libro', pregunta, estado: 'contradice', ajuste: r2(-cambioEsperado),
    detalle: `Después de sellar cambiaron movimientos del corte: ${partes.join(', ')}.`
      + (Math.abs(cambioEsperado) > EPS ? ` Con el libro de hoy la diferencia se mueve ${-cambioEsperado > 0 ? '+' : '−'}${mx(cambioEsperado)}.` : ''),
  };
}

function testigoCajaFuerte(h: HechosVerdad): TestigoDiferencia {
  const pregunta = 'La máquina registró todo lo que se movió en la caja fuerte';
  const k = h.caja_fuerte;
  const c = k?.hasta ?? h.control_dia;
  if (!k || !c) {
    return { id: 'caja_fuerte', pregunta, estado: 'sin_testigo', ajuste: 0,
      detalle: 'Falta un arqueo con la caja fuerte del día o uno anterior: no hay contra qué comparar a la máquina.' };
  }
  const vioControl = r2(c.caja_fuerte - k.desde.caja_fuerte);
  const maquina = r2(k.depositado - k.dispensado - k.vaciado + k.dotado);
  const resto = r2(vioControl - maquina);
  const tramo = `entre ${k.desde.folio} (${k.desde.dia}) y ${c.folio}`;
  if (Math.abs(resto) <= EPS) {
    return { id: 'caja_fuerte', pregunta, estado: 'confirma', ajuste: 0,
      detalle: `${tramo} la caja fuerte cambió ${vioControl >= 0 ? '+' : '−'}${mx(vioControl)} en los arqueos, lo mismo que registró la máquina.` };
  }
  return {
    id: 'caja_fuerte', pregunta, estado: 'contradice', ajuste: 0,
    detalle: `${tramo} la caja fuerte cambió ${vioControl >= 0 ? '+' : '−'}${mx(vioControl)} según los arqueos y la máquina registró ${maquina >= 0 ? '+' : '−'}${mx(maquina)}: ${mx(resto)} sin registro de un lado.`,
  };
}

function pistasDe(h: HechosVerdad): PistaDiferencia[] {
  const out: PistaDiferencia[] = h.control_sin_libro.map((m) => ({
    fuente: 'control_movimiento' as const, folio: m.folio, hora: m.hora, monto: r2(m.monto),
    detalle: `Control registró ${m.nota ? `«${m.nota}»` : 'un paquete sin nota'} por ${mx(m.monto)}${m.hora ? ` a las ${m.hora}` : ''} y el libro no tiene un movimiento de ese importe ese día.`,
  }));
  const k = h.caja_fuerte;
  const c = k?.hasta ?? h.control_dia;
  if (k && c) {
    const docs = r2(c.documentos - k.desde.documentos);
    // Un arqueo de la Suite sin cheques o vales contados no dice nada de ese rubro (NaN).
    if (Number.isFinite(docs) && Math.abs(docs) > EPS) {
      out.push({ fuente: 'control_cheques', folio: c.folio, hora: c.hora, monto: docs,
        detalle: `Los cheques y vales contados en caja ${docs > 0 ? 'subieron' : 'bajaron'} ${mx(docs)} desde ${k.desde.folio}; el libro no lleva cheques ni vales.` });
    }
    if (k.vaciado > EPS) {
      out.push({ fuente: 'caja_fuerte_fuera', folio: null, hora: null, monto: r2(k.vaciado),
        detalle: `La caja fuerte se vació ${mx(k.vaciado)}: ese dinero sale por fuera de la fórmula del corte.` });
    }
    if (k.dotado > EPS) {
      out.push({ fuente: 'caja_fuerte_fuera', folio: null, hora: null, monto: r2(k.dotado),
        detalle: `La caja fuerte se dotó con ${mx(k.dotado)}: ese dinero entra por fuera de la fórmula del corte.` });
    }
  }
  return out;
}

export function verdadDeLaDiferencia(h: HechosVerdad): VerdadDiferencia {
  const testigos = [testigoConteo(h), testigoFondo(h), testigoLibro(h), testigoCajaFuerte(h)];
  const pistas = pistasDe(h);
  const publicada = h.diferencia == null ? null : r2(h.diferencia);
  const verdadera = publicada == null ? null : r2(publicada + testigos.reduce((a, t) => a + t.ajuste, 0));
  const de = (id: TestigoDiferencia['id']) => testigos.find((t) => t.id === id)!;

  let estado: EstadoVerdad;
  let resumen: string;
  if (publicada == null || verdadera == null) {
    estado = 'sin_confirmar';
    resumen = 'El corte no tiene diferencia calculada.';
  } else if (Math.abs(verdadera - publicada) > EPS) {
    estado = 'corregida';
    const por = testigos.filter((t) => Math.abs(t.ajuste) > EPS).map((t) => t.id === 'conteo' ? 'el conteo' : t.id === 'fondo' ? 'el fondo' : 'el libro');
    resumen = `Se publicó ${difTexto(publicada)}; con los testigos es ${difTexto(verdadera)}. La mueve ${por.join(' y ')}.`;
  } else if (de('conteo').estado === 'confirma' && !testigos.some((t) => t.estado === 'contradice')) {
    estado = 'confirmada';
    resumen = Math.abs(publicada) <= EPS
      ? 'Cuadra, y los testigos lo confirman.'
      : `La diferencia de ${difTexto(publicada)} es real: ${quienContó(h.control_dia!)} confirma el conteo y nada la mueve. Falta saber qué la causó.`;
  } else {
    estado = 'sin_confirmar';
    const faltan = testigos.filter((t) => t.estado !== 'confirma').map((t) => t.pregunta.toLowerCase());
    resumen = `No se puede afirmar que ${difTexto(publicada)} sea la diferencia real: no se confirmó que ${faltan.join('; ni que ')}.`;
  }
  return { estado, publicada, verdadera, testigos, pistas, resumen };
}
