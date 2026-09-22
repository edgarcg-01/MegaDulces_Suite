import { cuerpoReporteCliente } from './reporte-cliente-papel';
import type { ClienteCandidato, ReporteDocumento, ReporteFiltrosUI } from './tickets.service';

/**
 * Candado del PAPEL del reporte por cliente (TK.8).
 *
 * **1. El papel declara su alcance.** Un reporte donde alguien eligió qué entra tiene que decir
 * cuántos quedaron fuera; si no, quien lo recibe lo lee como si fuera todo. Es la misma regla
 * que el resto de la suite aplica a cualquier cifra recortada (ADR-056).
 *
 * **2. Las notas de crédito restan.** Van en su lugar por fecha y en negativo, y el total del
 * periodo es lo que el cliente pagó de verdad. Si alguna vez se listan aparte o se omiten, el
 * total dice de más y el papel afirma que pagó mercancía que devolvió.
 *
 * **3. Lo que acota, se dice.** Filtrar por caja deja fuera facturas; filtrar por marca trae el
 * documento completo. Esas dos frases no son adorno: sin ellas el papel parece exhaustivo.
 *
 * **4. La fecha no se corre de día.** Un `date` de Postgres leído con `new Date()` y
 * renderizado en hora de México sale con el día ANTERIOR. Ya costó una entrega en la Fase LC.
 */

const C: ClienteCandidato = {
  id: '05:10448', sucursal: '05', sucursal_nombre: 'Zamora Centro', cliente_code: '10448',
  nombre: 'ABARROTES LA ESPERANZA SA DE CV', ciudad: 'Zamora', vendedor_nombre: null,
  clave_ambigua: false,
};

const D = (p: Partial<ReporteDocumento>): ReporteDocumento => ({
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Mostrador', sucursal: '05',
  caja: 5, folio: '0006440', fecha: '2026-09-18', atendio: 'Rosa Maria', renglones: null,
  descuento: 412.3, total: 4182.6, ...p,
});

const SIN_FILTROS: ReporteFiltrosUI = {};

describe('cuerpoReporteCliente — el papel declara su alcance', () => {
  it('dice cuántos documentos quedaron FUERA cuando alguien los quitó', () => {
    const html = cuerpoReporteCliente(C, [D({})], SIN_FILTROS, 3);
    expect(html).toContain('1 de 4');
    expect(html).toContain('quedaron fuera por decisión de quien lo emitió');
  });

  /** Prueba negativa: si nadie quitó nada, no se inventa una salvedad que no existe. */
  it('cuando no se quitó nada, dice que están todos', () => {
    const html = cuerpoReporteCliente(C, [D({})], SIN_FILTROS, 0);
    expect(html).toContain('Incluye todos los documentos del periodo');
    expect(html).not.toContain('quedaron fuera');
  });
});

describe('cuerpoReporteCliente — las notas de crédito restan', () => {
  it('el total del periodo es la compra MENOS la devolución', () => {
    const html = cuerpoReporteCliente(C, [
      D({ total: 4182.6 }),
      D({ id: '05UA2101-0000044', origen: 'abono', origen_label: 'Nota de crédito', total: -1240, descuento: 0 }),
    ], SIN_FILTROS, 0);
    // 4,182.60 − 1,240.00 = 2,942.60
    expect(html).toContain('2,942.60');
    expect(html).toContain('Las notas de crédito se restan del total.');
  });

  it('sin notas de crédito no promete una resta que no hubo', () => {
    const html = cuerpoReporteCliente(C, [D({})], SIN_FILTROS, 0);
    expect(html).not.toContain('Las notas de crédito se restan');
  });
});

describe('cuerpoReporteCliente — lo que acota, se dice', () => {
  it('el filtro de caja avisa que deja fuera las facturas', () => {
    const html = cuerpoReporteCliente(C, [D({})], { caja: '5' }, 0);
    expect(html).toContain('sólo caja 5');
    expect(html).toContain('deja fuera facturas y notas de crédito');
  });

  it('el filtro de marca avisa que el documento entra completo', () => {
    const html = cuerpoReporteCliente(C, [D({})], { brand_id: 'abc' }, 0);
    expect(html).toContain('completos');
  });

  it('sin filtros no imprime una línea de acotes vacía', () => {
    expect(cuerpoReporteCliente(C, [D({})], SIN_FILTROS, 0)).not.toContain('Acotado a:');
  });

  it('sin periodo lo dice, en vez de dejar el hueco mudo', () => {
    expect(cuerpoReporteCliente(C, [D({})], SIN_FILTROS, 0)).toContain('todo el histórico disponible');
  });
});

describe('cuerpoReporteCliente — la fecha no se corre de día', () => {
  it('un documento del 18/09 se imprime 18/09, no 17/09', () => {
    const html = cuerpoReporteCliente(C, [D({ fecha: '2026-09-18' })], SIN_FILTROS, 0);
    expect(html).toContain('18/09/2026');
    expect(html).not.toContain('17/09/2026');
  });

  /** El primero de mes es el peor caso: con el corrimiento cae en el mes anterior. */
  it('el primero de mes tampoco cae en el mes anterior', () => {
    const html = cuerpoReporteCliente(C, [D({ fecha: '2026-09-01' })], SIN_FILTROS, 0);
    expect(html).toContain('01/09/2026');
    expect(html).not.toContain('31/08/2026');
  });
});

describe('cuerpoReporteCliente — no es comprobante fiscal', () => {
  it('lo dice en el pie', () => {
    expect(cuerpoReporteCliente(C, [D({})], SIN_FILTROS, 0)).toContain('Documento informativo, no fiscal');
  });

  /** El nombre del cliente viene de Kepler: si trae `<` o `&`, no puede romper el papel. */
  it('escapa el nombre del cliente en vez de inyectarlo', () => {
    const malo = { ...C, nombre: 'ABARROTES <script>alert(1)</script> & CIA' };
    const html = cuerpoReporteCliente(malo, [D({})], SIN_FILTROS, 0);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; CIA');
  });
});
