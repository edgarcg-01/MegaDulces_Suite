// El archivo estaba vacío con la nota "TODO: implementar tests cuando el
// entorno de testing esté configurado". El entorno ya está configurado
// (`apps/view/jest.config.ts`, WMS-REC.6), y un archivo `.spec.ts` sin ningún
// test hace fallar la suite entera ("Your test suite must contain at least one
// test"), así que la deuda queda declarada como `todo` en vez de romper el
// target. Jest los cuenta como pendientes y los lista en cada corrida.
describe('OfflineStatusComponent', () => {
  it.todo('muestra el estado offline cuando el navegador pierde conexión');
  it.todo('vuelve a estado online al recuperar conexión');
  it.todo('no se pinta cuando la app arranca ya conectada');
});
