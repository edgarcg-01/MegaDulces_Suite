/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  console.log('[01f_embarque_completo_con_relaciones] Generando 50 embarques con relaciones (guía y costo)...');

  // Obtener datos existentes
  const choferes = await knex('logistica_colaboradores')
    .select('id', 'nombre')
    .whereRaw("roles::text LIKE ?", ['%chofer%'])
    .orWhereRaw("roles::text LIKE ?", ['%Operador%'])
    .limit(10);

  const ayudantes = await knex('logistica_colaboradores')
    .select('id', 'nombre')
    .whereRaw("roles::text LIKE ?", ['%ayudante%'])
    .limit(5);

  const unidades = await knex('logistica_unidades')
    .select('id', 'placa')
    .limit(5);

  if (choferes.length < 1 || unidades.length < 1) {
    console.log('[01f_embarque_completo_con_relaciones] No hay suficientes choferes o unidades, skipping.');
    return;
  }

  const destinos = [
    'GUADALAJARA', 'MORELIA', 'ZACATECAS', 'LEON', 'QUERETARO',
    'PUEBLA', 'MEXICO', 'TO LUCA', 'CUERNAVACA', 'TOLUCA',
    'AGUASCALIENTES', 'SAN LUIS POTOSI', 'MONTERREY', 'GUANAJUATO'
  ];

  const origenes = ['ZAMORA', 'MORELIA', 'URUAPAN', 'PATZCUARO'];

  let embarquesCreados = 0;
  let guiasCreadas = 0;
  let costosCreados = 0;

  for (let i = 0; i < 50; i++) {
    const chofer = choferes[i % choferes.length];
    const ayudante1 = ayudantes.length > 0 ? ayudantes[i % ayudantes.length] : null;
    const ayudante2 = ayudantes.length > 1 ? ayudantes[(i + 1) % ayudantes.length] : null;
    const unidad = unidades[i % unidades.length];
    const origen = origenes[i % origenes.length];
    const destino = destinos[i % destinos.length];
    
    const km = Math.floor(Math.random() * 300) + 50; // 50-350 km
    const flete = Math.floor(km * (40 + Math.random() * 20)); // $40-60 por km
    const valorCarga = Math.floor(flete * (8 + Math.random() * 4)); // 8-12x el flete
    const cajas = Math.floor(Math.random() * 400) + 100; // 100-500 cajas
    const peso = cajas * (20 + Math.random() * 10); // 20-30 kg por caja

    // PASO 1: Generar embarque
    const embarqueData = {
      folio: `EMB-2026-${(Date.now() + i).toString().slice(-9)}`,
      fecha: new Date(2026, 3, 15 + Math.floor(i / 5)), // Abril 15-25
      unidad_id: unidad.id,
      operador_id: chofer.id,
      origen: origen,
      destino_texto: destino,
      km: km,
      flete: flete,
      valor_carga: valorCarga,
      cajas: cajas,
      peso: peso,
      estado: 'completado',
      tipo: 'entrega'
    };

    const [embarque] = await knex('logistica_embarques')
      .insert(embarqueData)
      .returning('*');

    embarquesCreados++;

    // PASO 2: Generar guía relacionada con el embarque
    const viaticos = Math.floor(200 + Math.random() * 300); // $200-500
    const guiaData = {
      folio: `GIA-${(Date.now() + i).toString().slice(-6)}`,
      embarque_id: embarque.id,
      tipo: 'local',
      estado: 'completada',
      chofer_id: chofer.id,
      ayudante1_id: ayudante1 ? ayudante1.id : null,
      ayudante2_id: ayudante2 ? ayudante2.id : null,
      viaticos: viaticos,
      fecha_salida: new Date(embarque.fecha)
    };

    const [guia] = await knex('logistica_guias')
      .insert(guiaData)
      .returning('*');

    guiasCreadas++;

    // PASO 3: Generar costo relacionado con el embarque
    const costoChofer = Math.floor(flete * 0.2); // 20% del flete
    const costoAyudante = ayudante1 ? Math.floor(costoChofer * 0.5) : 0;
    const costoCombustible = Math.floor(km * 15 + Math.random() * 500); // ~$15/km
    const costoManiobra = Math.floor(Math.random() * 500) + 200; // $200-700
    const costoKm = km * 3.5;
    const casetas = Math.floor(Math.random() * 300) + 100; // $100-400

    const costoData = {
      embarque_id: embarque.id,
      ingreso_flete: parseFloat(embarque.flete),
      ingreso_carga: parseFloat(embarque.valor_carga),
      ingreso_retorno: 0,
      ingreso_total: parseFloat(embarque.flete) + parseFloat(embarque.valor_carga),
      costo_chofer: costoChofer,
      costo_ayudante: costoAyudante,
      costo_repartidor: 0,
      costo_combustible: costoCombustible,
      costo_viaticos: parseFloat(guia.viaticos),
      costo_maniobra: costoManiobra,
      costo_mantenimiento: 0,
      costo_km: costoKm,
      costo_total: 0,
      utilidad: 0,
      margen: 0,
      ayudantes_ext: 0,
      casetas: casetas,
      costo_fijo_km: costoKm,
      hospedaje: 0,
      maniobras: costoManiobra,
      otros: 0,
      pensiones: 0,
      permisos: 0,
      subtotal_operativo: 0,
      talachas: 0,
      viaticos_guia: parseFloat(guia.viaticos),
      observaciones: 'Embarque de prueba con relaciones completas',
      combustible: costoCombustible,
      total: 0
    };

    // Calcular totales
    costoData.costo_total = 
      costoData.costo_chofer +
      costoData.costo_ayudante +
      costoData.costo_combustible +
      costoData.costo_viaticos +
      costoData.costo_maniobra +
      costoData.costo_km +
      costoData.casetas +
      costoData.maniobras;

    costoData.utilidad = costoData.ingreso_total - costoData.costo_total;
    costoData.margen = costoData.ingreso_total > 0 ? (costoData.utilidad / costoData.ingreso_total) * 100 : 0;
    costoData.total = costoData.costo_total;

    await knex('logistica_costos')
      .insert(costoData);

    costosCreados++;

    if ((i + 1) % 10 === 0) {
      console.log(`[01f_embarque_completo_con_relaciones] Progreso: ${i + 1}/50 embarques`);
    }
  }

  console.log(`[01f_embarque_completo_con_relaciones] ✅ Generación completada:`);
  console.log(`   - Embarques: ${embarquesCreados}`);
  console.log(`   - Guías: ${guiasCreadas}`);
  console.log(`   - Costos: ${costosCreados}`);
};
