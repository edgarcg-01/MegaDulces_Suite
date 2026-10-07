import {
  armarDestinatarios,
  claveNormalizada,
  comisionSugerida,
  destinoTipo,
  fechaISO,
  nombreNormalizado,
  ordenarParadas,
  ParadaKepler,
  resolverPorCodigo,
  resumirViaje,
  tipoDeViaje,
  validarToma,
} from './nuevo-embarque.logic';

/**
 * EMB.12 — Las reglas de «Nuevo embarque desde Kepler», probadas con los casos REALES que se
 * midieron en Kepler el 2026-10-05 (guía 0001419 de Canindo, catálogos de Padre Hidalgo).
 * Cada una decide algo que se le enseña al usuario: un error aquí no truena, publica otra cosa.
 */

// Catálogo de checadores de Padre Hidalgo, tal cual está en Kepler: `1` y `01` son DOS personas.
const CHECADORES = [
  { codigo: '1', nombre: 'JUAN DIEGO' },
  { codigo: '01', nombre: 'IRENE' },
  { codigo: '02', nombre: 'JUAN DIEGO' },
  { codigo: '03', nombre: 'IVETTE' },
  { codigo: '04', nombre: 'LUIS ALEJANDRO RIZO' },
];

describe('fechaISO', () => {
  it('un Date a medianoche local (como lo entrega node-postgres) conserva su día', () => {
    expect(fechaISO(new Date(2026, 9, 3))).toBe('2026-10-03');
  });
  it('NO es String(fecha).slice(0,10), que da «Sat Oct 03» (LC.16)', () => {
    expect(String(new Date(2026, 9, 3)).slice(0, 10)).not.toBe('2026-10-03');
  });
  it('acepta texto ISO y declara null lo que no es fecha', () => {
    expect(fechaISO('2026-10-03T06:00:00.000Z')).toBe('2026-10-03');
    expect(fechaISO('ayer')).toBeNull();
    expect(fechaISO(null)).toBeNull();
    expect(fechaISO(new Date('x'))).toBeNull();
  });
});

describe('claveNormalizada', () => {
  it('quita ceros a la izquierda y espacios', () => {
    expect(claveNormalizada(' 00017 ')).toBe('17');
    expect(claveNormalizada('017')).toBe('17');
  });
  it('vacío o sólo ceros es null, no la cadena vacía', () => {
    expect(claveNormalizada('')).toBeNull();
    expect(claveNormalizada('000')).toBeNull();
    expect(claveNormalizada(null)).toBeNull();
  });
});

describe('resolverPorCodigo — exacto → normalizado → nada', () => {
  it('el código literal manda aunque la clave normalizada choque', () => {
    expect(resolverPorCodigo('01', CHECADORES)).toEqual({ codigo: '01', nombre: 'IRENE', metodo: 'exacto' });
    expect(resolverPorCodigo('1', CHECADORES)).toEqual({ codigo: '1', nombre: 'JUAN DIEGO', metodo: 'exacto' });
  });

  it('una clave normalizada que lleva a dos personas es AMBIGUA, no se escoge una', () => {
    // `001` no existe literal; sin ceros es `1`, que es JUAN DIEGO (`1`) y también IRENE (`01`).
    const r = resolverPorCodigo('001', CHECADORES);
    expect(r.metodo).toBe('ambiguo');
    expect(r.nombre).toBeNull();
  });

  it('normaliza cuando sólo hay una persona detrás de la clave', () => {
    expect(resolverPorCodigo('003', CHECADORES)).toEqual({ codigo: '03', nombre: 'IVETTE', metodo: 'normalizado' });
  });

  it('dos altas de la MISMA persona no son ambigüedad', () => {
    const cat = [{ codigo: '00018', nombre: 'SUBURBAN' }, { codigo: '018', nombre: 'suburban ' }];
    expect(resolverPorCodigo('18', cat).metodo).toBe('normalizado');
  });

  it('sin código en el documento es null (no se buscó), distinto de no encontrado', () => {
    expect(resolverPorCodigo('', CHECADORES).metodo).toBeNull();
    expect(resolverPorCodigo('99', CHECADORES)).toEqual({ codigo: '99', nombre: null, metodo: 'sin_resolver' });
  });
});

