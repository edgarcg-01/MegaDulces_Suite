import { accionesNegociacion, margenSobreCosto, type PedidoNegociacionDto } from './pedido-negociacion.contract';

/**
 * `[RA-NEG.1]` Las acciones del panel «Costo y negociación»: cada una aparece SÓLO cuando el dato que
 * la justifica existe. Los números son los de 70056 La Rosa Mazapán medidos en prod el 2026-10-22.
 */
const nombre = (c: string) => ({ '06': 'Canindo', '08': 'Morelia Abastos' } as Record<string, string>)[c] ?? c;

function dto(over: Partial<PedidoNegociacionDto> = {}): PedidoNegociacionDto {
  return {
    product_id: 'p', sku: '70056', unidad_base: 'PAQ', base_por_caja: 16,
    costo: {
      estandar_base: 78.595625, reposicion_base: 82.68, precio_ficha: 102.94, impuesto_pct: 8, precio_igual_en_todas: true,
      margen_ficha_pct: 21.27, precio_conserva_margen: 108.29, impacto_30d: 17735.76, sucursales_afectadas: ['01', '03', '07', '08'],
    },
    pagado: {
      desde: '2025-10-22', hasta: '2026-10-22', meses: [], ultimo: { fecha: '2026-10-21', sucursal: '06', costo_base: 78.595 },
      minimo: null, total_base: 52368, total_valor: 4455190.69, renglones: 81, renglones_sin_unidad: 0, renglones_atipicos: 0,
      al_estandar_reciente: [{ sucursal: '06', entradas: 3, base: 1520, costo_base: 78.5956 }], entradas: [],
    },
    proveedor: {
      supplier_id: 's', nombre: 'DISTRIBUIDORA DE LA ROSA SA DE CV', compras_12m: 81143559.22, recepciones_12m: 618,
      descuento_pago_12m: 3131340.22, descuento_notas_12m: 2092748.91, descuento_pct: 6.44,
      pronto_pago: { tasa: 0.0709, fuente: 'observed', pagos: 136, sin_descuento: 43, monto_sin_descuento: 20049786.69,
        estimado_perdido: 1421529.88, ultimo_sin_descuento: '2026-09-21', ultimos_sin_descuento: null },
      plazo_dias: 20, plazo_base: 'factura', plazo_kepler: [], tiempo_entrega_dias: null, reclamos: { del_proveedor: 0, en_la_base: 0 },
    },
    generado_at: '2026-10-22T12:00:00Z',
    ...over,
  };
}
const claves = (d: PedidoNegociacionDto) => accionesNegociacion(d, nombre).map((a) => a.clave);

describe('margenSobreCosto', () => {
  it('es el de Kepler: precio sin impuesto ÷ costo − 1', () => {
    expect(margenSobreCosto(102.94, 8, 82.68)!).toBeCloseTo(15.28, 2);
    expect(margenSobreCosto(102.94, 8, 78.595625)!).toBeCloseTo(21.27, 2);
  });
  it('sin impuesto medido o sin costo NO hay margen (nunca un cero)', () => {
    expect(margenSobreCosto(102.94, null, 82.68)).toBeNull();
    expect(margenSobreCosto(102.94, 8, 0)).toBeNull();
  });
});

describe('accionesNegociacion', () => {
  it('70056: negocia, o sube, pide y confirma — en ese orden', () => {
    const a = accionesNegociacion(dto(), nombre);
    expect(a.map((x) => x.verbo)).toEqual(['Negocia', 'O sube', 'Pide', 'Confirma']);
    expect(a[0].que).toBe('$1,257.53 la caja');
    expect(a[0].por).toBe('(hoy $1,322.88)');
    expect(a[1].que).toBe('el precio a $108.29');
    expect(a[3].que).toBe('el $78.60 de Canindo');
  });

  it('negocia contra la REPOSICIÓN, no contra la última entrada (que fue justo la del estándar)', () => {
    // Control: la última entrada es igual al estándar; si se comparara contra ella no habría acción.
    expect(claves(dto())).toContain('negocia');
    const alDia = dto({ costo: { ...dto().costo, reposicion_base: 78.595625 } });
    expect(claves(alDia)).not.toContain('negocia');
  });

  it('sin estándar no se negocia contra nada', () => {
    expect(claves(dto({ costo: { ...dto().costo, estandar_base: null } }))).not.toContain('negocia');
  });

  it('«sube» exige impacto medido y un solo precio; si es la única, se dice «Sube»', () => {
    expect(claves(dto({ costo: { ...dto().costo, impacto_30d: 0 } }))).not.toContain('sube');
    expect(claves(dto({ costo: { ...dto().costo, precio_igual_en_todas: false } }))).not.toContain('sube');
    const sola = accionesNegociacion(dto({ costo: { ...dto().costo, reposicion_base: 78.595625 } }), nombre);
    expect(sola[0].verbo).toBe('Sube');
  });

  it('«pide» sólo con pronto pago que se dejó de tomar', () => {
    expect(claves(dto({ proveedor: { ...dto().proveedor!, pronto_pago: null } }))).not.toContain('pide');
    const todos = { ...dto().proveedor!.pronto_pago!, sin_descuento: 0, estimado_perdido: 0 };
    expect(claves(dto({ proveedor: { ...dto().proveedor!, pronto_pago: todos } }))).not.toContain('pide');
    expect(claves(dto({ proveedor: null }))).not.toContain('pide');
  });

  it('«confirma» nombra la sucursal, y lo de oficinas sin plaza no se llama CEDIS', () => {
    const a = accionesNegociacion(dto(), nombre).find((x) => x.clave === 'confirma')!;
    expect(a.que).not.toMatch(/\b0\d\b/);   // nunca un código de sucursal
    const ofi = dto({ pagado: { ...dto().pagado, al_estandar_reciente: [{ sucursal: '00', entradas: 1, base: 240, costo_base: 40.39 }] } });
    expect(accionesNegociacion(ofi, () => 'CEDIS').find((x) => x.clave === 'confirma')!.que).toBe('el $40.39 capturado en oficinas');
    expect(claves(dto({ pagado: { ...dto().pagado, al_estandar_reciente: [] } }))).not.toContain('confirma');
  });

  it('sin caja, el costo se dice por su unidad base', () => {
    const a = accionesNegociacion(dto({ base_por_caja: null }), nombre)[0];
    expect(a.que).toBe('$78.60 paq');
  });
});
