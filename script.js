import { SOURCE_TYPES, SOURCE_FORMS, VIDEO_SOURCE_TYPES, AUDIO_SOURCE_TYPES } from './source-types.js';
import { VereadorManager } from './vereador-manager.js';
import { StreamManager } from './stream-manager.js';
import { generateQRCode } from './qrcode.js';

function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// ─────────────────────────────────────────
//  CLASSE PRINCIPAL
// ─────────────────────────────────────────
class OBSClone {
    constructor() {
        this.isStreaming    = false;
        this.isRecording    = false;
        this.scenes         = [];
        this.activeSceneId  = null;
        this.activeSource   = null;
        this.pendingType    = null;
        this.mediaStreams   = {};
        this.transitionType     = 'cut';
        this.transitionDuration = 300;
        this._transitioning = false;
        this._snapshotKey   = 'obsBackups';
        this._maxSnapshots  = 10;
        this.audioChains    = {};
        this._vuAnimId      = null;
        this.masterVolume   = 1;
        this._objectUrls    = {};
        this._vereadorAudio = {};
        this._audioCtx = null;
        this._vereadoresActive = false;
        this._entrevistasActive = false;
        this._vereadoresGridInterval = null;
        this._entrevistasInterval = null;
        this.settings       = this._loadSettings();
        this.isVirtualCam   = false;
        this.isStudioMode   = false;
        this._devices = { videoinput: [], audioinput: [], audiooutput: [] };
        try {
            this.init();
        } catch (e) {
            console.error('[OBS] Erro na inicializacao:', e);
            this.showNotification(`⚠️ Erro ao carregar: ${e.message || 'desconhecido'} — criando estado padrao`);
            this.scenes = [{ id: Date.now(), name: 'Cena 1', sources: [], activeSourceId: null }];
            this.activeSceneId = this.scenes[0].id;
            this.renderScenes();
        }
    }

    async _enumerateDevices() {
        try {
            if (!navigator.mediaDevices?.enumerateDevices) return;
            const raw = await navigator.mediaDevices.enumerateDevices();
            this._devices.videoinput = raw.filter(d => d.kind === 'videoinput');
            this._devices.audioinput = raw.filter(d => d.kind === 'audioinput');
            this._devices.audiooutput = raw.filter(d => d.kind === 'audiooutput');
            navigator.mediaDevices.addEventListener('devicechange', () => {
                this._enumerateDevices().catch(() => {});
            }, { once: true });
        } catch (e) {
            console.warn('[OBS] Erro ao enumerar dispositivos:', e.message);
        }
    }

    _populateDeviceSelects(root) {
        (root || document).querySelectorAll('.device-select[data-device-kind]').forEach(sel => {
            const kind = sel.dataset.deviceKind;
            const devices = this._devices[kind] || [];
            const currentVal = sel.value;
            sel.innerHTML = '<option value="">Selecionar dispositivo...</option>';
            devices.forEach(d => {
                const label = d.label || `Dispositivo ${d.deviceId.slice(0, 8)}...`;
                const opt = document.createElement('option');
                opt.value = d.deviceId === 'default' ? 'default' : d.deviceId;
                opt.textContent = label;
                if (opt.value === currentVal) opt.selected = true;
                sel.appendChild(opt);
            });
            if (!currentVal && devices.length > 0) {
                sel.selectedIndex = 1;
            }
        });
    }

    init() {
        this.setupEventListeners();
        this._enumerateDevices().catch(() => {});
        this.setupSectionDragDrop();
        this.vereadorManager = new VereadorManager(this);
        this.streamManager = new StreamManager();
        this.setupFloatingWindow();
        this.setupModals();
        this.loadData();
        this._restoreSectionLayout();
        this.startAutoSave();
        this.startAudioMixerLoop();
        this.renderAudioMixer();
        this._pipSyncInterval = setInterval(() => this._syncProgramPip(), 500);
        this._setupSettingsUI();
        this._setupPreviewLogoDrag();
        this._applyPreviewStyles();
        document.addEventListener('click', () => { this._resumeAudioContexts(); this._getAudioContext(); }, { once: true });
        document.addEventListener('touchstart', () => { this._resumeAudioContexts(); this._getAudioContext(); }, { once: true });
        window.addEventListener('beforeunload', (e) => {
            try {
                const data = this._captureSyncSnapshot();
                if (data) localStorage.setItem('obsScenes', JSON.stringify(data));
            } catch (_) {}
            this.saveData();
            if (this._pipSyncInterval) clearInterval(this._pipSyncInterval);
            if (this._vereadoresGridInterval) clearInterval(this._vereadoresGridInterval);
            Object.keys(this.audioChains).forEach(id => this.cleanupAudioChain(id));
        });
    }

