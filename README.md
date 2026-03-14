# ✝️ Presencia — Sistema de Presentación para Cultos

**Presencia** es una aplicación web completa para proyectar contenido durante cultos y servicios religiosos. Funciona directamente en el navegador, sin necesidad de instalación ni servidor.

---

## 📁 Archivos del proyecto

```
presencia/
├── index.html          ← Panel de control (el operador)
├── proyeccion.html     ← Ventana de proyección (el público / proyector)
├── remote.html         ← Control remoto desde celular
└── data/
    └── himnario.json   ← Base de datos del Himnario de Gloria
```

---

## 🚀 Cómo usar

### 1. Abrir el panel de control
Abre `index.html` en tu navegador (Chrome o Edge recomendados).

### 2. Abrir la ventana de proyección
Haz clic en **"Abrir Proyección"** en el panel. Se abrirá `proyeccion.html` en una nueva ventana. Arrástrala a la pantalla secundaria o proyector y presiona **F** para pantalla completa.

### 3. Control remoto (opcional)
Abre `remote.html` en el celular desde la misma red WiFi. En el panel ve a **Configuración → Control remoto**, actívalo e ingresa el código de 6 letras en el celular.

> ⚠️ La comunicación entre el panel y la proyección usa `BroadcastChannel`, por lo que ambas ventanas deben estar abiertas en el **mismo navegador** del mismo equipo. El control remoto requiere conexión a internet para la señalización inicial (usa PeerJS).

---

## 🎛️ Módulos

### ✏️ Texto Libre
Escribe cualquier texto y proyéctalo al instante. Incluye textos frecuentes predefinidos (Bienvenida, Ofrenda, Silencio, etc.), control de tamaño de fuente (20–120px) y alineación.

### 🎵 Himnario de Gloria
Base de datos con los himnos más usados del Himnario de Gloria (329 himnos en total). Búsqueda por número o título. Proyección estrofa por estrofa y coro independiente. Permite agregar himnos nuevos que se guardan permanentemente en el navegador.

### 🎤 Canciones Libres
Crea y gestiona tu propia biblioteca de alabanzas y adoraciones. Cada canción puede tener múltiples estrofas, coro y puente. Búsqueda por título, autor o letra. Exportación e importación en formato JSON para respaldo.

### 📖 Biblia
Acceso a 5 versiones en español mediante la API de bible-api.deno.dev:
- **RVR 1960** — Reina Valera 1960
- **RVR 1995** — Reina Valera 1995
- **NVI** — Nueva Versión Internacional
- **DHH** — Dios Habla Hoy
- **PDT** — Palabra de Dios para Todos

Búsqueda rápida por referencia (`Juan 3:16`), navegación por libro/capítulo/versículo, carga de capítulo completo y versículos favoritos guardados localmente.

> ⚠️ Requiere conexión a internet.

### 📅 Orden del Culto
Planifica la secuencia completa del servicio antes de comenzar. Combina himnos, canciones, versículos, textos y secciones en cualquier orden. Modo presentación con botones Anterior/Siguiente. Los órdenes se guardan y pueden reutilizarse en cultos futuros.

### 🖼️ Anuncios e Imágenes
Crea diapositivas de tres tipos: solo texto, solo imagen, o texto con imagen de fondo. Cinco opciones de color de fondo (oscuro, claro, dorado, azul, rojo). Carrusel automático con intervalo configurable (3–15 segundos).

### 🎨 Temas visuales
Seis temas para la ventana de proyección: Oscuro clásico, Noche estrellada, Cálido, Claro, Verde oscuro y Azul real. Control de color de texto y opacidad de fondo. El tema se guarda y restaura automáticamente.

### 🔊 Audio
Reproduce archivos de audio (MP3, WAV, OGG) directamente desde el navegador. Play, pausa y stop con fade in/out suave. Control de volumen y opción de bucle.

