# 📱 Implementación Offline-First - Trade Marketing

## Resumen de Cambios

Esta implementación añade capacidades **offline-first** a la aplicación de Trade Marketing, permitiendo a los usuarios trabajar sin conexión a internet y sincronizar datos automáticamente cuando la conexión vuelva.

---

## 🏗️ Arquitectura

### Frontend (Angular)
- **IndexedDB**: Base de datos local usando Dexie.js
- **Service Worker**: Intercepta peticiones y sirve archivos offline
- **Background Sync**: Sincronización automática cuando hay conexión
- **Geolocalización**: Validación de ubicación con fórmula de Haversine

### Backend (NestJS)
- **API Idempotente**: UUID generado en cliente para evitar duplicados
- **Validación geográfica**: Re-cálculo de distancia en servidor
- **Detección de fraude**: Flags para identificar posibles manipulaciones

---

## 📁 Archivos Creados/Modificados

### Frontend (Angular)
```
apps/view/src/
├── app/
│   ├── core/services/
│   │   ├── offline-database.service.ts      ← Base de datos local IndexedDB
│   │   ├── offline-sync.service.ts          ← Sincronización offline/online
│   │   ├── geo-validation.service.ts        ← Validación de geolocalización
│   │   ├── offline-daily-capture.service.ts ← Adaptador para capturas offline
│   │   └── pwa-install.service.ts           ← Instalación de PWA
│   │
│   ├── shared/components/offline-status/
│   │   ├── offline-status.component.ts      ← Componente de estado offline
│   │   ├── offline-status.component.html
│   │   ├── offline-status.component.scss
│   │   └── offline-status.component.spec.ts
│   │
│   └── modules/dashboard/captures/
│       └── daily-capture.service.ts          ← MODIFICADO: Soporte offline
│
├── sw-offline.js                             ← Service Worker personalizado
├── manifest.webmanifest                       ← Configuración PWA
├── main.ts                                   ← MODIFICADO: Registro SW
└── index.html                                ← MODIFICADO: Meta tags PWA
```

### Backend (NestJS)
```
apps/api/src/
├── app.module.ts                             ← MODIFICADO: +VisitasSyncModule
└── modules/visitas/
    ├── visitas-sync.module.ts                ← Módulo de sincronización
    ├── visitas-sync.controller.ts            ← Endpoints de sync
    └── visitas-sync.service.ts               ← Lógica de sincronización
```

### Base de Datos
```
database/migrations/
└── 20250415100000_add_offline_sync_fields.js ← Campos para sync + auditoría
```

---

## 🚀 Instrucciones de Instalación

### 1. Instalar Dependencias

```bash
cd C:\Users\Sistemas\.gemini\antigravity\scratch\Trade_marketing
npm install
```

### 2. Ejecutar Migraciones

```bash
npm run migrate:latest
```

### 3. Generar Iconos PWA

Necesitas crear iconos en las siguientes dimensiones:
- 72x72, 96x96, 128x128, 144x144, 152x152, 192x192, 384x384, 512x512

Colócalos en: `apps/view/src/assets/icons/`

### 4. Compilar y Probar

```bash
# Desarrollo
nx serve api
nx serve view

# Producción
nx build api --prod
nx build view --prod
```

---

## 🔄 Flujo de Trabajo

### Modo Online
1. Usuario selecciona tienda y inicia visita
2. Se captura geolocalización
3. Se registran exhibiciones normalmente
4. Al guardar, se envía directamente al backend
5. Backend valida geolocalización y genera folio

### Modo Offline
1. Usuario selecciona tienda del catálogo offline
2. Se valida geolocalización localmente (100m radio)
3. Se guardan datos en IndexedDB
4. Se muestra indicador de visitas pendientes
5. Cuando vuelve la conexión:
   - Se sincronizan automáticamente
   - Backend vuelve a validar geolocalización
   - Se marcan flags de fraude si hay discrepancias

---

## 📱 Características PWA

### Instalación
- Botón "Agregar a pantalla de inicio"
- Instalación nativa en Android/iOS
- Funcionamiento standalone sin barra de navegador

### Offline
- Service Worker cachea archivos estáticos
- Intercepta peticiones API y devuelve respuestas offline
- Sincronización en background cuando hay conexión

### Actualizaciones
- Detección automática de nuevas versiones
- Prompt para recargar cuando hay actualización

---

## 🔐 Seguridad y Validación

### Geolocalización
- **Frontend**: Fórmula de Haversine, radio de 100m
- **Backend**: Re-cálculo para detectar manipulaciones
- **Precisión GPS**: Validación de señal (alta/media/baja)

