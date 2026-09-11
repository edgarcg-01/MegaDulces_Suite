import { cuerpoTicket, TicketArqueo } from './ticket-arqueo';

/**
 * El ticket del arqueo es papel firmado: es el respaldo de cuánto efectivo se
 * entregó. `cuerpoTicket` está exportado desde el día uno "para poder probarlo"
 * y nadie lo había probado — estas son las dos cosas que de verdad se pueden
 * romper en silencio.
 *
 * **1. La grilla de 32 caracteres.** El ticket no se maqueta con CSS: se maqueta
 * contando caracteres, y cada renglón se rellena con espacios hasta `ANCHO`. La
 * letra está en 14px, que ocupa el **99%** de los 72 mm de papel — o sea que un
 * renglón de 33 caracteres YA no entra: se parte en dos y se rompe la alineación
 * `concepto ..... monto`. Ese fallo no se ve en pantalla, se ve en el papel de la
 * caja, que es el peor lugar para descubrirlo. El test de abajo lo atrapa antes.
 *
 * **2. El arqueo es CIEGO.** Con `revela: false` el papel de la cajera no puede
 * traer el esperado ni la diferencia: si los trae, deja de ser un conteo a ciegas
 * y se puede "ajustar" el siguiente para que cuadre.
 */

const BASE: TicketArqueo = {
  sucursal: 'La Piedad Abastos',
  caja: '2',
  fecha: '2026-09-11',
  cajera: '10C02',
  denominaciones: [
    { denominacion: 1000, cantidad: 3, subtotal: 3000 },
    { denominacion: 500, cantidad: 12, subtotal: 6000 },
    { denominacion: 0.5, cantidad: 24, subtotal: 12 },
  ],
  total_contado: 9012,
};

const lineas = (a: Partial<TicketArqueo>, revela = false) =>
  cuerpoTicket({ ...BASE, ...a }, { revela }).split('\n');

describe('cuerpoTicket — grilla de 32 caracteres', () => {
  /**
   * El caso más cargado que puede salir de la pantalla: relevo con entrante,
   * incidencia, nota, turno, y los montos de Kepler revelados. Si algo se pasa
   * de 32, es acá.
   */
  const cargado: Partial<TicketArqueo> = {
    sucursal: 'Zamora Centro Comercial Norte',
    cajera: 'DAVID_CISNEROS_GUTIERREZ',
    tipo: 'relevo',
    cajero_entrante: 'MARIA_GUADALUPE_HERNANDEZ',
    turno: '7001',
    duracion_horas: 8.5,
    total_contado: 1234567.89,
    medios_declarados: [
      { label: 'Tarjeta', monto: 98765.43 },
      { label: 'Transferencia', monto: 12345.67 },
    ],
    incidencia_tipo: 'faltante_no_justificado',
    nota: 'Se entrega con dos billetes marcados y una moneda extranjera en el fajo.',
    esperado: 1300000,
    diff_real: 65432.11,
    kepler_contado: 1234567.89,
    kepler_billetes: 1200000,
    kepler_monedas: 34567.89,
    kepler_retirado: 500000,
    capturado_por: 'qa_layout_tmp',
    validado_por: 'ENCARGADA_TURNO',
    capturado_at: '2026-09-11T11:41:47.000Z',
  };

  it('ningún renglón pasa de 32 caracteres, ni en el ticket más cargado', () => {
    const largos = lineas(cargado, true)
      .map((l, i) => ({ n: i + 1, largo: l.length, texto: l }))
      .filter((x) => x.largo > 32);
    // El mensaje importa: si esto falla hay que ver QUÉ renglón se pasó.
    expect(largos).toEqual([]);
  });

  it('tampoco en el ticket de la cajera (sin los montos de Kepler)', () => {
    expect(lineas(cargado, false).filter((l) => l.length > 32)).toEqual([]);
  });

  it('la columna derecha cierra exactamente en la posición 32', () => {
    const fila = lineas({}, false).find((l) => l.startsWith('TOTAL CONTADO'));
    expect(fila).toBeDefined();
    expect(fila).toHaveLength(32);
    // Y el monto queda pegado al borde derecho, no flotando.
    expect(fila!.endsWith(' ')).toBe(false);
  });

  it('las líneas separadoras miden el ancho del ticket', () => {
    const seps = lineas({}, false).filter((l) => /^[-=]+$/.test(l));
    expect(seps.length).toBeGreaterThan(0);
    expect(seps.every((l) => l.length === 32)).toBe(true);
  });
});

describe('cuerpoTicket — el papel dice QUÉ es', () => {
  // Los tres tipos que ofrece la pantalla. `retiro` salía encabezado
  // 'ARQUEO DE CAJA' porque el generador sólo distinguía el relevo.
  it.each([
    ['cierre', 'ARQUEO DE CAJA'],
    ['retiro', 'RETIRO DE CAJA'],
    ['relevo', 'RELEVO DE CAJA'],
  ])('tipo %s → %s', (tipo, encabezado) => {
    expect(lineas({ tipo })[1]).toBe(encabezado);
  });

  it('sin tipo se asume el corte del día', () => {
    expect(lineas({ tipo: null })[1]).toBe('ARQUEO DE CAJA');
  });

  it('el relevo dice a quién se le entregó la caja', () => {
    const t = lineas({ tipo: 'relevo', cajero_entrante: 'MARIA_LOPEZ' }).join('\n');
    expect(t).toContain('Entrega a');
    expect(t).toContain('MARIA_LOPEZ');
  });
});

describe('cuerpoTicket — el arqueo sigue siendo ciego en el papel', () => {
  const conCuadre: Partial<TicketArqueo> = {
    esperado: 15000,
    diff_real: 5988,
    kepler_contado: 9012,
    venta: 42000,
  };

  it('sin revelar NO imprime el esperado ni la diferencia', () => {
    const t = lineas(conCuadre, false).join('\n');
    expect(t).not.toContain('Esperado');
    expect(t).not.toContain('15,000');
    expect(t).not.toContain('5,988');
  });

  it('pero sí imprime lo que la cajera contó', () => {
    const t = lineas(conCuadre, false).join('\n');
    expect(t).toContain('TOTAL CONTADO');
    expect(t).toContain('9,012');
  });

  it('revelando aparece el bloque de Kepler', () => {
    const t = lineas(conCuadre, true).join('\n');
    expect(t).toContain('Esperado');
    expect(t).toContain('15,000');
  });
});