### ⏱️ Herramientas
- **Reloj en tiempo real** — proyectable a la pantalla del público.
- **Cuenta regresiva** — configurable en minutos y segundos. Cambia a naranja al quedar 60 segundos y a rojo al quedar 30. Proyecta "¡Tiempo!" al finalizar.
- **Notas privadas** — área de texto solo visible en el panel del operador, guardada automáticamente.

### 📱 Control remoto
Controla el panel desde un celular u otro dispositivo en la misma red. Funciones disponibles desde el celular: Anterior/Siguiente en el Orden del Culto, Pantalla negra, Limpiar, Proyectar texto, Escribir texto directamente y controlar el tamaño de fuente.

### 🆕 Plataforma Extendida (v11)
Se añadieron capacidades avanzadas para evolución y operación:

- **Storage versionado + migraciones** (`schemaVersion`) y recuperación segura de datos.
- **IndexedDB para medios** de anuncios (imágenes), reduciendo presión en `localStorage`.
- **Diagnóstico y observabilidad** (niveles de log y panel de eventos).
- **Resiliencia bíblica** con reintentos y caché local de consultas.
- **Centro de control en vivo** con estado consolidado + botón global de pánico.
- **Roles y bloqueo por PIN** de módulos sensibles.
  - Nota: por defecto el bloqueo aplica al panel del operador; el control remoto no se bloquea, salvo que se active la opción para restringir comandos remotos críticos.
- **Escenas/plantillas** guardables y aplicables en un clic.
- **Paquete de culto** para backup/restauración integral.
- **Teleprompter** (`teleprompter.html`) con control de velocidad desde panel.
- **Métricas operativas locales** (sesiones, proyecciones, módulos usados).

---

## 💾 Almacenamiento de datos

Todos los datos se guardan en el `localStorage` del navegador del panel:

| Clave | Contenido |
|---|---|
| `presencia_himnos_extra` | Himnos agregados manualmente |
| `presencia_canciones` | Biblioteca de canciones libres |
| `presencia_biblia_favs` | Versículos favoritos |
| `presencia_ordenes` | Órdenes del culto guardados |
| `presencia_anuncios` | Diapositivas de anuncios |
| `presencia_tema` | Tema visual seleccionado |
| `presencia_notas` | Notas privadas del operador |

> Los datos persisten aunque se cierre el navegador, pero son locales al dispositivo. Usa las opciones de **Exportar** en cada módulo para hacer respaldos.

---

## 🌐 Despliegue en GitHub Pages

Para acceder a la aplicación desde internet (útil para el control remoto):

1. Sube los archivos a un repositorio de GitHub.
2. Ve a **Settings → Pages → Branch: main → Save**.
3. En minutos tendrás la app disponible en:
   `https://tu-usuario.github.io/presencia/`

---

## 🔧 Compatibilidad

| Navegador | Panel | Proyección | Remoto |
|---|---|---|---|
| Chrome / Edge | ✅ Recomendado | ✅ | ✅ |
| Firefox | ✅ | ✅ | ✅ |
| Safari (iOS) | ✅ | ✅ | ✅ |
| Navegador Android | ✅ | ✅ | ✅ |

> La función de control remoto requiere que el navegador tenga acceso a internet para la conexión inicial vía PeerJS (WebRTC).

---

## 📋 Atajos de teclado (ventana de proyección)

| Tecla | Acción |
|---|---|
| `F` | Activar / salir de pantalla completa |
| `Esc` | Salir de pantalla completa |

---

## 🛠️ Tecnologías utilizadas

- **HTML5 / CSS3 / JavaScript** — sin frameworks ni dependencias de compilación
- **BroadcastChannel API** — comunicación en tiempo real entre panel y proyección
- **PeerJS (WebRTC)** — control remoto P2P entre dispositivos
- **bible-api.deno.dev** — API pública de la Biblia en español
- **localStorage** — persistencia de datos sin servidor
- **Google Fonts** — tipografías Cinzel y Crimson Pro

---

## 📦 Versión

**Presencia v1.0** — Todas las fases completadas  
Desarrollado con ❤️ para el servicio
