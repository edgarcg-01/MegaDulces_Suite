// Preset base de Jest para el monorepo. El `jest.config.ts` de la raíz resuelve
// los proyectos con `getJestProjectsAsync()`, pero ningún proyecto tenía su
// propio `jest.config.ts` — así que el target `test` apuntaba a un archivo
// inexistente y las specs nunca corrieron. Ver FASE_WMS_ESTACION_RECEPCION.
const nxPreset = require('@nx/jest/preset').default;

module.exports = { ...nxPreset };