    // ─────────────────────────────────────────
    //  EVENT LISTENERS
    // ─────────────────────────────────────────
    setupEventListeners() {
        document.getElementById('start-btn')       ?.addEventListener('click', () => this.startStreaming());
        document.getElementById('stop-btn')        ?.addEventListener('click', () => this.stopStreaming());
        document.getElementById('record-btn')      ?.addEventListener('click', () => this.toggleRecording());
        document.getElementById('add-source-btn')  ?.addEventListener('click', () => this.addFromDropdown());
        this._populateSourceDropdown();
        document.getElementById('add-scene-btn')   ?.addEventListener('click', () => this.createScene());
        document.getElementById('remove-scene-btn')?.addEventListener('click', () => this.removeScene());
        document.getElementById('backup-restore-btn')?.addEventListener('click', () => this.showBackupList());
        document.getElementById('transition-go-btn')?.addEventListener('click', () => this.doTransition());
        document.getElementById('transition-cut-btn')?.addEventListener('click', () => { this.transitionType = 'cut'; document.getElementById('transition-type').value = 'cut'; this.doTransition(); });
        document.getElementById('transition-type') ?.addEventListener('change', (e) => { this.transitionType = e.target.value; });
        document.getElementById('transition-duration')?.addEventListener('change', (e) => { this.transitionDuration = parseInt(e.target.value) || 300; });

        document.getElementById('virtual-cam-btn')?.addEventListener('click', () => this.toggleVirtualCam());
        document.querySelectorAll('.project-btn').forEach(b => {
            b.addEventListener('click', () => this.projectProgram(parseInt(b.dataset.width) || 1920, parseInt(b.dataset.height) || 1080));
        });
        document.getElementById('studio-mode-btn')?.addEventListener('click', () => this.toggleStudioMode());
        document.getElementById('settings-btn')?.addEventListener('click', () => this.openSettings());
        document.getElementById('settings-alt-btn')?.addEventListener('click', () => this.openSettings());

        document.querySelectorAll('.btn-audio-layout').forEach(b => {
            b.addEventListener('click', () => this.setAudioLayout(b.dataset.layout));
        });

        document.getElementById('monitor-link-btn')?.addEventListener('click', () => this._openMonitorLink());

        document.getElementById('close-audio-filters')?.addEventListener('click', () => this.closeAudioFilters());
        document.getElementById('close-audio-filters-btn')?.addEventListener('click', () => this.closeAudioFilters());

        document.getElementById('close-settings-modal')?.addEventListener('click', () => this.closeSettings());
        document.getElementById('cancel-settings-btn')?.addEventListener('click', () => this.closeSettings());
        document.getElementById('save-settings-btn')?.addEventListener('click', () => this.saveSettings());
        document.getElementById('modal-settings')?.addEventListener('click', (e) => { if (e.target.id === 'modal-settings') this.closeSettings(); });

        // Chroma Key modal
        document.getElementById('close-chroma-modal')?.addEventListener('click', () => this.closeChromaModal());
        document.getElementById('close-chroma-modal-btn')?.addEventListener('click', () => this.closeChromaModal());
        document.getElementById('chroma-apply-btn')?.addEventListener('click', () => { this._applyChromaKeySettings(); this.closeChromaModal(); });
        document.getElementById('chroma-reset-btn')?.addEventListener('click', () => {
            document.getElementById('chroma-color').value = '#00ff00';
            document.getElementById('chroma-similarity').value = '80';
            document.getElementById('chroma-similarity-val').textContent = '80';
            document.getElementById('chroma-smoothness').value = '50';
            document.getElementById('chroma-smoothness-val').textContent = '50';
            document.getElementById('chroma-opacity').value = '100';
            document.getElementById('chroma-opacity-val').textContent = '100';
            this._renderChromaPreview();
        });
        document.getElementById('modal-chroma')?.addEventListener('click', (e) => {
            if (e.target.id === 'modal-chroma') this.closeChromaModal();
        });
        // Color preset buttons
        document.querySelectorAll('[data-chroma-color]').forEach(b => {
            b.addEventListener('click', () => {
                document.getElementById('chroma-color').value = b.dataset.chromaColor;
                this._renderChromaPreview();
            });
        });
        // Range sliders update labels + preview
        ['chroma-similarity','chroma-smoothness','chroma-opacity'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', () => {
                document.getElementById(id + '-val').textContent = el.value;
                this._renderChromaPreview();
            });
        });

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'B') {
                e.preventDefault();
                this.showBackupList();
            }
        });

        // Virtual camera modal
        const closeVcamModal = () => {
            document.getElementById('modal-vcam').style.display = 'none';
        };
        document.getElementById('close-vcam-modal')?.addEventListener('click', closeVcamModal);
        document.getElementById('close-vcam-btn')?.addEventListener('click', closeVcamModal);
        document.getElementById('vcam-stop-btn')?.addEventListener('click', () => this.toggleVirtualCam());
        document.getElementById('modal-vcam')?.addEventListener('click', (e) => {
            if (e.target.id === 'modal-vcam') closeVcamModal();
        });
        document.getElementById('vcam-copy-btn')?.addEventListener('click', () => {
            const inp = document.getElementById('vcam-link-input');
            if (!inp) return;
            inp.select();
            document.execCommand('copy');
            this.showNotification('🔗 Link copiado!');
        });
    }

    closeChromaModal() {
        const canvas = document.getElementById('chroma-preview-canvas');
        if (canvas && canvas._chromaAnim) cancelAnimationFrame(canvas._chromaAnim);
        document.getElementById('modal-chroma').style.display = 'none';
    }

    // ─────────────────────────────────────────
    //  DRAG & DROP DE SEÇÕES ENTRE COLUNAS
    // ─────────────────────────────────────────
    setupSectionDragDrop() {
        const cols = document.querySelectorAll('.col');
        let draggedSection = null;

        // Permite arrastar apenas pelo handle
        document.querySelectorAll('.section-drag-handle').forEach(h => {
            h.addEventListener('mousedown', () => {
                const s = h.closest('.draggable-section');
                if (s) s._dragReady = true;
            });
        });

        cols.forEach(col => {
            col.addEventListener('dragstart', (e) => {
                const section = e.target.closest('.draggable-section');
                if (!section || !section._dragReady) { e.preventDefault(); return; }
                section._dragReady = false;
                draggedSection = section;
                section.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', section.dataset.section);
            });

            col.addEventListener('dragend', () => {
                document.querySelectorAll('.draggable-section').forEach(el => { el._dragReady = false; el.classList.remove('dragging'); });
                document.querySelectorAll('.col.drag-over').forEach(el => el.classList.remove('drag-over'));
                document.querySelectorAll('.draggable-section.drag-over').forEach(el => el.classList.remove('drag-over'));
                draggedSection = null;
            });

            col.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!draggedSection) return;
                e.dataTransfer.dropEffect = 'move';

                const colEl = e.target.closest('.col');
                if (!colEl) return;
                colEl.classList.add('drag-over');

                const targetSection = e.target.closest('.draggable-section');
                document.querySelectorAll('.draggable-section.drag-over').forEach(el => el.classList.remove('drag-over'));
                if (targetSection && targetSection !== draggedSection) {
                    const rect = targetSection.getBoundingClientRect();
                    const midX = rect.left + rect.width / 2;
                    targetSection.classList.toggle('drag-over', e.clientX < midX);
                }
            });

            col.addEventListener('dragleave', (e) => {
                const colEl = e.target.closest('.col');
                if (colEl && !colEl.contains(e.relatedTarget)) {
                    colEl.classList.remove('drag-over');
                }
                const section = e.target.closest('.draggable-section');
                if (section) section.classList.remove('drag-over');
            });

            col.addEventListener('drop', (e) => {
                e.preventDefault();
                if (!draggedSection) return;

                const targetCol = e.target.closest('.col');
                if (!targetCol) return;

                const targetSection = e.target.closest('.draggable-section');

                if (targetSection && targetSection !== draggedSection) {
                    const rect = targetSection.getBoundingClientRect();
                    const midX = rect.left + rect.width / 2;
                    const midY = rect.top + rect.height / 2;
                    // Com flex-wrap row, usa eixo X para decidir antes/depois
                    if (e.clientX < midX) {
                        targetCol.insertBefore(draggedSection, targetSection);
                    } else {
                        targetCol.insertBefore(draggedSection, targetSection.nextElementSibling);
                    }
                } else {
                    targetCol.appendChild(draggedSection);
                }

                document.querySelectorAll('.col.drag-over').forEach(el => el.classList.remove('drag-over'));
                document.querySelectorAll('.draggable-section.drag-over').forEach(el => el.classList.remove('drag-over'));
                draggedSection.classList.remove('dragging');
                draggedSection._dragReady = false;
                draggedSection = null;

                this._saveSectionLayout();
                this.showNotification('↕️ Layout reorganizado');
            });
        });
    }

    _saveSectionLayout() {
        const layout = [];
        document.querySelectorAll('.col').forEach(col => {
            const colName = col.dataset.column;
            const sections = [];
            col.querySelectorAll('.draggable-section').forEach(sec => {
                sections.push(sec.dataset.section);
            });
            layout.push({ column: colName, sections });
        });
        try {
            localStorage.setItem('obsSectionLayout', JSON.stringify(layout));
        } catch (e) {
            if (e.name === 'QuotaExceededError') console.warn('[OBS] Quota excedida ao salvar layout');
        }
    }

    _restoreSectionLayout() {
        try {
            const raw = localStorage.getItem('obsSectionLayout');
            if (!raw) return;
            const layout = JSON.parse(raw);
            const sectionMap = {};
            document.querySelectorAll('.draggable-section').forEach(sec => {
                sectionMap[sec.dataset.section] = sec;
            });
            layout.forEach(({ column, sections }) => {
                const col = document.querySelector(`.col[data-column="${column}"]`);
                if (!col) return;
                sections.forEach(id => {
                    const sec = sectionMap[id];
                    if (sec && sec.parentElement !== col) {
                        col.appendChild(sec);
                    }
                });
            });
        } catch (e) { console.warn('[OBS] Erro ao restaurar layout:', e); }
    }

    // ─────────────────────────────────────────
    //  MODAIS
    // ─────────────────────────────────────────
    setupModals() {
        document.getElementById('close-type-modal')?.addEventListener('click', () => this.closeTypeModal());

        document.querySelectorAll('.source-type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.type;
                this.closeTypeModal();
                this.openConfigModal(type);
            });
        });

        document.getElementById('close-config-modal')?.addEventListener('click', () => this.closeConfigModal());
        document.getElementById('cancel-config-btn')  ?.addEventListener('click', () => this.closeConfigModal());
        document.getElementById('confirm-config-btn') ?.addEventListener('click', () => this.confirmSource());

        document.getElementById('modal-source-type')  ?.addEventListener('click', (e) => { if (e.target.id === 'modal-source-type')   this.closeTypeModal(); });
        document.getElementById('modal-source-config')?.addEventListener('click', (e) => { if (e.target.id === 'modal-source-config') this.closeConfigModal(); });
        document.getElementById('modal-audio-filters')?.addEventListener('click', (e) => { if (e.target.id === 'modal-audio-filters') this.closeAudioFilters(); });
    }

    openTypeModal() {
        document.getElementById('modal-source-type').style.display = 'flex';
    }

    closeTypeModal() {
        document.getElementById('modal-source-type').style.display = 'none';
    }

    openConfigModal(type) {
        this.pendingType = type;
        const info = SOURCE_TYPES[type];
        document.getElementById('config-modal-title').textContent = `${info.icon} ${info.label}`;
        document.getElementById('config-modal-body').innerHTML = SOURCE_FORMS[type]();
        this._populateDeviceSelects(document.getElementById('config-modal-body'));
        document.getElementById('modal-source-config').style.display = 'flex';
    }

    closeConfigModal() {
        document.getElementById('modal-source-config').style.display = 'none';
        this.pendingType = null;
    }

    _populateSourceDropdown() {
        const sel = document.getElementById('source-type-select');
        if (!sel) return;
        sel.innerHTML = Object.entries(SOURCE_TYPES).map(([k, v]) =>
            `<option value="${k}">${v.icon} ${v.label}</option>`
        ).join('');
    }

    addFromDropdown() {
        const sel = document.getElementById('source-type-select');
        if (!sel) return;
        const type = sel.value;
        if (type) this.openConfigModal(type);
    }

    // ─────────────────────────────────────────
    //  GERENCIAR CENAS
    // ─────────────────────────────────────────
    get activeScene() {
        return this.scenes.find(s => s.id === this.activeSceneId) || null;
    }

    get currentSources() {
        const scene = this.activeScene;
        return scene ? scene.sources : [];
    }

    createScene(name) {
        if (!name) {
            name = `Cena ${this.scenes.length + 1}`;
        }
        const scene = {
            id: Date.now(),
            name,
            sources: [],
            activeSourceId: null,
        };
        this.scenes.push(scene);
        this.saveData();
        this.renderScenes();
        this.selectScene(scene.id);
        this.showNotification(`📽️ Cena "${name}" criada!`);
    }

    removeScene() {
        const scene = this.activeScene;
        if (!scene) return;
        if (this.scenes.length <= 1) {
            this.showNotification('⚠️ Não é possível remover a única cena');
            return;
        }

        // Para streams da cena
        scene.sources.forEach(s => {
            if (this.mediaStreams[s.id]) {
                this.mediaStreams[s.id].getTracks().forEach(t => t.stop());
                delete this.mediaStreams[s.id];
            }
            this.cleanupAudioChain(s.id);
        });

        this.scenes = this.scenes.filter(s => s.id !== scene.id);
        this.saveData();
        this.renderScenes();
        this.selectScene(this.scenes[0].id);
        this.showNotification('🗑️ Cena removida');
    }

    renameScene(id, newName) {
        const scene = this.scenes.find(s => s.id === id);
        if (!scene) return;
        scene.name = newName.trim() || scene.name;
        this.saveData();
        this.renderScenes();
    }

    selectScene(id) {
        if (this._dragHappened) { this._dragHappened = false; return; }
        if (this._transitioning) return;
        if (this._vereadoresActive && id !== 'vereadores') {
            this._doMultiViewTransition(id);
            return;
        }
        if (this._entrevistasActive && id !== 'entrevistas') {
            this.stopEntrevistas();
        }
        if (id === this.activeSceneId && this.activeScene) {
            this.renderScenePreview();
            return;
        }

        const scene = this.scenes.find(s => s.id === id);
        if (!scene) return;

        const prevSceneId = this.activeSceneId;
        this.activeSceneId = id;
        this.activeSource = scene.activeSourceId || null;
        this.renderScenes();
        this.renderSources();

        // Aplica transição se estiver trocando de cena
        if (prevSceneId !== null && prevSceneId !== id) {
            this.applyTransition(prevSceneId);
        } else {
            this.renderScenePreview();
        }

        this.saveData();
    }

    selectVereadoresScene() {
        if (this._entrevistasActive) this.stopEntrevistas();
        if (!this._vereadoresActive) {
            this._vereadoresActive = true;
            this.activeSceneId = 'vereadores';
            this.activeSource = null;
            this.renderScenes();
            this.renderSources();
            this.renderMultiView();
        }
        this._transitioning = false;
    }

    _doMultiViewTransition(nextSceneId) {
        var pa = document.getElementById('preview-area');
        var grid = document.getElementById('multiview-grid');
        var dur = this.transitionDuration || 300;
        if (grid) {
            grid.style.transition = 'opacity ' + dur + 'ms ease';
            grid.style.opacity = '0';
        }
        var self = this;
        setTimeout(function(){
            self.stopMultiView();
            if (self._transitioning) return;
            self._transitioning = true;
            var scene = self.scenes.find(function(s){ return s.id === nextSceneId; });
            if (!scene) { self._transitioning = false; return; }
            self.activeSceneId = nextSceneId;
            self.activeSource = scene.activeSourceId || null;
            self.renderScenes();
            self.renderSources();
            self.renderScenePreview();
            self.saveData();
            setTimeout(function(){ self._transitioning = false; }, dur);
        }, dur + 50);
    }

    renderMultiView() {
        var previewArea = document.getElementById('preview-area');
        if (!previewArea) return;
        this.clearPreview();
        previewArea.style.backgroundColor = '#0a0a14';

        var container = document.createElement('div');
        container.id = 'multiview-grid';
        container.style.cssText = 'position:absolute;inset:0;display:grid;gap:3px;padding:3px;';
        previewArea.appendChild(container);
        this._multiViewCells = {};
        var pad = function(n){ return String(n).padStart(2,'0'); };
        for (var i = 1; i <= 12; i++) {
            var id = i;
            var label = 'VER' + pad(id);
            var cell = document.createElement('div');
            cell.id = 'mvc-' + id;
            cell.style.cssText = 'position:relative;background:#111;border-radius:4px;overflow:hidden;display:none;border:1px solid #333;';
            var vid = document.createElement('video');
            vid.id = 'mvv-' + id;
            vid.autoplay = true;
            vid.playsInline = true;
            vid.muted = true;
            vid.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;position:relative;z-index:2;';
            cell.appendChild(vid);
            var dot = document.createElement('div');
            dot.style.cssText = 'position:absolute;top:4px;right:4px;width:8px;height:8px;border-radius:50%;background:#4caf50;box-shadow:0 0 4px #4caf50;z-index:3;';
            cell.appendChild(dot);
            var lbl = document.createElement('div');
            lbl.style.cssText = 'position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,.7);color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;z-index:3;';
            lbl.textContent = label;
            cell.appendChild(lbl);
            container.appendChild(cell);
            this._multiViewCells[id] = { cell: cell, vid: vid };
        }
        this._updateMultiViewGrid();
        if (this._vereadoresGridInterval) clearInterval(this._vereadoresGridInterval);
        this._vereadoresGridInterval = setInterval(this._updateMultiViewGrid.bind(this), 2000);
    }

    _updateMultiViewGrid() {
        if (!this._vereadoresActive) return;
        var container = document.getElementById('multiview-grid');
        if (!container) return;
        var connected = [];
        for (var i = 1; i <= 12; i++) {
            var stream = this.vereadorManager && this.vereadorManager.connections ? this.vereadorManager.connections[i] : null;
            var entry = this._multiViewCells[i];
            if (!entry) continue;
            if (stream && stream.active && stream.getVideoTracks().length > 0) {
                entry.cell.style.display = 'flex';
                if (entry.vid.srcObject !== stream) {
                    entry.vid.srcObject = stream;
                }
                connected.push(i);
            } else {
                entry.cell.style.display = 'none';
            }
        }
        var n = connected.length;
        var cols = n === 0 ? 1 : Math.min(n, 4);
        var rows = n === 0 ? 1 : Math.ceil(n / cols);
        container.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
        container.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';
    }

    stopMultiView() {
        this._vereadoresActive = false;
        if (this._vereadoresGridInterval) {
            clearInterval(this._vereadoresGridInterval);
            this._vereadoresGridInterval = null;
        }
        this.clearPreview();
        this.renderScenes();
        this.renderSources();
    }

    selectEntrevistasScene() {
        if (this._vereadoresActive) this.stopMultiView();
        if (!this._entrevistasActive) {
            this._entrevistasActive = true;
            this.activeSceneId = 'entrevistas';
            this.activeSource = null;
            this.renderScenes();
            this.renderSources();
            this.clearPreview();
            const previewArea = document.getElementById('preview-area');
            if (previewArea) {
                const entrevistasSources = [];
                for (const scene of this.scenes) {
                    for (const src of scene.sources) {
                        if (src.type === 'entrevistas') entrevistasSources.push(src);
                    }
                }
                if (entrevistasSources.length > 0) {
                    const src = entrevistasSources[0];
                    this.renderEntrevistasFull(previewArea, src);
                } else {
                    previewArea.innerHTML = '<div style="padding:20px;color:#999;text-align:center;font-size:14px">Crie uma fonte "Entrevistas" em uma cena para usar este layout</div>';
                }
            }
        }
        if (this._entrevistasInterval) clearInterval(this._entrevistasInterval);
        this._entrevistasInterval = setInterval(() => this._refreshEntrevistas(), 2000);
        this._transitioning = false;
    }

    stopEntrevistas() {
        this._entrevistasActive = false;
        if (this._entrevistasInterval) {
            clearInterval(this._entrevistasInterval);
            this._entrevistasInterval = null;
        }
        this.clearPreview();
        this.renderScenes();
        this.renderSources();
    }

    renderEntrevistasFull(container, source) {
        container.innerHTML = '';
        const layout = source.config.layout || 2;
        if (!source.config.screens || source.config.screens.length !== layout) {
            const labels = layout === 2 ? ['CONVIDADO', 'ENTREVISTADOR']
                : layout === 3 ? ['CONVIDADO 1', 'CONVIDADO 2', 'ENTREVISTADOR']
                : ['CONVIDADO 1', 'CONVIDADO 2', 'CONVIDADO 3', 'ENTREVISTADOR'];
            source.config.screens = labels.map((label, i) => ({ id: i, label, type: null, config: {}, slotId: null }));
        }
        const { style: gridStyle } = this._getEntrevistasGridCSS(layout);
        const grid = document.createElement('div');
        grid.className = 'entrevistas-grid entrevistas-full';
        grid.dataset.sourceId = source.id;
        grid.style.cssText = gridStyle;
        source.config.screens.forEach((screen, i) => {
            const cell = this._createEntrevistasCell(screen, i, layout);
            grid.appendChild(cell);
        });
        container.appendChild(grid);
        this._setupEntrevistasDragDrop(grid);
    }

    applyTransition(prevSceneId) {
        const previewArea = document.getElementById('preview-area');
        if (!previewArea) return;

        const dur = this.transitionDuration;

        if (this.transitionType === 'fade') {
            this._transitioning = true;
            previewArea.style.setProperty('--transition-duration', dur + 'ms');
            previewArea.classList.add('transition-fade');
            this.renderScenePreview();
            setTimeout(() => {
                previewArea.classList.remove('transition-fade');
                this._transitioning = false;
            }, dur);
        } else {
            this.renderScenePreview();
        }
    }

    renderScenes() {
        const list = document.getElementById('scenes-list');
        if (!list) return;

        var vereadoresActive = this._vereadoresActive ? 'active' : '';
        var vereadoresHtml = '<div class="scene-item scene-vereadores ' + vereadoresActive + '" data-id="vereadores">' +
            '<span class="scene-name" title="VEREADORES">👥 VEREADORES</span>' +
        '</div>';

        var entrevistasActive = this._entrevistasActive ? 'active' : '';
        var entrevistasHtml = '<div class="scene-item scene-entrevistas ' + entrevistasActive + '" data-id="entrevistas">' +
            '<span class="scene-name" title="ENTREVISTAS">🎙️ ENTREVISTAS</span>' +
        '</div>';

        if (this.scenes.length === 0) {
            list.innerHTML = vereadoresHtml + entrevistasHtml + '<p>Nenhuma cena</p>';
            document.getElementById('remove-scene-btn').disabled = true;
            this._setupSceneListEvents(list);
            return;
        }

        list.innerHTML = vereadoresHtml + entrevistasHtml + this.scenes.map(s => `
            <div class="scene-item ${this.activeSceneId === s.id ? 'active' : ''}" data-id="${s.id}" draggable="true">
                <span class="drag-handle">⠿</span>
                <span class="scene-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
                <button class="scene-rename-btn" title="Renomear">✎</button>
            </div>
        `).join('');

        document.getElementById('remove-scene-btn').disabled = this.scenes.length <= 1;
        this._setupDragDrop(list, 'scene');
        this._setupSceneListEvents(list);
    }

    promptRenameScene(id) {
        const scene = this.scenes.find(s => s.id === id);
        if (!scene) return;
        const newName = prompt('Renomear cena:', scene.name);
        if (newName && newName.trim()) {
            this.renameScene(id, newName.trim());
        }
    }

    // ─────────────────────────────────────────
    //  CONFIRMAR ADIÇÃO DE FONTE
    // ─────────────────────────────────────────
    async confirmSource() {
        const type = this.pendingType;
        if (!type) return;

        const scene = this.activeScene;
        if (!scene) {
            this.showNotification('⚠️ Selecione ou crie uma cena primeiro');
            return;
        }

        const nameEl = document.getElementById('src-name');
        const name   = nameEl ? nameEl.value.trim() || SOURCE_TYPES[type].label : SOURCE_TYPES[type].label;

        const source = {
            id:      Date.now(),
            type,
            name,
            icon:    SOURCE_TYPES[type].icon,
            visible: true,
            config:  this.collectConfig(type),
        };

        this.closeConfigModal();

        try {
            await this.activateSource(source);
        } catch (err) {
            console.error('Erro ao ativar fonte:', err);
            this.showNotification(`❌ Erro: ${err.message}`);
            return;
        }

        scene.sources.push(source);
        scene.activeSourceId = source.id;
        this.activeSource = source.id;
        await this.saveData();
        this.renderSources();
        this.renderAudioMixer();
        this.showNotification(`${source.icon} Fonte "${source.name}" adicionada!`);
    }

    _validateString(val, maxLen = 256) {
        if (typeof val !== 'string') return '';
        return val.trim().substring(0, maxLen);
    }

    _validateNumber(val, min, max, def) {
        const n = parseInt(val);
        if (isNaN(n)) return def;
        return Math.max(min, Math.min(max, n));
    }

    _validateColor(val) {
        if (/^#[0-9a-fA-F]{6}$/.test(val)) return val;
        return '#000000';
    }

    collectConfig(type) {
        const g = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
        const fileInput = (id) => { const el = document.getElementById(id); return el && el.files ? el.files : null; };
        switch (type) {
            case 'camera':  return {
                deviceId: g('src-device') || '',
                width: this._validateNumber(g('src-width'), 320, 7680, 1920),
                height: this._validateNumber(g('src-height'), 240, 4320, 1080),
            };
            case 'screen':  return {
                width: this._validateNumber(g('src-width'), 320, 7680, 1920),
                height: this._validateNumber(g('src-height'), 240, 4320, 1080),
            };
            case 'window':  return {
                width: this._validateNumber(g('src-width'), 320, 7680, 1920),
                height: this._validateNumber(g('src-height'), 240, 4320, 1080),
            };
            case 'image':   return { file: this.getImageDataUrl() };
            case 'text':    return {
                text: this._validateString(g('src-text'), 2000),
                color: this._validateColor(g('src-color')),
                fontSize: this._validateNumber(g('src-fontsize'), 10, 200, 48),
                bg: this._validateColor(g('src-bg')),
            };
            case 'audio':   return { deviceId: g('src-device') || 'default' };
            case 'browser': return {
                url: this._validateString(g('src-url'), 2048),
                width: this._validateNumber(g('src-width'), 320, 7680, 1280),
                height: this._validateNumber(g('src-height'), 240, 4320, 720),
            };
            case 'color':   return { color: this._validateColor(g('src-color')) };
            case 'slideshow': return {
                files: fileInput('src-slideshow-files'),
                interval: this._validateNumber(g('src-slideshow-interval'), 500, 30000, 3000),
                transition: ['fade', 'cut'].includes(g('src-slideshow-transition')) ? g('src-slideshow-transition') : 'fade',
            };
            case 'gameCapture': return {
                mode: g('src-game-mode') || 'any',
                width: this._validateNumber(g('src-width'), 320, 7680, 1920),
                height: this._validateNumber(g('src-height'), 240, 4320, 1080),
            };
            case 'audioOutputCapture': return {};
            case 'videoCaptureDevice': return {
                deviceId: g('src-video-device') || '',
                width: this._validateNumber(g('src-video-width'), 320, 7680, 1920),
                height: this._validateNumber(g('src-video-height'), 240, 4320, 1080),
            };
            case 'media':   return {
                file: this.getMediaFile(),
                loop: g('src-media-loop') === 'true',
                autoplay: g('src-media-autoplay') === 'true',
            };
            case 'vereador': return {
                nome: this._validateString(g('src-vereador-name'), 100),
                photo: this.getVereadorPhoto(),
                color: this._validateColor(g('src-vereador-color')),
                bg: this._validateColor(g('src-vereador-bg')),
            };
            case 'vereadores': return {
                cols: parseInt(document.getElementById('src-ver-grid-cols')?.value) || 3,
            };
            case 'entrevistas': return {
                layout: parseInt(document.getElementById('src-entrevistas-layout')?.value) || 2,
                screens: [], // array of { slotId: null | number, label: string } — preenchido na renderização
            };
            default:        return {};
        }
    }

    getImageDataUrl() {
        const fileInput = document.getElementById('src-file');
        if (!fileInput || !fileInput.files[0]) return null;
        return fileInput.files[0];
    }

    getMediaFile() {
        const fileInput = document.getElementById('src-media-file');
        if (!fileInput || !fileInput.files[0]) return null;
        return fileInput.files[0];
    }

    getVereadorPhoto() {
        const fileInput = document.getElementById('src-vereador-photo');
        if (!fileInput || !fileInput.files[0]) return null;
        return fileInput.files[0];
    }

    // ─────────────────────────────────────────
    //  ATIVAR FONTE (renderiza no preview)
    // ─────────────────────────────────────────
    async activateSource(source) {
        const previewArea = document.getElementById('preview-area');
        if (!previewArea) return;

        // Se já é a fonte ativa e tem stream no preview, não reativa
        if (source.id === this.activeSource && this.mediaStreams[source.id]) {
            const existing = previewArea.querySelector('#preview-video');
            if (existing && existing.srcObject === this.mediaStreams[source.id]) {
                return;
            }
        }

        this.clearPreview();

        switch (source.type) {
            case 'camera': {
                let camConstraints = { video: { width: { ideal: source.config.width || 1920 }, height: { ideal: source.config.height || 1080 } }, audio: true };
                if (source.config.deviceId) {
                    camConstraints.video.deviceId = { exact: source.config.deviceId };
                }
                let stream;
                try {
                    stream = await navigator.mediaDevices.getUserMedia(camConstraints);
                } catch (camErr) {
                    if (camErr.name === 'OverconstrainedError' && source.config.deviceId) {
                        delete camConstraints.video.deviceId;
                        stream = await navigator.mediaDevices.getUserMedia(camConstraints);
                    } else {
                        throw camErr;
                    }
                }
                this.mediaStreams[source.id] = stream;

                const video = this.createVideoEl('preview-video', stream, true, false);
                previewArea.appendChild(video);
                this.setupAudioChain(source.id, stream);
                break;
            }

            case 'screen':
            case 'window': {
                const displayConstraints = {
                    video: {
                        width: { ideal: source.config.width || 1920 },
                        height: { ideal: source.config.height || 1080 },
                    },
                    audio: true,
                };
                const stream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
                this.mediaStreams[source.id] = stream;
                const video = this.createVideoEl('preview-video', stream, false, false);
                previewArea.appendChild(video);
                this.setupAudioChain(source.id, stream);
                break;
            }

            case 'image': {
                let url = source.config.file;
                if (url instanceof File || (!url && document.getElementById('src-file')?.files[0])) {
                    const file = url instanceof File ? url : document.getElementById('src-file').files[0];
                    url = URL.createObjectURL(file);
                    this._objectUrls[source.id] = url;
                } else if (!url) {
                    throw new Error('Nenhuma imagem selecionada');
                }
                const img = document.createElement('img');
                img.src = url;
                img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
                previewArea.appendChild(img);
                break;
            }

            case 'text': {
                const div = document.createElement('div');
                div.className = 'source-text-overlay';
                div.style.color      = source.config.color      || '#fff';
                div.style.fontSize   = (source.config.fontSize  || 48) + 'px';
                div.style.background = source.config.bg         || '#000';
                div.textContent      = source.config.text       || '';
                previewArea.appendChild(div);
                break;
            }

            case 'audio': {
                const audioConstraints = { audio: true, video: false };
                if (source.config.deviceId && source.config.deviceId !== 'default') {
                    audioConstraints.audio = { deviceId: { exact: source.config.deviceId } };
                }
                const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
                this.mediaStreams[source.id] = stream;
                this.renderAudioVisualizer(previewArea, stream);
                this.setupAudioChain(source.id, stream);
                break;
            }

            case 'browser': {
                const iframe = document.createElement('iframe');
                iframe.src = source.config.url || 'https:' + '//example.com';
                iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;';
                iframe.sandbox = 'allow-scripts allow-same-origin allow-forms';
                previewArea.appendChild(iframe);
                break;
            }

            case 'color': {
                previewArea.style.backgroundColor = source.config.color || '#1a1a2e';
                break;
            }

            case 'slideshow': {
                let files = source.config.files;
                if (!files || files.length === 0) {
                    this.showNotification('⚠️ Nenhuma imagem selecionada para o slideshow');
                    break;
                }
                const slideshowContainer = document.createElement('div');
                slideshowContainer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
                previewArea.appendChild(slideshowContainer);
                const imgEl = document.createElement('img');
                imgEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
                slideshowContainer.appendChild(imgEl);
                let currentSlide = 0;
                let slideUrls = [];
                const loadNextSlide = async () => {
                    if (slideUrls.length === 0) return;
                    currentSlide = (currentSlide + 1) % slideUrls.length;
                    imgEl.src = slideUrls[currentSlide];
                };
                const loadSlides = async () => {
                    if (typeof files === 'string') {
                        slideUrls = JSON.parse(files);
                    } else {
                        var blobUrls = this._objectUrls[source.id];
                        if (blobUrls) blobUrls.forEach(function(u){ URL.revokeObjectURL(u); });
                        blobUrls = [];
                        for (const file of files) {
                            const url = file instanceof File ? URL.createObjectURL(file) : file;
                            blobUrls.push(url);
                            slideUrls.push(url);
                        }
                        this._objectUrls[source.id] = blobUrls;
                    }
                    if (slideUrls.length > 0) {
                        imgEl.src = slideUrls[0];
                        if (slideUrls.length > 1) {
                            source._slideshowInterval = setInterval(loadNextSlide, source.config.interval || 3000);
                        }
                    }
                };
                loadSlides();
                break;
            }

            case 'gameCapture': {
                const gameConstraints = {
                    video: {
                        cursor: 'always',
                        width: { ideal: source.config.width || 1920 },
                        height: { ideal: source.config.height || 1080 },
                    },
                    audio: true,
                };
                const stream = await navigator.mediaDevices.getDisplayMedia(gameConstraints);
                this.mediaStreams[source.id] = stream;
                const video = this.createVideoEl('preview-video', stream, false, false);
                previewArea.appendChild(video);
                this.setupAudioChain(source.id, stream);
                break;
            }

            case 'audioOutputCapture': {
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: { width: 1, height: 1 },
                    audio: true,
                });
                stream.getVideoTracks().forEach(t => t.stop());
                this.mediaStreams[source.id] = stream;
                this.renderAudioVisualizer(previewArea, stream);
                this.setupAudioChain(source.id, stream);
                break;
            }

            case 'videoCaptureDevice': {
                let vcdConstraints = {
                    video: {
                        width: { ideal: source.config.width || 1920 },
                        height: { ideal: source.config.height || 1080 },
                    },
                    audio: false,
                };
                if (source.config.deviceId) {
                    vcdConstraints.video.deviceId = { exact: source.config.deviceId };
                }
                let stream;
                try {
                    stream = await navigator.mediaDevices.getUserMedia(vcdConstraints);
                } catch (vcdErr) {
                    if (vcdErr.name === 'OverconstrainedError' && source.config.deviceId) {
                        delete vcdConstraints.video.deviceId;
                        stream = await navigator.mediaDevices.getUserMedia(vcdConstraints);
                    } else {
                        throw vcdErr;
                    }
                }
                this.mediaStreams[source.id] = stream;
                const video = this.createVideoEl('preview-video', stream, false, true);
                previewArea.appendChild(video);
                // Re-captura automática se o dispositivo for desconectado e reconectado
                stream.getVideoTracks()[0]?.addEventListener('ended', () => {
                    setTimeout(() => {
                        if (this.activeSource === source.id) {
                            delete this.mediaStreams[source.id];
                            this.activateSource(source).catch(() => {});
                        }
                    }, 2000);
                });
                break;
            }

            case 'media': {
                let file = source.config.file;
                if (file instanceof File || (!file && document.getElementById('src-media-file')?.files[0])) {
                    file = file instanceof File ? file : document.getElementById('src-media-file').files[0];
                    const url = URL.createObjectURL(file);
                    this._objectUrls[source.id] = url;
                    file = url;
                } else if (!file) {
                    throw new Error('Nenhum arquivo de mídia selecionado');
                }
                const video = document.createElement('video');
                video.src = file;
                video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
                video.loop = source.config.loop !== false;
                video.autoplay = source.config.autoplay === true;
                video.controls = true;
                video.muted = false;
                previewArea.appendChild(video);
                video.play().catch(function(e){
                    if (e.name === 'NotAllowedError') {
                        video.muted = true;
                        video.play().catch(function(){});
                    }
                });
                break;
            }

            case 'vereador': {
                const container = document.createElement('div');
                container.style.cssText = `
                    position:absolute;inset:0;width:100%;height:100%;
                    display:flex;flex-direction:column;align-items:center;justify-content:center;
                    background: ${source.config.bg || '#1a1a2e'};
                    font-family: 'Segoe UI', sans-serif;
                    padding: 20px;
                `;
                const photoFile = source.config.photo;
                let photoUrl = source.config.photo;
                if (photoFile instanceof File) {
                    photoUrl = await this.readFileAsDataURL(photoFile);
                    source.config.photo = photoUrl;
                }
                if (photoUrl) {
                    const img = document.createElement('img');
                    img.src = photoUrl;
                    img.style.cssText = `
                        width: 120px; height: 120px; border-radius: 50%;
                        object-fit: cover; border: 3px solid #0066cc;
                        margin-bottom: 16px;
                    `;
                    container.appendChild(img);
                }
                const nome = document.createElement('div');
                nome.textContent = source.config.nome || 'Vereador';
                nome.style.cssText = `
                    font-size: 2em; font-weight: 700;
                    color: ${source.config.color || '#fff'};
                    text-align: center; margin-bottom: 8px;
                `;
                container.appendChild(nome);
                previewArea.appendChild(container);
                break;
            }

            case 'vereadores': {
                const vm = this.vereadorManager;
                const connected = [];
                if (vm && vm.connections) {
                    for (let i = 1; i <= 12; i++) {
                        const s = vm.connections[i];
                        if (s && s.active && s.getVideoTracks().length > 0) connected.push(i);
                    }
                }
                const n = connected.length;
                const cols = n === 0 ? 1 : Math.min(n, 4);
                const rows = n === 0 ? 1 : Math.ceil(n / cols);
                const grid = document.createElement('div');
                grid.className = 'ver-grid-source';
                grid.style.cssText = `position:absolute;inset:0;width:100%;height:100%;display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);gap:2px;padding:2px;`;
                for (let i = 0; i < 12; i++) {
                    const cell = document.createElement('div');
                    cell.style.cssText = 'display:flex;align-items:center;justify-content:center;overflow:hidden;background:#0a0a14;border-radius:2px;' + (i < n ? '' : 'display:none;');
                    const video = document.createElement('video');
                    video.autoplay = true;
                    video.playsinline = true;
                    video.muted = true;
                    video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
                    cell.appendChild(video);
                    grid.appendChild(cell);
                }
                previewArea.appendChild(grid);
                this._verGridSource = grid;
                this._verGridSourceId = source.id;
                this._refreshVereadoresRandom(grid);
                break;
            }

            case 'entrevistas': {
                const layout = source.config.layout || 2;
                const labels = layout === 2 ? ['CONVIDADO', 'ENTREVISTADOR']
                    : layout === 3 ? ['CONVIDADO 1', 'CONVIDADO 2', 'ENTREVISTADOR']
                    : ['CONVIDADO 1', 'CONVIDADO 2', 'CONVIDADO 3', 'ENTREVISTADOR'];
                if (!source.config.screens || source.config.screens.length !== layout) {
                    source.config.screens = labels.map((label, i) => ({
                        id: i,
                        label,
                        type: null,
                        config: {},
                        slotId: null,
                    }));
                }
                const { style: gridStyle } = this._getEntrevistasGridCSS(layout);
                const grid = document.createElement('div');
                grid.className = 'entrevistas-grid';
                grid.dataset.sourceId = source.id;
                grid.style.cssText = gridStyle;
                source.config.screens.forEach((screen, i) => {
                    const cell = this._createEntrevistasCell(screen, i, layout);
                    grid.appendChild(cell);
                });
                previewArea.appendChild(grid);
                this._entrevistasSourceId = source.id;
                this._setupEntrevistasDragDrop(grid);
                break;
            }
        }
        // Chroma Key: se ativo na fonte, substitui preview por canvas
        const videoEl = document.getElementById('preview-video');
        if (videoEl && source.chromaKey?.enabled) {
            this._replaceWithChromaCanvas(source, videoEl, previewArea);
        }
    }

    refreshVereadoresSource() {
        const grid = this._verGridSource;
        if (!grid) return;
        this._refreshVereadoresRandom(grid);
    }

    _refreshVereadoresRandom(grid) {
        const vm = this.vereadorManager;
        const connected = [];
        for (let i = 1; i <= 12; i++) {
            const s = vm && vm.connections ? vm.connections[i] : null;
            if (s && s.active && s.getVideoTracks().length > 0) connected.push(s);
        }
        for (let i = connected.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [connected[i], connected[j]] = [connected[j], connected[i]];
        }
        for (let i = 0; i < 12; i++) {
            const cell = grid.children[i];
            if (!cell) continue;
            const video = cell.querySelector('video');
            if (!video) continue;
            const stream = connected[i] || null;
            if (stream && video.srcObject !== stream) {
                video.srcObject = stream;
                video.play().catch(() => {});
            } else if (!stream && video.srcObject) {
                video.srcObject = null;
            }
        }
    }

    _getEntrevistasGridCSS(layout) {
        const base = 'position:absolute;inset:0;width:100%;height:100%;display:grid;gap:4px;padding:4px;';
        if (layout === 3) {
            return { style: base + 'grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;', cols: 2, rows: 2 };
        }
        if (layout === 2) {
            return { style: base + 'grid-template-columns:1fr 1fr;grid-template-rows:1fr;', cols: 2, rows: 1 };
        }
        return { style: base + 'grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;', cols: 2, rows: 2 };
    }

    _createEntrevistasCell(screen, index, layout) {
        const cell = document.createElement('div');
        cell.className = 'entrevistas-cell';
        cell.dataset.screenId = index;
        const isConvidado = layout === 3 && index < 2;
        const isEntrevistador = layout === 3 && index === 2;
        let cellCSS = 'position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;border-radius:6px;border:1px solid #333;cursor:grab;';
        if (isConvidado) {
            cellCSS += 'background:transparent;aspect-ratio:1/1;';
        } else if (isEntrevistador) {
            cellCSS += 'background:#0a0a14;grid-column:2;grid-row:span 2;';
        } else {
            cellCSS += 'background:#0a0a14;';
        }
        cell.style.cssText = cellCSS;

        if (screen.type === 'vereador') {
            const video = document.createElement('video');
            video.autoplay = true;
            video.playsinline = true;
            video.muted = true;
            video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
            cell.appendChild(video);
            const slotId = screen.slotId;
            if (slotId) {
                const stream = this.vereadorManager?.connections?.[slotId];
                if (stream && stream.active) {
                    video.srcObject = stream;
                    video.play().catch(() => {});
                }
            }
        } else if (screen.type === 'webcam' || screen.type === 'camera') {
            const video = document.createElement('video');
            video.autoplay = true;
            video.playsinline = true;
            video.muted = true;
            video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
            cell.appendChild(video);
            const deviceId = screen.config?.deviceId;
            if (deviceId) {
                this._startEntrevistasCamera(screen, video);
            } else {
                const empty = document.createElement('div');
                empty.style.cssText = 'color:#666;font-size:13px;text-align:center;padding:8px;pointer-events:none;z-index:2;';
                empty.textContent = screen.label + '\n(sem câmera)';
                cell.appendChild(empty);
            }
        } else if (screen.type === 'image') {
            const img = document.createElement('img');
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;';
            if (screen.config?.url) {
                img.src = screen.config.url;
            } else {
                img.style.display = 'none';
            }
            cell.appendChild(img);
            if (!screen.config?.url) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color:#666;font-size:13px;text-align:center;padding:8px;pointer-events:none;z-index:2;';
                empty.textContent = screen.label + '\n(sem imagem)';
                cell.appendChild(empty);
            }
        } else if (screen.type === 'video' || screen.type === 'media') {
            const video = document.createElement('video');
            video.autoplay = true;
            video.playsinline = true;
            video.muted = true;
            video.controls = false;
            video.loop = true;
            video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
            if (screen.config?.url) {
                video.src = screen.config.url;
            }
            cell.appendChild(video);
            if (!screen.config?.url) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color:#666;font-size:13px;text-align:center;padding:8px;pointer-events:none;z-index:2;';
                empty.textContent = screen.label + '\n(sem arquivo)';
                cell.appendChild(empty);
            }
        } else if (screen.type === 'document') {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
            if (screen.config?.url) {
                iframe.src = screen.config.url;
            }
            cell.appendChild(iframe);
            if (!screen.config?.url) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color:#666;font-size:13px;text-align:center;padding:8px;pointer-events:none;z-index:2;';
                empty.textContent = screen.label + '\n(sem documento)';
                cell.appendChild(empty);
            }
        } else if (screen.type === 'color') {
            const div = document.createElement('div');
            div.style.cssText = 'width:100%;height:100%;display:block;';
            if (screen.config?.color) {
                div.style.background = screen.config.color;
            }
            cell.appendChild(div);
        } else {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:#666;font-size:13px;text-align:center;padding:8px;pointer-events:none;z-index:2;white-space:pre-line;';
            empty.textContent = screen.label + '\n(clique 2x para\nconfigurar)';
            cell.appendChild(empty);
            cell.style.justifyContent = 'center';
        }

        const lbl = document.createElement('div');
        lbl.style.cssText = 'position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,.7);color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;z-index:2;pointer-events:none;';
        lbl.textContent = screen.type ? screen.label + ' [' + screen.type.toUpperCase() + ']' : screen.label;
        cell.appendChild(lbl);
        return cell;
    }

    _startEntrevistasCamera(screen, videoEl) {
        const deviceId = screen.config?.deviceId;
        if (!deviceId) return;
        const constraints = { video: { deviceId: { exact: deviceId }, width: 1280, height: 720 }, audio: false };
        navigator.mediaDevices.getUserMedia(constraints).then(stream => {
            if (videoEl) {
                videoEl.srcObject = stream;
                videoEl.play().catch(() => {});
            }
            screen._stream = stream;
        }).catch(() => {
            navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false }).then(stream => {
                if (videoEl) {
                    videoEl.srcObject = stream;
                    videoEl.play().catch(() => {});
                }
                screen._stream = stream;
            }).catch(() => {});
        });
    }

    _setupEntrevistasDragDrop(grid) {
        const cells = grid.querySelectorAll('.entrevistas-cell');
        let dragIndex = null;

        const onDragStart = (e) => {
            const cell = e.currentTarget;
            dragIndex = parseInt(cell.dataset.screenId);
            cell.style.opacity = '0.5';
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(dragIndex));
        };
        const onDragEnd = (e) => {
            e.currentTarget.style.opacity = '';
        };
        const onDragOver = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        };
        const onDrop = (e) => {
            e.preventDefault();
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
            const toCell = e.currentTarget;
            const toIdx = parseInt(toCell.dataset.screenId);
            if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
            const sourceId = parseInt(grid.dataset.sourceId);
            const source = this._findSource(sourceId);
            if (!source || !source.config.screens) return;
            const screens = source.config.screens;
            [screens[fromIdx], screens[toIdx]] = [screens[toIdx], screens[fromIdx]];
            for (let i = 0; i < screens.length; i++) screens[i].id = i;
            if (this._entrevistasActive) {
                const pa = document.getElementById('preview-area');
                if (pa) this.renderEntrevistasFull(pa, source);
            } else {
                this.renderScenePreview();
            }
            this.saveData();
        };

        cells.forEach(cell => {
            cell.draggable = true;
            cell.addEventListener('dragstart', onDragStart);
            cell.addEventListener('dragend', onDragEnd);
            cell.addEventListener('dragover', onDragOver);
            cell.addEventListener('drop', onDrop);

            // Double-click to assign a source
            cell.addEventListener('dblclick', (e) => {
                e.preventDefault();
                const g = e.currentTarget.closest('.entrevistas-grid');
                const srcId = parseInt(g ? g.dataset.sourceId : grid.dataset.sourceId);
                const screenId = parseInt(e.currentTarget.dataset.screenId);
                this._showEntrevistasSourceEditor(srcId, screenId, grid);
            });
        });
    }

    _showEntrevistasSourceEditor(sourceId, screenId, grid) {
        const source = this._findSource(sourceId);
        if (!source || !source.config.screens) return;
        const screen = source.config.screens[screenId];
        const self = this;

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9998;';
        const menu = document.createElement('div');
        menu.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;border:1px solid #444;border-radius:8px;padding:16px;z-index:9999;min-width:280px;max-width:90vw;max-height:80vh;overflow-y:auto;';
        overlay.addEventListener('click', () => { menu.remove(); overlay.remove(); });

        function renderTypePicker() {
            menu.innerHTML = '';
            const title = document.createElement('div');
            title.textContent = screen.label + ' — escolha o tipo:';
            title.style.cssText = 'color:#fff;font-weight:700;margin-bottom:12px;font-size:14px;';
            menu.appendChild(title);

            const types = [
                { id: 'vereador', label: '👤 VEREADOR', desc: 'Stream de vereador conectado' },
                { id: 'webcam', label: '📷 WEBCAM', desc: 'Câmera USB/webcam' },
                { id: 'camera', label: '📱 CÂMERA', desc: 'Câmera do dispositivo' },
                { id: 'video', label: '🎬 VÍDEO', desc: 'Arquivo de vídeo (URL)' },
                { id: 'image', label: '🖼️ IMAGEM', desc: 'Arquivo de imagem (URL)' },
                { id: 'document', label: '📄 DOCUMENTO (PDF)', desc: 'Documento PDF (URL)' },
                { id: 'media', label: '🎵 MÍDIA', desc: 'Arquivo de mídia (URL)' },
                { id: 'color', label: '🎨 COR', desc: 'Cor sólida' },
            ];

            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
            types.forEach(t => {
                const btn = document.createElement('button');
                btn.innerHTML = t.label + '<br><span style="font-size:11px;color:#999">' + t.desc + '</span>';
                btn.style.cssText = 'background:#2a2a4e;color:#fff;border:1px solid #555;border-radius:4px;padding:8px 12px;cursor:pointer;text-align:left;line-height:1.4;';
                btn.addEventListener('click', () => {
                    screen.type = t.id;
                    screen.config = {};
                    screen.slotId = null;
                    if (screen._stream) {
                        screen._stream.getTracks().forEach(t => t.stop());
                        delete screen._stream;
                    }
                    if (t.id === 'vereador') renderVereadorPicker();
                    else renderConfigForm(t.id);
                });
                list.appendChild(btn);
            });

            if (screen.type) {
                const resetBtn = document.createElement('button');
                resetBtn.textContent = '✕ REMOVER FONTE';
                resetBtn.style.cssText = 'background:#4a1a1a;color:#fff;border:1px solid #a33;border-radius:4px;padding:8px 12px;cursor:pointer;margin-top:8px;text-align:center;width:100%;';
                resetBtn.addEventListener('click', () => {
                    screen.type = null;
                    screen.config = {};
                    screen.slotId = null;
                    if (screen._stream) {
                        screen._stream.getTracks().forEach(t => t.stop());
                        delete screen._stream;
                    }
                    self._recreateEntrevistasCell(sourceId, screenId, grid);
                    self.saveData();
                    menu.remove();
                    overlay.remove();
                });
                list.appendChild(resetBtn);
            }

            menu.appendChild(list);
        }

        function renderVereadorPicker() {
            menu.innerHTML = '';
            const vm = self.vereadorManager;
            const connectedSlots = [];
            for (let i = 1; i <= 12; i++) {
                if (vm && vm.connections && vm.connections[i] && vm.connections[i].active) {
                    connectedSlots.push(i);
                }
            }
            const title = document.createElement('div');
            title.textContent = 'Selecionar VEREADOR:';
            title.style.cssText = 'color:#fff;font-weight:700;margin-bottom:12px;font-size:14px;';
            menu.appendChild(title);

            if (connectedSlots.length === 0) {
                const msg = document.createElement('div');
                msg.textContent = 'Nenhum vereador conectado';
                msg.style.cssText = 'color:#999;padding:8px;';
                menu.appendChild(msg);
            } else {
                const list = document.createElement('div');
                list.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-height:250px;overflow-y:auto;';
                connectedSlots.forEach(slotId => {
                    const name = vm.nomes?.[slotId] || `Vereador ${slotId}`;
                    const btn = document.createElement('button');
                    btn.textContent = `👤 ${name}`;
                    btn.style.cssText = 'background:#2a2a4e;color:#fff;border:1px solid #555;border-radius:4px;padding:6px 12px;cursor:pointer;text-align:left;';
                    btn.addEventListener('click', () => {
                        screen.slotId = slotId;
                        self._recreateEntrevistasCell(sourceId, screenId, grid);
                        self.saveData();
                        menu.remove();
                        overlay.remove();
                    });
                    list.appendChild(btn);
                });
                menu.appendChild(list);
            }

            const backBtn = document.createElement('button');
            backBtn.textContent = '⬅ VOLTAR';
            backBtn.style.cssText = 'background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:6px 12px;cursor:pointer;margin-top:8px;width:100%;';
            backBtn.addEventListener('click', renderTypePicker);
            menu.appendChild(backBtn);
        }

        function renderConfigForm(type) {
            menu.innerHTML = '';
            const title = document.createElement('div');
            const typeLabels = { webcam: 'WEBCAM', camera: 'CÂMERA', video: 'VÍDEO', image: 'IMAGEM', document: 'DOCUMENTO (PDF)', media: 'MÍDIA' };
            title.textContent = screen.label + ' — configurar ' + (typeLabels[type] || type);
            title.style.cssText = 'color:#fff;font-weight:700;margin-bottom:12px;font-size:14px;';
            menu.appendChild(title);

            if (type === 'webcam' || type === 'camera') {
                const label = document.createElement('div');
                label.textContent = 'Selecione a câmera:';
                label.style.cssText = 'color:#ccc;margin-bottom:6px;font-size:12px;';
                menu.appendChild(label);
                const select = document.createElement('select');
                select.style.cssText = 'width:100%;padding:6px;border-radius:4px;border:1px solid #555;background:#2a2a4e;color:#fff;margin-bottom:8px;';
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = '— selecione —';
                select.appendChild(placeholder);
                if (self._devices?.videoinput) {
                    self._devices.videoinput.forEach(d => {
                        const opt = document.createElement('option');
                        opt.value = d.deviceId;
                        opt.textContent = d.label || `Câmera ${d.deviceId.slice(0, 8)}`;
                        if (d.deviceId === screen.config?.deviceId) opt.selected = true;
                        select.appendChild(opt);
                    });
                }
                menu.appendChild(select);
                const saveBtn = document.createElement('button');
                saveBtn.textContent = '✅ APLICAR';
                saveBtn.style.cssText = 'background:#0066cc;color:#fff;border:none;border-radius:4px;padding:8px 16px;cursor:pointer;width:100%;margin-top:4px;';
                saveBtn.addEventListener('click', () => {
                    screen.config.deviceId = select.value;
                    self._recreateEntrevistasCell(sourceId, screenId, grid);
                    self.saveData();
                    menu.remove();
                    overlay.remove();
                });
                menu.appendChild(saveBtn);
            } else if (type === 'color') {
                const label = document.createElement('div');
                label.textContent = 'Escolha a cor:';
                label.style.cssText = 'color:#ccc;margin-bottom:6px;font-size:12px;';
                menu.appendChild(label);
                const picker = document.createElement('input');
                picker.type = 'color';
                picker.value = screen.config?.color || '#0066cc';
                picker.style.cssText = 'width:100%;height:48px;border:1px solid #555;border-radius:4px;background:#2a2a4e;cursor:pointer;margin-bottom:8px;';
                menu.appendChild(picker);
                const saveBtn = document.createElement('button');
                saveBtn.textContent = '✅ APLICAR';
                saveBtn.style.cssText = 'background:#0066cc;color:#fff;border:none;border-radius:4px;padding:8px 16px;cursor:pointer;width:100%;margin-top:4px;';
                saveBtn.addEventListener('click', () => {
                    screen.config.color = picker.value;
                    self._recreateEntrevistasCell(sourceId, screenId, grid);
                    self.saveData();
                    menu.remove();
                    overlay.remove();
                });
                menu.appendChild(saveBtn);
            } else {
                const label = document.createElement('div');
                label.textContent = 'URL do arquivo:';
                label.style.cssText = 'color:#ccc;margin-bottom:6px;font-size:12px;';
                menu.appendChild(label);
                const input = document.createElement('input');
                input.type = 'text';
                input.placeholder = 'https://...';
                input.value = screen.config?.url || '';
                input.style.cssText = 'width:100%;padding:6px;border-radius:4px;border:1px solid #555;background:#2a2a4e;color:#fff;margin-bottom:8px;box-sizing:border-box;';
                menu.appendChild(input);
                const saveBtn = document.createElement('button');
                saveBtn.textContent = '✅ APLICAR';
                saveBtn.style.cssText = 'background:#0066cc;color:#fff;border:none;border-radius:4px;padding:8px 16px;cursor:pointer;width:100%;margin-top:4px;';
                saveBtn.addEventListener('click', () => {
                    screen.config.url = input.value.trim() || null;
                    self._recreateEntrevistasCell(sourceId, screenId, grid);
                    self.saveData();
                    menu.remove();
                    overlay.remove();
                });
                menu.appendChild(saveBtn);
            }

            const backBtn = document.createElement('button');
            backBtn.textContent = '⬅ VOLTAR';
            backBtn.style.cssText = 'background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:6px 12px;cursor:pointer;margin-top:8px;width:100%;';
            backBtn.addEventListener('click', renderTypePicker);
            menu.appendChild(backBtn);
        }

        document.body.appendChild(overlay);
        document.body.appendChild(menu);
        renderTypePicker();
    }

    _recreateEntrevistasCell(sourceId, screenId, grid) {
        const source = this._findSource(sourceId);
        if (!source || !source.config.screens) return;
        const screen = source.config.screens[screenId];
        const layout = source.config.layout || 2;
        const oldCell = grid.querySelector(`.entrevistas-cell[data-screen-id="${screenId}"]`);
        const newCell = this._createEntrevistasCell(screen, screenId, layout);
        if (oldCell && newCell) {
            grid.replaceChild(newCell, oldCell);
            this._setupEntrevistasDragDrop(grid);
        }
    }

    _refreshEntrevistas() {
        const grids = document.querySelectorAll('.entrevistas-grid');
        grids.forEach(grid => {
            const sourceId = parseInt(grid.dataset.sourceId);
            const source = this._findSource(sourceId);
            if (!source || !source.config.screens) return;
            source.config.screens.forEach(screen => {
                const cell = grid.querySelector(`.entrevistas-cell[data-screen-id="${screen.id}"]`);
                if (!cell) return;
                if (screen.type === 'vereador') {
                    const video = cell.querySelector('video');
                    if (!video) return;
                    const slotId = screen.slotId;
                    if (slotId) {
                        const stream = this.vereadorManager?.connections?.[slotId];
                        if (stream && stream.active && video.srcObject !== stream) {
                            video.srcObject = stream;
                            video.play().catch(() => {});
                        } else if (!stream && video.srcObject) {
                            video.srcObject = null;
                        }
                    } else if (video.srcObject) {
                        video.srcObject = null;
                    }
                } else if (screen.type === 'webcam' || screen.type === 'camera') {
                    const video = cell.querySelector('video');
                    if (!video) return;
                    if (screen.config?.deviceId && !screen._stream) {
                        this._startEntrevistasCamera(screen, video);
                    }
                }
            });
        });
    }

    renderScenePreview() {
        const scene = this.activeScene;
        const previewArea = document.getElementById('preview-area');
        if (!scene || !previewArea) {
            this.clearPreview();
            return;
        }

        this.clearPreview();

        const source = scene.sources.length > 0
            ? scene.sources.find(s => s.id === scene.activeSourceId) || scene.sources[scene.sources.length - 1]
            : null;

        if (source) {
            this.activeSource = source.id;
            scene.activeSourceId = source.id;
            this.activateSource(source).then(() => {
                this._applyPreviewStyles();
            }).catch(err => {
                console.error('Erro ao renderizar preview da cena:', err);
                this._applyPreviewStyles();
            });
        } else {
            this._applyPreviewStyles();
        }

        this.renderSources();
    }

    createVideoEl(id, stream, mirror, forceMuted) {
        let v = document.getElementById(id);
        if (!v) {
            v = document.createElement('video');
            v.id = id;
        }
        v.autoplay    = true;
        v.muted       = !!forceMuted;
        v.playsInline = true;
        v.srcObject   = stream;
        v.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:${mirror ? 'scaleX(-1)' : 'none'};`;
        v.play().catch(function(e){
            if (e.name === 'NotAllowedError') {
                v.muted = true;
                v.play().catch(function(){});
            }
        });
        return v;
    }

    readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    renderAudioVisualizer(container, stream) {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
        container.appendChild(canvas);

        const ctx    = canvas.getContext('2d');
        const ac     = new AudioContext();
        const source = ac.createMediaStreamSource(stream);
        const analyser = ac.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const bufLen = analyser.frequencyBinCount;
        const dataArr = new Uint8Array(bufLen);

        const draw = () => {
            requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArr);
            canvas.width  = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const barW = (canvas.width / bufLen) * 2.5;
            let x = 0;
            for (let i = 0; i < bufLen; i++) {
                const barH = (dataArr[i] / 255) * canvas.height;
                const r = 0, g = 102 + dataArr[i] / 2, b = 204;
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.fillRect(x, canvas.height - barH, barW, barH);
                x += barW + 1;
            }
        };
        draw();
    }

    clearPreview() {
        const previewArea = document.getElementById('preview-area');
        if (!previewArea) return;
        if (this._vereadoresGridInterval) {
            clearInterval(this._vereadoresGridInterval);
            this._vereadoresGridInterval = null;
        }
        this._verGridSource = null;
        this._verGridSourceId = null;
        [...previewArea.children].forEach(child => {
            if (!child.classList.contains('screen-placeholder') && child.id !== 'preview-logo' && !child.classList.contains('vereador-pip')) child.remove();
        });
        previewArea.style.backgroundColor = '';
    }

    // ─────────────────────────────────────────
    //  GERENCIAR FONTES
    // ─────────────────────────────────────────
    setActiveSource(id) {
        this.activeSource = id;
        const scene = this.activeScene;
        if (scene) scene.activeSourceId = id;
        document.querySelectorAll('.source-item').forEach(el => {
            el.classList.toggle('active', el.dataset.id == id);
        });
        this.saveData();
    }

    removeSource(id) {
        const scene = this.activeScene;
        if (!scene) return;

        if (this.mediaStreams[id]) {
            this.mediaStreams[id].getTracks().forEach(t => t.stop());
            delete this.mediaStreams[id];
        }

        this.cleanupAudioChain(id);
        this._stopChromaCanvas(id);
        // limpa intervalo do slideshow
        var src = scene.sources.find(function(s) { return s.id === id; });
        if (src && src._slideshowInterval) {
            clearInterval(src._slideshowInterval);
            src._slideshowInterval = null;
        }
        if (this._objectUrls[id]) {
            var urls = Array.isArray(this._objectUrls[id]) ? this._objectUrls[id] : [this._objectUrls[id]];
            urls.forEach(function(u){ URL.revokeObjectURL(u); });
            delete this._objectUrls[id];
        }

        scene.sources = scene.sources.filter(s => s.id !== id);
        if (this.activeSource === id) {
            this.activeSource = null;
            scene.activeSourceId = null;
            this.clearPreview();
        }

        this.saveData();
        this.renderSources();
        this.showNotification('🗑️ Fonte removida');
    }

    // ─────────────────────────────────────────
    //  CHROMA KEY
    // ─────────────────────────────────────────
    openChromaKey(sourceId) {
        const scene = this.activeScene;
        if (!scene) return;
        const source = scene.sources.find(s => s.id === sourceId);
        if (!source) return;
        if (!source.chromaKey) {
            source.chromaKey = { enabled: true, color: '#00ff00', similarity: 80, smoothness: 50, opacity: 100 };
        }
        // Preenche o modal
        document.getElementById('chroma-modal-title').textContent = `🎨 Chroma Key — ${source.name}`;
        document.getElementById('chroma-color').value = source.chromaKey.color || '#00ff00';
        document.getElementById('chroma-similarity').value = source.chromaKey.similarity;
        document.getElementById('chroma-similarity-val').textContent = source.chromaKey.similarity;
        document.getElementById('chroma-smoothness').value = source.chromaKey.smoothness;
        document.getElementById('chroma-smoothness-val').textContent = source.chromaKey.smoothness;
        document.getElementById('chroma-opacity').value = source.chromaKey.opacity ?? 100;
        document.getElementById('chroma-opacity-val').textContent = source.chromaKey.opacity ?? 100;
        this._chromaSourceId = sourceId;
        this._renderChromaPreview();
        document.getElementById('modal-chroma').style.display = 'flex';
    }

    _renderChromaPreview() {
        const canvas = document.getElementById('chroma-preview-canvas');
        if (!canvas) return;
        const source = this._getChromaSource();
        if (!source) return;
        const stream = this.mediaStreams[source.id];
        if (!stream) return;
        // reutiliza elemento video em vez de criar um novo a cada chamada
        if (canvas._chromaVideo) {
            canvas._chromaVideo.srcObject = null;
            canvas._chromaVideo.pause();
        } else {
            canvas._chromaVideo = document.createElement('video');
        }
        const video = canvas._chromaVideo;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        video.play().catch(function() {});
        const color = source.chromaKey?.color || '#00ff00';
        const similarity = (source.chromaKey?.similarity ?? 80) / 100;
        const smoothness = (source.chromaKey?.smoothness ?? 50) / 100;
        const opacity = (source.chromaKey?.opacity ?? 100) / 100;
        const ctx = canvas.getContext('2d');
        canvas.width = 320;
        canvas.height = 180;
        let anim;
        const draw = () => {
            if (!video.videoWidth) { anim = requestAnimationFrame(draw); return; }
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            this._processChromaKey(imageData, color, similarity, smoothness, opacity);
            ctx.putImageData(imageData, 0, 0);
            anim = requestAnimationFrame(draw);
        };
        draw();
        canvas._chromaAnim = anim;
    }

    _getChromaSource() {
        if (!this._chromaSourceId) return null;
        const scene = this.activeScene;
        if (!scene) return null;
        return scene.sources.find(s => s.id === this._chromaSourceId);
    }

    _processChromaKey(imageData, color, similarity, smoothness, opacity) {
        const data = imageData.data;
        const keyR = parseInt(color.slice(1,3), 16);
        const keyG = parseInt(color.slice(3,5), 16);
        const keyB = parseInt(color.slice(5,7), 16);
        const threshold = similarity * 1.5; // 0-150
        const feather = smoothness * 30; // 0-30

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const dist = Math.sqrt(
                (r - keyR) ** 2 +
                (g - keyG) ** 2 +
                (b - keyB) ** 2
            );
            if (dist < threshold) {
                let alpha = 0;
                if (dist > threshold - feather) {
                    alpha = ((threshold - dist) / feather) * (1 - opacity);
                } else {
                    alpha = 1 - opacity;
                }
                data[i + 3] = Math.max(0, Math.min(255, 255 - (255 - data[i + 3]) * (1 - alpha)));
            }
        }
    }

    _stopChromaCanvas(id) {
        if (this._chromaSourceId === id) {
            const canvas = document.getElementById('chroma-preview-canvas');
            if (canvas) {
                if (canvas._chromaAnim) cancelAnimationFrame(canvas._chromaAnim);
                if (canvas._chromaVideo) {
                    canvas._chromaVideo.pause();
                    canvas._chromaVideo.srcObject = null;
                    canvas._chromaVideo = null;
                }
            }
        }
    }

    _applyChromaKeySettings() {
        const source = this._getChromaSource();
        if (!source) return;
        if (!source.chromaKey) source.chromaKey = {};
        source.chromaKey.enabled = true;
        source.chromaKey.color = document.getElementById('chroma-color').value;
        source.chromaKey.similarity = parseInt(document.getElementById('chroma-similarity').value);
        source.chromaKey.smoothness = parseInt(document.getElementById('chroma-smoothness').value);
        source.chromaKey.opacity = parseInt(document.getElementById('chroma-opacity').value);
        this.saveData();
        // Re-render the source in preview if it's active
        if (this.activeSource === source.id) {
            this.selectSource(source.id);
        }
        this.showNotification('🎨 Chroma Key aplicado');
    }

    _replaceWithChromaCanvas(source, videoEl, container) {
        const oldC = container.querySelector('.chroma-canvas');
        if (oldC) {
            if (oldC._chromaAnim) cancelAnimationFrame(oldC._chromaAnim);
            oldC.remove();
        }
        const canvas = document.createElement('canvas');
        canvas.className = 'chroma-canvas';
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
        container.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const ck = source.chromaKey || {};
        const color = ck.color || '#00ff00';
        const similarity = (ck.similarity ?? 80) / 100;
        const smoothness = (ck.smoothness ?? 50) / 100;
        const opacity = (ck.opacity ?? 100) / 100;
        let anim;
        const draw = () => {
            if (!videoEl.videoWidth || videoEl.paused) { anim = requestAnimationFrame(draw); return; }
            const rect = container.getBoundingClientRect();
            const w = Math.round(rect.width);
            const h = Math.round(rect.height);
            if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
            ctx.drawImage(videoEl, 0, 0, w, h);
            const imageData = ctx.getImageData(0, 0, w, h);
            this._processChromaKey(imageData, color, similarity, smoothness, opacity);
            ctx.putImageData(imageData, 0, 0);
            anim = requestAnimationFrame(draw);
        };
        draw();
        canvas._chromaAnim = anim;
        videoEl.style.opacity = '0';
        videoEl.style.pointerEvents = 'none';
    }

    // ─────────────────────────────────────────
    //  MIXER DE ÁUDIO
    // ─────────────────────────────────────────
    _getAudioContext() {
        if (!this._audioCtx) {
            this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this._audioCtx.state === 'suspended') {
            this._audioCtx.resume();
        }
        return this._audioCtx;
    }

    _findVideoEl(sourceId) {
        var el = document.getElementById('preview-video');
        if (el && el.tagName === 'VIDEO') return el;
        var programArea = document.getElementById('program-area');
        if (programArea) {
            var v = programArea.querySelector('video[data-source-id="' + sourceId + '"]');
            if (v) return v;
        }
        return null;
    }

    setupAudioChain(sourceId, stream) {
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            console.log('[OBS] Sem audio para', sourceId);
            return;
        }

        this.cleanupAudioChain(sourceId);

        try {
            var context = this._getAudioContext();
            var mediaSource = context.createMediaStreamSource(stream);
            var analyser = context.createAnalyser();
            analyser.fftSize = 256;

            // feed audio monitor via a small gain node — NÃO conecta ao destination
            // o audio sai pelo elemento <video> (muted=false)
            mediaSource.connect(analyser);

            this.audioChains[sourceId] = {
                context: context,
                mediaSource: mediaSource,
                analyser: analyser,
                muted: false,
                solo: false,
                pan: 0,
                volume: 1,
                volumeEl: null,
                filterState: {
                    noiseSuppression: !!(stream.getAudioTracks()[0]?.getSettings()?.noiseSuppression),
                    echoCancellation: !!(stream.getAudioTracks()[0]?.getSettings()?.echoCancellation),
                    noiseGate:   { enabled: false, threshold: -32, attack: 25, release: 150 },
                    compressor:  { enabled: true, ratio: 10, threshold: -18, attack: 6, release: 60, gain: 0 },
                    limiter:     { enabled: false, threshold: -6 },
                    gain: 0,
                },
                _gateGain: null,
                _gateTimeout: null,
            };
        } catch (e) {
            console.error('[OBS] Erro audio chain', sourceId, e);
        }

        this.renderAudioMixer();
    }

    cleanupAudioChain(sourceId) {
        var chain = this.audioChains[sourceId];
        if (!chain) return;
        try {
            if (chain._gateTimeout) clearTimeout(chain._gateTimeout);
            if (chain.mediaSource) {
                try { chain.mediaSource.disconnect(); } catch(e){}
            }
            if (chain.analyser) {
                try { chain.analyser.disconnect(); } catch(e){}
            }
            var el = this._findVideoEl(sourceId);
            if (el) { el.volume = 1; el.muted = false; }
        } catch (e) { console.warn('[OBS] Erro ao limpar cadeia de audio:', e); }
        delete this.audioChains[sourceId];
        this.renderAudioMixer();
    }

    setupVereadorAudio(slotId, stream, label) {
        if (this._vereadorAudio[slotId]) this.cleanupVereadorAudio(slotId);
        const ctx = this._getAudioContext();
        var src = ctx.createMediaStreamSource(stream);
        var gain = ctx.createGain();
        var panner = ctx.createStereoPanner();
        var analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(gain);
        gain.connect(panner);
        panner.connect(analyser);
        analyser.connect(ctx.destination);
        this._vereadorAudio[slotId] = {
            context: ctx, source: src, gain: gain, panner: panner,
            analyser: analyser, muted: false, solo: false,
            volume: 1, pan: 0, label: label || 'Vereador ' + slotId
        };
        this.renderAudioMixer();
    }

    cleanupVereadorAudio(slotId) {
        var va = this._vereadorAudio[slotId];
        if (!va) return;
        try {
            if (va.context && va.context.state !== 'closed') va.context.close();
        } catch(e) {}
        delete this._vereadorAudio[slotId];
        this.renderAudioMixer();
    }

    setVereadorVolume(slotId, val) {
        var va = this._vereadorAudio[slotId];
        if (!va) return;
        va.volume = val;
        va.gain.gain.value = val;
        this._updateSoloState();
    }

    setVereadorPan(slotId, val) {
        var va = this._vereadorAudio[slotId];
        if (!va) return;
        va.pan = val;
        va.panner.pan.value = val;
    }

    toggleVereadorMute(slotId) {
        var va = this._vereadorAudio[slotId];
        if (!va) return;
        va.muted = !va.muted;
        this._updateSoloState();
    }

    toggleVereadorSolo(slotId) {
        var va = this._vereadorAudio[slotId];
        if (!va) return;
        va.solo = !va.solo;
        this._updateSoloState();
    }

    setAudioLayout(layout) {
        const list = document.getElementById('audio-mixer-list');
        if (!list) return;
        list.classList.toggle('horizontal', layout === 'horizontal');
        document.querySelectorAll('.btn-audio-layout').forEach(b => {
            b.classList.toggle('active', b.dataset.layout === layout);
        });
        this.renderAudioMixer();
    }

    renderAudioMixer() {
        const list = document.getElementById('audio-mixer-list');
        if (!list) return;

        let scene = this.activeScene;
        if (!scene) scene = { sources: [] };

        const audioSources = scene.sources ? scene.sources.filter(s =>
            AUDIO_SOURCE_TYPES.includes(s.type)
        ) : [];

        var vereadorCards = '';
        for (var sk in this._vereadorAudio) {
            var va = this._vereadorAudio[sk];
            vereadorCards += '<div class="audio-card" data-id="vereador-' + sk + '" data-type="vereador">' +
                '<div class="audio-card-header"><span class="audio-label">📱 ' + va.label + '</span>' +
                '<div class="audio-card-btns">' +
                    '<button class="audio-mute-btn" title="Mutar">🔇</button>' +
                    '<button class="audio-solo-btn" title="Solo">S</button>' +
                '</div></div>' +
                '<div class="audio-card-body">' +
                    '<input type="range" class="audio-fader" min="0" max="1" step="0.01" value="' + va.volume + '" />' +
                    '<div class="audio-pan"><span>Pan</span>' +
                    '<input type="range" class="audio-pan-slider" min="-1" max="1" step="0.01" value="' + va.pan + '" /></div>' +
                    '<div class="audio-vu-bar"><div class="audio-vu-fill" id="vu-vereador-' + sk + '"></div></div>' +
                '</div></div>';
        }

        list.innerHTML = (audioSources.length > 0 ? audioSources.map(s => this.renderMixerCard(s)).join('') : '') +
            vereadorCards +
            '<div class="audio-master">' +
                '<div class="audio-master-header"><span>🔊 Master</span><span class="master-db" id="master-db">0.0 dB</span></div>' +
                '<input type="range" class="audio-master-slider" min="0" max="1" step="0.01" value="' + this.masterVolume + '" />' +
            '</div>';

        // Attach events - regular sources
        audioSources.forEach(s => {
            const chain = this.audioChains[s.id];
            const card = list.querySelector(`.audio-card[data-id="${s.id}"]`);
            if (!card) return;

            const fader = card.querySelector('.audio-fader');
            if (fader) {
                if (chain) fader.value = chain.volume;
                fader.addEventListener('input', (e) => {
                    this.setVolume(s.id, parseFloat(e.target.value));
                });
            }

            const panSlider = card.querySelector('.audio-pan-slider');
            if (panSlider) {
                if (chain) panSlider.value = chain.pan;
                panSlider.addEventListener('input', (e) => {
                    this.setPan(s.id, parseFloat(e.target.value));
                });
            }

            const muteBtn = card.querySelector('.audio-mute-btn');
            if (muteBtn) {
                muteBtn.addEventListener('click', () => this.toggleMute(s.id));
                if (chain?.muted) muteBtn.classList.add('muted');
            }

            const soloBtn = card.querySelector('.audio-solo-btn');
            if (soloBtn) {
                soloBtn.addEventListener('click', () => this.toggleSolo(s.id));
            }

            const filtersBtn = card.querySelector('.audio-filters-btn');
            if (filtersBtn) {
                filtersBtn.addEventListener('click', () => this.openAudioFilters(s.id));
            }
        });

        // events for vereador cards
        for (var sk in this._vereadorAudio) {
            var card = list.querySelector('.audio-card[data-id="vereador-' + sk + '"]');
            if (!card) continue;
            (function(id){
                var va = this._vereadorAudio[id];
                var fader = card.querySelector('.audio-fader');
                if (fader) {
                    fader.value = va.volume;
                    fader.addEventListener('input', function(e){
                        this.setVereadorVolume(id, parseFloat(e.target.value));
                    }.bind(this));
                }
                var pan = card.querySelector('.audio-pan-slider');
                if (pan) {
                    pan.value = va.pan;
                    pan.addEventListener('input', function(e){
                        this.setVereadorPan(id, parseFloat(e.target.value));
                    }.bind(this));
                }
                var muteBtn = card.querySelector('.audio-mute-btn');
                if (muteBtn) {
                    muteBtn.addEventListener('click', function(){
                        this.toggleVereadorMute(id);
                    }.bind(this));
                }
                var soloBtn = card.querySelector('.audio-solo-btn');
                if (soloBtn) {
                    soloBtn.addEventListener('click', function(){
                        this.toggleVereadorSolo(id);
                    }.bind(this));
                }
            }).call(this, sk);
        }

        const masterSlider = list.querySelector('.audio-master-slider');
        if (masterSlider) {
            masterSlider.addEventListener('input', (e) => {
                this.setMasterVolume(parseFloat(e.target.value));
                const db = parseFloat(e.target.value) <= 0 ? '-∞' : (Math.round(20 * Math.log10(parseFloat(e.target.value)) * 10) / 10).toFixed(1);
                const el = document.getElementById('master-db');
                if (el) el.textContent = db + ' dB';
            });
        }

        this._setupDragDrop(list, 'audio');
    }

    renderMixerCard(source) {
        const chain = this.audioChains[source.id];
        const vol = chain ? chain.volume : 1;
        const volDb = vol <= 0 ? '-∞' : (Math.round(20 * Math.log10(vol) * 10) / 10).toFixed(1);
        const muted = chain?.muted || false;
        const muteIcon = muted ? '🔇' : '🔊';
        const solo = chain?.solo || false;
        const pan = chain ? chain.pan : 0;
        return `
            <div class="audio-card" data-id="${source.id}">
                <div class="audio-card-header">
                    <span class="drag-handle">⠿</span>
                    <span class="audio-icon">${source.icon}</span>
                    <span class="audio-name" title="${escapeHtml(source.name)}">${escapeHtml(source.name)}</span>
                </div>
                <div class="audio-meter-row">
                    <canvas class="vu-canvas" id="vu-${source.id}"></canvas>
                </div>
                <div class="audio-fader-row">
                    <input type="range" class="audio-fader" min="0" max="1" step="0.01" value="${vol}" orient="vertical" />
                </div>
                <div class="audio-pan-row">
                    <span class="pan-label">L</span>
                    <input type="range" class="audio-pan-slider" min="-1" max="1" step="0.05" value="${pan}" />
                    <span class="pan-label">R</span>
                </div>
                <div class="audio-actions">
                    <button class="audio-btn audio-mute-btn ${muted ? 'muted' : ''}" title="Mute">${muteIcon}</button>
                    <button class="audio-btn audio-solo-btn ${solo ? 'solo-active' : ''}" title="Solo / PFL">${solo ? '🔴' : '🔘'}Solo</button>
                    <span class="audio-db-readout">${muted ? '-∞' : volDb} dB</span>
                    <button class="audio-btn audio-filters-btn" title="Filtros">⚙</button>
                </div>
            </div>
        `;
    }

    startAudioMixerLoop() {
        const loop = () => {
            this.updateVUMeters();
            this._vuAnimId = requestAnimationFrame(loop);
        };
        this._vuAnimId = requestAnimationFrame(loop);
    }

    updateVUMeters() {
        for (const id in this.audioChains) {
            const chain = this.audioChains[id];
            const canvas = document.getElementById(`vu-${id}`);
            if (!canvas || !chain.analyser) continue;

            const ctx = canvas.getContext('2d');
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            if (w === 0 || h === 0) continue;
            canvas.width = w * 2; // retina
            canvas.height = h * 2;
            ctx.scale(2, 2);

            const data = new Uint8Array(chain.analyser.frequencyBinCount);
            chain.analyser.getByteTimeDomainData(data);

            // RMS level 0-255
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                const val = data[i] - 128;
                sum += val * val;
            }
            const rms = Math.sqrt(sum / data.length);
            const level = Math.min(rms / 128, 1); // 0-1

            // dBFS
            const dbfs = level <= 0 ? -100 : 20 * Math.log10(level);

            // Draw VU meter
            ctx.clearRect(0, 0, w, h);

            const barW = w;
            const barH = h;
            const fillW = Math.max(2, barW * level);

            // Background
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, barW, barH);

            // Colors: green (-50 to -20 dBFS), yellow (-20 to -9), red (-9 to 0)
            const greenEnd = barW;
            const yellowStart = barW * 0.6;
            const redStart = barW * 0.82;

            if (fillW > 0) {
                if (fillW <= yellowStart) {
                    ctx.fillStyle = '#44cc44';
                    ctx.fillRect(0, 0, fillW, barH);
                } else if (fillW <= redStart) {
                    ctx.fillStyle = '#44cc44';
                    ctx.fillRect(0, 0, yellowStart, barH);
                    ctx.fillStyle = '#ffcc00';
                    ctx.fillRect(yellowStart, 0, fillW - yellowStart, barH);
                } else {
                    ctx.fillStyle = '#44cc44';
                    ctx.fillRect(0, 0, yellowStart, barH);
                    ctx.fillStyle = '#ffcc00';
                    ctx.fillRect(yellowStart, 0, redStart - yellowStart, barH);
                    ctx.fillStyle = '#cc0000';
                    ctx.fillRect(redStart, 0, fillW - redStart, barH);
                }
            }

            // Tick marks
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            for (let x = 0; x < barW; x += barW / 10) {
                ctx.fillRect(x, 0, 1, barH);
            }
        }
        for (var vid in this._vereadorAudio) {
            var va = this._vereadorAudio[vid];
            var fill = document.getElementById('vu-vereador-' + vid);
            if (!fill || !va.analyser) continue;
            var data = new Uint8Array(va.analyser.frequencyBinCount);
            va.analyser.getByteFrequencyData(data);
            var avg = 0;
            for (var i = 0; i < data.length; i++) avg += data[i];
            avg /= data.length;
            var pct = Math.min(1, avg / 128);
            fill.style.width = (pct * 100) + '%';
            fill.style.background = pct > 0.82 ? '#cc0000' : (pct > 0.6 ? '#ffcc00' : '#44cc44');
        }
    }

    _updateSoloState() {
        var chains = Object.values(this.audioChains);
        var vaList = Object.values(this._vereadorAudio);
        var hasSolo = chains.some(function(c){ return c.solo; }) ||
                      vaList.some(function(v){ return v.solo; });

        for (var id in this.audioChains) {
            var chain = this.audioChains[id];
            var el = this._findVideoEl(id);
            var shouldPlay = !hasSolo || chain.solo;
            var vol = shouldPlay ? (chain.muted ? 0 : chain.volume * this.masterVolume) : 0;
            if (el) { el.volume = vol; el.muted = vol === 0; }
        }

        for (var sid in this._vereadorAudio) {
            var va = this._vereadorAudio[sid];
            var shouldPlay = !hasSolo || va.solo;
            var vol = shouldPlay ? (va.muted ? 0 : va.volume * this.masterVolume) : 0;
            va.gain.gain.value = vol;
        }
    }

    setVolume(sourceId, vol) {
        const chain = this.audioChains[sourceId];
        if (!chain) return;
        chain.volume = vol;
        this._updateSoloState();
        this.renderAudioMixer();
    }

    toggleMute(sourceId) {
        const chain = this.audioChains[sourceId];
        if (!chain) return;
        chain.muted = !chain.muted;
        this._updateSoloState();
        this.renderAudioMixer();
    }

    setPan(sourceId, pan) {
        const chain = this.audioChains[sourceId];
        if (!chain) return;
        chain.pan = pan;
        this.renderAudioMixer();
    }

    toggleSolo(sourceId) {
        const chain = this.audioChains[sourceId];
        if (!chain) return;
        chain.solo = !chain.solo;
        this._updateSoloState();
        this.renderAudioMixer();
    }

    setMasterVolume(vol) {
        this.masterVolume = vol;
        this._updateSoloState();
        this.renderAudioMixer();
    }

    openAudioFilters(sourceId) {
        const chain = this.audioChains[sourceId];
        const scene = this.activeScene;
        const source = scene?.sources.find(s => s.id === sourceId);
        if (!source) return;

        const title = document.getElementById('audio-filters-title');
        const body = document.getElementById('audio-filters-body');
        if (title) title.textContent = `🎛️ Filtros — ${source.icon} ${source.name}`;
        if (!body) return;

        const st = chain?.filterState || this._defaultFilterState();

        body.innerHTML = `
            <div class="filter-group">
                <div class="filter-header">
                    <span>Supressão de Ruído</span>
                    <button class="filter-toggle ${st.noiseSuppression ? 'on' : ''}" data-filter="noiseSuppression"></button>
                </div>
            </div>
            <div class="filter-group">
                <div class="filter-header">
                    <span>Cancelamento de Eco</span>
                    <button class="filter-toggle ${st.echoCancellation ? 'on' : ''}" data-filter="echoCancellation"></button>
                </div>
            </div>
            <div class="filter-group">
                <div class="filter-header">
                    <span>Porta de Ruído (Noise Gate)</span>
                    <button class="filter-toggle ${st.noiseGate.enabled ? 'on' : ''}" data-filter="noiseGate"></button>
                </div>
                <div class="filter-params">
                    <div class="filter-param">
                        <label>Threshold</label>
                        <input type="range" min="-60" max="0" step="1" value="${st.noiseGate.threshold}" data-param="noiseGate-threshold" />
                        <span class="param-value">${st.noiseGate.threshold} dB</span>
                    </div>
                    <div class="filter-param">
                        <label>Attack</label>
                        <input type="range" min="1" max="200" step="1" value="${st.noiseGate.attack}" data-param="noiseGate-attack" />
                        <span class="param-value">${st.noiseGate.attack} ms</span>
                    </div>
                    <div class="filter-param">
                        <label>Release</label>
                        <input type="range" min="10" max="500" step="1" value="${st.noiseGate.release}" data-param="noiseGate-release" />
                        <span class="param-value">${st.noiseGate.release} ms</span>
                    </div>
                </div>
            </div>
            <div class="filter-group">
                <div class="filter-header">
                    <span>Compressor</span>
                    <button class="filter-toggle ${st.compressor.enabled ? 'on' : ''}" data-filter="compressor"></button>
                </div>
                <div class="filter-params">
                    <div class="filter-param">
                        <label>Ratio</label>
                        <input type="range" min="1" max="32" step="0.5" value="${st.compressor.ratio}" data-param="compressor-ratio" />
                        <span class="param-value">${st.compressor.ratio}:1</span>
                    </div>
                    <div class="filter-param">
                        <label>Threshold</label>
                        <input type="range" min="-60" max="0" step="1" value="${st.compressor.threshold}" data-param="compressor-threshold" />
                        <span class="param-value">${st.compressor.threshold} dB</span>
                    </div>
                    <div class="filter-param">
                        <label>Attack</label>
                        <input type="range" min="0" max="100" step="1" value="${st.compressor.attack}" data-param="compressor-attack" />
                        <span class="param-value">${st.compressor.attack} ms</span>
                    </div>
                    <div class="filter-param">
                        <label>Release</label>
                        <input type="range" min="10" max="500" step="1" value="${st.compressor.release}" data-param="compressor-release" />
                        <span class="param-value">${st.compressor.release} ms</span>
                    </div>
                    <div class="filter-param">
                        <label>Output Gain</label>
                        <input type="range" min="-32" max="32" step="0.5" value="${st.compressor.gain}" data-param="compressor-gain" />
                        <span class="param-value">${st.compressor.gain} dB</span>
                    </div>
                </div>
            </div>
            <div class="filter-group">
                <div class="filter-header">
                    <span>Limitador</span>
                    <button class="filter-toggle ${st.limiter.enabled ? 'on' : ''}" data-filter="limiter"></button>
                </div>
                <div class="filter-params">
                    <div class="filter-param">
                        <label>Threshold</label>
                        <input type="range" min="-24" max="0" step="1" value="${st.limiter.threshold}" data-param="limiter-threshold" />
                        <span class="param-value">${st.limiter.threshold} dB</span>
                    </div>
                </div>
            </div>
            <div class="filter-group">
                <div class="filter-header">
                    <span>Ganho (Gain)</span>
                </div>
                <div class="filter-params">
                    <div class="filter-param">
                        <label>Ganho</label>
                        <input type="range" min="-20" max="20" step="0.5" value="${st.gain}" data-param="gain" />
                        <span class="param-value">${st.gain} dB</span>
                    </div>
                </div>
            </div>
        `;

        // Toggle filters
        body.querySelectorAll('.filter-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.toggle('on');
                this._applyAudioFilter(sourceId);
            });
        });

        // Range sliders
        body.querySelectorAll('input[type="range"]').forEach(input => {
            input.addEventListener('input', () => {
                const span = input.parentElement.querySelector('.param-value');
                const val = input.value;
                const param = input.dataset.param;
                if (param?.includes('compressor-ratio')) span.textContent = val + ':1';
                else if (param?.includes('gain')) span.textContent = val + ' dB';
                else if (param?.includes('ms') || param?.includes('attack') || param?.includes('release')) span.textContent = val + ' ms';
                else span.textContent = val + ' dB';
                this._applyAudioFilter(sourceId);
            });
        });

        document.getElementById('modal-audio-filters').style.display = 'flex';
    }

    closeAudioFilters() {
        document.getElementById('modal-audio-filters').style.display = 'none';
    }

    _defaultFilterState() {
        return {
            noiseSuppression: false,
            echoCancellation: false,
            noiseGate:   { enabled: false, threshold: -32, attack: 25, release: 150 },
            compressor:  { enabled: true, ratio: 10, threshold: -18, attack: 6, release: 60, gain: 0 },
            limiter:     { enabled: false, threshold: -6 },
            gain: 0,
        };
    }

    _applyAudioFilter(sourceId) {
        const chain = this.audioChains[sourceId];
        if (!chain || !chain.context) return;

        const body = document.getElementById('audio-filters-body');
        if (!body) return;

        const state = chain.filterState;

        // Read UI state
        state.noiseSuppression = body.querySelector('.filter-toggle[data-filter="noiseSuppression"]')?.classList.contains('on') || false;
        state.echoCancellation = body.querySelector('.filter-toggle[data-filter="echoCancellation"]')?.classList.contains('on') || false;
        state.noiseGate.enabled = body.querySelector('.filter-toggle[data-filter="noiseGate"]')?.classList.contains('on') || false;
        state.compressor.enabled = body.querySelector('.filter-toggle[data-filter="compressor"]')?.classList.contains('on') || false;
        state.limiter.enabled = body.querySelector('.filter-toggle[data-filter="limiter"]')?.classList.contains('on') || false;

        // Read slider values
        const getVal = (param) => {
            const el = body.querySelector(`input[data-param="${param}"]`);
            return el ? parseFloat(el.value) : 0;
        };

        state.noiseGate.threshold = getVal('noiseGate-threshold');
        state.noiseGate.attack = getVal('noiseGate-attack');
        state.noiseGate.release = getVal('noiseGate-release');
        state.compressor.ratio = getVal('compressor-ratio');
        state.compressor.threshold = getVal('compressor-threshold');
        state.compressor.attack = getVal('compressor-attack');
        state.compressor.release = getVal('compressor-release');
        state.compressor.gain = getVal('compressor-gain');
        state.limiter.threshold = getVal('limiter-threshold');
        state.gain = getVal('gain');

        // Apply compressor
        if (state.compressor.enabled && chain.compressor) {
            try {
                const ratio = Math.max(1, Math.min(20, state.compressor.ratio));
                const threshold = Math.max(-100, Math.min(0, state.compressor.threshold));
                const attack = Math.max(0, Math.min(1, state.compressor.attack / 1000));
                const release = Math.max(0, Math.min(1, state.compressor.release / 1000));
                chain.compressor.ratio.value = ratio;
                chain.compressor.threshold.value = threshold;
                chain.compressor.attack.value = attack;
                chain.compressor.release.value = release;
            } catch (e) { console.warn('[OBS] Erro ao aplicar compressor:', e); }
        }

        // Apply gain offset
        const gainDb = state.gain;
        const gainLinear = Math.pow(10, gainDb / 20);
        // We apply this as a multiplier on volumeGain
        const baseVol = chain.muted ? 0 : chain.volume;
        chain.volumeGain.gain.setValueAtTime(baseVol * gainLinear, chain.context.currentTime);

        // Noise gate - simple approach using level checking
        // We'll handle this in the VU loop via requestAnimationFrame
        if (state.noiseGate.enabled) {
            this._runNoiseGate(sourceId);
        }

        // Re-render mixer to keep dB readout current
        this.renderAudioMixer();
    }

    _runNoiseGate(sourceId) {
        const chain = this.audioChains[sourceId];
        if (!chain || !chain.analyser || !chain.context) return;

        const state = chain.filterState;
        if (!state.noiseGate.enabled) {
            if (chain._gateGain) {
                chain._gateGain.gain.setValueAtTime(1, chain.context.currentTime);
            }
            return;
        }

        // Create or reuse gate gain node
        if (!chain._gateGain) {
            try {
                const gateGain = chain.context.createGain();
                // We need to re-route: mediaSource → gateGain → compressor
                chain.mediaSource.disconnect();
                chain.mediaSource.connect(gateGain);
                gateGain.connect(chain.compressor);
                chain._gateGain = gateGain;
            } catch (e) {
                return;
            }
        }

        // Read level
        const data = new Uint8Array(chain.analyser.frequencyBinCount);
        chain.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            const val = data[i] - 128;
            sum += val * val;
        }
        const rms = Math.sqrt(sum / data.length);
        const dbfs = rms <= 0 ? -100 : 20 * Math.log10(Math.max(0.0001, rms / 128));

        const threshold = state.noiseGate.threshold;
        const now = chain.context.currentTime;

        if (dbfs < threshold - 5) {
            // Below threshold → close gate
            const releaseSec = Math.max(0.01, state.noiseGate.release / 1000);
            chain._gateGain.gain.setTargetAtTime(0, now, releaseSec);
        } else if (dbfs > threshold) {
            // Above threshold → open gate
            const attackSec = Math.max(0.001, state.noiseGate.attack / 1000);
            chain._gateGain.gain.setTargetAtTime(1, now, attackSec);
        }
    }

    // ─────────────────────────────────────────
    //  MIXER DE ÁUDIO - FIM
    // ─────────────────────────────────────────

    async selectSource(id) {
        const scene = this.activeScene;
        if (!scene) return;
        const source = scene.sources.find(s => s.id === id);
        if (!source) return;
        try {
            await this.activateSource(source);
            this.setActiveSource(id);
        } catch (err) {
            this.showNotification(`❌ Erro: ${err.message || err.name || 'Falha ao acessar dispositivo'}`);
        }
    }

    renderSources() {
        const list = document.getElementById('sources-list');
        if (!list) return;

        const addRow = document.querySelector('.add-source-row');
        if (addRow) addRow.style.display = '';

        const sources = this.currentSources;

        if (sources.length === 0) {
            list.innerHTML = '<p>Nenhuma fonte adicionada</p>';
        } else {
            list.innerHTML = sources.map(s => {
                const hasChroma = VIDEO_SOURCE_TYPES.includes(s.type);
                return `<div class="source-item ${this.activeSource === s.id ? 'active' : ''}" data-id="${s.id}" draggable="true">
                    <span class="drag-handle">⠿</span>
                    <span class="source-icon">${s.icon}</span>
                    <span class="source-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
                    <div class="source-actions">
                        <button class="btn-eye" onclick="obsClone.selectSource(${s.id})" title="Ativar">👁</button>
                        ${hasChroma ? `<button class="btn-chroma" onclick="obsClone.openChromaKey(${s.id})" title="Chroma Key">🎨</button>` : ''}
                        <button onclick="obsClone.removeSource(${s.id})" title="Remover">🗑</button>
                    </div>
                </div>`;
            }).join('');
            this._setupDragDrop(list, 'source');
        }

        this._renderVereadorLinksList(list);
    }

    _renderVereadorLinksList(list) {
        let mgr = this.vereadorManager;
        if (!mgr || !mgr.slots) mgr = window.obsClone?.vereadorManager;
        if (!mgr || !mgr.slots) return;
        const self = this;

        const html = '<div class="vereador-list-separator">👥 VEREADORES</div>' +
            mgr.slots.map((s) => {
                const isOnline = s.connected ? 'online' : '';
                const link = escapeHtml(s.link);
                return `<div class="source-item vereador-link-item ${isOnline}" data-slot="${s.id}">
                    <span class="source-icon">👤</span>
                    <span class="source-name" title="${link}">${s.label}</span>
                    <div class="source-actions">
                        <button class="btn-vereador-status ${isOnline}" data-slot="${s.id}" title="${isOnline ? 'Desconectar' : 'Conectar'}">${isOnline ? '🟢' : '⚪'}</button>
                        <button class="btn-edit-vereador" data-slot="${s.id}" title="Renomear">✏️</button>
                        <button class="btn-copy-link" data-link="${link}" title="Copiar link">📋</button>
                    </div>
                </div>`;
            }).join('');

        list.insertAdjacentHTML('beforeend', html);

        list.querySelectorAll('.source-item.vereador-link-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                e.stopPropagation();
                const slotId = parseInt(el.dataset.slot);
                const slot = mgr.slots.find(s => s.id === slotId);
                if (!slot) return;
                if (slot.connected) {
                    mgr.addToPreview(slotId);
                } else {
                    mgr.openConnectionModal(slotId);
                }
            });
        });

        list.querySelectorAll('.btn-vereador-status').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const slotId = parseInt(btn.dataset.slot);
                const slot = mgr.slots.find(s => s.id === slotId);
                if (!slot) return;
                if (slot.connected) {
                    mgr.disconnectSlot(slotId);
                    mgr._removePipCompletely(slotId);
                } else {
                    mgr.openConnectionModal(slotId);
                }
            });
        });

        list.querySelectorAll('.btn-copy-link').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(btn.dataset.link).then(() => {
                    btn.textContent = '✅';
                    setTimeout(() => { btn.textContent = '📋'; }, 1500);
                });
            });
        });

        list.querySelectorAll('.btn-edit-vereador').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                mgr.renameSlot(parseInt(btn.dataset.slot));
            });
        });
    }

    // ─────────────────────────────────────────
    //  DRAG & DROP
    // ─────────────────────────────────────────
    _setupSceneListEvents(list) {
        list.addEventListener('click', (e) => {
            const sceneItem = e.target.closest('.scene-item');
            if (!sceneItem) return;
            if (e.target.closest('.scene-rename-btn')) {
                e.stopPropagation();
                this.promptRenameScene(parseInt(sceneItem.dataset.id));
                return;
            }
            if (this._dragHappened) { this._dragHappened = false; return; }
            if (sceneItem.dataset.id === 'vereadores') {
                this.selectVereadoresScene();
            } else if (sceneItem.dataset.id === 'entrevistas') {
                this.selectEntrevistasScene();
            } else {
                this.selectScene(parseInt(sceneItem.dataset.id));
            }
        });
    }

    _setupDragDrop(list, type) {
        let draggedEl = null;

        const onDragStart = (e) => {
            const handle = e.target.closest('.drag-handle');
            if (!handle) return;
            draggedEl = e.target.closest('[draggable]');
            if (!draggedEl) return;
            this._dragHappened = false;
            draggedEl.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggedEl.dataset.id);
        };

        const onDragEnd = () => {
            if (draggedEl) draggedEl.classList.remove('dragging');
            list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            draggedEl = null;
            setTimeout(() => { this._dragHappened = false; }, 100);
        };

        const onDragOver = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const target = e.target.closest('[draggable]');
            if (!target || target === draggedEl) return;
            const rect = target.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            target.classList.toggle('drag-over', e.clientY < mid);
        };

        const onDragLeave = (e) => {
            const target = e.target.closest('[draggable]');
            if (target) target.classList.remove('drag-over');
        };

        const onDrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const target = e.target.closest('[draggable]');
            if (!target || !draggedEl) return;

            const fromId = parseInt(draggedEl.dataset.id);
            const toId = parseInt(target.dataset.id);
            if (fromId === toId) return;

            this._dragHappened = true;

            if (type === 'scene') {
                const fromIdx = this.scenes.findIndex(s => s.id === fromId);
                const toIdx = this.scenes.findIndex(s => s.id === toId);
                if (fromIdx === -1 || toIdx === -1) return;
                const [moved] = this.scenes.splice(fromIdx, 1);
                this.scenes.splice(toIdx, 0, moved);
                this.saveData();
                this.renderScenes();
            } else if (type === 'source' || type === 'audio') {
                const scene = this.activeScene;
                if (!scene) return;
                const fromIdx = scene.sources.findIndex(s => s.id === fromId);
                const toIdx = scene.sources.findIndex(s => s.id === toId);
                if (fromIdx === -1 || toIdx === -1) return;
                const [moved] = scene.sources.splice(fromIdx, 1);
                scene.sources.splice(toIdx, 0, moved);
                this.saveData();
        this.renderSources();
        this._applyPreviewStyles();
                if (type === 'audio') this.renderAudioMixer();
            }

            list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            draggedEl = null;
        };

        list.addEventListener('dragstart', onDragStart);
        list.addEventListener('dragend', onDragEnd);
        list.addEventListener('dragover', onDragOver);
        list.addEventListener('dragleave', onDragLeave);
        list.addEventListener('drop', onDrop);
    }

    // ─────────────────────────────────────────
    //  PERSISTÊNCIA
    // ─────────────────────────────────────────
    loadData() {
        const saved = localStorage.getItem('obsScenes');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                this.scenes = data.scenes || [];
                this.activeSceneId = data.activeSceneId || null;
                this.transitionType = data.transitionType || 'cut';
                this.transitionDuration = data.transitionDuration || 300;

                // Restaura selects
                const tt = document.getElementById('transition-type');
                if (tt) tt.value = this.transitionType;
                const td = document.getElementById('transition-duration');
                if (td) td.value = this.transitionDuration;
            } catch(e) {
                console.error('[OBS] Erro ao carregar dados salvos:', e);
                this.scenes = [];
            }
        }

        // Fallback: migrar dados antigos (obsSources) para cenas
        if (this.scenes.length === 0) {
            const oldSources = localStorage.getItem('obsSources');
            if (oldSources) {
                try {
                    const old = JSON.parse(oldSources);
                    const defaultScene = {
                        id: Date.now(),
                        name: 'Cena 1',
                        sources: old,
                        activeSourceId: old.length > 0 ? old[0].id : null,
                    };
                    this.scenes.push(defaultScene);
                } catch(e) { console.warn('[OBS] Erro ao migrar dados antigos:', e); }
            }
        }

        // Garante ao menos uma cena
        if (this.scenes.length === 0) {
            this.scenes.push({
                id: Date.now(),
                name: 'Cena 1',
                sources: [],
                activeSourceId: null,
            });
        }

        // Ativa primeira cena se nenhuma ativa
        if (!this.activeSceneId || !this.scenes.find(s => s.id === this.activeSceneId)) {
            this.activeSceneId = this.scenes[0].id;
        }

        this.renderScenes();
        this.renderScenePreview();

        // Restaura selects de transição
        const tt = document.getElementById('transition-type');
        if (tt) tt.value = this.transitionType;
        const td = document.getElementById('transition-duration');
        if (td) td.value = this.transitionDuration;
    }

    async _sanitizeSourceForSave(source) {
        const s = { ...source, config: { ...source.config } };
        const tasks = [];
        if (s.config.file instanceof File) {
            tasks.push(
                this.readFileAsDataURL(s.config.file).then(url => { s.config.file = url; })
            );
        }
        if (s.config.photo instanceof File) {
            tasks.push(
                this.readFileAsDataURL(s.config.photo).then(url => { s.config.photo = url; })
            );
        }
        if (s.config.files && typeof s.config.files !== 'string') {
            try {
                const files = Array.from(s.config.files);
                tasks.push(
                    Promise.all(files.map(f => this.readFileAsDataURL(f))).then(urls => {
                        s.config.files = urls;
                    })
                );
            } catch (e) {
                s.config.files = [];
            }
        }
        await Promise.all(tasks);
        if (s.config.files && Array.isArray(s.config.files)) {
            s.config.files = s.config.files.filter(f => typeof f === 'string');
        }
        return s;
    }

    async saveData() {
        const scenesWithSources = await Promise.all(this.scenes.map(async scene => ({
            ...scene,
            sources: await Promise.all(scene.sources.map(s => this._sanitizeSourceForSave(s))),
        })));
        const data = {
            scenes: scenesWithSources,
            activeSceneId: this.activeSceneId,
            transitionType: this.transitionType,
            transitionDuration: this.transitionDuration,
        };
        try {
            localStorage.setItem('obsScenes', JSON.stringify(data));
            this.saveSnapshot(data);
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                this.showNotification('⚠️ Espaço de armazenamento insuficiente. Limpe backups antigos.');
                this._trimOldData();
            } else {
                console.error('[OBS] Erro ao salvar dados:', e);
            }
        }
    }

    _trimOldData() {
        try {
            localStorage.removeItem(this._snapshotKey);
            var totalSize = 0;
            var data = {
                scenes: this.scenes.map(function(scene) {
                    return {
                        ...scene,
                        sources: scene.sources.map(function(s) {
                            var clean = { ...s, config: { ...s.config } };
                            if (clean.config.file && typeof clean.config.file === 'string' && clean.config.file.length > 50000) {
                                delete clean.config.file;
                                clean.config._trimmed = true;
                            }
                            if (clean.config.files) {
                                try {
                                    var urls = JSON.parse(clean.config.files);
                                    if (Array.isArray(urls)) {
                                        clean.config.files = JSON.stringify(urls.filter(function(u) {
                                            return typeof u !== 'string' || u.length <= 50000;
                                        }));
                                    }
                                } catch(e) {}
                            }
                            return clean;
                        }),
                    };
                }),
                activeSceneId: this.activeSceneId,
            };
            localStorage.setItem('obsScenes', JSON.stringify(data));
        } catch (e2) {
            console.error('[OBS] Falha ao salvar mesmo após limpeza:', e2);
        }
    }

    _captureSyncSnapshot() {
        try {
            return {
                scenes: this.scenes.map(scene => ({
                    ...scene,
                    sources: scene.sources.map(s => ({
                        ...s,
                        config: { ...s.config, file: undefined, photo: undefined, files: undefined },
                    })),
                })),
                activeSceneId: this.activeSceneId,
                transitionType: this.transitionType,
                transitionDuration: this.transitionDuration,
            };
        } catch (e) {
            console.warn('[OBS] Erro ao capturar snapshot síncrono:', e);
            return null;
        }
    }

    startAutoSave() {
        clearInterval(this._autoSaveInterval);
        this._autoSaveInterval = setInterval(() => {
            if (this.scenes.length > 0) this.saveData();
        }, 30000);
    }

    _syncProgramPip() {
        try {
            const previewArea = document.getElementById('preview-area');
            const programArea = document.getElementById('program-area');
            if (!previewArea || !programArea) return;
            const pipPreview = previewArea.querySelector('.vereador-pip');
            const pipProgram = programArea.querySelector('.vereador-pip');
            if (pipPreview && (!pipProgram || pipPreview.dataset.slot !== pipProgram.dataset.slot)) {
                if (pipProgram) {
                    const v = pipProgram.querySelector('.vereador-pip-video');
                    if (v) { v.pause(); v.srcObject = null; }
                    pipProgram.remove();
                }
                const slotId = parseInt(pipPreview.dataset.slot);
                const stream = this.vereadorManager.connections[slotId];
                const slot = this.vereadorManager.slots.find(s => s.id === slotId);
                const pip = document.createElement('div');
                pip.className = 'vereador-pip';
                pip.dataset.slot = slotId;
                pip.innerHTML = `
                    <div class="vereador-pip-video-wrapper">
                        <video class="vereador-pip-video" autoplay playsinline muted></video>
                    </div>
                `;
                pip.style.width = pipPreview.style.width || '';
                pip.style.height = pipPreview.style.height || '';
                pip.style.maxHeight = pipPreview.style.maxHeight || '';
                programArea.appendChild(pip);
                const video = pip.querySelector('.vereador-pip-video');
                if (video && stream) {
                    video.srcObject = stream;
                    video.play().catch(() => {});
                }
            }
            if (!pipPreview && pipProgram) {
                const v = pipProgram.querySelector('.vereador-pip-video');
                if (v) { v.pause(); v.srcObject = null; }
                pipProgram.remove();
            }
        } catch (e) {
            console.warn('[OBS] Erro na sincronizacao PiP:', e);
        }
    }

    saveSnapshot(currentData) {
        try {
            const key = this._snapshotKey;
            const raw = localStorage.getItem(key);
            const list = raw ? JSON.parse(raw) : [];
            list.push({ data: currentData, ts: Date.now() });
            if (list.length > this._maxSnapshots) list.shift();
            localStorage.setItem(key, JSON.stringify(list));
        } catch (e) {
            // Quota excedida — limpa backups antigos
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                localStorage.removeItem(this._snapshotKey);
            }
        }
    }

    getBackups() {
        try {
            const raw = localStorage.getItem(this._snapshotKey);
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    }

    restoreBackup(index) {
        const backups = this.getBackups();
        const snap = backups[index];
        if (!snap) { this.showNotification('⚠️ Backup nao encontrado'); return; }

        // Para streams e audio da cena atual
        Object.values(this.mediaStreams).forEach(ms => {
            if (ms) ms.getTracks().forEach(t => t.stop());
        });
        this.mediaStreams = {};
        Object.keys(this.audioChains).forEach(id => this.cleanupAudioChain(id));

        this.scenes = snap.data.scenes || [];
        this.activeSceneId = snap.data.activeSceneId || null;
        if (snap.data.transitionType) this.transitionType = snap.data.transitionType;
        if (snap.data.transitionDuration) this.transitionDuration = snap.data.transitionDuration;

        const tt = document.getElementById('transition-type');
        if (tt) tt.value = this.transitionType;
        const td = document.getElementById('transition-duration');
        if (td) td.value = this.transitionDuration;

        this.activeSource = null;
        this.renderScenes();
        this.renderScenePreview();
        this.saveData();

        const d = new Date(snap.ts);
        this.showNotification(`♻️ Restaurado backup de ${d.toLocaleString()}`);
    }

    showBackupList() {
        const backups = this.getBackups();
        if (backups.length === 0) {
            this.showNotification('📂 Nenhum backup disponivel');
            return;
        }

        let msg = '📂 BACKUPS DISPONIVEIS:\n';
        const list = backups.slice().reverse();
        list.forEach((snap, i) => {
            const d = new Date(snap.ts);
            const sceneCount = snap.data.scenes?.length || 0;
            msg += `\n${i + 1}. ${d.toLocaleString()} (${sceneCount} cena(s))`;
        });
        msg += '\n\nDigite o numero do backup para restaurar (0 = cancelar):';
        const choice = prompt(msg);
        if (choice === null || choice === '0') return;
        const idx = parseInt(choice);
        if (isNaN(idx) || idx < 1 || idx > list.length) {
            this.showNotification('⚠️ Numero invalido');
            return;
        }
        const realIndex = backups.length - idx;
        if (confirm(`Restaurar backup ${idx} de ${new Date(backups[realIndex].ts).toLocaleString()}?\nCenas atuais serao perdidas.`)) {
            this.restoreBackup(realIndex);
        }
    }

    // ─────────────────────────────────────────
    //  TRANSMISSÃO
    // ─────────────────────────────────────────
    startStreaming() {
        if (this.isStreaming) return;
        try {
            this.isStreaming = true;
            this.updateButtonStates();

            const previewArea = document.getElementById('preview-area');
            const activeId = this.activeSource;
            const stream   = activeId ? this.mediaStreams[activeId] : null;
            const programVideo = document.getElementById('program-video');
            const placeholder  = document.getElementById('program-placeholder');

            if (stream && programVideo) {
                programVideo.srcObject = stream;
                programVideo.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';
                if (previewArea) {
                    if (previewArea.style.backgroundImage) {
                        programVideo.parentElement.style.backgroundImage = previewArea.style.backgroundImage;
                        programVideo.parentElement.style.backgroundSize = previewArea.style.backgroundSize || 'cover';
                        programVideo.parentElement.style.backgroundPosition = previewArea.style.backgroundPosition || 'center';
                    }
                    const logoEl = document.getElementById('preview-logo');
                    if (logoEl) {
                        const existing = programVideo.parentElement.querySelector('.preview-logo');
                        if (!existing) programVideo.parentElement.appendChild(logoEl.cloneNode(true));
                    }
                }
            } else if (programVideo) {
                this.mirrorPreviewToProgram();
            }

            this.startProgramMirror();

            setTimeout(() => {
                const progStream = this._getProgramStream();
                if (!progStream) return;

                // VDO.Ninja — retorno para convidados + monitor
                if (this.vereadorManager?.vdo) {
                    this.vereadorManager.publishProgram(progStream);
                }

                // StreamManager — WHIP per-target (Aitum-style)
                const enabledTargets = this.settings.stream.targets.filter(t => t.enabled);
                if (enabledTargets.length > 0 && this.settings.whip.endpoint) {
                    this.streamManager.configure(enabledTargets, this.settings.whip.endpoint, this.settings.output.videoBitrate);

                    const hasVertical = enabledTargets.some(t => t.orientation === 'vertical');
                    let verticalStream = null;

                    if (hasVertical) {
                        const programVideo = document.getElementById('program-video');
                        verticalStream = this.streamManager.startVerticalCanvas(
                            programVideo, this.settings
                        );
                    }

                    this.streamManager.startAll(progStream, verticalStream);
                }
            }, 500);

            this.showNotification('🔴 Transmissão iniciada!');
        } catch (e) {
            console.error('[OBS] Erro ao iniciar transmissão:', e);
            this.showNotification(`❌ Erro ao iniciar transmissão: ${e.message}`);
            this.isStreaming = false;
            this.updateButtonStates();
        }
    }

    doTransition() {
        const previewArea = document.getElementById('preview-area');
        const programArea = document.getElementById('program-area');
        const programVideo = document.getElementById('program-video');
        const placeholder = document.getElementById('program-placeholder');
        if (!previewArea || !programArea) { this.showNotification('⚠️ Preview ou Programa não disponíveis'); return; }

        this._transitioning = true;

        if (this.transitionType === 'fade') {
            programArea.style.setProperty('--transition-duration', this.transitionDuration + 'ms');
            programArea.classList.add('transition-fade');
        }

        // Limpa programa
        if (programVideo) { programVideo.srcObject = null; programVideo.style.display = 'none'; }
        [...programArea.children].forEach(child => {
            if (!child.classList.contains('screen-placeholder') && child.id !== 'program-video' && child.id !== 'program-canvas' && !child.classList.contains('vereador-pip'))
                child.remove();
        });
        programArea.style.backgroundColor = '';
        programArea.style.backgroundImage = '';

        // Copia preview → programa
        const activeId = this.activeSource;
        const stream = activeId ? this.mediaStreams[activeId] : null;
        if (stream && programVideo) {
            programVideo.srcObject = stream;
            programVideo.style.display = 'block';
            // Clona logo para o programa
            const logoEl = document.getElementById('preview-logo');
            if (logoEl) programArea.appendChild(logoEl.cloneNode(true));
        } else {
            [...previewArea.children].forEach(child => {
                if (child.classList.contains('screen-placeholder') || child.classList.contains('vereador-pip')) return;
                const clone = child.cloneNode(true);
                programArea.appendChild(clone);
                // Restaura srcObject dos vídeos (cloneNode não copia streams)
                if (clone.querySelectorAll) {
                    var origVids = child.querySelectorAll('video[id^="mvv-"]');
                    var cloneVids = clone.querySelectorAll('video[id^="mvv-"]');
                    for (var vi = 0; vi < origVids.length && vi < cloneVids.length; vi++) {
                        cloneVids[vi].srcObject = origVids[vi].srcObject;
                    }
                }
            });
            programArea.style.backgroundColor = previewArea.style.backgroundColor;
        }

        // Copia PiP (apenas 1) do preview para o programa
        const pipPreview = previewArea.querySelector('.vereador-pip');
        const pipProgram = programArea.querySelector('.vereador-pip');
        if (pipProgram) {
            const v = pipProgram.querySelector('.vereador-pip-video');
            if (v) v.srcObject = null;
            pipProgram.remove();
        }
        if (pipPreview) {
            const clone = pipPreview.cloneNode(true);
            programArea.appendChild(clone);
            const video = clone.querySelector('.vereador-pip-video');
            const origVideo = pipPreview.querySelector('.vereador-pip-video');
            if (video && origVideo) {
                video.srcObject = origVideo.srcObject;
                video.play().catch(() => {});
            }
        }
        // Copia backgroundImage da preview
        if (previewArea.style.backgroundImage) {
            programArea.style.backgroundImage = previewArea.style.backgroundImage;
            programArea.style.backgroundSize = previewArea.style.backgroundSize || 'cover';
            programArea.style.backgroundPosition = previewArea.style.backgroundPosition || 'center';
        }
        if (placeholder) placeholder.style.display = 'none';

        if (this.transitionType === 'fade') {
            setTimeout(() => {
                programArea.classList.remove('transition-fade');
                this._transitioning = false;
            }, this.transitionDuration);
        } else {
            this._transitioning = false;
        }

        this.startProgramMirror();

        this.showNotification('▶ Transição aplicada');
    }

    startProgramMirror() {
        const win = document.getElementById('floating-window');
        if (win && win.style.display === 'none') return;

        const programVideo = document.getElementById('program-video');
        const floatingVideo = document.getElementById('floating-video');
        const body = document.getElementById('floating-body');
        const floatScreen = body?.querySelector('.float-screen');
        const screenContent = floatScreen?.querySelector('.screen-content');
        const status = document.getElementById('floating-status');
        if (!body || !floatScreen || !screenContent) return;

        // Limpa screen-content (mantém video, overlay, float-logo, PiP)
        [...screenContent.children].forEach(child => {
            if (child.id === 'floating-video' || child.classList.contains('floating-overlay') || child.id === 'float-logo' || child.classList.contains('vereador-pip')) return;
            child.remove();
        });
        if (floatingVideo) { floatingVideo.srcObject = null; floatingVideo.style.display = 'none'; }

        // Aplica fundo/logo das configurações VERTICAL (tela cheia 9:16)
        this._applyFloatingStyles();

        // Ajusta altura do screen-content para 16:9 exato
        this._resizeScreenContent();

        const programArea = document.getElementById('program-area');
        if (!programArea) return;

        // Copia backgroundColor do programa para o vertical
        if (programArea.style.backgroundColor) {
            floatScreen.style.backgroundColor = programArea.style.backgroundColor;
        }

        if (programVideo && programVideo.srcObject && floatingVideo) {
            floatingVideo.style.display = 'block';
            floatingVideo.srcObject = programVideo.srcObject;
            floatingVideo.play().catch(() => {});
            if (status) status.style.display = 'none';
            // Clona PiP para o vertical mesmo no caminho de stream
            this._clonePipToVertical(screenContent, programArea);
        } else {
            floatScreen.style.backgroundColor = programArea.style.backgroundColor || '#000';

            [...programArea.children].forEach(child => {
                if (child.classList.contains('screen-placeholder') || child.id === 'program-video' || child.id === 'program-canvas') return;
                const clone = child.cloneNode(true);
                if (!clone.classList.contains('preview-logo') && !clone.classList.contains('vereador-pip')) {
                    clone.style.position = 'absolute';
                    clone.style.top = '0';
                    clone.style.left = '0';
                    clone.style.width = '100%';
                    clone.style.height = '100%';
                }
                screenContent.appendChild(clone);
                if (clone.querySelectorAll) {
                    var origVids = child.querySelectorAll('video[id^="mvv-"]');
                    var cloneVids = clone.querySelectorAll('video[id^="mvv-"]');
                    for (var vi = 0; vi < origVids.length && vi < cloneVids.length; vi++) {
                        cloneVids[vi].srcObject = origVids[vi].srcObject;
                    }
                }
            });

            // Clona PiP (apenas 1) para o vertical
            this._clonePipToVertical(screenContent, programArea);
            if (status) status.style.display = 'none';
        }
    }

    stopProgramMirror() {
        const floatingVideo = document.getElementById('floating-video');
        const body = document.getElementById('floating-body');
        const floatScreen = body?.querySelector('.float-screen');
        const screenContent = floatScreen?.querySelector('.screen-content');
        const status = document.getElementById('floating-status');
        if (!body || !floatScreen || !screenContent) return;

        if (floatingVideo) {
            floatingVideo.srcObject = null;
            floatingVideo.style.display = 'none';
        }
        // Remove clones de dentro do screen-content (mantém video, overlay, logo e PiPs)
        [...screenContent.children].forEach(child => {
            if (child.id === 'floating-video' || child.classList.contains('floating-overlay') || child.id === 'float-logo' || child.classList.contains('vereador-pip')) return;
            child.remove();
        });
        if (status) {
            status.textContent = 'Transmissão não iniciada';
            status.style.display = 'flex';
        }
    }

    _clonePipToVertical(screenContent, programArea) {
        const pipProgram = programArea.querySelector('.vereador-pip');
        const pipVertical = screenContent.querySelector('.vereador-pip');
        if (pipVertical) {
            const v = pipVertical.querySelector('.vereador-pip-video');
            if (v) { v.pause(); v.srcObject = null; }
            pipVertical.remove();
        }
        if (pipProgram) {
            const slotId = parseInt(pipProgram.dataset.slot);
            const stream = this.vereadorManager.connections[slotId];
            const slot = this.vereadorManager.slots.find(s => s.id === slotId);
            const pip = document.createElement('div');
            pip.className = 'vereador-pip';
            pip.dataset.slot = slotId;
            pip.innerHTML = `
                <div class="vereador-pip-video-wrapper">
                    <video class="vereador-pip-video" autoplay playsinline muted></video>
                </div>
            `;
            pip.style.width = pipProgram.style.width || '';
            pip.style.height = pipProgram.style.height || '';
            screenContent.appendChild(pip);
            const video = pip.querySelector('.vereador-pip-video');
            if (video && stream) {
                video.srcObject = stream;
                video.play().catch(() => {});
            }
        }
    }

    _applyFloatingStyles() {
        const v = this.settings?.vertical;
        if (!v) return;
        const floatScreen = document.querySelector('.float-screen');
        const logoEl = document.getElementById('float-logo');
        if (!floatScreen) return;

        if (v.backgroundImage) {
            floatScreen.style.backgroundImage = `url('${v.backgroundImage}')`;
            floatScreen.style.backgroundSize = 'cover';
            floatScreen.style.backgroundPosition = 'center';
        } else {
            floatScreen.style.backgroundImage = null;
            floatScreen.style.backgroundSize = 'cover';
            floatScreen.style.backgroundPosition = 'center';
        }

        // Logo
        if (logoEl) {
            const logo = v.logo;
            if (logo.src) {
                logoEl.style.backgroundImage = `url('${logo.src}')`;
                logoEl.style.display = 'block';
                logoEl.style.width = logo.width + 'px';
                logoEl.style.height = logo.height + 'px';
                logoEl.style.top = logo.y + 'px';
                logoEl.style.right = logo.x + 'px';
                logoEl.style.left = 'auto';
                logoEl.style.bottom = 'auto';
            } else {
                logoEl.style.backgroundImage = '';
                logoEl.style.display = 'none';
            }
        }
    }

    _resizeScreenContent() {
        const sc = document.querySelector('.screen-content');
        if (!sc) return;
        let w = sc.getBoundingClientRect().width;
        if (w <= 0) w = sc.parentElement?.getBoundingClientRect().width || 0;
        if (w <= 0) w = 200;
        sc.style.height = (w * 9 / 16) + 'px';
    }

    _setupLogoDrag() {
        const logoEl = document.getElementById('float-logo');
        const container = document.querySelector('.screen-content');
        if (!logoEl || !container) return;

        let isDragging = false, isResizing = false;
        let startX, startY, origX, origY, origW, origH;

        const onMove = (clientX, clientY) => {
            if (isDragging) {
                const rect = container.getBoundingClientRect();
                const dx = clientX - startX;
                const dy = clientY - startY;
                let newRight = Math.max(0, origX - dx);
                let newTop = Math.max(0, origY + dy);
                newRight = Math.min(newRight, rect.width - logoEl.offsetWidth);
                newTop = Math.min(newTop, rect.height - logoEl.offsetHeight);
                logoEl.style.right = newRight + 'px';
                logoEl.style.top = newTop + 'px';
                logoEl.style.left = 'auto';
                logoEl.style.bottom = 'auto';
            }
            if (isResizing) {
                const dx = clientX - startX;
                const dy = clientY - startY;
                const newW = Math.max(16, Math.min(300, origW + dx));
                const newH = Math.max(16, Math.min(300, origH + dy));
                logoEl.style.width = newW + 'px';
                logoEl.style.height = newH + 'px';
            }
        };

        const onUp = () => {
            if (isDragging) {
                isDragging = false;
                logoEl.classList.remove('dragging');
                if (this.settings?.vertical) {
                    this.settings.vertical.logo.x = parseFloat(logoEl.style.right) || 8;
                    this.settings.vertical.logo.y = parseFloat(logoEl.style.top) || 8;
                    this.settings.vertical.logo.width = logoEl.offsetWidth;
                    this.settings.vertical.logo.height = logoEl.offsetHeight;
                }
            }
            if (isResizing) {
                isResizing = false;
                if (this.settings?.vertical) {
                    this.settings.vertical.logo.width = logoEl.offsetWidth;
                    this.settings.vertical.logo.height = logoEl.offsetHeight;
                }
            }
        };

        // Drag: mousedown on logo
        logoEl.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('float-logo-resize-handle')) return;
            e.preventDefault();
            isDragging = true;
            logoEl.classList.add('dragging');
            startX = e.clientX;
            startY = e.clientY;
            origX = parseFloat(logoEl.style.right) || 8;
            origY = parseFloat(logoEl.style.top) || 8;
        });

        // Resize: mousedown on handle
        const resizeHandle = logoEl.querySelector('.float-logo-resize-handle');
        if (resizeHandle) {
            resizeHandle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                isResizing = true;
                startX = e.clientX;
                startY = e.clientY;
                origW = logoEl.offsetWidth;
                origH = logoEl.offsetHeight;
            });
        }

        // Global mouse move/up
        document.addEventListener('mousemove', (e) => {
            if (isDragging || isResizing) onMove(e.clientX, e.clientY);
        });
        document.addEventListener('mouseup', onUp);

        // Touch support
        logoEl.addEventListener('touchstart', (e) => {
            if (e.target.classList.contains('float-logo-resize-handle')) return;
            const t = e.touches[0];
            isDragging = true;
            logoEl.classList.add('dragging');
            startX = t.clientX;
            startY = t.clientY;
            origX = parseFloat(logoEl.style.right) || 8;
            origY = parseFloat(logoEl.style.top) || 8;
        }, { passive: true });

        if (resizeHandle) {
            resizeHandle.addEventListener('touchstart', (e) => {
                e.stopPropagation();
                const t = e.touches[0];
                isResizing = true;
                startX = t.clientX;
                startY = t.clientY;
                origW = logoEl.offsetWidth;
                origH = logoEl.offsetHeight;
            }, { passive: true });
        }

        document.addEventListener('touchmove', (e) => {
            if (isDragging || isResizing) {
                const t = e.touches[0];
                onMove(t.clientX, t.clientY);
            }
        }, { passive: true });
        document.addEventListener('touchend', onUp);
    }

    _applyPreviewStyles() {
        const h = this.settings?.horizontal;
        if (!h) return;
        const previewArea = document.getElementById('preview-area');
        const logoEl = document.getElementById('preview-logo');
        if (!previewArea) return;

        if (h.backgroundImage) {
            previewArea.style.backgroundImage = `url('${h.backgroundImage}')`;
            previewArea.style.backgroundSize = 'cover';
            previewArea.style.backgroundPosition = 'center';
        } else {
            previewArea.style.backgroundImage = '';
        }

        if (logoEl) {
            const logo = h.logo;
            if (logo.src) {
                logoEl.style.backgroundImage = `url('${logo.src}')`;
                logoEl.style.display = 'block';
                logoEl.style.width = logo.width + 'px';
                logoEl.style.height = logo.height + 'px';
                logoEl.style.top = logo.y + 'px';
                logoEl.style.right = logo.x + 'px';
                logoEl.style.left = 'auto';
                logoEl.style.bottom = 'auto';
            } else {
                logoEl.style.backgroundImage = '';
                logoEl.style.display = 'none';
            }
        }
    }

    _setupPreviewLogoDrag() {
        const logoEl = document.getElementById('preview-logo');
        const previewArea = document.getElementById('preview-area');
        if (!logoEl || !previewArea) return;

        let isDragging = false, isResizing = false;
        let startX, startY, origX, origY, origW, origH;

        const onMove = (clientX, clientY) => {
            if (isDragging) {
                const rect = previewArea.getBoundingClientRect();
                const dx = clientX - startX;
                const dy = clientY - startY;
                let newRight = Math.max(0, origX - dx);
                let newTop = Math.max(0, origY + dy);
                newRight = Math.min(newRight, rect.width - logoEl.offsetWidth);
                newTop = Math.min(newTop, rect.height - logoEl.offsetHeight);
                logoEl.style.right = newRight + 'px';
                logoEl.style.top = newTop + 'px';
                logoEl.style.left = 'auto';
                logoEl.style.bottom = 'auto';
            }
            if (isResizing) {
                const dx = clientX - startX;
                const dy = clientY - startY;
                const newW = Math.max(16, Math.min(300, origW + dx));
                const newH = Math.max(16, Math.min(300, origH + dy));
                logoEl.style.width = newW + 'px';
                logoEl.style.height = newH + 'px';
            }
        };

        const onUp = () => {
            if (isDragging) {
                isDragging = false;
                logoEl.classList.remove('dragging');
                if (this.settings?.horizontal) {
                    this.settings.horizontal.logo.x = parseFloat(logoEl.style.right) || 8;
                    this.settings.horizontal.logo.y = parseFloat(logoEl.style.top) || 8;
                    this.settings.horizontal.logo.width = logoEl.offsetWidth;
                    this.settings.horizontal.logo.height = logoEl.offsetHeight;
                }
            }
            if (isResizing) {
                isResizing = false;
                if (this.settings?.horizontal) {
                    this.settings.horizontal.logo.width = logoEl.offsetWidth;
                    this.settings.horizontal.logo.height = logoEl.offsetHeight;
                }
            }
        };

        logoEl.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('preview-logo-resize-handle')) return;
            e.preventDefault();
            isDragging = true;
            logoEl.classList.add('dragging');
            startX = e.clientX;
            startY = e.clientY;
            origX = parseFloat(logoEl.style.right) || 8;
            origY = parseFloat(logoEl.style.top) || 8;
        });

        const resizeHandle = logoEl.querySelector('.preview-logo-resize-handle');
        if (resizeHandle) {
            resizeHandle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                isResizing = true;
                startX = e.clientX;
                startY = e.clientY;
                origW = logoEl.offsetWidth;
                origH = logoEl.offsetHeight;
            });
        }

        document.addEventListener('mousemove', (e) => {
            if (isDragging || isResizing) onMove(e.clientX, e.clientY);
        });
        document.addEventListener('mouseup', onUp);

        logoEl.addEventListener('touchstart', (e) => {
            if (e.target.classList.contains('preview-logo-resize-handle')) return;
            const t = e.touches[0];
            isDragging = true;
            logoEl.classList.add('dragging');
            startX = t.clientX;
            startY = t.clientY;
            origX = parseFloat(logoEl.style.right) || 8;
            origY = parseFloat(logoEl.style.top) || 8;
        }, { passive: true });

        if (resizeHandle) {
            resizeHandle.addEventListener('touchstart', (e) => {
                e.stopPropagation();
                const t = e.touches[0];
                isResizing = true;
                startX = t.clientX;
                startY = t.clientY;
                origW = logoEl.offsetWidth;
                origH = logoEl.offsetHeight;
            }, { passive: true });
        }

        document.addEventListener('touchmove', (e) => {
            if (isDragging || isResizing) {
                const t = e.touches[0];
                onMove(t.clientX, t.clientY);
            }
        }, { passive: true });
        document.addEventListener('touchend', onUp);
    }

    mirrorPreviewToProgram() {
        const previewArea  = document.getElementById('preview-area');
        const programArea  = document.getElementById('program-area');
        const placeholder  = document.getElementById('program-placeholder');
        if (!previewArea || !programArea) return;

        [...previewArea.children].forEach(child => {
            if (child.classList.contains('screen-placeholder') || child.classList.contains('vereador-pip')) return;
            const clone = child.cloneNode(true);
            programArea.appendChild(clone);
        });
        programArea.style.backgroundColor = previewArea.style.backgroundColor;
        if (previewArea.style.backgroundImage) {
            programArea.style.backgroundImage = previewArea.style.backgroundImage;
            programArea.style.backgroundSize = previewArea.style.backgroundSize || 'cover';
            programArea.style.backgroundPosition = previewArea.style.backgroundPosition || 'center';
        }
        if (placeholder) placeholder.style.display = 'none';

        // Copia PiP (apenas 1) do preview para o programa
        const pipPreview = previewArea.querySelector('.vereador-pip');
        const pipProgram = programArea.querySelector('.vereador-pip');
        if (pipProgram) {
            const v = pipProgram.querySelector('.vereador-pip-video');
            if (v) { v.pause(); v.srcObject = null; }
            pipProgram.remove();
        }
        if (pipPreview) {
            const slotId = parseInt(pipPreview.dataset.slot);
            const stream = this.vereadorManager.connections[slotId];
            const slot = this.vereadorManager.slots.find(s => s.id === slotId);
            const pip = document.createElement('div');
            pip.className = 'vereador-pip';
            pip.dataset.slot = slotId;
            pip.innerHTML = `
                <div class="vereador-pip-video-wrapper">
                    <video class="vereador-pip-video" autoplay playsinline muted></video>
                </div>
            `;
            pip.style.width = pipPreview.style.width || '';
            pip.style.height = pipPreview.style.height || '';
            pip.style.maxHeight = pipPreview.style.maxHeight || '';
            programArea.appendChild(pip);
            const video = pip.querySelector('.vereador-pip-video');
            if (video && stream) {
                video.srcObject = stream;
                video.play().catch(() => {});
            }
        }
        if (placeholder) placeholder.style.display = 'none';
    }

    stopStreaming() {
        if (!this.isStreaming) return;
        this.isStreaming = false;
        this.updateButtonStates();

        const programVideo = document.getElementById('program-video');
        const programArea  = document.getElementById('program-area');
        const placeholder  = document.getElementById('program-placeholder');

        if (programVideo) { programVideo.srcObject = null; programVideo.style.display = 'none'; }
        if (programArea)  {
            [...programArea.children].forEach(child => {
                if (!child.classList.contains('screen-placeholder') && child.id !== 'program-video' && child.id !== 'program-canvas' && !child.classList.contains('vereador-pip'))
                    child.remove();
            });
            programArea.style.backgroundColor = '';
        }
        if (placeholder) placeholder.style.display = 'flex';
        this.stopProgramMirror();

        // Para WHIP per-target (StreamManager)
        this.streamManager.stopAll();

        // Para VDO.Ninja
        if (this.vereadorManager?.vdo) {
            this.vereadorManager.stopProgramPublish();
        }

        this.showNotification('⬛ Transmissão parada.');
    }

    _getProgramStream() {
        const programVideo = document.getElementById('program-video');
        if (programVideo?.srcObject instanceof MediaStream) {
            return programVideo.srcObject;
        }
        const activeId = this.activeSource;
        if (activeId && this.mediaStreams[activeId]) {
            const src = this.mediaStreams[activeId];
            const tracks = [];
            src.getVideoTracks().forEach(t => tracks.push(t.clone()));
            src.getAudioTracks().forEach(t => tracks.push(t.clone()));
            if (tracks.length > 0) return new MediaStream(tracks);
        }
        return null;
    }

    _renderProgramCanvas() {
        const canvas = document.getElementById('program-canvas');
        if (!canvas) return;
        const programArea = document.getElementById('program-area');
        if (!programArea) return;
        const programVideo = document.getElementById('program-video');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = 1280;
        canvas.height = 720;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const bg = programArea.style.backgroundColor || '#000';
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        if (programVideo?.srcObject && programVideo.style.display !== 'none' && programVideo.readyState > 0) {
            try {
                const vw = programVideo.videoWidth || 1280;
                const vh = programVideo.videoHeight || 720;
                const sx = 0, sy = 0, sw = vw, sh = vh;
                const aspect = vw / vh;
                let dx, dy, dw, dh;
                if (aspect > 16 / 9) {
                    dh = canvas.height;
                    dw = dh * aspect;
                    dx = (canvas.width - dw) / 2;
                    dy = 0;
                } else {
                    dw = canvas.width;
                    dh = dw / aspect;
                    dx = 0;
                    dy = (canvas.height - dh) / 2;
                }
                ctx.drawImage(programVideo, sx, sy, sw, sh, dx, dy, dw, dh);
            } catch (e) {}
        }

        const programLogo = programArea.querySelector('.preview-logo');
        if (programLogo) {
            const bgImg = programLogo.style.backgroundImage;
            if (bgImg && bgImg.startsWith('url(')) {
                const img = new Image();
                img.onload = () => {
                    const lw = parseInt(programLogo.style.width) || 60;
                    const lh = parseInt(programLogo.style.height) || 60;
                    const lx = programLogo.offsetLeft || 8;
                    const ly = programLogo.offsetTop || 8;
                    ctx.drawImage(img, lx, ly, lw, lh);
                };
                img.src = bgImg.slice(5, -2);
            }
        }

        programArea.querySelectorAll('.vereador-pip video').forEach(v => {
            if (v.srcObject && v.readyState > 0) {
                try {
                    const rect = v.closest('.vereador-pip').getBoundingClientRect();
                    const pRect = programArea.getBoundingClientRect();
                    const rx = rect.left - pRect.left;
                    const ry = rect.top - pRect.top;
                    const rw = rect.width;
                    const rh = rect.height;
                    const sx2 = rect.width / programArea.offsetWidth * canvas.width;
                    const sy2 = rect.height / programArea.offsetHeight * canvas.height;
                    const dx2 = rx / programArea.offsetWidth * canvas.width;
                    const dy2 = ry / programArea.offsetHeight * canvas.height;
                    ctx.drawImage(v, 0, 0, v.videoWidth || 320, v.videoHeight || 240, dx2, dy2, sx2, sy2);
                } catch (e) {}
            }
        });
    }

    // ─────────────────────────────────────────
    //  GRAVAÇÃO
    // ─────────────────────────────────────────
    toggleRecording() {
        const recordBtn = document.getElementById('record-btn');
        if (!recordBtn) return;

        if (!this.isRecording) {
            this._startRecording(recordBtn);
        } else {
            this._stopRecording(recordBtn);
        }
    }

    _startRecording(recordBtn) {
        if (typeof MediaRecorder === 'undefined') {
            this.showNotification('⚠️ Gravação não suportada neste navegador');
            return;
        }
        const stream = this._getRecordingStream();
        if (!stream) {
            this.showNotification('⚠️ Nenhuma fonte ativa para gravar');
            return;
        }

        try {
            const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
                ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
                : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
                ? 'video/webm;codecs=vp9,opus'
                : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
                ? 'video/webm;codecs=vp8,opus'
                : 'video/webm';
            const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';

            this._mediaRecorder = new MediaRecorder(stream, { mimeType });
            this._recordedChunks = [];

            this._mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this._recordedChunks.push(e.data);
            };

            this._mediaRecorder.onerror = (e) => {
                console.error('[OBS] Erro no MediaRecorder:', e.error);
                this.showNotification('❌ Erro na gravação');
                this.isRecording = false;
                recordBtn.classList.remove('recording');
                recordBtn.textContent = '⏺ Gravar';
            };

            this._mediaRecorder.onstop = () => {
                const blob = new Blob(this._recordedChunks, { type: mimeType });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                a.href = url;
                a.download = `NossaTV_Gravacao_${ts}.${ext}`;
                a.click();
                URL.revokeObjectURL(url);
                this._recordedChunks = [];
                this._recordingStream = null;
                this.showNotification(`✅ Gravação salva (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
            };

            this._mediaRecorder.start(1000);
            this.isRecording = true;
            this._recordingStream = stream;
            recordBtn.classList.add('recording');
            recordBtn.textContent = '⏹ Parar Gravação';
            this.showNotification('⏺ Gravação iniciada');
        } catch (e) {
            console.error('[OBS] Erro ao iniciar MediaRecorder:', e);
            this.showNotification(`❌ Erro ao iniciar gravação: ${e.message}`);
        }
    }

    _stopRecording(recordBtn) {
        if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
            try { this._mediaRecorder.stop(); } catch (e) { console.warn('[OBS] MediaRecorder já estava parado:', e); }
        }
        if (this._recordingStream) {
            this._recordingStream.getTracks().forEach(t => t.stop());
            this._recordingStream = null;
        }
        this.isRecording = false;
        recordBtn.classList.remove('recording');
        recordBtn.textContent = '⏺ Gravar';
    }

    _getRecordingStream() {
        const activeId = this.activeSource;
        if (activeId && this.mediaStreams[activeId]) {
            const sourceStream = this.mediaStreams[activeId];
            const tracks = [];
            sourceStream.getVideoTracks().forEach(t => tracks.push(t.clone()));
            sourceStream.getAudioTracks().forEach(t => tracks.push(t.clone()));
            if (tracks.length > 0) return new MediaStream(tracks);
        }
        const programCanvas = document.getElementById('program-canvas');
        if (programCanvas) {
            try { return programCanvas.captureStream(30); } catch (e) { console.warn('[OBS] captureStream não suportado:', e); }
        }
        return null;
    }

    async toggleVirtualCam() {
        const btn = document.getElementById('virtual-cam-btn');
        if (!btn) return;

        // Stop
        if (this.vereadorManager?.isVirtualCameraActive()) {
            this.vereadorManager.stopVirtualCamera();
            this.isVirtualCam = false;
            btn.classList.remove('active');
            btn.textContent = '📷 Câmera Virtual';
            document.getElementById('modal-vcam').style.display = 'none';
            this._removeVcamBadge();
            this.showNotification('📷 Câmera virtual parada');
            return;
        }

        // Start
        btn.textContent = '📷 Iniciando...';
        btn.disabled = true;

        try {
            const stream = this._getProgramStream();
            if (!stream) {
                this.showNotification('⚠️ Nenhuma fonte de vídeo ativa no programa');
                btn.textContent = '📷 Câmera Virtual';
                btn.disabled = false;
                return;
            }

            const link = await this.vereadorManager.startVirtualCamera(stream);
            this.isVirtualCam = true;
            btn.classList.add('active');
            btn.textContent = '📷 Cam. Virtual (Ativa)';
            btn.disabled = false;

            this._addVcamBadge();
            this._showVirtualCamLink(link);
            this.showNotification('📷 Câmera virtual ativa! Link copiado.');
        } catch (e) {
            console.error('[OBS] Erro ao iniciar câmera virtual:', e);
            this.showNotification('⚠️ Erro: ' + (e.message || 'conexão VDO.Ninja'));
            btn.textContent = '📷 Câmera Virtual';
            btn.disabled = false;
        }
    }

    _addVcamBadge() {
        let badge = document.getElementById('vcam-badge');
        if (badge) return;
        badge = document.createElement('div');
        badge.id = 'vcam-badge';
        badge.className = 'vcam-badge';
        badge.innerHTML = '<span class="status-dot status-online"></span> Câmera Virtual Ativa';
        badge.title = 'Clique para ver o link';
        badge.addEventListener('click', () => {
            const input = document.getElementById('vcam-link-input');
            if (input && input.value) {
                document.getElementById('modal-vcam').style.display = 'flex';
            }
        });
        document.body.appendChild(badge);
    }

    _removeVcamBadge() {
        const badge = document.getElementById('vcam-badge');
        if (badge) badge.remove();
    }

    _showVirtualCamLink(link) {
        const modal = document.getElementById('modal-vcam');
        const input = document.getElementById('vcam-link-input');
        const qrCanvas = document.getElementById('vcam-qr-canvas');
        const status = document.getElementById('vcam-status');

        if (!modal || !input) return;

        input.value = link;
        if (status) {
            status.innerHTML = '<span class="status-dot status-online"></span> Online — compartilhe o link abaixo';
        }

        if (qrCanvas) {
            setTimeout(() => generateQRCode(qrCanvas, link), 50);
        }

        modal.style.display = 'flex';

        navigator.clipboard.writeText(link).catch(() => {});
    }

    toggleStudioMode() {
        this.isStudioMode = !this.isStudioMode;
        const btn = document.getElementById('studio-mode-btn');
        if (!btn) return;
        btn.classList.toggle('active', this.isStudioMode);
        btn.textContent = this.isStudioMode ? '🎬 Estúdio (Ativo)' : '🎬 Modo Estúdio';
        this.showNotification(this.isStudioMode ? '🎬 Modo Estúdio ativado' : '🎬 Modo Estúdio desativado');
    }

    projectProgram(width, height) {
        width = width || 1920;
        height = height || 1080;
        const sw = Math.min(width, screen.availWidth);
        const sh = Math.min(height, screen.availHeight);
        const w = window.open('', 'projetar', `width=${sw},height=${sh},menubar=no,toolbar=no,location=no,status=no`);
        if (!w) { this.showNotification('⚠️ Permita pop-ups para projetar o programa.'); return; }
        w.document.write(`<!DOCTYPE html>
<html><head><title>Programa — Projetar</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#000;overflow:hidden}
body{display:flex;align-items:center;justify-content:center}
#proj-screen{width:100vw;height:100vh;position:relative;display:flex;align-items:center;justify-content:center;background-size:contain;background-position:center;background-repeat:no-repeat;background-color:#000}
#proj-screen>*{position:absolute;pointer-events:none}
#proj-screen .screen-placeholder{position:relative;color:#555;font-size:2em;z-index:1;text-align:center}
#proj-screen video{width:100%;height:100%;object-fit:contain}
#proj-screen img{width:100%;height:100%;object-fit:contain;transform:scale(2);transform-origin:center center}
#proj-screen iframe{width:100%;height:100%;border:none}
#proj-screen .source-text-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:2em;font-weight:bold;text-align:center;padding:16px;z-index:2}
.vereador-pip{position:absolute;bottom:8px;left:8px;z-index:20;overflow:hidden;background:#000;width:auto;min-width:60px;max-height:80px}
.vereador-pip-video-wrapper{aspect-ratio:16/9;position:relative;overflow:hidden;background:#000}
.vereador-pip-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.vereador-pip-name{flex:1;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status-dot{display:inline-block;width:5px;height:5px;border-radius:50%;flex-shrink:0}
.status-online{background:#44cc44}
.preview-logo{position:absolute;top:8px;right:8px;width:60px;height:60px;z-index:10;background-size:contain;background-repeat:no-repeat;background-position:center}
#proj-ctrl-btn{position:fixed;top:8px;right:8px;z-index:999;background:rgba(0,0,0,0.5);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:4px 10px;font-size:0.85em;cursor:pointer;pointer-events:all;transition:background 0.15s;opacity:0.4}
#proj-ctrl-btn:hover{opacity:1;background:rgba(0,102,204,0.7)}

</style></head><body>
<button id="proj-ctrl-btn">⛶ Tela Cheia</button>
<div id="proj-screen"><span class="screen-placeholder">Programa não iniciado</span></div>
<script>
var fsBtn=document.getElementById('proj-ctrl-btn');
fsBtn.addEventListener('click',function(){
    if(document.fullscreenElement){document.exitFullscreen()}else{document.documentElement.requestFullscreen()}
});
document.addEventListener('fullscreenchange',function(){
    fsBtn.textContent=document.fullscreenElement?'✕ Sair Tela Cheia':'⛶ Tela Cheia';
});
function syncVids(s,d){
    s.querySelectorAll('video[id]').forEach(function(v){
        if(!v.srcObject)return;
        var dv=d.querySelector('video#'+v.id);
        if(dv&&dv.srcObject!==v.srcObject){dv.srcObject=v.srcObject;dv.play().catch(function(){});}
    });
    s.querySelectorAll('.vereador-pip').forEach(function(sp){
        var sv=sp.querySelector('video');if(!sv||!sv.srcObject)return;
        var dp=d.querySelector('.vereador-pip[data-slot="'+sp.dataset.slot+'"]');if(!dp)return;
        var dv=dp.querySelector('video');
        if(dv&&dv.srcObject!==sv.srcObject){dv.srcObject=sv.srcObject;dv.play().catch(function(){});}
    });
}
function cloneKids(s,d){
    var kids=[].slice.call(s.children).filter(function(c){return !c.classList.contains('screen-placeholder')&&c.id!=='program-canvas';});
    kids.forEach(function(c){
        var k=c.id||c.className||c.tagName+'_'+Math.random();
        if(c.dataset&&c.dataset.slot)k+='_slot'+c.dataset.slot;
        var ex=[].find.call(d.children,function(x){return x.dataset.key===k});
        if(ex&&ex.parentNode){
            if(c.tagName==='VIDEO'&&c.srcObject&&ex.srcObject!==c.srcObject){ex.srcObject=c.srcObject;ex.play().catch(function(){});}
            if(c.tagName==='IMG'&&c.src!==ex.src)ex.src=c.src;
            if(c.tagName==='IFRAME'&&c.src!==ex.src)ex.src=c.src;
            ex.style.cssText=c.style.cssText;
        }else{
            if(ex)ex.remove();
            var cl=c.cloneNode(true);cl.dataset.key=k;
            if(cl.tagName==='VIDEO'&&c.srcObject){cl.srcObject=c.srcObject;cl.play().catch(function(){});}
            d.appendChild(cl);
        }
    });
    syncVids(s,d);
    [].slice.call(d.children).forEach(function(x){
        if(x.classList.contains('screen-placeholder'))return;
        var alive=false;
        kids.forEach(function(sc){
            var sk=sc.id||sc.className||'';if(sc.dataset&&sc.dataset.slot)sk+='_slot'+sc.dataset.slot;
            if(x.dataset.key===sk||(sc.id&&x.id===sc.id))alive=true;
        });
        if(!alive)x.remove();
    });
}

function upd(){
    try{
        var o=window.opener;if(!o)return;
        var pa=o.document.getElementById('program-area'),s=document.getElementById('proj-screen');
        if(!pa||!s)return;
        s.style.backgroundColor=pa.style.backgroundColor||'#000';s.style.backgroundImage=pa.style.backgroundImage||'';
        cloneKids(pa,s);
        var h=s.querySelector(':scope > *:not(.screen-placeholder)'),ph=s.querySelector('.screen-placeholder');
        if(!h){if(!ph){var p=document.createElement('span');p.className='screen-placeholder';p.textContent='Programa não iniciado';s.appendChild(p);}}else if(ph){ph.remove();}
    }catch(e){console.warn('[Proj] Erro ao sincronizar:',e);}
}
var t=setInterval(upd,200);upd();
window.addEventListener('beforeunload',function(){clearInterval(t);});
<\/script>
</body></html>`);
        w.document.close();
        setTimeout(() => { try { w.moveTo(0,0); w.resizeTo(screen.availWidth, screen.availHeight); } catch(e) { console.warn('[OBS] Erro ao redimensionar janela:', e); } }, 100);
        this.showNotification(`📺 Programa projetado — arraste para o monitor desejado`);
    }

    // ─────────────────────────────────────────
    //  CONFIGURAÇÕES
    // ─────────────────────────────────────────
    _defaultSettings() {
        return {
            stream: {
                targets: [
                    { id: 1, platform: 'youtube', key: '', orientation: 'horizontal', enabled: true, bitrate: 0, resolution: '', fps: 0 },
                ],
            },
            whip: {
                enabled: false,
                endpoint: '',
            },
            output: { videoBitrate: 3500, audioBitrate: 192, recordQuality: 'medium' },
            video:  { baseRes: '1280x720', outputRes: '1280x720', fps: 30, downscale: 'bicubic' },
            audio:  { sampleRate: 48000, globalDevice: 'default' },
            general: { theme: 'dark', language: 'pt-BR' },
            vertical: {
                backgroundImage: '',
                logo: { src: '', x: 8, y: 8, width: 60, height: 60 },
            },
            horizontal: {
                backgroundImage: '',
                logo: { src: '', x: 8, y: 8, width: 60, height: 60 },
            },
        };
    }

    _loadSettings() {
        try {
            const raw = localStorage.getItem('obsSettings');
            if (raw) {
                const saved = JSON.parse(raw);
                const def = this._defaultSettings();
                // Merge deep
                for (const cat in def) {
                    if (saved[cat]) {
                        for (const key in def[cat]) {
                            if (saved[cat][key] !== undefined) def[cat][key] = saved[cat][key];
                        }
                    }
                }
                return def;
            }
        } catch (e) { console.warn('[OBS] Erro ao carregar configuracoes:', e); }
        return this._defaultSettings();
    }

    _saveSettings() {
        localStorage.setItem('obsSettings', JSON.stringify(this.settings));
    }

    _setupSettingsUI() {
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                const pane = document.getElementById('pane-' + tab.dataset.tab);
                if (pane) pane.classList.add('active');
            });
        });
        document.getElementById('add-stream-target-btn')?.addEventListener('click', () => {
            const targets = this.settings.stream.targets;
            const maxId = targets.reduce((m, t) => Math.max(m, t.id), 0);
            targets.push({ id: maxId + 1, platform: 'rtmp', key: '', url: '', orientation: 'horizontal', enabled: true, bitrate: 0, resolution: '', fps: 0 });
            this._renderStreamTargets();
        });

        document.getElementById('generate-whip-config')?.addEventListener('click', () => {
            const targets = this.settings.stream.targets.filter(t => t.enabled);
            if (targets.length === 0) {
                this.showNotification('⚠️ Adicione pelo menos um destino RTMP válido');
                return;
            }
            this.streamManager.configure(targets, this.settings.whip.endpoint);
            this.streamManager.generateMediaMTXConfig();
            this.showNotification('✅ Config MediaMTX gerada! Salve como mediamtx.yml junto ao binário.');
        });

        // Vertical: background image
        document.getElementById('set-vertical-bg-file')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                this.settings.vertical.backgroundImage = ev.target.result;
                this._applyFloatingStyles();
            };
            reader.readAsDataURL(file);
        });
        document.getElementById('clear-vertical-bg')?.addEventListener('click', () => {
            this.settings.vertical.backgroundImage = '';
            document.getElementById('set-vertical-bg-file').value = '';
            this._applyFloatingStyles();
        });

        // Vertical: logo
        document.getElementById('set-vertical-logo-file')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                this.settings.vertical.logo.src = ev.target.result;
                this._applyFloatingStyles();
            };
            reader.readAsDataURL(file);
        });
        document.getElementById('clear-vertical-logo')?.addEventListener('click', () => {
            this.settings.vertical.logo.src = '';
            document.getElementById('set-vertical-logo-file').value = '';
            this._applyFloatingStyles();
        });

        // Live preview: logo size
        ['set-vertical-logo-width', 'set-vertical-logo-height'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', (e) => {
                const v = this.settings.vertical;
                v.logo.width = parseInt(document.getElementById('set-vertical-logo-width').value) || 60;
                v.logo.height = parseInt(document.getElementById('set-vertical-logo-height').value) || 60;
                this._applyFloatingStyles();
            });
        });

        // Horizontal: background image
        document.getElementById('set-horizontal-bg-file')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                this.settings.horizontal.backgroundImage = ev.target.result;
                this._applyPreviewStyles();
            };
            reader.readAsDataURL(file);
        });
        document.getElementById('clear-horizontal-bg')?.addEventListener('click', () => {
            this.settings.horizontal.backgroundImage = '';
            document.getElementById('set-horizontal-bg-file').value = '';
            this._applyPreviewStyles();
        });

        // Horizontal: logo
        document.getElementById('set-horizontal-logo-file')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                this.settings.horizontal.logo.src = ev.target.result;
                this._applyPreviewStyles();
            };
            reader.readAsDataURL(file);
        });
        document.getElementById('clear-horizontal-logo')?.addEventListener('click', () => {
            this.settings.horizontal.logo.src = '';
            document.getElementById('set-horizontal-logo-file').value = '';
            this._applyPreviewStyles();
        });

        // Live preview: horizontal logo size
        ['set-horizontal-logo-width', 'set-horizontal-logo-height'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', (e) => {
                const v = this.settings.horizontal;
                v.logo.width = parseInt(document.getElementById('set-horizontal-logo-width').value) || 60;
                v.logo.height = parseInt(document.getElementById('set-horizontal-logo-height').value) || 60;
                this._applyPreviewStyles();
            });
        });
    }

    _renderStreamTargets() {
        const list = document.getElementById('stream-targets-list');
        if (!list) return;

        const targets = this.settings.stream.targets;

        list.innerHTML = targets.map(t => {
            const platLabels = { youtube: 'YouTube', instagram: 'Instagram', rtmp: 'RTMP Custom' };
            const orientLabel = t.orientation === 'horizontal' ? 'Horizontal (16:9)' : 'Vertical (9:16)';
            return `
                <div class="stream-target-card" data-id="${t.id}" draggable="true">
                    <div class="stream-target-header">
                        <span class="drag-handle">⠿</span>
                        <span class="target-platform">${platLabels[t.platform] || t.platform}</span>
                        <div class="target-actions">
                            <button class="btn-target-toggle ${t.enabled ? 'on' : ''}" data-target-id="${t.id}"></button>
                            <button class="btn-target-remove" data-target-id="${t.id}">✕</button>
                        </div>
                    </div>
                    <div class="stream-target-fields">
                        <div class="form-group">
                            <label>Plataforma</label>
                            <select class="target-platform-select" data-target-id="${t.id}">
                                <option value="youtube" ${t.platform === 'youtube' ? 'selected' : ''}>YouTube</option>
                                <option value="instagram" ${t.platform === 'instagram' ? 'selected' : ''}>Instagram</option>
                                <option value="rtmp" ${t.platform === 'rtmp' ? 'selected' : ''}>RTMP Custom</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>${t.platform === 'rtmp' ? 'URL RTMP' : 'Chave de Stream'}</label>
                            <div style="display:flex;gap:4px">
                                <input type="${t.platform === 'rtmp' ? 'url' : 'password'}" class="target-key" data-target-id="${t.id}" value="${escapeHtml(t.platform === 'rtmp' ? (t.url || '') : (t.key || ''))}" placeholder="${t.platform === 'rtmp' ? 'rtmp://...' : 'Chave...'}" style="flex:1" />
                                ${t.platform !== 'rtmp' ? '<button class="btn-key-toggle" data-target-id="' + t.id + '" title="Mostrar/ocultar chave" style="background:none;border:1px solid #444;color:#888;border-radius:4px;cursor:pointer;padding:4px 8px;font-size:0.85em">👁</button>' : ''}
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Orientação</label>
                            <select class="target-orientation" data-target-id="${t.id}">
                                <option value="horizontal" ${t.orientation === 'horizontal' ? 'selected' : ''}>Horizontal (16:9)</option>
                                <option value="vertical" ${t.orientation === 'vertical' ? 'selected' : ''}>Vertical (9:16)</option>
                            </select>
                        </div>
                        <div class="form-group" style="display:flex;gap:6px">
                            <div style="flex:2">
                                <label>Bitrate</label>
                                <input type="number" class="target-bitrate" data-target-id="${t.id}" value="${t.bitrate || ''}" placeholder="Global" min="500" max="50000" step="100" style="width:100%" />
                            </div>
                            <div style="flex:2">
                                <label>Resolução</label>
                                <select class="target-resolution" data-target-id="${t.id}">
                                    <option value="" ${!t.resolution ? 'selected' : ''}>Global</option>
                                    <option value="1920x1080" ${t.resolution === '1920x1080' ? 'selected' : ''}>1920x1080</option>
                                    <option value="1280x720" ${t.resolution === '1280x720' ? 'selected' : ''}>1280x720</option>
                                    <option value="854x480" ${t.resolution === '854x480' ? 'selected' : ''}>854x480</option>
                                </select>
                            </div>
                            <div style="flex:1">
                                <label>FPS</label>
                                <select class="target-fps" data-target-id="${t.id}">
                                    <option value="" ${!t.fps ? 'selected' : ''}>Global</option>
                                    <option value="60" ${t.fps === 60 ? 'selected' : ''}>60</option>
                                    <option value="30" ${t.fps === 30 ? 'selected' : ''}>30</option>
                                    <option value="24" ${t.fps === 24 ? 'selected' : ''}>24</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // Attach events
        list.querySelectorAll('.btn-target-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.targetId);
                const t = this.settings.stream.targets.find(x => x.id === id);
                if (t) { t.enabled = !t.enabled; this._renderStreamTargets(); }
            });
        });

        list.querySelectorAll('.btn-target-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.targetId);
                this.settings.stream.targets = this.settings.stream.targets.filter(x => x.id !== id);
                this._renderStreamTargets();
            });
        });

        list.querySelectorAll('.target-platform-select').forEach(sel => {
            sel.addEventListener('change', () => {
                const id = parseInt(sel.dataset.targetId);
                const t = this.settings.stream.targets.find(x => x.id === id);
                if (t) { t.platform = sel.value; this._renderStreamTargets(); }
            });
        });

        list.querySelectorAll('.target-key').forEach(inp => {
            inp.addEventListener('input', () => {
                const id = parseInt(inp.dataset.targetId);
                const t = this.settings.stream.targets.find(x => x.id === id);
                if (t) {
                    if (t.platform === 'rtmp') t.url = inp.value;
                    else t.key = inp.value;
                }
            });
        });

        list.querySelectorAll('.target-orientation').forEach(sel => {
            sel.addEventListener('change', () => {
                const id = parseInt(sel.dataset.targetId);
                const t = this.settings.stream.targets.find(x => x.id === id);
                if (t) t.orientation = sel.value;
            });
        });

        list.querySelectorAll('.btn-key-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.targetId);
                const inp = list.querySelector(`.target-key[data-target-id="${id}"]`);
                if (!inp) return;
                if (inp.type === 'password') {
                    inp.type = 'text';
                    btn.textContent = '🙈';
                } else {
                    inp.type = 'password';
                    btn.textContent = '👁';
                }
            });
        });

        list.querySelectorAll('.target-bitrate').forEach(inp => {
            inp.addEventListener('input', () => {
                const id = parseInt(inp.dataset.targetId);
                const t = this.settings.stream.targets.find(x => x.id === id);
                if (t) t.bitrate = parseInt(inp.value) || 0;
            });
        });

        list.querySelectorAll('.target-resolution').forEach(sel => {
            sel.addEventListener('change', () => {
                const id = parseInt(sel.dataset.targetId);
                const t = this.settings.stream.targets.find(x => x.id === id);
                if (t) t.resolution = sel.value;
            });
        });

        list.querySelectorAll('.target-fps').forEach(sel => {
            sel.addEventListener('change', () => {
                const id = parseInt(sel.dataset.targetId);
                const t = this.settings.stream.targets.find(x => x.id === id);
                if (t) t.fps = parseInt(sel.value) || 0;
            });
        });

        // Drag & drop for stream targets
        this._setupDragDropStreamTargets(list);
    }

    _setupDragDropStreamTargets(list) {
        let draggedEl = null;

        const onStart = (e) => {
            const handle = e.target.closest('.drag-handle');
            if (!handle || e.target.closest('select, input, button')) return;
            draggedEl = e.target.closest('[draggable]');
            if (!draggedEl) return;
            draggedEl.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggedEl.dataset.id);
        };

        const onEnd = () => {
            if (draggedEl) draggedEl.classList.remove('dragging');
            list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            draggedEl = null;
        };

        const onOver = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const target = e.target.closest('[draggable]');
            if (!target || target === draggedEl) return;
            const rect = target.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (e.clientY < mid) target.classList.add('drag-over');
            else target.classList.remove('drag-over');
        };

        const onLeave = (e) => {
            const target = e.target.closest('[draggable]');
            if (target) target.classList.remove('drag-over');
        };

        const onDrop = (e) => {
            e.preventDefault();
            const target = e.target.closest('[draggable]');
            if (!target || !draggedEl) return;

            const fromId = parseInt(draggedEl.dataset.id);
            const toId = parseInt(target.dataset.id);
            if (fromId === toId) return;

            const arr = this.settings.stream.targets;
            const fromIdx = arr.findIndex(x => x.id === fromId);
            const toIdx = arr.findIndex(x => x.id === toId);
            if (fromIdx === -1 || toIdx === -1) return;
            const [moved] = arr.splice(fromIdx, 1);
            arr.splice(toIdx, 0, moved);
            this._renderStreamTargets();

            list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            draggedEl = null;
        };

        list.addEventListener('dragstart', onStart);
        list.addEventListener('dragend', onEnd);
        list.addEventListener('dragover', onOver);
        list.addEventListener('dragleave', onLeave);
        list.addEventListener('drop', onDrop);
    }

    openSettings() {
        const s = this.settings;

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
        };

        this._renderStreamTargets();

        setVal('set-video-bitrate', s.output.videoBitrate);
        setVal('set-audio-bitrate', s.output.audioBitrate);
        setVal('set-record-quality', s.output.recordQuality);
        setVal('set-base-res', s.video.baseRes);
        setVal('set-output-res', s.video.outputRes);
        setVal('set-fps', s.video.fps);
        setVal('set-downscale', s.video.downscale);
        setVal('set-sample-rate', s.audio.sampleRate);
        setVal('set-global-audio', s.audio.globalDevice);
        setVal('set-theme', s.general.theme);
        setVal('set-language', s.general.language);

        setVal('set-vertical-logo-width', s.vertical.logo.width);
        setVal('set-vertical-logo-height', s.vertical.logo.height);

        setVal('set-horizontal-logo-width', s.horizontal.logo.width);
        setVal('set-horizontal-logo-height', s.horizontal.logo.height);

        // WHIP settings
        const whipToggle = document.getElementById('toggle-whip');
        if (whipToggle) whipToggle.checked = s.whip.enabled;
        setVal('set-whip-endpoint', s.whip.endpoint);

        document.getElementById('modal-settings').style.display = 'flex';
    }

    closeSettings() {
        document.getElementById('modal-settings').style.display = 'none';
    }

    saveSettings() {
        const g = (id) => { const el = document.getElementById(id); return el ? el.value : null; };

        this.settings.output.videoBitrate = this._validateNumber(g('set-video-bitrate'), 500, 10000, 3500);
        this.settings.output.audioBitrate = [64, 128, 160, 192, 256, 320].includes(parseInt(g('set-audio-bitrate')))
            ? parseInt(g('set-audio-bitrate')) : 192;
        this.settings.output.recordQuality = ['high', 'medium', 'low', 'lossless'].includes(g('set-record-quality'))
            ? g('set-record-quality') : 'medium';
        this.settings.video.baseRes = ['1920x1080', '1280x720', '854x480'].includes(g('set-base-res'))
            ? g('set-base-res') : '1280x720';
        this.settings.video.outputRes = ['1920x1080', '1280x720', '854x480'].includes(g('set-output-res'))
            ? g('set-output-res') : '1280x720';
        this.settings.video.fps = [60, 30, 24].includes(parseInt(g('set-fps')))
            ? parseInt(g('set-fps')) : 30;
        this.settings.video.downscale = ['bilinear', 'bicubic', 'lanczos'].includes(g('set-downscale'))
            ? g('set-downscale') : 'bicubic';
        this.settings.audio.sampleRate = [44100, 48000].includes(parseInt(g('set-sample-rate')))
            ? parseInt(g('set-sample-rate')) : 48000;
        this.settings.audio.globalDevice = g('set-global-audio') || 'default';
        this.settings.general.theme = ['dark', 'light', 'system'].includes(g('set-theme'))
            ? g('set-theme') : 'dark';
        this.settings.whip.enabled = document.getElementById('toggle-whip')?.checked ?? false;
        this.settings.whip.endpoint = (document.getElementById('set-whip-endpoint')?.value || '').trim();
        this.settings.general.language = ['pt-BR', 'en'].includes(g('set-language'))
            ? g('set-language') : 'pt-BR';

        this.settings.vertical.logo.width = this._validateNumber(g('set-vertical-logo-width'), 16, 300, 60);
        this.settings.vertical.logo.height = this._validateNumber(g('set-vertical-logo-height'), 16, 300, 60);
        this.settings.horizontal.logo.width = this._validateNumber(g('set-horizontal-logo-width'), 16, 300, 60);
        this.settings.horizontal.logo.height = this._validateNumber(g('set-horizontal-logo-height'), 16, 300, 60);

        // Validate stream targets
        this.settings.stream.targets = this.settings.stream.targets.filter(t => {
            if (t.platform === 'rtmp') {
                if (!t.url || !t.url.startsWith('rtmp://')) {
                    return false;
                }
                t.key = '';
            } else {
                if (!t.key || t.key.length < 5) {
                    return false;
                }
                t.url = '';
            }
            return true;
        });

        this._saveSettings();
        this.closeSettings();
        this.showNotification('⚙ Configurações salvas');
    }

    _resumeAudioContexts() {
        for (const id in this.audioChains) {
            const chain = this.audioChains[id];
            if (chain.context && chain.context.state === 'suspended') {
                chain.context.resume().catch(() => {});
            }
        }
    }

    // ─────────────────────────────────────────
    //  ESTADOS DOS BOTÕES
    // ─────────────────────────────────────────
    updateButtonStates() {
        const startBtn = document.getElementById('start-btn');
        const stopBtn  = document.getElementById('stop-btn');
        if (startBtn) startBtn.disabled = this.isStreaming;
        if (stopBtn)  stopBtn.disabled  = !this.isStreaming;
    }

    // ─────────────────────────────────────────
    //  NOTIFICAÇÕES (toast)
    // ─────────────────────────────────────────
    _openMonitorLink() {
        const link = this.vereadorManager?.getMonitorLink() || new URL('monitor.html', window.location.href).href;
        if (navigator.share) {
            navigator.share({ title: 'NossaTV - Monitor', text: 'Acompanhe a transmissão ao vivo:', url: link })
                .catch(() => this._copyMonitorLink(link));
        } else {
            this._copyMonitorLink(link);
        }
    }

    _copyMonitorLink(link) {
        const el = document.createElement('textarea');
        el.value = link;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        el.remove();
        this.showNotification('📱 Link do monitor copiado! Envie para seu celular.');
    }

    showNotification(message) {
        console.log(`[OBS] ${message}`);
        let toast = document.getElementById('obs-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'obs-toast';
            toast.style.cssText = [
                'position:fixed','bottom:90px','left:50%',
                'transform:translateX(-50%)',
                'background:#0066cc','color:#fff',
                'padding:10px 22px','border-radius:6px',
                'font-size:0.88em','font-weight:600',
                'box-shadow:0 4px 16px rgba(0,0,0,0.5)',
                'z-index:99999','opacity:0',
                'transition:opacity 0.3s','white-space:nowrap'
            ].join(';');
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.style.opacity = '1';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2800);
    }

    // ─────────────────────────────────────────
    //  JANELA FLUTUANTE — Drag & Drop
    // ─────────────────────────────────────────
    setupFloatingWindow() {
        const win         = document.getElementById('floating-window');
        const header      = document.getElementById('floating-header');
        const minimizeBtn = document.getElementById('float-minimize');
        const closeBtn    = document.getElementById('float-close');
        const reopenBtn   = document.getElementById('reopen-float');
        if (!win || !header) return;

        let isDragging = false, startX, startY, origLeft, origTop;

        header.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('float-btn')) return;
            isDragging = true;
            startX = e.clientX; startY = e.clientY;
            origLeft = win.offsetLeft; origTop = win.offsetTop;
            win.classList.add('dragging');
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const maxX = window.innerWidth  - win.offsetWidth;
            const maxY = window.innerHeight - win.offsetHeight;
            win.style.left  = Math.max(0, Math.min(origLeft + e.clientX - startX, maxX)) + 'px';
            win.style.top   = Math.max(0, Math.min(origTop  + e.clientY - startY, maxY)) + 'px';
            win.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) { isDragging = false; win.classList.remove('dragging'); }
        });

        header.addEventListener('touchstart', (e) => {
            if (e.target.classList.contains('float-btn')) return;
            const t = e.touches[0];
            isDragging = true;
            startX = t.clientX; startY = t.clientY;
            origLeft = win.offsetLeft; origTop = win.offsetTop;
            win.classList.add('dragging');
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            const t = e.touches[0];
            const maxX = window.innerWidth  - win.offsetWidth;
            const maxY = window.innerHeight - win.offsetHeight;
            win.style.left  = Math.max(0, Math.min(origLeft + t.clientX - startX, maxX)) + 'px';
            win.style.top   = Math.max(0, Math.min(origTop  + t.clientY - startY, maxY)) + 'px';
            win.style.right = 'auto';
        }, { passive: true });

        document.addEventListener('touchend', () => { isDragging = false; win.classList.remove('dragging'); });

        minimizeBtn?.addEventListener('click', () => {
            win.classList.toggle('minimized');
            minimizeBtn.textContent = win.classList.contains('minimized') ? '+' : '−';
        });

        closeBtn?.addEventListener('click', () => {
            win.style.display = 'none';
            if (reopenBtn) reopenBtn.style.display = 'flex';
        });

        reopenBtn?.addEventListener('click', () => {
            win.style.display = 'block';
            reopenBtn.style.display = 'none';
            this._applyFloatingStyles();
            this._resizeScreenContent();
            if (this.isStreaming) this.startProgramMirror();
        });

        this._setupLogoDrag();
        this._applyFloatingStyles();
        requestAnimationFrame(() => this._resizeScreenContent());
    }

}

// ─────────────────────────────────────────
//  BOOT — expõe global para onclick handlers inline
// ─────────────────────────────────────────
window.obsClone = null;
document.addEventListener('DOMContentLoaded', () => { window.obsClone = new OBSClone(); });
