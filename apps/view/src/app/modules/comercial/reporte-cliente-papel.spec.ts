import { cuerpoReporteCliente } from './reporte-cliente-papel';
import type { ClienteCandidato, ReporteDocumento, ReporteFiltrosUI } from './tickets.service';

/**
 * Candado del PAPEL del reporte por cliente (TK.8).
 *
 * **1. El papel declara su alcance.** Un reporte donde alguien eligió qué entra tiene que decir
 * cuántos quedaron fuera; si no, quien lo recibe lo lee como si fuera todo (ADR-056).
 *
 * **2. Las notas de crédito restan.** Van en su lugar por fecha y en negativo, y el total es lo
 * que el cliente pagó. Si se omitieran, el papel afirmaría que pagó mercancía que devolvió.
 *
 * **3. La clave ambigua se dice.** El catálogo de clientes está replicado en las nueve
 * sucursales y el reporte junta todas — pero cuando la MISMA clave trae nombres distintos según
 * la plaza, puede estar sumando a dos personas. Eso va impreso, no en un manual.
 *
 * **4. La fecha no se corre de día.** Un `date` de Postgres leído con `new Date()` y renderizado
 * en hora de México sale con el día ANTERIOR. Ya costó una entrega en la Fase LC.
 */

const C: ClienteCandidato = {
  cliente_code: '10448', nombre: 'ABARROTES LA ESPERANZA SA DE CV', ciudad: 'Zamora',
  zona: 'CENTRO', plazas: 9, clave_ambigua: false, score: 1,
};

const D = (p: Partial<ReporteDocumento>): ReporteDocumento => ({
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Mostrador', sucursal: '05',
  sucursal_nombre: 'Zamora Centro', caja: 5, folio: '0006440', fecha: '2026-09-18',
  atendio: 'Rosa Maria', descuento: 412.3, total: 4182.6, ...p,
});

const SIN: ReporteFiltrosUI = {};

describe('el papel declara su alcance', () => {
  it('dice cuántos documentos quedaron FUERA cuando alguien los quitó', () => {
    const html = cuerpoReporteCliente(C, [D({})], SIN, 3);
    expect(html).toContain('1 de 4');
    expect(html).toContain('quedaron fuera por decisión de quien lo emitió');
  });

  /** Prueba negativa: si nadie quitó nada, no se inventa una salvedad que no existe. */
  it('cuando no se quitó nada, dice que están todos', () => {
    const html = cuerpoReporteCliente(C, [D({})], SIN, 0);
    expect(html).toContain('Incluye todos los documentos del periodo');
    expect(html).not.toContain('quedaron fuera');
  });

  /** El reporte ahora cruza sucursales: cuántas, en el encabezado. */
  it('dice en cuántas sucursales compró', () => {
    const html = cuerpoReporteCliente(C, [
      D({ id: 'A', sucursal: '05' }), D({ id: 'B', sucursal: '01', sucursal_nombre: 'Padre Hidalgo' }),
    ], SIN, 0);
    expect(html).toContain('2 sucursales');
    expect(html).toContain('Padre Hidalgo');
  });

  it('con una sola sucursal lo dice en singular', () => {
    const html = cuerpoReporteCliente(C, [D({})], SIN, 0);
    expect(html).toContain('en 1 sucursal');
    expect(html).not.toContain('en 1 sucursales');
  });
});

describe('las notas de crédito restan', () => {
  it('el total del periodo es la compra MENOS la devolución', () => {
    const html = cuerpoReporteCliente(C, [
      D({ total: 4182.6 }),
      D({ id: '05UA2101-0000044', origen: 'abono', origen_label: 'Nota de crédito', total: -1240, descuento: 0 }),
    ], SIN, 0);
    expect(html).toContain('2,942.60');
    expect(html).toContain('Las notas de crédito se restan del total.');
  });

  it('sin notas de crédito no promete una resta que no hubo', () => {
    expect(cuerpoReporteCliente(C, [D({})], SIN, 0)).not.toContain('Las notas de crédito se restan');
  });
});

describe('la clave ambigua se dice', () => {
  it('avisa cuando la misma clave trae nombres distintos por plaza', () => {
    const html = cuerpoReporteCliente({ ...C, clave_ambigua: true }, [D({})], SIN, 0);
    expect(html).toContain('nombres distintos');
    expect(html).toContain('mas de un cliente');
  });

  it('sin ambigüedad no siembra una duda que no existe', () => {
    expect(cuerpoReporteCliente(C, [D({})], SIN, 0)).not.toContain('nombres distintos');
  });
});

