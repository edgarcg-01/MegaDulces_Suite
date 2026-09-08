/**
 * `[CV.24]` Doble de `@primeui/license-manager` para jest.
 *
 * El paquete real publica ESM (y arrastra `@noble/ed25519` + `@noble/hashes`, también ESM)
 * desde archivos `.js`, así que jest los lee como CommonJS y muere en "Unexpected token
 * 'export'". Cualquier spec que importe un módulo de PrimeNG lo arrastra: por eso este app
 * no tenía NI UN spec de componente y las pantallas sólo se probaban a ojo.
 *
 * La licencia no es parte de ningún contrato de producto — sólo silencia un banner en prod
 * (`providePrimeNG({ license })`). Se apunta a este doble por `moduleNameMapper` en
 * `jest.config.ts`, y sólo en tests: el bundle de producción usa el paquete real.
 */
export function registerLicense(): void { /* no-op en tests */ }

export function verifyLicense(): boolean { return true; }