describe('destinoTipo / tipoDeViaje', () => {
  it('serie 1 es entrega a cliente; serie 2 se separa por el código del destino', () => {
    expect(destinoTipo(1, 'C3098')).toBe('cliente');
    expect(destinoTipo(2, 'TI006')).toBe('sucursal');
    expect(destinoTipo(2, 'RUTA 28')).toBe('ruta');
    expect(destinoTipo(2, 'RD 501')).toBe('ruta');
  });

  it('una guía que mezcla clientes y sucursales es entrega, y se dice que es mixta', () => {
    const t = tipoDeViaje([{ serie: 1, cliente_code: 'C1' }, { serie: 2, cliente_code: 'TI008' }]);
    expect(t.tipo).toBe('entrega');
    expect(t.mixto).toBe(true);
    expect(t.etiqueta).toBe('Entrega a cliente + Traspaso a sucursal');
  });

  it('cargar un camión de ruta es traspaso (lo que acepta logistics.shipments.type)', () => {
    const t = tipoDeViaje([{ serie: 2, cliente_code: 'RD 503' }]);
    expect(t).toMatchObject({ tipo: 'traspaso', mixto: false, etiqueta: 'Carga a camión de ruta' });
  });
});

// La guía 0001419 de Canindo (3-oct-2026), parada por parada, como la devuelve Kepler.
const GUIA_0001419: ParadaKepler[] = [
  { serie: 1, folio: '0001051', cliente_code: 'C3051', ruta_clave: 'R0041', ruta_nombre: 'SANTAGIO TANGAMNADAPIO', orden_visita: 1, total: '12054.93', cajas: 10, sueltos: 6, kg: null, facturado: true, nota_almacen: '10  CAJAS    A-1' },
  { serie: 1, folio: '0001052', cliente_code: 'C3098', ruta_clave: 'R0057', ruta_nombre: 'JIQUILPAN', orden_visita: 2, total: '54468.36', cajas: 67, sueltos: 0, kg: null, facturado: true },
  { serie: 1, folio: '0001053', cliente_code: 'C3098', ruta_clave: 'R0057', ruta_nombre: 'JIQUILPAN', orden_visita: 2, total: '2002.49', cajas: 5, sueltos: 0, kg: null, facturado: true },
  { serie: 1, folio: '0001054', cliente_code: 'C3080', ruta_clave: 'R0043', ruta_nombre: 'VENUSTIANO CARRANZA', orden_visita: 2, total: '1389.25', cajas: 0, sueltos: 1, kg: 21, facturado: true },
  { serie: 1, folio: '0001055', cliente_code: 'C3080', ruta_clave: 'R0043', ruta_nombre: 'VENUSTIANO CARRANZA', orden_visita: 2, total: '24217.71', cajas: 24, sueltos: 0, kg: null, facturado: false },
  { serie: 1, folio: '0001056', cliente_code: 'C3080', ruta_clave: 'R0043', ruta_nombre: 'VENUSTIANO CARRANZA', orden_visita: 2, total: '305.86', cajas: 0, sueltos: 9, kg: null, facturado: true },
  { serie: 1, folio: '0001057', cliente_code: 'C3080', ruta_clave: 'R0043', ruta_nombre: 'VENUSTIANO CARRANZA', orden_visita: 2, total: '440.93', cajas: 1, sueltos: 0, kg: null, facturado: true },
  { serie: 1, folio: '0001058', cliente_code: 'C3079', ruta_clave: 'R0039', ruta_nombre: 'SAHUAYO', orden_visita: 1, total: '38668.53', cajas: 43, sueltos: 10, kg: null, facturado: true },
  { serie: 1, folio: '0001059', cliente_code: 'C3078', ruta_clave: 'R0039', ruta_nombre: 'SAHUAYO', orden_visita: 5, total: '9194.14', cajas: 18, sueltos: 0, kg: null, facturado: true },
  { serie: 1, folio: '0001060', cliente_code: 'C3064', ruta_clave: 'R0039', ruta_nombre: 'SAHUAYO', orden_visita: 6, total: '3807.91', cajas: 3, sueltos: 0, kg: null, facturado: true },
  { serie: 1, folio: '0001061', cliente_code: 'C3054', ruta_clave: 'R0043', ruta_nombre: 'VENUSTIANO CARRANZA', orden_visita: 1, total: '2752.66', cajas: 1, sueltos: 33, kg: null, facturado: true },
  { serie: 1, folio: '0001062', cliente_code: 'C3054', ruta_clave: 'R0043', ruta_nombre: 'VENUSTIANO CARRANZA', orden_visita: 1, total: '3459.73', cajas: 2, sueltos: 26, kg: 18, facturado: true },
  { serie: 1, folio: '0001067', cliente_code: 'C3080', ruta_clave: 'R0043', ruta_nombre: 'VENUSTIANO CARRANZA', orden_visita: 2, total: '6833.70', cajas: 16, sueltos: 0, kg: null, facturado: true },
];

