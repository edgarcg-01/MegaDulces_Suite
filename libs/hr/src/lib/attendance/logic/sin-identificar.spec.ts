import { sinIdentificar, type FilaChecoEnSemana } from './sin-identificar';

const fila = (o: Partial<FilaChecoEnSemana>): FilaChecoEnSemana => ({
  codigo: '1', checadas: 4, ligado: true, ignorado: false, nombre: 'Ana López Ruiz',
  departamento: 'Cajas · cajas', tieneDepartamento: true, nombreReloj: 'Ana', ...o,
});

describe('[RH.1.6b] sin identificar', () => {
  it('identificada (ficha, nombre completo y departamento) no sale', () => {
    expect(sinIdentificar([fila({})])).toEqual([]);
  });

  it('sin ficha, nombre de una palabra o sin departamento sí salen, con el motivo', () => {
    const r = sinIdentificar([
      fila({ codigo: '2', ligado: false, nombre: null, departamento: null, tieneDepartamento: false, nombreReloj: 'Donnacho', checadas: 9 }),
      fila({ codigo: '3', nombre: 'Juan', checadas: 2 }),
      fila({ codigo: '4', departamento: null, tieneDepartamento: false, checadas: 5 }),
    ]);
    expect(r.map((p) => [p.codigo, p.sinFicha, p.sinNombre, p.sinDepartamento])).toEqual([
      ['2', true, true, true], ['4', false, false, true], ['3', false, true, false],
    ]);
    expect(r[0].nombre).toBe('Donnacho');
  });

  it('no cuentan: promotora de marca, Admin, ignorados', () => {
    expect(sinIdentificar([
      fila({ codigo: '5', nombre: 'Promo', departamento: 'Promotoría de marca · promotoria_marca' }),
      fila({ codigo: '6', ligado: false, nombreReloj: 'Admin', nombre: null }),
      fila({ codigo: '7', ligado: false, ignorado: true, nombre: null }),
    ])).toEqual([]);
  });

  it('«PROMOTORIA MEGA DULCES» SÍ cuenta (es piso): sin nombre completo, sale', () => {
    const r = sinIdentificar([fila({ codigo: '8', nombre: 'Lupita', departamento: 'PROMOTORIA MEGA DULCES · tienda' })]);
    expect(r.map((p) => p.codigo)).toEqual(['8']);
  });

  it('⛔ NEGATIVA — una persona SIN ligar nunca se salva por tener nombre largo en el reloj', () => {
    const r = sinIdentificar([fila({ codigo: '9', ligado: false, nombre: null, nombreReloj: 'Juan Pérez López' })]);
    expect(r[0]).toMatchObject({ sinFicha: true });
  });
});
