/**
 * Código Agrupador del SAT (c_CodigoAgrupador, Anexo 24) — SUBCONJUNTO común.
 * Sirve como sugerencias (datalist) al capturar el mapeo cuenta mayor → agrupador.
 * NO es el catálogo completo (~700 códigos): el contador puede escribir cualquier
 * clave válida con formato NNN o NNN.NN. Naturaleza contable: D deudora / A acreedora.
 */

export interface SatCodAgrup {
  code: string;
  label: string;
  natur: 'D' | 'A';
}

export const SAT_COD_AGRUPADOR: SatCodAgrup[] = [
  // ── Activo (deudora) ──
  { code: '101.01', label: 'Caja y efectivo', natur: 'D' },
  { code: '102.01', label: 'Bancos nacionales', natur: 'D' },
  { code: '102.02', label: 'Bancos extranjeros', natur: 'D' },
  { code: '103.01', label: 'Inversiones temporales', natur: 'D' },
  { code: '105.01', label: 'Clientes nacionales', natur: 'D' },
  { code: '105.02', label: 'Clientes extranjeros', natur: 'D' },
  { code: '106.01', label: 'Cuentas y documentos por cobrar (corto plazo)', natur: 'D' },
  { code: '107.01', label: 'Deudores diversos por cobrar', natur: 'D' },
  { code: '108.01', label: 'Estimación de cuentas incobrables', natur: 'A' },
  { code: '110.01', label: 'Pagos anticipados', natur: 'D' },
  { code: '113.01', label: 'Anticipo a proveedores', natur: 'D' },
  { code: '115.01', label: 'Inventario', natur: 'D' },
  { code: '115.05', label: 'Mercancías en tránsito', natur: 'D' },
  { code: '118.01', label: 'IVA acreditable pagado', natur: 'D' },
  { code: '118.02', label: 'IVA acreditable pendiente de pago', natur: 'D' },
  { code: '119.01', label: 'IVA a favor', natur: 'D' },
  { code: '120.01', label: 'Anticipo de impuestos (pagos provisionales)', natur: 'D' },
  { code: '151.01', label: 'Terrenos', natur: 'D' },
  { code: '152.01', label: 'Edificios', natur: 'D' },
  { code: '153.01', label: 'Maquinaria y equipo', natur: 'D' },
  { code: '154.01', label: 'Equipo de transporte', natur: 'D' },
  { code: '155.01', label: 'Mobiliario y equipo de oficina', natur: 'D' },
  { code: '156.01', label: 'Equipo de cómputo', natur: 'D' },
  { code: '163.01', label: 'Depreciación acumulada', natur: 'A' },

  // ── Pasivo (acreedora) ──
  { code: '201.01', label: 'Proveedores nacionales', natur: 'A' },
  { code: '201.02', label: 'Proveedores extranjeros', natur: 'A' },
  { code: '205.01', label: 'Acreedores diversos (corto plazo)', natur: 'A' },
  { code: '206.01', label: 'Cuentas y documentos por pagar (corto plazo)', natur: 'A' },
  { code: '208.01', label: 'IVA trasladado', natur: 'A' },
  { code: '209.01', label: 'IVA trasladado no cobrado (pendiente)', natur: 'A' },
  { code: '210.01', label: 'Provisión de sueldos y salarios por pagar', natur: 'A' },
  { code: '211.01', label: 'Retenciones ISR por salarios', natur: 'A' },
  { code: '213.01', label: 'Impuestos y derechos por pagar', natur: 'A' },
  { code: '214.01', label: 'IVA por pagar', natur: 'A' },
  { code: '216.01', label: 'Anticipo de clientes', natur: 'A' },

  // ── Capital (acreedora) ──
  { code: '301.01', label: 'Capital social', natur: 'A' },
  { code: '302.01', label: 'Reservas', natur: 'A' },
  { code: '304.01', label: 'Resultado de ejercicios anteriores', natur: 'A' },
  { code: '305.01', label: 'Resultado del ejercicio', natur: 'A' },

  // ── Ingresos (acreedora) ──
  { code: '401.01', label: 'Ventas y/o servicios gravados a la tasa general (16%)', natur: 'A' },
  { code: '401.02', label: 'Ventas y/o servicios exentos', natur: 'A' },
  { code: '401.03', label: 'Ventas y/o servicios a la tasa 0%', natur: 'A' },
  { code: '402.01', label: 'Devoluciones, descuentos o bonificaciones sobre ventas', natur: 'D' },
  { code: '403.01', label: 'Otros ingresos', natur: 'A' },

  // ── Costos (deudora) ──
  { code: '501.01', label: 'Costo de venta', natur: 'D' },
  { code: '502.01', label: 'Compras nacionales', natur: 'D' },
  { code: '502.02', label: 'Compras de importación', natur: 'D' },
  { code: '503.01', label: 'Devoluciones, descuentos o bonificaciones sobre compras', natur: 'A' },

  // ── Gastos (deudora) ──
  { code: '601.01', label: 'Gastos — Sueldos y salarios', natur: 'D' },
  { code: '601.06', label: 'Gastos — Honorarios', natur: 'D' },
  { code: '601.13', label: 'Gastos — Combustibles y lubricantes', natur: 'D' },
  { code: '601.19', label: 'Gastos — Fletes y acarreos', natur: 'D' },
  { code: '601.32', label: 'Gastos — Renta', natur: 'D' },
  { code: '601.50', label: 'Gastos — Luz, agua y teléfono', natur: 'D' },
  { code: '601.55', label: 'Gastos — Mantenimiento', natur: 'D' },
  { code: '601.62', label: 'Gastos — Publicidad y propaganda', natur: 'D' },
  { code: '601.84', label: 'Otros gastos generales', natur: 'D' },

  // ── Resultado integral de financiamiento ──
  { code: '701.01', label: 'Gastos financieros', natur: 'D' },
  { code: '702.01', label: 'Productos financieros', natur: 'A' },
];