describe('resumirViaje — la guía 0001419 de Canindo', () => {
  const r = resumirViaje(GUIA_0001419);

  it('cuadra con lo medido en Kepler: 13 paradas, 7 clientes, 4 rutas, 190 cajas, 85 sueltos', () => {
    expect(r.paradas).toBe(13);
    // 7, no 6: C3051, C3098, C3080, C3079, C3078, C3064 y C3054 (la maqueta dijo 6 y estaba mal).
    expect(r.clientes).toBe(7);
    // Ordenadas por nombre: JIQUILPAN, SAHUAYO, SANTAGIO TANGAMNADAPIO, VENUSTIANO CARRANZA.
    expect(r.rutas.map((x) => x.clave)).toEqual(['R0057', 'R0039', 'R0041', 'R0043']);
    expect(r.cajas).toBe(190);
    expect(r.sueltos).toBe(85);
  });

  it('el valor se suma en centavos: $159,596.20 exactos, sin colas de flotante', () => {
    expect(r.valor_venta).toBe(159596.2);
    expect(r.valor_traspaso).toBe(0);
  });

  it('kilos: sólo los de renglones por kilo (39), y el peso total se declara inexistente', () => {
    expect(r.kg_vendido_por_kilo).toBe(39);
    expect(r.peso_total).toBeNull();
  });

  it('cuenta las facturadas sobre las paradas a cliente', () => {
    expect(r.facturadas).toBe(12);
    expect(r.paradas_a_cliente).toBe(13);
  });

  it('sin renglones por kilo, el kilo es null — no cero', () => {
    expect(resumirViaje([{ serie: 1, folio: '1', kg: null }]).kg_vendido_por_kilo).toBeNull();
  });

  it('la venta y el traspaso NO se suman: Kepler valúa el traspaso a costo', () => {
    const m = resumirViaje([
      { serie: 1, folio: '1', cliente_code: 'C1', total: 100 },
      { serie: 2, folio: '2', cliente_code: 'TI008', total: 40 },
    ]);
    expect(m.valor_venta).toBe(100);
    expect(m.valor_traspaso).toBe(40);
  });
});

describe('ordenarParadas', () => {
  it('ruta alfabética, luego orden de visita, luego folio; lo que no tiene ruta al final', () => {
    const xs = ordenarParadas([
      { serie: 1, folio: '3', ruta_nombre: null },
      { serie: 1, folio: '2', ruta_nombre: 'SAHUAYO', orden_visita: 5 },
      { serie: 1, folio: '1', ruta_nombre: 'SAHUAYO', orden_visita: 1 },
      { serie: 1, folio: '4', ruta_nombre: 'JIQUILPAN', orden_visita: 9.5 },
    ]);
    expect(xs.map((x) => x.folio)).toEqual(['4', '1', '2', '3']);
  });
});

// Catálogo de rutas de la Suite (logistics.routes) con las comisiones que ya tiene.
const RUTAS_SUITE = [
  { id: 'r-jiq', name: 'JIQUILPAN', kepler_code: null, driver_commission: '98.04', helper_commission: '57.76' },
  { id: 'r-tan', name: 'TANGAMANDAPIO', kepler_code: null, driver_commission: '103.20', helper_commission: '63.84' },
  { id: 'r-sah', name: 'SAHUAYO', kepler_code: null, driver_commission: '92.88', helper_commission: '51.68' },
  { id: 'r-vca', name: 'Venustiano Carranza', kepler_code: null, driver_commission: '77.40', helper_commission: '48.64' },
];