describe('lo que acota, se dice', () => {
  it('el filtro de caja avisa que deja fuera las facturas', () => {
    const html = cuerpoReporteCliente(C, [D({})], { caja: '5' }, 0);
    expect(html).toContain('sólo caja 5');
    expect(html).toContain('deja fuera facturas y notas de crédito');
  });

  it('el folio y la sucursal también se declaran', () => {
    const html = cuerpoReporteCliente(C, [D({})], { folio: '6440', warehouse_codes: '05' }, 0);
    expect(html).toContain('folio que contenga');
    expect(html).toContain('sólo la sucursal 05');
  });

  it('el filtro de marca avisa que el documento entra completo', () => {
    expect(cuerpoReporteCliente(C, [D({})], { brand_id: 'abc' }, 0)).toContain('completos');
  });

  it('sin filtros no imprime una línea de acotes vacía', () => {
    expect(cuerpoReporteCliente(C, [D({})], SIN, 0)).not.toContain('Acotado a:');
  });

  it('sin periodo lo dice, en vez de dejar el hueco mudo', () => {
    expect(cuerpoReporteCliente(C, [D({})], SIN, 0)).toContain('todo el histórico disponible');
  });
});

describe('la fecha no se corre de día', () => {
  it('un documento del 18/09 se imprime 18/09, no 17/09', () => {
    const html = cuerpoReporteCliente(C, [D({ fecha: '2026-09-18' })], SIN, 0);
    expect(html).toContain('18/09/2026');
    expect(html).not.toContain('17/09/2026');
  });

  /** El primero de mes es el peor caso: con el corrimiento cae en el mes anterior. */
  it('el primero de mes tampoco cae en el mes anterior', () => {
    const html = cuerpoReporteCliente(C, [D({ fecha: '2026-09-01' })], SIN, 0);
    expect(html).toContain('01/09/2026');
    expect(html).not.toContain('31/08/2026');
  });
});

describe('se declara informativo, y no se rompe con lo que venga de Kepler', () => {
  it('lo dice en el pie', () => {
    // `[TK.14]` Sin «fiscal» ni «no fiscal» en el papel (pedido del usuario 2026-09-30).
    const t = cuerpoReporteCliente(C, [D({})], SIN, 0);
    expect(t).toContain('Documento informativo.');
    expect(t.toLowerCase()).not.toContain('fiscal');
  });

  /** El nombre viene de Kepler: si trae `<` o `&`, no puede romper el papel. */
  it('escapa el nombre del cliente en vez de inyectarlo', () => {
    const malo = { ...C, nombre: 'ABARROTES <script>alert(1)</script> & CIA' };
    const html = cuerpoReporteCliente(malo, [D({})], SIN, 0);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; CIA');
  });

  it('un reporte sin documentos lo declara en vez de salir en blanco', () => {
    expect(cuerpoReporteCliente(C, [], SIN, 0)).toContain('Sin documentos.');
  });
});

/**
 * `[TK.d3]` La columna del descuento: se llama por su nombre y trae el porcentaje.
 *
 * El rótulo pelado «Descuento» se leía como «todo lo que el cliente ahorró», y no es eso: es el
 * descuento **de cabecera** que declara el ERP. Las rebajas por renglón son otra capa y sólo
 * salen con «Detalle por producto» (medido: de 609 facturas, 435 difieren en más de $1 entre
 * las dos — `ERP_KEPLER` §3.1).
 */
describe('[TK.d3] el descuento de cliente en el papel', () => {
  it('la columna se llama «Descuento de cliente», no «Descuento» a secas', () => {
    const html = cuerpoReporteCliente(C, [D({})], SIN, 0);
    expect(html).toContain('>Descuento de cliente<');
  });

  it('imprime el porcentaje que el ERP declara, al lado del importe', () => {
    const html = cuerpoReporteCliente(C, [D({ descuento: 742.27, descuento_pct: 3 })], SIN, 0);
    expect(html).toContain('742.27');
    expect(html).toContain('(3%)');
  });

  /**
   * ⚠️ Sin porcentaje declarado no se inventa un «(0%)»: un documento que no lo trae no es uno
   * con cero por ciento de descuento (ADR-056).
   */
  it('sin porcentaje declarado sale el importe solo', () => {
    const html = cuerpoReporteCliente(C, [D({ descuento: 742.27, descuento_pct: null })], SIN, 0);
    expect(html).toContain('742.27');
    expect(html).not.toContain('(0%)');
  });

  /** Y sin descuento sigue saliendo el guion, no un $0.00 que afirmaría un descuento de cero. */
  it('sin descuento, guion', () => {
    const html = cuerpoReporteCliente(C, [D({ descuento: 0, descuento_pct: null })], SIN, 0);
    expect(html).toContain('—');
  });
});
