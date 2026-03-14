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
    if (cached && Array.isArray(cached.data)) return { data: cached.data, cached: true };
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
        const data = result.data;
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
    patchBibliaFetch();
    patchAnuncios();
    wireRemotosCounter();
    await migrateAnunciosToIDB();
    Logger.info('Enhancements inicializadas', { version: APP_VER });
  });
})();
