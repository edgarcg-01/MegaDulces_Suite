/**
 * `[RH.14.9]` La forma de un nombre de persona: casos de prod (anonimizados), lo que NO se toca, idempotencia y que la
 * copia en JavaScript de la migración decida IGUAL.
 */
import fs from 'fs';
import path from 'path';
import { esNombreDePersona, nombrePropio } from './nombre-propio';

const MIGRACIONES = path.resolve(__dirname, '../../../../database/migrations-newdb');
const archivoMigracion = fs.readdirSync(MIGRACIONES).find((f) => f.endsWith('_rh_nombres_forma_propia.js'));

const CASOS: Array<[string, string]> = [
  ['JOSE LUIS MUÑOZ MOTA', 'Jose Luis Muñoz Mota'],
  ['JOSE DE JESUS GARCIA TORRES', 'Jose de Jesus Garcia Torres'],
  ['CECILIA DEL PILAR GARCÍA MEJÍA', 'Cecilia del Pilar García Mejía'],
  ['carmen elizabeth alaniz jimenez', 'Carmen Elizabeth Alaniz Jimenez'],
  ['Juan pablo linares hernandez', 'Juan Pablo Linares Hernandez'],
  ['pedro Pablo Patricio Chávez', 'Pedro Pablo Patricio Chávez'],
  ['EDITH Picard', 'Edith Picard'],
  ['María de la Paz Gutiérrez Guzmán', 'María de la Paz Gutiérrez Guzmán'],
  ['  ANA   PEÑA-ORTIZ  ', 'Ana Peña-Ortiz'],
  ["MARY O'BRIEN", "Mary O'Brien"],
  ['MA. GUADALUPE SANCHEZ', 'Ma. Guadalupe Sanchez'],
  ['DE LA CRUZ JUAN', 'De la Cruz Juan'],          // la partícula al inicio sí lleva mayúscula
  ['Checador-ZC', 'Checador-ZC'],                   // sigla en un nombre ya mezclado: se respeta
  ['ÁNGEL ÚRSULA ÑÚÑEZ', 'Ángel Úrsula Ñúñez'],
  // Lo que el ensayo contra prod mostró que la primera versión EMPEORABA:
  ['MARGARITA PH', 'Margarita PH'],                 // sigla sin vocales: se respeta aun en MAYÚSCULAS
  ['Lucia/Ferrero', 'Lucia/Ferrero'],               // la diagonal separa como el guion
  ['JorgeRubioLeon', 'JorgeRubioLeon'],             // palabras pegadas: no se tocan (se corrigen a mano)
  ['RUIZ MATA MA DE LOS ANGELES', 'Ruiz Mata Ma de los Angeles'],
  ['BRENDA RIOS LA ROSA', 'Brenda Rios La Rosa'],   // «la» sin «de» antes es apellido
  ['ESPINO JR LUIS ARTURO', 'Espino Jr Luis Arturo'],
  ['JUAN PEREZ JR.', 'Juan Perez Jr.'],
];

describe('[RH.14.9] nombrePropio', () => {
  it('cada palabra con mayúscula inicial, partículas en minúscula, sin inventar acentos', () => {
    for (const [antes, despues] of CASOS) expect(nombrePropio(antes)).toBe(despues);
    expect(nombrePropio('MARIA')).toBe('Maria');     // no se le pone el acento
  });

  it('⛔ NEGATIVO: lo que no es nombre de persona no se toca (credencial o ID)', () => {
    for (const x of ['francisco.compras', 'FRANCISCO.CHECADOR', 'promLP_mara', 'Empleado 96', 'Checador - 8ESQ', 'alguien@correo.mx', '', '   ']) {
      expect(nombrePropio(x)).toBe(x.replace(/\s+/g, ' ').trim());
    }
    expect(esNombreDePersona('Empleado 96')).toBe(false);
    expect(esNombreDePersona('Ana López')).toBe(true);
  });

  it('idempotente: dos veces da lo mismo que una', () => {
    for (const [antes] of CASOS) expect(nombrePropio(nombrePropio(antes))).toBe(nombrePropio(antes));
  });

  it('la copia de la migración decide IGUAL (si una cambia y la otra no, esto se pone rojo)', () => {
    expect(archivoMigracion).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const js = require(path.join(MIGRACIONES, archivoMigracion as string));
    const corpus = [...CASOS.map(([a]) => a), 'francisco.compras', 'promLP_mara', 'Empleado 96', 'MARIA', 'Feeds y tareas programadas', 'JR. DOS SANTOS DA SILVA'];
    for (const x of corpus) expect(js.nombrePropio(x)).toBe(nombrePropio(x));
  });
});