describe('comisionSugerida', () => {
  it('con varias rutas usa la de mayor comisión, y dice cuál fue', () => {
    const c = comisionSugerida([{ clave: 'R0057', nombre: 'JIQUILPAN' }, { clave: 'R0039', nombre: 'SAHUAYO' }], RUTAS_SUITE);
    expect(c).toMatchObject({ driver: 98.04, helper: 57.76, regla: 'mayor_comision_del_viaje' });
    expect(c.ruta_usada?.route_id).toBe('r-jiq');
  });

  it('NO empareja por parecido: «SANTAGIO TANGAMNADAPIO» de Kepler no es «TANGAMANDAPIO»', () => {
    const c = comisionSugerida(
      [{ clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO' }, { clave: 'R0043', nombre: 'VENUSTIANO CARRANZA' }],
      RUTAS_SUITE,
    );
    expect(c.sin_tarifa).toEqual([{ clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO' }]);
    expect(c.driver).toBe(77.4); // la única emparejada (sin acentos ni mayúsculas)
  });

  it('kepler_code gana sobre el nombre', () => {
    const cat = [...RUTAS_SUITE, { id: 'r-k', name: 'OTRO NOMBRE', kepler_code: 'R0041', driver_commission: 150, helper_commission: 90 }];
    const c = comisionSugerida([{ clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO' }], cat);
    expect(c.emparejadas[0]).toMatchObject({ metodo: 'kepler_code', route_id: 'r-k' });
    expect(c.driver).toBe(150);
  });

  it('una ruta emparejada con tarifa 0/0 (alta automática desde Kepler) es «sin tarifa», no tarifa cero', () => {
    const cat = [...RUTAS_SUITE, { id: 'r-k', name: 'SANTAGIO TANGAMNADAPIO', kepler_code: 'R0041', driver_commission: '0.00', helper_commission: '0.00' }];
    const c = comisionSugerida([{ clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO' }], cat);
    expect(c.sin_tarifa).toEqual([{ clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO' }]);
    expect(c.emparejadas).toHaveLength(0);
    expect(c.driver).toBeNull();
  });

  it('si ninguna ruta tiene tarifa, la sugerencia es null (no cero)', () => {
    const c = comisionSugerida([{ clave: 'R9', nombre: 'NINGUNA' }], RUTAS_SUITE);
    expect(c.driver).toBeNull();
    expect(c.helper).toBeNull();
    expect(c.ruta_usada).toBeNull();
  });

  it('nombreNormalizado quita acentos y signos', () => {
    expect(nombreNormalizado('  Sahuayo de Morelos, Mich.')).toBe('SAHUAYO DE MORELOS MICH');
    expect(nombreNormalizado('Purísima del Rincón')).toBe('PURISIMA DEL RINCON');
  });
});

describe('validarToma', () => {
  const base = { delivery_type: 'route' };
  // La tarifa del viaje 06-G0001419 si todas sus rutas tuvieran tarifa: la mayor es JIQUILPAN.
  const tarifa = { driver: 98.04, helper: 57.76, ruta_usada: { clave: 'R0057', nombre: 'JIQUILPAN', route_id: 'r57' }, sin_tarifa: [] };
  const ctxConChofer = { chofer_kepler_driver_id: 'd-cesar', ya_tomado_folio: null, comision: tarifa, paradas_sin_ruta: 0 };
  const ctxSinChofer = { ...ctxConChofer, chofer_kepler_driver_id: null };

  it('con chofer de Kepler y tipo de entrega, se puede tomar', () => {
    expect(validarToma(base, ctxConChofer)).toEqual([]);
  });

  it('si Kepler no trae chofer (unidad 00008 en Padre Hidalgo), hay que elegirlo', () => {
    expect(validarToma(base, ctxSinChofer)).toContain('Falta el chofer: Kepler no lo trae para esta unidad. Elígelo.');
    expect(validarToma({ ...base, driver_id: 'd-x' }, ctxSinChofer)).toEqual([]);
  });

  it('si Kepler trae al chofer, la API no acepta otro: se corrige en Kepler', () => {
    expect(validarToma({ ...base, driver_id: 'd-otro' }, ctxConChofer))
      .toContain('El chofer viene de Kepler y no se cambia aquí: corrígelo en Kepler.');
    // Mandar el mismo que trae Kepler no es un cambio.
    expect(validarToma({ ...base, driver_id: 'd-cesar' }, ctxConChofer)).toEqual([]);
  });

  it('una guía ya tomada no se toma otra vez, y dice en qué embarque está', () => {
    expect(validarToma(base, { ...ctxConChofer, ya_tomado_folio: 'EMB-2026-00012' }))
      .toContain('Este viaje ya se tomó en el embarque EMB-2026-00012.');
  });

  it('exige el tipo de entrega', () => {
    expect(validarToma({}, ctxConChofer)).toContain('Indica si la entrega es por ruta o viaje largo.');
    expect(validarToma({ delivery_type: 'avion' }, ctxConChofer)).toHaveLength(1);
  });

  it('el chofer no puede ser ayudante, y los ayudantes no se repiten', () => {
    expect(validarToma({ ...base, helper1_id: 'd-cesar' }, ctxConChofer)).toContain('El chofer no puede ir también como ayudante.');
    expect(validarToma({ ...base, helper1_id: 'a', helper2_id: 'a' }, ctxConChofer)).toContain('Ayudante 1 y ayudante 2 son la misma persona.');
    expect(validarToma({ ...base, helper2_id: 'a' }, ctxConChofer)).toContain('Captura primero al ayudante 1.');
  });

  it('montos negativos o no numéricos se rechazan; los km son enteros', () => {
    const e = validarToma({ ...base, per_diem_total: Number.NaN, freight_revenue: -1, actual_km: 12.5 }, ctxConChofer);
    expect(e).toContain('Los viáticos debe ser un número mayor o igual a cero.');
    expect(e).toContain('El flete cobrado debe ser un número mayor o igual a cero.');
    expect(e).toContain('Los kilómetros deben ser un número entero mayor o igual a cero.');
  });

  // ── La comisión se CALCULA (fórmula de la beta de Logística, decisión 2026-10-07) ──────────

  it('una ruta del viaje sin tarifa FRENA la toma (la guía 0001419 real: SANTAGIO no tiene)', () => {
    const ctx = { ...ctxConChofer, comision: { ...tarifa, sin_tarifa: [{ clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO' }] } };
    expect(validarToma(base, ctx)).toEqual(['Falta la tarifa de SANTAGIO TANGAMNADAPIO en Logística › Configuración › Comisiones.']);
  });

  it('una parada sin ruta en Kepler también frena', () => {
    expect(validarToma(base, { ...ctxConChofer, paradas_sin_ruta: 2 })[0]).toMatch(/^2 paradas no tienen ruta en Kepler/);
  });

  it('una comisión tecleada distinta de la calculada se rechaza; la misma pasa', () => {
    expect(validarToma({ ...base, driver_commission: 150 }, ctxConChofer))
      .toContain('La comisión se calcula de la tarifa de la ruta; no se captura.');
    expect(validarToma({ ...base, helper1_commission: 57.76 }, ctxConChofer))
      .toContain('La comisión se calcula de la tarifa de la ruta; no se captura.'); // no va ayudante: le toca 0
    expect(validarToma({ ...base, driver_commission: 98.04, helper1_id: 'a', helper1_commission: 57.76 }, ctxConChofer)).toEqual([]);
  });
});

describe('armarDestinatarios', () => {
  it('una parada por destinatario, en el orden de la ruta, con la llave de Kepler', () => {
    const d = armarDestinatarios(GUIA_0001419, '06');
    expect(d).toHaveLength(13);
    expect(d[0]).toMatchObject({ kepler_folio: '0001052', kepler_serie: '1', kepler_warehouse_code: '06', boxes_count: 67, value: 54468.36 });
    expect(d.reduce((a, x) => a + x.boxes_count, 0)).toBe(190);
  });

  it('sin nombre de destino usa el código de cliente, y la nota de almacén viaja como nota', () => {
    const [x] = armarDestinatarios([{ serie: 1, folio: '9', cliente_code: 'C3051', nota_almacen: ' 10 CAJAS A-1 ' }], '06');
    expect(x.customer_name).toBe('C3051');
    expect(x.notes).toBe('10 CAJAS A-1');
    expect(x.address).toBeNull();
  });
});