### Prevención de Fraude
- `flag_fraude_frontend`: Precisión baja o distancia > 100m
- `flag_fraude_backend`: Discrepancia entre coordenadas cliente/servidor
- `flag_revisado_auditoria`: Marca de revisión manual

### Idempotencia
- UUID v4 generado en cliente
- `sync_uuid` único en base de datos
- Reintentos automáticos con backoff exponencial

---

## 📊 Dashboard de Auditoría

### Endpoints disponibles:
- `GET /api/visitas/estadisticas-sincronizacion` - Estadísticas de sync
- `GET /api/visitas/con-fraude` - Visitas con posible fraude
- `POST /api/visitas/:id/marcar-revisada` - Marcar revisada

### Campos de auditoría:
- `sync_uuid`: UUID de idempotencia
- `distancia_tienda`: Distancia calculada
- `confianza_ubicacion`: alta/media/baja
- `flag_fraude_*`: Flags de detección
- `intentos_sincronizacion`: Contador de reintentos
- `fecha_creacion_dispositivo`: Timestamp local
- `fecha_sincronizacion`: Timestamp servidor

---

## 🛠️ Configuración Avanzada

### Variables de Entorno (Frontend)
```typescript
// environments/environment.ts
export const environment = {
  apiUrl: 'https://tu-api.com',
  offlineConfig: {
    maxRetries: 5,
    syncInterval: 60000, // 1 minuto
    geoPrecision: 50,    // 50 metros mínimo
    maxDistance: 100     // 100 metros máximo
  }
};
```

### Configuración Service Worker
```javascript
// sw-offline.js
const CACHE_NAME = 'trademarketing-offline-v1';
const API_ENDPOINTS = [
  '/api/catalogs/conceptos',
  '/api/visitas/sincronizar'
  // ... más endpoints
];
```

---

## 🧪 Testing

### Pruebas de Conectividad
1. Desactivar WiFi
2. Crear visita
3. Verificar almacenamiento en IndexedDB
4. Activar WiFi
5. Verificar sincronización automática

### Pruebas de Geolocalización
1. Simular ubicación lejana (>100m)
2. Verificar bloqueo en frontend
3. Verificar flag_fraude en backend

### Pruebas de Idempotencia
1. Crear visita
2. Desconectar red durante sync
3. Reconectar y verificar que no se duplique

---

## 🚦 Estado de Implementación

| Componente | Estado | Notas |
|------------|--------|-------|
| OfflineDatabaseService | ✅ Listo | IndexedDB con Dexie |
| GeoValidationService | ✅ Listo | Haversine + precisión |
| OfflineSyncService | ✅ Listo | RxJS + reintentos |
| DailyCaptureService | ✅ Listo | Integrado offline |
| VisitasSyncController | ✅ Listo | API idempotente |
| VisitasSyncService | ✅ Listo | Validación backend |
| Service Worker | ✅ Listo | Cache + interceptación |
| Componente UI | ✅ Listo | OfflineStatusComponent |
| PWA Manifest | ✅ Listo | Instalación app |
| Migraciones DB | ✅ Listo | Nuevos campos |
| VisitasSyncModule | ✅ Listo | Registrado en app |

---

## 🔮 Mejoras Futuras

1. **Capacitor**: Conversión a app nativa (iOS/Android)
2. **SQLite**: Reemplazar IndexedDB con SQLite nativo
3. **Fotos Offline**: Captura de fotos en modo offline
4. **Background Sync API**: Sincronización nativa del navegador
5. **Push Notifications**: Notificaciones de sync completada
6. **Mapas Offline**: Descarga de mapas para navegación sin conexión

---

## 📞 Soporte

Para reportar problemas:
1. Revisar consola del navegador
2. Verificar Service Worker registrado
3. Comprobar IndexedDB en DevTools
4. Revisar logs de sincronización

---

## ✅ Checklist de Verificación

Antes de deploy a producción:
- [ ] Migraciones ejecutadas exitosamente
- [ ] Iconos PWA generados en todas las dimensiones
- [ ] Service Worker se registra correctamente
- [ ] IndexedDB funciona en modo privado/incógnito
- [ ] Geolocalización funciona en múltiples dispositivos
- [ ] Sincronización offline/online probada exhaustivamente
- [ ] No hay duplicados al sincronizar
- [ ] Flags de fraude se generan correctamente
- [ ] App se puede instalar como PWA
- [ ] Funciona en Android/iOS/Chrome/Safari

---

**Versión**: 1.0.0  
**Fecha**: 2025-04-15  
**Autor**: Sistema de Trade Marketing
