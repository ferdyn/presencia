/*
 * Puente entre el estado léxico del panel y las extensiones cargadas como scripts.
 * Las extensiones usan window.*; las variables del panel están declaradas con let/const.
 */
(function () {
  const expose = (name, read, write) => {
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: false,
      get: read,
      ...(write ? { set: write } : {})
    });
  };

  expose('canal', () => canal);
  expose('pantallaOscura', () => pantallaOscura, value => { pantallaOscura = Boolean(value); });
  expose('alineacion', () => alineacion, value => { alineacion = value; });
  expose('tamanoFuente', () => tamanoFuente, value => { tamanoFuente = Number(value) || 60; });
  expose('proyeccionAbierta', () => proyeccionAbierta, value => { proyeccionAbierta = Boolean(value); });

  expose('anunciosLib', () => anunciosLib, value => { anunciosLib = Array.isArray(value) ? value : []; });
  expose('temaActual', () => temaActual, value => { temaActual = value || 'dark'; });
  expose('remotosConectados', () => remotosConectados);

  expose('BIBLE_API', () => BIBLE_API);
  expose('bibliaVersion', () => bibliaVersion, value => { bibliaVersion = value || 'rv1960'; });
  expose('ultimosVersiculos', () => ultimosVersiculos, value => { ultimosVersiculos = Array.isArray(value) ? value : []; });
  expose('ultimaRef', () => ultimaRef, value => { ultimaRef = String(value || ''); });
})();
