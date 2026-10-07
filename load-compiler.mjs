// Carga @angular/compiler en el proceso de Node antes de que arranque la
// CLI de Nx. Necesario para builds de Angular v18+ con esbuild en Node 20.
// Se inyecta vía `NODE_OPTIONS="--import file:///app/load-compiler.mjs"`.
import '@angular/compiler';
