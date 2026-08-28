(function(){
  const APP_VER = '11.0';
  const STORAGE_SCHEMA_KEY = 'presencia_schema_version';
  const STORAGE_SCHEMA_VERSION = 2;
  const DB_NAME = 'presencia_media';
  const DB_STORE = 'assets';
  const LOG_KEY = 'presencia_logs';
  const METRICS_KEY = 'presencia_metrics';
  const SCENES_KEY = 'presencia_escenas';

  const Logger = {
    level: localStorage.getItem('presencia_log_level') || 'info',
    levels: { info: 1, warn: 2, error: 3 },
    write(level, msg, meta){
      if (this.levels[level] < this.levels[this.level]) return;
      const entry = { ts: new Date().toISOString(), level, msg, meta: meta || null };
      const logs = StorageService.get(LOG_KEY, []);
      logs.push(entry);
      while (logs.length > 300) logs.shift();
      StorageService.set(LOG_KEY, logs);
      if (level === 'error') console.error('[Presencia]', msg, meta || '');
      else if (level === 'warn') console.warn('[Presencia]', msg, meta || '');
      else console.info('[Presencia]', msg, meta || '');
      renderDiagnostics();
    },
    info(m,meta){ this.write('info',m,meta); },
    warn(m,meta){ this.write('warn',m,meta); },
    error(m,meta){ this.write('error',m,meta); }
  };

  const StorageService = {
    getSchemaVersion(){ return Number(localStorage.getItem(STORAGE_SCHEMA_KEY) || '0'); },
    setSchemaVersion(v){ localStorage.setItem(STORAGE_SCHEMA_KEY, String(v)); },
    safeParse(raw, fallback){
      if (!raw) return fallback;
      try { return JSON.parse(raw); } catch(e){ return fallback; }
    },
    get(key, fallback){
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return this.safeParse(raw, fallback);
    },
    set(key, value){ localStorage.setItem(key, JSON.stringify(value)); },
    migrate(){
      let current = this.getSchemaVersion();
      if (current >= STORAGE_SCHEMA_VERSION) return;
      Logger.info('Iniciando migración de esquema', { from: current, to: STORAGE_SCHEMA_VERSION });

      if (current < 1) {
        ['presencia_canciones','presencia_anuncios','presencia_ordenes','presencia_biblia_favs'].forEach(k => {
          const data = this.get(k, []);
          if (!Array.isArray(data)) this.set(k, []);
        });
        current = 1;
      }

      if (current < 2) {
        const metrics = this.get(METRICS_KEY, null);
        if (!metrics) this.set(METRICS_KEY, {
          startedAt: Date.now(),
          projections: 0,
          moduleSwitches: {},
          mostUsed: { himnos: 0, canciones: 0, anuncios: 0, biblia: 0 },
          sessions: 0,
          recoveries: 0
        });
        if (!this.get(SCENES_KEY, null)) this.set(SCENES_KEY, []);
        current = 2;
      }

      this.setSchemaVersion(STORAGE_SCHEMA_VERSION);
      Logger.info('Migración completada', { version: STORAGE_SCHEMA_VERSION });
    }
  };

  function openDB(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPutImage(dataUrl){
    if (!dataUrl) return null;
    const id = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    const db = await openDB();
    await new Promise((resolve,reject)=>{
      const tx = db.transaction(DB_STORE,'readwrite');
      tx.objectStore(DB_STORE).put({ id, dataUrl, createdAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = ()=>reject(tx.error);
    });
    return id;
  }

  async function idbGetImage(id){
    if (!id) return null;
    const db = await openDB();
    return await new Promise((resolve,reject)=>{
      const tx = db.transaction(DB_STORE,'readonly');
      const req = tx.objectStore(DB_STORE).get(id);
      req.onsuccess = ()=>resolve(req.result ? req.result.dataUrl : null);
      req.onerror = ()=>reject(req.error);
    });
  }

  async function migrateAnunciosToIDB(){
    if (!Array.isArray(window.anunciosLib) || !window.anunciosLib.length) return;
    let changed = false;
    for (const a of window.anunciosLib) {
      if (a.imagen && a.imagen.startsWith('data:image') && !a.mediaId) {
        try {
          a.mediaId = await idbPutImage(a.imagen);
          a.imagen = '';
          changed = true;
        } catch (e) {
          Logger.warn('No se pudo mover imagen a IndexedDB', e?.message || e);
        }
      }
    }
    if (changed && typeof window.guardarAnunciosStorage === 'function') {
      window.guardarAnunciosStorage();
      Logger.info('Anuncios migrados a IndexedDB');
    }
  }

  async function hydrateAnuncio(a){
    if (!a || a.imagen) return a;
    if (a.mediaId) {
      try { a.imagen = await idbGetImage(a.mediaId); }
      catch(e){ Logger.warn('No se pudo hidratar imagen de anuncio', a.mediaId); }
    }
    return a;
  }

  async function fetchWithRetryAndCache(url, cacheKey, retries=2){
    let lastErr;
    for (let i=0; i<=retries; i++) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP '+resp.status);
        const data = await resp.json();
        StorageService.set(cacheKey, { ts: Date.now(), data });
        return { data, cached: false };
      } catch (e) {
        lastErr = e;
        await new Promise(r=>setTimeout(r, 400 * Math.pow(2, i)));
      }
    }
    const cached = StorageService.get(cacheKey, null);
    if (cached && (Array.isArray(cached.data) || (cached.data && typeof cached.data === 'object'))) return { data: cached.data, cached: true };
    throw lastErr;
  }

  function addConfigCard(title, html){
    const configBody = document.querySelector('#mod-config .module-body');
    if (!configBody) return null;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="card-title">${title}</div>${html}`;
    configBody.insertBefore(card, configBody.firstChild);
    return card;
  }

  function renderDiagnostics(){
    const wrap = document.getElementById('diagLogs');
    if (!wrap) return;
    const logs = StorageService.get(LOG_KEY, []).slice(-12).reverse();
    wrap.innerHTML = logs.map(l => `<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;"><strong style="color:${l.level==='error'?'var(--danger)':l.level==='warn'?'#f0a830':'var(--accent)'}">${l.level.toUpperCase()}</strong> ${new Date(l.ts).toLocaleTimeString()} — ${l.msg}</div>`).join('') || '<div style="color:var(--text-muted);font-size:12px;">Sin eventos.</div>';
  }

  function setupControlCenter(){
    addConfigCard('🧭 Centro de control', `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
        <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:10px;">
          <div style="font-size:11px;color:var(--text-muted)">Módulo activo</div>
          <div id="ccModulo" style="font-family:'Cinzel',serif;color:var(--accent)">texto</div>
        </div>
        <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:10px;">
          <div style="font-size:11px;color:var(--text-muted)">Remotos</div>
          <div id="ccRemotos" style="font-family:'Cinzel',serif;color:var(--accent)">0</div>
        </div>
      </div>
      <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:11px;color:var(--text-muted)">Proyección actual</div>
        <div id="ccTexto" style="font-size:13px;color:var(--text);">—</div>
      </div>
      <button class="btn btn-danger btn-full" onclick="window.panicMode()">🚨 Botón de pánico</button>
    `);

    window.panicMode = function(){
      try { if (typeof window.audioStop === 'function') window.audioStop(); } catch(e){}
      try { if (typeof window.limpiarPantalla === 'function') window.limpiarPantalla(); } catch(e){}
      try { if (typeof window.toggleBlackScreen === 'function' && !window.pantallaOscura) window.toggleBlackScreen(); } catch(e){}
      Logger.warn('Pánico activado');
    };
  }

  function setupDiagnosticsPanel(){
    addConfigCard('🧪 Diagnóstico', `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <label style="font-size:12px;color:var(--text-dim);">Nivel log</label>
        <select id="diagLevel" style="background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:6px;border-radius:6px;">
          <option value="info">info</option><option value="warn">warn</option><option value="error">error</option>
        </select>
        <button class="btn btn-secondary" style="padding:6px 10px;font-size:11px;" onclick="window.clearLogs()">Limpiar</button>
      </div>
      <div id="diagLogs" style="max-height:180px;overflow:auto;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:8px;"></div>
    `);
    const sel = document.getElementById('diagLevel');
    if (sel) {
      sel.value = Logger.level;
      sel.onchange = () => {
        Logger.level = sel.value;
        localStorage.setItem('presencia_log_level', Logger.level);
        Logger.info('Nivel de log actualizado', Logger.level);
      };
    }
    window.clearLogs = function(){ StorageService.set(LOG_KEY, []); renderDiagnostics(); };
    renderDiagnostics();
  }

  function setupNetworkStatus(){
    const status = document.getElementById('statusLabel');
    function paint(){
      const online = navigator.onLine;
      const text = online ? 'Red disponible' : 'Sin internet (modo degradado)';
      if (status && !window.proyeccionAbierta) status.textContent = text;
      Logger.info('Estado de red: ' + (online ? 'online' : 'offline'));
    }
    window.addEventListener('online', paint);
    window.addEventListener('offline', paint);
    paint();
  }

  function setupRolesAndPin(){
    const roles = StorageService.get('presencia_roles', { role: 'admin', pin: '', blocks: {}, remoteUnaffected: true });
    const card = addConfigCard('👥 Roles y bloqueo por PIN', `
      <div style="font-size:12px;color:var(--text-dim);line-height:1.5;margin-bottom:10px;">
        El PIN protege módulos del <strong style="color:var(--text)">panel</strong>.

        <strong style="color:var(--accent)">Importante:</strong> por defecto <u>no bloquea el control remoto</u>.
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        <select id="roleSelect" style="background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px;">
          <option value="admin">Admin</option>
          <option value="proyeccion">Operador proyección</option>
          <option value="audio">Operador audio</option>
          <option value="liturgia">Líder liturgia</option>
        </select>
        <input id="rolePin" type="password" placeholder="PIN (opcional)" style="max-width:160px;">
        <button class="btn btn-secondary" style="padding:8px 12px;" onclick="window.saveRoleConfig()">Guardar</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--text-dim);margin-bottom:8px;">
        <label><input type="checkbox" id="blkConfig"> Bloquear Configuración (incluye Audio)</label>
        <label><input type="checkbox" id="blkAnuncios"> Bloquear Anuncios</label>
      </div>
      <label style="font-size:12px;color:var(--text-dim);display:flex;gap:8px;align-items:center;">
        <input type="checkbox" id="lockRemoteWithPin"> Aplicar PIN también a comandos remotos críticos
      </label>
    `);
    if (!card) return;

    function readCfg(){
      return StorageService.get('presencia_roles', { role: 'admin', pin: '', blocks: {}, remoteUnaffected: true });
    }

    function isBlocked(moduleId){
      const cfg = readCfg();
      return !!(cfg.blocks && cfg.blocks[moduleId]);
    }

    window.isRoleModuleBlocked = isBlocked;

    document.getElementById('roleSelect').value = roles.role;
    document.getElementById('rolePin').value = roles.pin || '';
    document.getElementById('blkConfig').checked = !!roles.blocks.config;
    document.getElementById('blkAnuncios').checked = !!roles.blocks.anuncios;
    document.getElementById('lockRemoteWithPin').checked = !roles.remoteUnaffected;

    window.saveRoleConfig = function(){
      const cfg = {
        role: document.getElementById('roleSelect').value,
        pin: document.getElementById('rolePin').value.trim(),
        blocks: {
          config: document.getElementById('blkConfig').checked,
          anuncios: document.getElementById('blkAnuncios').checked
        },
        remoteUnaffected: !document.getElementById('lockRemoteWithPin').checked
      };
      StorageService.set('presencia_roles', cfg);
      Logger.info('Roles actualizados', cfg);
      alert('Configuración de roles guardada.');
    };

    const originalSwitchModule = window.switchModule;
    window.switchModule = function(id, el){
      const cfg = readCfg();
      if (isBlocked(id)) {
        const entered = prompt('Módulo protegido. Ingresa PIN:');
        if (!entered || entered !== cfg.pin) {
          Logger.warn('Acceso denegado a módulo ' + id);
          if (typeof window.showToast === 'function') window.showToast('Módulo protegido por PIN','warn');
          return;
        }
      }
      const metrics = StorageService.get(METRICS_KEY, {});
      metrics.moduleSwitches = metrics.moduleSwitches || {};
      metrics.moduleSwitches[id] = (metrics.moduleSwitches[id] || 0) + 1;
      StorageService.set(METRICS_KEY, metrics);
      const ccModulo = document.getElementById('ccModulo');
      if (ccModulo) ccModulo.textContent = id;
      return originalSwitchModule(id, el);
    };

    // Control explícito de impacto en remoto
    if (typeof window.procesarComandoRemoto === 'function') {
      const originalRemote = window.procesarComandoRemoto;
      window.procesarComandoRemoto = function(data){
        const cfg = readCfg();
        const critical = ['negro','limpiar','proyectar','texto','fuente-up','fuente-down'];
        if (!cfg.remoteUnaffected && critical.includes(data?.cmd)) {
          Logger.warn('Comando remoto bloqueado por política PIN', data?.cmd);
          if (typeof window.showToast === 'function') window.showToast('Comando remoto bloqueado por política PIN','warn');
          return;
        }
        return originalRemote(data);
      };
    }
  }

  function setupScenes(){
    addConfigCard('🎬 Escenas y plantillas', `
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <input id="sceneName" type="text" placeholder="Nombre de la escena">
        <button class="btn btn-secondary" style="padding:8px 12px;" onclick="window.saveScene()">Guardar escena</button>
      </div>
      <div id="sceneList" style="display:flex;flex-direction:column;gap:6px;"></div>
    `);

    window.saveScene = function(){
      const name = document.getElementById('sceneName').value.trim();
      if (!name) return alert('Escribe un nombre para la escena.');
      const scene = {
        id: Date.now().toString(),
        name,
        theme: window.temaActual || 'dark',
        fontSize: window.tamanoFuente || 60,
        align: window.alineacion || 'center',
        text: document.getElementById('textoLibre')?.value || ''
      };
      const scenes = StorageService.get(SCENES_KEY, []);
      scenes.unshift(scene);
      StorageService.set(SCENES_KEY, scenes.slice(0,50));
      renderScenes();
    };

    window.applyScene = function(id){
      const scenes = StorageService.get(SCENES_KEY, []);
      const s = scenes.find(x => x.id === id);
      if (!s) return;
      window.tamanoFuente = s.fontSize;
      window.alineacion = s.align;
      const fs = document.getElementById('fontSize'); if (fs) fs.value = s.fontSize;
      const fsv = document.getElementById('fontSizeVal'); if (fsv) fsv.textContent = s.fontSize;
      const txt = document.getElementById('textoLibre'); if (txt) txt.value = s.text;
      const btnTema = document.querySelector(`[data-tema="${s.theme}"]`);
      if (btnTema && typeof window.selTema === 'function') window.selTema(s.theme, btnTema);
      if (typeof window.proyectarTexto === 'function' && s.text) window.proyectarTexto();
      Logger.info('Escena aplicada', s.name);
    };

    window.deleteScene = function(id){
      const scenes = StorageService.get(SCENES_KEY, []).filter(s => s.id !== id);
      StorageService.set(SCENES_KEY, scenes);
      renderScenes();
    };

    function renderScenes(){
      const list = document.getElementById('sceneList');
      if (!list) return;
      const scenes = StorageService.get(SCENES_KEY, []);
      list.innerHTML = scenes.map(s => `
        <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:8px;display:flex;align-items:center;gap:8px;">
          <div style="flex:1;"><div style="color:var(--text);font-size:13px;">${s.name}</div><div style="font-size:11px;color:var(--text-muted);">${s.theme} · ${s.fontSize}px · ${s.align}</div></div>
          <button class="orden-btn" onclick="window.applyScene('${s.id}')">Aplicar</button>
          <button class="orden-btn del" onclick="window.deleteScene('${s.id}')">✕</button>
        </div>
      `).join('') || '<div style="font-size:12px;color:var(--text-muted);">Sin escenas guardadas.</div>';
    }

    renderScenes();
  }

  function setupCultPackage(){
    addConfigCard('📦 Paquete de culto', `
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-secondary" onclick="window.exportCultPackage()">Exportar paquete</button>
        <label class="btn btn-secondary" style="cursor:pointer;">
          Importar paquete <input type="file" id="cultPkgInput" accept="application/json" style="display:none;">
        </label>
      </div>
    `);

    window.exportCultPackage = function(){
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        keys: {
          canciones: StorageService.get('presencia_canciones', []),
          bibliaFavs: StorageService.get('presencia_biblia_favs', []),
          ordenes: StorageService.get('presencia_ordenes', []),
          anuncios: StorageService.get('presencia_anuncios', []),
          tema: localStorage.getItem('presencia_tema') || 'dark',
          notas: localStorage.getItem('presencia_notas') || '',
          escenas: StorageService.get(SCENES_KEY, []),
          metrics: StorageService.get(METRICS_KEY, {})
        }
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'presencia-paquete-' + new Date().toISOString().slice(0,10) + '.json';
      a.click();
      Logger.info('Paquete de culto exportado');
    };

    const inp = document.getElementById('cultPkgInput');
    if (inp) {
      inp.onchange = () => {
        const file = inp.files[0]; if (!file) return;
        const fr = new FileReader();
        fr.onload = (e) => {
          try {
            const pkg = JSON.parse(e.target.result);
            if (!pkg.keys) throw new Error('invalido');
            StorageService.set('presencia_canciones', pkg.keys.canciones || []);
            StorageService.set('presencia_biblia_favs', pkg.keys.bibliaFavs || []);
            StorageService.set('presencia_ordenes', pkg.keys.ordenes || []);
            StorageService.set('presencia_anuncios', pkg.keys.anuncios || []);
            localStorage.setItem('presencia_tema', pkg.keys.tema || 'dark');
            localStorage.setItem('presencia_notas', pkg.keys.notas || '');
            StorageService.set(SCENES_KEY, pkg.keys.escenas || []);
            StorageService.set(METRICS_KEY, pkg.keys.metrics || {});
            Logger.info('Paquete importado');
            alert('Paquete importado. Recarga la página para aplicar todo.');
          } catch(err){
            Logger.error('Error al importar paquete', err?.message || err);
            alert('Paquete inválido.');
          }
        };
        fr.readAsText(file);
      };
    }
  }

  function setupTeleprompter(){
    addConfigCard('🗒️ Teleprompter', `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button class="btn btn-secondary" onclick="window.openTeleprompter()">Abrir teleprompter</button>
        <label style="font-size:12px;color:var(--text-dim);">Velocidad</label>
        <input type="range" id="teleSpeed" min="10" max="80" value="30" style="accent-color:var(--accent);">
        <button class="btn btn-secondary" onclick="window.sendToTeleprompter()">Enviar texto actual</button>
      </div>
    `);

    window.openTeleprompter = function(){
      window.open('teleprompter.html', 'presencia-teleprompter', 'width=1200,height=700');
      Logger.info('Teleprompter abierto');
    };

    window.sendToTeleprompter = function(){
      const texto = document.getElementById('textoLibre')?.value || document.getElementById('currentSlideContent')?.textContent || '';
      const speed = Number(document.getElementById('teleSpeed')?.value || 30);
      if (window.canal) {
        window.canal.postMessage({ type: 'teleprompter-update', text: texto });
        window.canal.postMessage({ type: 'teleprompter-speed', speed });
      }
      Logger.info('Texto enviado a teleprompter');
    };
  }

  function setupMetrics(){
    const m = StorageService.get(METRICS_KEY, {});
    m.sessions = (m.sessions || 0) + 1;
    StorageService.set(METRICS_KEY, m);

    const originalActualizarPreview = window.actualizarPreview;
    window.actualizarPreview = function(texto){
      const metrics = StorageService.get(METRICS_KEY, {});
      metrics.projections = (metrics.projections || 0) + (texto ? 1 : 0);
      StorageService.set(METRICS_KEY, metrics);

      const ccText = document.getElementById('ccTexto');
      if (ccText) ccText.textContent = (texto || '—').slice(0, 120);
      return originalActualizarPreview(texto);
    };

    addConfigCard('📈 Métricas operativas', `
      <div id="metricsBox" style="font-size:13px;color:var(--text-dim);"></div>
    `);

    function renderMetrics(){
      const box = document.getElementById('metricsBox');
      if (!box) return;
      const metrics = StorageService.get(METRICS_KEY, {});
      const switches = metrics.moduleSwitches || {};
      const top = Object.entries(switches).sort((a,b)=>b[1]-a[1]).slice(0,3)
        .map(([k,v])=>`${k}: ${v}`).join(' · ') || 'sin datos';
      box.innerHTML = `
        <div>Sesiones: <strong style="color:var(--accent)">${metrics.sessions || 0}</strong></div>
        <div>Proyecciones: <strong style="color:var(--accent)">${metrics.projections || 0}</strong></div>
        <div>Módulos más usados: <strong style="color:var(--accent)">${top}</strong></div>
      `;
    }
    renderMetrics();
    setInterval(renderMetrics, 5000);
  }

  function patchBibliaFetch(){
    if (typeof window._fetchYMostrar !== 'function') return;
    const original = window._fetchYMostrar;
    window._fetchYMostrar = async function(ref, tituloManual){
      const cacheKey = 'presencia_biblia_cache_' + (window.bibliaVersion || 'rv1960') + '_' + ref.toLowerCase();
      try {
        if (typeof window.setBibliaEstado === 'function') window.setBibliaEstado('Buscando (con reintentos)...', '');
        const url = `${window.BIBLE_API}/read/${window.bibliaVersion}/${ref.toLowerCase()}`;
        const result = await fetchWithRetryAndCache(url, cacheKey, 2);
        let data = result.data;
        if (data && !Array.isArray(data) && typeof data === 'object') {
          data = [data];
        }
        if (!Array.isArray(data) || !data.length) throw new Error('Sin resultados');
        window.ultimosVersiculos = data;
        window.ultimaRef = tituloManual || ref;
        if (typeof window.mostrarVersiculos === 'function') window.mostrarVersiculos(data, tituloManual || ref);
        if (typeof window.setBibliaEstado === 'function') {
          window.setBibliaEstado(result.cached ? `Cargado desde caché (${data.length})` : `${data.length} versículo(s) cargados`, 'ok');
        }
      } catch (e) {
        Logger.error('Fallo consulta bíblica', e?.message || e);
        return original(ref, tituloManual);
      }
    };
  }

  function patchAnuncios(){
    if (typeof window.guardarAnuncio === 'function') {
      const originalGuardarAnuncio = window.guardarAnuncio;
      window.guardarAnuncio = async function(){
        const imagenData = document.getElementById('aImagenData')?.value || '';
        if (imagenData && imagenData.startsWith('data:image')) {
          try {
            const mediaId = await idbPutImage(imagenData);
            if (mediaId) {
              const hidden = document.getElementById('aImagenData');
              hidden.value = '';
              const existing = document.getElementById('anuncioEditandoId')?.value;
              if (existing) {
                const idx = (window.anunciosLib || []).findIndex(a => a.id === existing);
                if (idx >= 0) window.anunciosLib[idx].mediaId = mediaId;
              }
              window.__lastMediaId = mediaId;
            }
          } catch(e){ Logger.warn('No se pudo persistir imagen en IndexedDB', e?.message || e); }
        }
        originalGuardarAnuncio();
        if (window.__lastMediaId) {
          const last = (window.anunciosLib || []).slice(-1)[0];
          if (last && !last.mediaId) { last.mediaId = window.__lastMediaId; last.imagen=''; }
          if (typeof window.guardarAnunciosStorage === 'function') window.guardarAnunciosStorage();
          window.__lastMediaId = null;
        }
      };
    }

    if (typeof window.proyectarAnuncio === 'function') {
      const originalProyectarAnuncio = window.proyectarAnuncio;
      window.proyectarAnuncio = async function(idx){
        const a = window.anunciosLib?.[idx];
        if (a) await hydrateAnuncio(a);
        return originalProyectarAnuncio(idx);
      };
    }

    if (typeof window.renderizarAnuncios === 'function') {
      const origRender = window.renderizarAnuncios;
      window.renderizarAnuncios = async function(){
        if (Array.isArray(window.anunciosLib)) {
          for (const a of window.anunciosLib) await hydrateAnuncio(a);
        }
        return origRender();
      };
    }
  }

  function setupA11y(){
    addConfigCard('♿ Accesibilidad', `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-secondary" onclick="window.toggleHighContrast()">Alto contraste</button>
        <button class="btn btn-secondary" onclick="window.enableKeyboardNav()">Mejorar navegación teclado</button>
      </div>
    `);

    window.toggleHighContrast = function(){
      document.body.classList.toggle('hc-mode');
      const on = document.body.classList.contains('hc-mode');
      if (on) {
        document.documentElement.style.setProperty('--bg-deep', '#000');
        document.documentElement.style.setProperty('--text', '#fff');
        document.documentElement.style.setProperty('--accent', '#ffd54f');
      } else {
        document.documentElement.style.removeProperty('--bg-deep');
        document.documentElement.style.removeProperty('--text');
        document.documentElement.style.removeProperty('--accent');
      }
    };

    window.enableKeyboardNav = function(){
      document.querySelectorAll('button,.nav-item,input,textarea,select').forEach(el=>{
        el.setAttribute('tabindex','0');
      });
      alert('Navegación por teclado reforzada.');
    };
  }

  function wireRemotosCounter(){
    setInterval(() => {
      const ccRem = document.getElementById('ccRemotos');
      if (ccRem) ccRem.textContent = String(window.remotosConectados?.size || 0);
    }, 1000);
  }

  function setupProjectionSyncing() {
    if (!window.canal) return;

    // Helpers para acceder de forma dinámica a las variables declaradas en el script global de index.html
    function getTamanoFuente() {
      try { return tamanoFuente; } catch (e) { return window.tamanoFuente || 60; }
    }
    function getAlineacion() {
      try { return alineacion; } catch (e) { return window.alineacion || 'center'; }
    }
    function getTemaActual() {
      try { return temaActual; } catch (e) { return window.temaActual || 'dark'; }
    }
    function getPantallaOscura() {
      try { return pantallaOscura; } catch (e) { return window.pantallaOscura || false; }
    }

    function setGlobalTamanoFuente(val) {
      try { tamanoFuente = val; } catch (e) {}
      try { window.tamanoFuente = val; } catch (e) {}
    }
    function setGlobalAlineacion(val) {
      try { alineacion = val; } catch (e) {}
      try { window.alineacion = val; } catch (e) {}
    }
    function setGlobalTemaActual(val) {
      try { temaActual = val; } catch (e) {}
      try { window.temaActual = val; } catch (e) {}
    }
    function setGlobalPantallaOscura(val) {
      try { pantallaOscura = val; } catch (e) {}
      try { window.pantallaOscura = val; } catch (e) {}
    }

    const originalPostMessage = window.canal.postMessage;
    let ultimoContenidoProyectado = null;
    let ultimoTemaProyectado = null;
    let ultimoColorProyectado = null;
    let ultimaOpacidadProyectada = null;
    let ultimoFontSizeProyectado = null;
    let ultimoAlignProyectado = null;
    let ultimoBlackProyectado = null;

    window.canal.postMessage = function(msg) {
      if (msg) {
        if (msg.type === 'content') {
          ultimoContenidoProyectado = msg;
          if (ultimoContenidoProyectado && !ultimoContenidoProyectado.fontSize) {
            ultimoContenidoProyectado.fontSize = getTamanoFuente();
          }
          if (ultimoContenidoProyectado && !ultimoContenidoProyectado.align) {
            ultimoContenidoProyectado.align = getAlineacion();
          }
        } else if (msg.type === 'clear') {
          ultimoContenidoProyectado = null;
        } else if (msg.type === 'tema') {
          ultimoTemaProyectado = msg;
          if (msg.temaActualName) {
            setGlobalTemaActual(msg.temaActualName);
          }
        } else if (msg.type === 'textoColor') {
          ultimoColorProyectado = msg;
        } else if (msg.type === 'fondoOpacidad') {
          ultimaOpacidadProyectada = msg;
        } else if (msg.type === 'fontSize') {
          ultimoFontSizeProyectado = msg;
          setGlobalTamanoFuente(msg.value);
          if (ultimoContenidoProyectado) {
            ultimoContenidoProyectado.fontSize = msg.value;
          }
        } else if (msg.type === 'align') {
          ultimoAlignProyectado = msg;
          setGlobalAlineacion(msg.value);
          if (ultimoContenidoProyectado) {
            ultimoContenidoProyectado.align = msg.value;
          }
        } else if (msg.type === 'black') {
          ultimoBlackProyectado = msg;
          setGlobalPantallaOscura(msg.black);
        }
      }

      // Enviar de forma directa por ventana para saltar la restricción de storage partitioning (iframes)
      if (window.proyeccionWin && !window.proyeccionWin.closed) {
        try {
          window.proyeccionWin.postMessage(msg, '*');
        } catch (e) {
          console.warn('Error postMessage directo a proyeccionWin:', e);
        }
      }
      const miniIframe = document.getElementById('miniProyectorIframe');
      if (miniIframe && miniIframe.contentWindow) {
        try {
          miniIframe.contentWindow.postMessage(msg, '*');
        } catch (e) {
          console.warn('Error postMessage directo a miniProyectorIframe:', e);
        }
      }

      return originalPostMessage.apply(window.canal, arguments);
    };

    // Escuchar mensajes en el canal para sincronizar cuando llegue un ping o teleprompter-ping
    const originalOnMessage = window.canal.onmessage;
    window.canal.onmessage = function(e) {
      const msg = e ? e.data : null;
      if (msg) {
        if (msg.type === 'ping') {
          window.proyeccionAbierta = true;
          if (typeof window.actualizarEstado === 'function') {
            window.actualizarEstado(true);
          }

          // Re-sincronizar inmediatamente todo el estado usando window.canal.postMessage para enviar por todos los conductos
          const TEMAS = {
            dark:   { bg: 'radial-gradient(ellipse at 30% 40%, #0d1520 0%, #000 65%)', text: '#e8e2d5', accent: '#c9a84c' },
            starry: { bg: 'radial-gradient(ellipse at center, #060918 0%, #000 80%)', text: '#e8e2d5', accent: '#7a9ecf' },
            warm:   { bg: 'radial-gradient(ellipse at center, #1c1007 0%, #000 75%)', text: '#f3e5ab', accent: '#dca035' },
            light:  { bg: '#fbfbf9', text: '#111', accent: '#8a6e2f' },
            green:  { bg: 'radial-gradient(ellipse at center, #031407 0%, #000 75%)', text: '#e0ebd4', accent: '#4caf80' },
            royal:  { bg: 'radial-gradient(ellipse at center, #0a061a 0%, #000 80%)', text: '#e5e2f5', accent: '#9b71e6' }
          };
          const currentThemeName = getTemaActual();
          const currentThemeObj = TEMAS[currentThemeName];

          if (ultimoTemaProyectado) {
            window.canal.postMessage(ultimoTemaProyectado);
          } else if (currentThemeObj) {
            window.canal.postMessage({ type: 'tema', tema: currentThemeObj, temaActualName: currentThemeName });
          }

          if (ultimoColorProyectado) {
            window.canal.postMessage(ultimoColorProyectado);
          } else {
            const picker = document.getElementById('textoColorPicker');
            if (picker && picker.value) {
              window.canal.postMessage({ type: 'textoColor', color: picker.value });
            }
          }

          if (ultimaOpacidadProyectada) {
            window.canal.postMessage(ultimaOpacidadProyectada);
          } else {
            const opSlider = document.getElementById('fondoOpacidad');
            if (opSlider) {
              window.canal.postMessage({ type: 'fondoOpacidad', value: parseInt(opSlider.value) / 100 });
            }
          }

          if (ultimoFontSizeProyectado) {
            window.canal.postMessage(ultimoFontSizeProyectado);
          } else {
            window.canal.postMessage({ type: 'fontSize', value: getTamanoFuente() });
          }

          if (ultimoAlignProyectado) {
            window.canal.postMessage(ultimoAlignProyectado);
          } else {
            window.canal.postMessage({ type: 'align', value: getAlineacion() });
          }

          if (ultimoContenidoProyectado) {
            window.canal.postMessage(ultimoContenidoProyectado);
          } else {
            window.canal.postMessage({ type: 'clear' });
          }

          if (ultimoBlackProyectado) {
            window.canal.postMessage(ultimoBlackProyectado);
          } else {
            window.canal.postMessage({ type: 'black', black: !!getPantallaOscura() });
          }
        } else if (msg.type === 'closed') {
          window.proyeccionAbierta = false;
          if (typeof window.actualizarEstado === 'function') {
            window.actualizarEstado(false);
          }
        } else if (msg.type === 'teleprompter-ping') {
          // Responder al ping del teleprompter con el texto y la velocidad actuales
          const txt = document.getElementById('textoLibre')?.value || document.getElementById('currentSlideContent')?.textContent || '';
          const speed = Number(document.getElementById('teleSpeed')?.value || 30);
          window.canal.postMessage({ type: 'teleprompter-update', text: txt });
          window.canal.postMessage({ type: 'teleprompter-speed', speed });
        }
      }
      if (typeof originalOnMessage === 'function') {
        return originalOnMessage.apply(this, arguments);
      }
    };
    
    Logger.info('Sincronización automatizada de proyección inicializada');
  }

  function setupUsageStatistics() {
    // Track active projections to compute precise usage time
    window._activeProjection = null;

    // Load active tracking from session if page is reloaded
    try {
      const activeSaved = localStorage.getItem('presencia_active_projection_session');
      if (activeSaved) {
        window._activeProjection = JSON.parse(activeSaved);
        // Update startTime to avoid huge gap if they closed the browser
        window._activeProjection.startTime = Date.now();
      }
    } catch(e){}

    // Helper to commit current projection duration
    function commitActiveProjection() {
      if (window._activeProjection) {
        const duration = Math.round((Date.now() - window._activeProjection.startTime) / 1000);
        if (duration > 0) {
          try {
            const usage = JSON.parse(localStorage.getItem('presencia_uso_items') || '{}');
            const id = window._activeProjection.id;
            if (!usage[id]) {
              usage[id] = {
                id,
                type: window._activeProjection.type,
                title: window._activeProjection.title,
                duration: 0,
                count: 1
              };
            }
            usage[id].duration += duration;
            localStorage.setItem('presencia_uso_items', JSON.stringify(usage));
          } catch(e) {
            console.error('Error saving usage stats:', e);
          }
        }
        window._activeProjection = null;
        localStorage.removeItem('presencia_active_projection_session');
      }
    }

    // Helper to start a new active projection
    function startActiveProjection(type, id, displayTitle) {
      commitActiveProjection(); // Commit previous first if any

      // Increment count for new projection
      try {
        const usage = JSON.parse(localStorage.getItem('presencia_uso_items') || '{}');
        if (!usage[id]) {
          usage[id] = {
            id,
            type,
            title: displayTitle,
            duration: 0,
            count: 0
          };
        }
        usage[id].count += 1;
        localStorage.setItem('presencia_uso_items', JSON.stringify(usage));
      } catch(e) {
        console.error('Error incrementing usage count:', e);
      }

      window._activeProjection = {
        type,
        id,
        title: displayTitle,
        startTime: Date.now()
      };
      
      try {
        localStorage.setItem('presencia_active_projection_session', JSON.stringify(window._activeProjection));
      } catch(e){}
    }

    // Hook into window.canal.postMessage to detect projection events
    if (window.canal) {
      const originalPostMessage = window.canal.postMessage;
      window.canal.postMessage = function(msg) {
        if (msg) {
          if (msg.type === 'content' && (msg.contentType === 'himno' || msg.contentType === 'cancion')) {
            const isHimno = msg.contentType === 'himno';
            let id = '';
            let displayTitle = '';

            if (isHimno) {
              const num = msg.label ? msg.label.replace('HIMNO ', '') : '';
              const baseTitle = msg.subtitle ? msg.subtitle.split(' — ')[0] : 'Himno sin título';
              id = 'himno-' + num;
              displayTitle = baseTitle;
            } else {
              const baseTitle = msg.subtitle ? msg.subtitle.split(' — ')[0] : 'Canción sin título';
              // Try to find the song by title in cancionesLib
              let songId = '';
              if (Array.isArray(window.cancionesLib)) {
                const found = window.cancionesLib.find(c => c.titulo === baseTitle);
                if (found) songId = found.id;
              }
              id = 'cancion-' + (songId || baseTitle.replace(/\s+/g, '-').toLowerCase());
              displayTitle = baseTitle;
            }

            // Only start new active projection session if different song/hymn is chosen
            if (!window._activeProjection || window._activeProjection.id !== id) {
              startActiveProjection(msg.contentType, id, displayTitle);
            } else {
              // Update subtitle/content but keep the same startTime
              window._activeProjection.title = displayTitle;
            }
          } else if (msg.type === 'clear' || msg.type === 'black' || (msg.type === 'content' && msg.contentType !== 'himno' && msg.contentType !== 'cancion')) {
            // Commit if clear, black, or another type like bible/anuncio is projected
            commitActiveProjection();
          }
        }
        return originalPostMessage.apply(window.canal, arguments);
      };
    }

    // Also commit on window unload
    window.addEventListener('beforeunload', () => {
      commitActiveProjection();
    });

    // Add card to Config module
    addConfigCard('📊 Tiempo de uso y frecuencia', `
      <div style="font-size:12.5px;color:var(--text-dim);line-height:1.6;margin-bottom:12px;">
        Análisis interactivo de la frecuencia y tiempo real acumulado de proyección de canciones e himnos.
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
        <label style="font-size:12px;color:var(--text-dim);">Métrica:</label>
        <select id="d3ChartMetric" style="background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:6px 10px;border-radius:8px;font-size:12.5px;" onchange="window.renderD3UsageChart()">
          <option value="duration">⏱️ Tiempo de uso (Segundos)</option>
          <option value="count">🔄 Frecuencia (Proyecciones)</option>
        </select>
        <button class="btn btn-secondary" style="padding:6px 12px;font-size:11.5px;margin-left:auto;" onclick="window.resetUsageStatistics()">Restablecer</button>
      </div>
      <div id="d3ChartContainer" style="width:100%; min-height:220px; position:relative; background:var(--bg-input); border:1px solid var(--border); border-radius:12px; overflow:hidden;"></div>
    `);

    // Define globally accessible render and reset functions
    window.renderD3UsageChart = function() {
      const container = document.getElementById('d3ChartContainer');
      if (!container) return;
      
      container.innerHTML = '';
      
      let usageData = {};
      try {
        usageData = JSON.parse(localStorage.getItem('presencia_uso_items') || '{}');
      } catch(e){
        usageData = {};
      }
      
      const data = Object.values(usageData);
      
      if (data.length === 0) {
        container.innerHTML = `
          <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:220px; color:var(--text-muted); text-align:center; padding:16px;">
            <span style="font-size:32px; margin-bottom:10px;">📊</span>
            <p style="font-size:12.5px; line-height:1.5;">Aún no hay datos de uso acumulados.<br>Proyecta himnos o canciones para visualizar su tiempo de uso aquí.</p>
          </div>
        `;
        return;
      }
      
      const metric = document.getElementById('d3ChartMetric')?.value || 'duration';
      if (metric === 'duration') {
        data.sort((a, b) => b.duration - a.duration);
      } else {
        data.sort((a, b) => b.count - a.count);
      }
      
      // Top 10 items for visual clarity
      const topData = data.slice(0, 10);
      
      const width = container.clientWidth || 340;
      const height = Math.max(220, topData.length * 35 + 40);
      
      const margin = { top: 15, right: 25, bottom: 40, left: 110 };
      const innerWidth = width - margin.left - margin.right;
      const innerHeight = height - margin.top - margin.bottom;
      
      const svg = d3.select('#d3ChartContainer')
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', `translate(${margin.left}, ${margin.top})`);
        
      // Scales
      const yScale = d3.scaleBand()
        .domain(topData.map(d => d.title))
        .range([0, innerHeight])
        .padding(0.25);
        
      const maxVal = d3.max(topData, d => metric === 'duration' ? d.duration : d.count) || 1;
      const xScale = d3.scaleLinear()
        .domain([0, maxVal])
        .range([0, innerWidth]);
        
      // Soft Grid lines
      svg.append('g')
        .attr('class', 'grid')
        .attr('transform', `translate(0, ${innerHeight})`)
        .call(d3.axisBottom(xScale)
          .ticks(5)
          .tickSize(-innerHeight)
          .tickFormat('')
        )
        .call(g => g.selectAll('.tick line')
          .attr('stroke', 'var(--border)')
          .attr('stroke-opacity', 0.6)
          .attr('stroke-dasharray', '2,2')
        )
        .call(g => g.select('.domain').remove());
        
      // Axes formatting
      const xAxis = d3.axisBottom(xScale)
        .ticks(5)
        .tickFormat(d => {
          if (metric === 'duration') {
            if (d >= 60) {
              return Math.round(d / 60) + 'm';
            }
            return d + 's';
          }
          return d;
        });
        
      const yAxis = d3.axisLeft(yScale);
      
      svg.append('g')
        .attr('transform', `translate(0, ${innerHeight})`)
        .call(xAxis)
        .call(g => {
          g.selectAll('.tick text')
            .attr('fill', 'var(--text-dim)')
            .attr('font-size', '10px')
            .attr('font-family', 'inherit');
          g.select('.domain')
            .attr('stroke', 'var(--border)');
          g.selectAll('.tick line')
            .attr('stroke', 'var(--border)');
        });
        
      const yAxisG = svg.append('g')
        .call(yAxis);
        
      yAxisG.selectAll('.tick text')
        .attr('fill', 'var(--text)')
        .attr('font-size', '10.5px')
        .attr('font-family', 'inherit')
        .each(function(d) {
          // Truncate long titles on Y-axis to prevent spill over
          let text = d;
          if (text.length > 14) {
            text = text.substring(0, 12) + '...';
          }
          d3.select(this).text(text);
        });
        
      yAxisG.select('.domain')
        .attr('stroke', 'var(--border)');
      yAxisG.selectAll('.tick line')
        .attr('stroke', 'var(--border)');
        
      // Draw Bars with rounded corners and gradients or solid CSS variables
      const bars = svg.selectAll('.bar')
        .data(topData)
        .enter()
        .append('rect')
        .attr('class', 'bar')
        .attr('y', d => yScale(d.title))
        .attr('x', 0)
        .attr('height', yScale.bandwidth())
        .attr('fill', 'var(--accent)')
        .attr('rx', 4)
        .attr('ry', 4)
        .attr('opacity', 0.8)
        .style('cursor', 'pointer')
        .attr('width', 0); // Start width at 0 for animation
        
      // Animate transition width
      bars.transition()
        .duration(500)
        .attr('width', d => Math.max(4, xScale(metric === 'duration' ? d.duration : d.count)));
        
      // Tooltip implementation matching design
      let tooltip = d3.select('body').select('.d3-usage-tooltip');
      if (tooltip.empty()) {
        tooltip = d3.select('body').append('div')
          .attr('class', 'd3-usage-tooltip')
          .style('position', 'absolute')
          .style('z-index', '9999')
          .style('background', 'var(--bg-card)')
          .style('border', '1px solid var(--border)')
          .style('color', 'var(--text)')
          .style('padding', '8px 12px')
          .style('border-radius', '12px')
          .style('font-size', '12px')
          .style('box-shadow', '0 8px 24px rgba(0,0,0,0.18)')
          .style('pointer-events', 'none')
          .style('opacity', 0)
          .style('transition', 'opacity 0.15s ease');
      }
        
      bars.on('mouseover', function(event, d) {
        d3.select(this)
          .attr('opacity', 1)
          .attr('fill', 'var(--accent-dim)');
          
        const isHimno = d.type === 'himno';
        const icon = isHimno ? '🎵' : '🎤';
        const typeStr = isHimno ? 'Himno' : 'Canción Libre';
        const formattedTime = formatUsageTime(d.duration);
        
        tooltip.style('opacity', 1);
        tooltip.html(`
          <div style="font-weight:700; color:var(--accent); margin-bottom:3px;">${icon} ${d.title}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-bottom:5px;">${typeStr}</div>
          <div>⏱️ Tiempo: <strong>${formattedTime}</strong></div>
          <div>🔄 Proyecciones: <strong>${d.count} veces</strong></div>
        `);
      })
      .on('mousemove', function(event) {
        tooltip
          .style('left', (event.pageX + 12) + 'px')
          .style('top', (event.pageY - 12) + 'px');
      })
      .on('mouseout', function() {
        d3.select(this)
          .attr('opacity', 0.8)
          .attr('fill', 'var(--accent)');
        tooltip.style('opacity', 0);
      });
    };

    window.resetUsageStatistics = function() {
      if (confirm('¿Estás seguro de restablecer las estadísticas de uso de himnos y canciones? Se borrará todo el historial de tiempo de uso.')) {
        localStorage.removeItem('presencia_uso_items');
        localStorage.removeItem('presencia_active_projection_session');
        window._activeProjection = null;
        window.renderD3UsageChart();
        if (typeof window.showToast === 'function') {
          window.showToast('Estadísticas restablecidas', 'ok');
        }
      }
    };

    // Helper to format time strings nicely
    function formatUsageTime(totalSecs) {
      if (!totalSecs) return '0 seg';
      if (totalSecs < 60) return totalSecs + ' seg';
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      if (secs === 0) return mins + ' min';
      return mins + 'm ' + secs + 's';
    }

    // Trigger initial render
    window.renderD3UsageChart();

    // Hook into switchModule to redraw when config module becomes active
    const originalSwitchModule = window.switchModule;
    window.switchModule = function(id, el) {
      const res = originalSwitchModule(id, el);
      if (id === 'config') {
        // Delay slightly to allow transition/rendering to complete
        setTimeout(() => {
          window.renderD3UsageChart();
        }, 120);
      }
      return res;
    };

    // Redraw on window resize
    window.addEventListener('resize', () => {
      if (document.getElementById('mod-config')?.classList.contains('active')) {
        window.renderD3UsageChart();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    StorageService.migrate();
    setupControlCenter();
    setupDiagnosticsPanel();
    setupNetworkStatus();
    setupRolesAndPin();
    setupScenes();
    setupCultPackage();
    setupTeleprompter();
    setupA11y();
    setupMetrics();
    setupUsageStatistics();
    patchBibliaFetch();
    patchAnuncios();
    wireRemotosCounter();
    setupProjectionSyncing();
    await migrateAnunciosToIDB();
    Logger.info('Enhancements inicializadas', { version: APP_VER });
  });
})();
