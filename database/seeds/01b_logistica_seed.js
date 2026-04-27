/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
exports.seed = async function(knex) {
  // 1. Destinos y Comisiones - Delete existing and insert new
  await knex('logistica_catalogo_destinos').del();

  const comisiones = [
    {destino:'AGUASCALIENTES',chofer:250,repartidor:130.40,ayudante:91.20,km:null},
    {destino:'APATZINGAN',chofer:129,repartidor:130.40,ayudante:91.20,km:null},
    {destino:'ARANDAS MATUTINO',chofer:95,repartidor:76,ayudante:67.16,km:null},
    {destino:'ARANDAS VESPERTINO',chofer:61.92,repartidor:48.90,ayudante:36.48,km:null},
    {destino:'ARIO DE ROSALES',chofer:129,repartidor:130.40,ayudante:91.20,km:null},
    {destino:'ATOTONILCO',chofer:103.20,repartidor:88.02,ayudante:60.80,km:null},
    {destino:'CIUDAD HIDALGO',chofer:129,repartidor:130.40,ayudante:97.28,km:null},
    {destino:'COTIJA',chofer:103.20,repartidor:88.02,ayudante:66.88,km:null},
    {destino:'DEGOLLADO',chofer:51.60,repartidor:48.90,ayudante:30.40,km:null},
    {destino:'ECUANDUREO',chofer:61.92,repartidor:48.90,ayudante:36.48,km:null},
    {destino:'GUADALAJARA',chofer:180,repartidor:127.25,ayudante:127.25,km:null},
    {destino:'GUANAJUATO',chofer:113.52,repartidor:97.80,ayudante:76,km:null},
    {destino:'JACONA',chofer:77.40,repartidor:71.72,ayudante:51.68,km:null},
    {destino:'JIQUILPAN',chofer:98.04,repartidor:78.24,ayudante:57.76,km:null},
    {destino:'LA BARCA',chofer:77.40,repartidor:65.20,ayudante:45.60,km:null},
    {destino:'LEON',chofer:113.52,repartidor:97.80,ayudante:76,km:null},
    {destino:'LOS REYES',chofer:103.20,repartidor:114.10,ayudante:76,km:null},
    {destino:'MORELIA',chofer:180,repartidor:119.89,ayudante:111.40,km:null},
    {destino:'MOROLEON',chofer:92.88,repartidor:81.50,ayudante:60.80,km:null},
    {destino:'NUEVA ITALIA',chofer:129,repartidor:130.40,ayudante:91.20,km:null},
    {destino:'PATZCUARO',chofer:103.20,repartidor:84.76,ayudante:63.84,km:null},
    {destino:'PENJAMILLO',chofer:77.40,repartidor:71.72,ayudante:51.68,km:null},
    {destino:'PENJAMO',chofer:51.60,repartidor:48.90,ayudante:36.48,km:null},
    {destino:'PERIBAN',chofer:103.20,repartidor:114.10,ayudante:76,km:null},
    {destino:'PURUANDIRO',chofer:103.20,repartidor:88.02,ayudante:66.88,km:null},
    {destino:'QUERENDARO',chofer:129,repartidor:130.40,ayudante:91.20,km:null},
    {destino:'QUEDAR A DORMIR / NOCHE',chofer:180,repartidor:113.72,ayudante:106.04,km:null},
    {destino:'TANGAMANDAPIO',chofer:103.20,repartidor:84.76,ayudante:63.84,km:null},
    {destino:'SAHUAYO',chofer:92.88,repartidor:71.72,ayudante:51.68,km:null},
    {destino:'VIAJE EN DOMINGO',chofer:200,repartidor:126.35,ayudante:117.82,km:null},
    {destino:'SAN JOSE',chofer:51.60,repartidor:39.12,ayudante:30.40,km:null},
    {destino:'SANTA ANA M',chofer:87.72,repartidor:71.72,ayudante:54.72,km:null},
    {destino:'SUCURSAL MATUTINO',chofer:51.60,repartidor:48.90,ayudante:30.40,km:null},
    {destino:'SEGUNDO VIAJE SUCURSAL',chofer:25.80,repartidor:16.30,ayudante:0,km:null},
    {destino:'TANGANCICUARO',chofer:103.20,repartidor:88.02,ayudante:60.80,km:null},
    {destino:'TANHUATO',chofer:61.92,repartidor:48.90,ayudante:36.48,km:null},
    {destino:'URUAPAN',chofer:113.52,repartidor:97.80,ayudante:76,km:null},
    {destino:'VALLE DE SANTIAGO',chofer:77.40,repartidor:65.20,ayudante:45.60,km:null},
    {destino:'VENUSTIANO CARRANZA',chofer:77.40,repartidor:65.20,ayudante:48.64,km:null},
    {destino:'YURECUARO',chofer:61.92,repartidor:48.90,ayudante:36.48,km:null},
    {destino:'YURIDIA',chofer:92.88,repartidor:81,ayudante:60.80,km:null},
    {destino:'ZACAPU',chofer:87.72,repartidor:71.72,ayudante:54.72,km:null},
    {destino:'ZAMORA',chofer:120,repartidor:100,ayudante:100,km:null},
    {destino:'ZINAPECUARO',chofer:129,repartidor:130.40,ayudante:97.28,km:null},
    {destino:'ZITACUARO',chofer:129,repartidor:130.40,ayudante:97.28,km:null},
    {destino:'CARGA CAMION MEDIANO',chofer:30,repartidor:0,ayudante:30,km:null},
    {destino:'CARGA CAMION GRANDE',chofer:50,repartidor:50,ayudante:50,km:null},
    {destino:'CARGA NISSAN',chofer:30,repartidor:0,ayudante:0,km:null},
    {destino:'COJUMATLAN DE REGULES',chofer:94.12,repartidor:0,ayudante:65.88,km:126.7},
    {destino:'CELAYA',chofer:126.47,repartidor:0,ayudante:88.53,km:145.9},
    {destino:'COMONFORT',chofer:141.64,repartidor:0,ayudante:99.15,km:163.4},
    {destino:'CUERAMARO',chofer:58.68,repartidor:0,ayudante:41.08,km:67.7},
    {destino:'DOLORES HIDALGO',chofer:169.03,repartidor:0,ayudante:118.32,km:195},
    {destino:'IRAPUATO',chofer:74.63,repartidor:0,ayudante:52.24,km:86.1},
    {destino:'ROMITA GTO',chofer:90.23,repartidor:0,ayudante:63.16,km:104.1},
    {destino:'SAN FRANCISCO / PURISIMA DEL RINCON',chofer:73.68,repartidor:0,ayudante:51.58,km:85},
    {destino:'SAN MIGUEL DE ALLENDE',chofer:162.96,repartidor:0,ayudante:114.07,km:188},
    {destino:'AMECA JALISCO',chofer:267.25,repartidor:0,ayudante:187.07,km:252.4},
    {destino:'AUTLAN DE NAVARRO JAL',chofer:486.46,repartidor:0,ayudante:340.52,km:358},
    {destino:'CD. GUZMAN',chofer:311.19,repartidor:0,ayudante:217.83,km:293.9},
    {destino:'ENCARNACION DE DIAZ JAL',chofer:182.44,repartidor:0,ayudante:127.70,km:172.3},
    {destino:'SAN GABRIEL JAL',chofer:437.68,repartidor:0,ayudante:306.37,km:322.1},
    {destino:'SAN JUAN DE LOS LAGOS JAL',chofer:180.95,repartidor:0,ayudante:126.67,km:170.9},
    {destino:'SAN MIGUEL EL ALTO JAL',chofer:146.96,repartidor:0,ayudante:102.88,km:138.8},
    {destino:'TEPATITLAN',chofer:149.61,repartidor:0,ayudante:104.73,km:141.3},
    {destino:'TESISTAN',chofer:192.28,repartidor:0,ayudante:134.60,km:181.6},
    {destino:'UNION DE SAN ANTONIO',chofer:120.71,repartidor:0,ayudante:84.49,km:114},
    {destino:'YAHUALICA',chofer:209.54,repartidor:0,ayudante:146.68,km:197.9},
    {destino:'ZACOALCO DE TORRES',chofer:247.55,repartidor:0,ayudante:173.29,km:233.8},
    {destino:'ZAPOPAN',chofer:186.99,repartidor:0,ayudante:130.89,km:176.6},
    {destino:'ACAMBAY EDO MEX',chofer:367.96,repartidor:0,ayudante:257.57,km:291.1},
    {destino:'ATIZAPAN / ECATEPEC',chofer:478.69,repartidor:0,ayudante:335.08,km:378.7},
    {destino:'TEOLOYUCAN',chofer:450,repartidor:0,ayudante:315,km:356},
    {destino:'JILOTEPEC / CHAPA DE MOTA',chofer:399.68,repartidor:0,ayudante:279.78,km:316.2},
    {destino:'TULTITLAN',chofer:464.40,repartidor:0,ayudante:325.08,km:367.4},
    {destino:'CHALCO',chofer:547.08,repartidor:0,ayudante:382.95,km:432.8},
    {destino:'NEZAHUALCOYOTL',chofer:507.13,repartidor:0,ayudante:354.99,km:401.2},
    {destino:'APAXCO 10 TON',chofer:200,repartidor:0,ayudante:140,km:null},
    {destino:'APAXCO 15 TON',chofer:300,repartidor:0,ayudante:210,km:null},
    {destino:'APAXCO TON EXTRA',chofer:20,repartidor:0,ayudante:14,km:null},
    {destino:'TEXCOCO',chofer:500,repartidor:0,ayudante:350,km:null},
    {destino:'CUAUTITLAN IZCALLI',chofer:450,repartidor:0,ayudante:315,km:null},
    {destino:'CHICHIMEQUILLAS QRO',chofer:226.10,repartidor:0,ayudante:158.27,km:226.1},
    {destino:'QUERETARO',chofer:189.20,repartidor:0,ayudante:132.44,km:189.2},
    {destino:'BUENAVISTA QUERETARO',chofer:217,repartidor:0,ayudante:151.90,km:217},
    {destino:'IZTAPALAPA 1',chofer:400,repartidor:0,ayudante:280,km:null},
    {destino:'IZTAPALAPA 2',chofer:500,repartidor:0,ayudante:350,km:null},
    {destino:'SAN LUIS POTOSI',chofer:366.82,repartidor:0,ayudante:256.77,km:300.8},
    {destino:'VILLA DE REYES / BLEDOS SLP',chofer:298.77,repartidor:0,ayudante:209.14,km:245},
    {destino:'QUIROGA',chofer:143.39,repartidor:0,ayudante:100.37,km:141},
    {destino:'JUVENTINO ROSAS',chofer:114.59,repartidor:0,ayudante:80.21,km:132.2},
    {destino:'IXMIQUILPAN HGO',chofer:430.53,repartidor:0,ayudante:301.37,km:340.6},
    {destino:'NOCHISTLAN ZACATECAS',chofer:221.82,repartidor:0,ayudante:155.28,km:209.5},
    {destino:'TLALTENANGO ZACATECAS',chofer:466.08,repartidor:0,ayudante:326.25,km:343},
    {destino:'JALPA ZACATECAS',chofer:440.26,repartidor:0,ayudante:308.18,km:324},
    {destino:'GUADALAJARA - LERMA EDO MEX',chofer:619.38,repartidor:0,ayudante:433.57,km:490}
  ];

  const destinosToInsert = comisiones.map(c => ({
    nombre: c.destino,
    comision_chofer: c.chofer,
    comision_repartidor: c.repartidor,
    comision_ayudante: c.ayudante,
    km: c.km
  }));

  await knex('logistica_catalogo_destinos').insert(destinosToInsert);
  console.log(`[01b_logistica] Inserted ${destinosToInsert.length} destinos.`);

  // 2. Períodos 2026 - Delete existing and insert new
  await knex('logistica_periodos').del();

  const periodos = [
    {num:1,  inicio:'2026-01-01', fin:'2026-01-14', pago:'2026-01-17'},
    {num:2,  inicio:'2026-01-15', fin:'2026-01-28', pago:'2026-01-31'},
    {num:3,  inicio:'2026-01-29', fin:'2026-02-11', pago:'2026-02-14'},
    {num:4,  inicio:'2026-02-12', fin:'2026-02-25', pago:'2026-02-28'},
    {num:5,  inicio:'2026-02-26', fin:'2026-03-11', pago:'2026-03-14'},
    {num:6,  inicio:'2026-03-12', fin:'2026-03-25', pago:'2026-03-28'},
    {num:7,  inicio:'2026-03-26', fin:'2026-04-08', pago:'2026-04-11'},
    {num:8,  inicio:'2026-04-09', fin:'2026-04-22', pago:'2026-04-25'},
    {num:9,  inicio:'2026-04-23', fin:'2026-05-06', pago:'2026-05-09'},
    {num:10, inicio:'2026-05-07', fin:'2026-05-20', pago:'2026-05-23'},
    {num:11, inicio:'2026-05-21', fin:'2026-06-03', pago:'2026-06-06'},
    {num:12, inicio:'2026-06-04', fin:'2026-06-17', pago:'2026-06-20'},
    {num:13, inicio:'2026-06-18', fin:'2026-07-01', pago:'2026-07-04'},
    {num:14, inicio:'2026-07-02', fin:'2026-07-15', pago:'2026-07-18'},
    {num:15, inicio:'2026-07-16', fin:'2026-07-29', pago:'2026-08-01'},
    {num:16, inicio:'2026-07-30', fin:'2026-08-12', pago:'2026-08-15'},
    {num:17, inicio:'2026-08-13', fin:'2026-08-26', pago:'2026-08-29'},
    {num:18, inicio:'2026-08-27', fin:'2026-09-09', pago:'2026-09-12'},
    {num:19, inicio:'2026-09-10', fin:'2026-09-23', pago:'2026-09-26'},
    {num:20, inicio:'2026-09-24', fin:'2026-10-07', pago:'2026-10-10'},
    {num:21, inicio:'2026-10-08', fin:'2026-10-21', pago:'2026-10-24'},
    {num:22, inicio:'2026-10-22', fin:'2026-11-04', pago:'2026-11-07'},
    {num:23, inicio:'2026-11-05', fin:'2026-11-18', pago:'2026-11-21'},
    {num:24, inicio:'2026-11-19', fin:'2026-12-02', pago:'2026-12-05'},
    {num:25, inicio:'2026-12-03', fin:'2026-12-16', pago:'2026-12-19'},
    {num:26, inicio:'2026-12-17', fin:'2026-12-30', pago:'2027-01-02'}
  ];

  const periodosToInsert = periodos.map(p => ({
    numero: p.num,
    inicio: p.inicio,
    fin: p.fin,
    pago: p.pago
  }));

  await knex('logistica_periodos').insert(periodosToInsert);
  console.log(`[01b_logistica] Inserted ${periodosToInsert.length} periodos.`);

  // 3. Configuración de Finanzas (Factores y Costos KM) - Delete existing and insert new
  await knex('logistica_config_finanzas').del();

  const config = [
    // Factores
    { clave: 'factor_aguascalientes', categoria: 'factor', valor: 0.60478, descripcion: 'A AGUASCALIENTES' },
    { clave: 'factor_michoacan', categoria: 'factor', valor: 1.01695, descripcion: 'A URUAPAN' },
    { clave: 'factor_jalisco_zacatecas', categoria: 'factor', valor: 1.05882, descripcion: 'A GDL Y ZAC.' },
    { clave: 'factor_guanajuato', categoria: 'factor', valor: 0.86681, descripcion: 'PROM GTO Y LEON' },
    { clave: 'factor_slp', categoria: 'factor', valor: 1.2195, descripcion: 'A LA CAPITAL S.L.P.' },
    { clave: 'factor_queretaro', categoria: 'factor', valor: 1.0000, descripcion: '' },
    { clave: 'factor_edomex_cdmx', categoria: 'factor', valor: 1.26404, descripcion: 'A TEOLOYUCAN' },
    
    // Costos KM
    { clave: 'costo_km_international', categoria: 'costo_km', valor: 7.64, descripcion: 'INTERNATIONAL' },
    { clave: 'costo_km_international_ii', categoria: 'costo_km', valor: 8.09, descripcion: 'INTERNATIONAL II' },
    { clave: 'costo_km_freightliner_std', categoria: 'costo_km', valor: 5.92, descripcion: 'FREIGHTLINER STD' },
    { clave: 'costo_km_freightliner_auto', categoria: 'costo_km', valor: 5.89, descripcion: 'FREIGHTLINER AUTO' },
    { clave: 'costo_km_hino_500', categoria: 'costo_km', valor: 23.53, descripcion: 'HINO 500' },
    { clave: 'costo_km_international_iii', categoria: 'costo_km', valor: 17.16, descripcion: 'INTERNATIONAL III' },
    { clave: 'costo_km_international_city_star', categoria: 'costo_km', valor: 7.12, descripcion: 'INTERNATIONAL CITY STAR' },
    { clave: 'costo_km_kodiak', categoria: 'costo_km', valor: 11.47, descripcion: 'KODIAK' },
    { clave: 'costo_km_f350', categoria: 'costo_km', valor: 4.05, descripcion: 'F-350' },
    { clave: 'costo_km_f450', categoria: 'costo_km', valor: 4.91, descripcion: 'F-450' },
    { clave: 'costo_km_nissan_fz0437b', categoria: 'costo_km', valor: 4.53, descripcion: 'NISSAN FZ0437B' },
    { clave: 'costo_km_ram_4000_zamora', categoria: 'costo_km', valor: 7.14, descripcion: 'RAM 4000 ZAMORA' },
    { clave: 'costo_km_ram_4000_morelia', categoria: 'costo_km', valor: 7.07, descripcion: 'RAM 4000 MORELIA' },
    { clave: 'costo_km_nissan_jv05705', categoria: 'costo_km', valor: 6.28, descripcion: 'NISSAN JV05705' },

    // Tarifas Maniobra
    { clave: 'tarifa_maniobra_carga', categoria: 'tarifa_maniobra', valor: 30.00, descripcion: 'Carga por persona' },
    { clave: 'tarifa_maniobra_descarga', categoria: 'tarifa_maniobra', valor: 1.00, descripcion: 'Descarga por caja' }
  ];

  await knex('logistica_config_finanzas').insert(config);
  console.log(`[01b_logistica] Inserted ${config.length} config items.`);
};
