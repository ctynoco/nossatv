import { generateQRCode } from './qrcode.js';

const ROOM = 'NossaTV';

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
];

export class VereadorManager {
    constructor(obs) {
        this.obs = obs;
        this.slots = [];
        this.activeSlot = null;
        this.connections = {};
        this.vdo = null;
        this._vdoReady = false;
        this._viewActive = {};
        this._pendingStreams = {};
        this._pendingTimeouts = {};
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._destroyed = false;
        this._currentCycleIndex = 0;
        this._cycleTimer = null;
        this.init();
    }

    init() {
        for (let i = 1; i <= 12; i++) {
            const label = `VER${String(i).padStart(2, '0')}`;
            const guestUrl = new URL('guest.html', window.location.href);
            guestUrl.searchParams.set('slot', label);
            this.slots.push({
                id: i,
                streamID: `slot_${label}`,
                label: label,
                connected: false,
                link: guestUrl.href,
            });
        }
        this.renderGrid();
        this.setupEvents();
        this._initVDO();
    }

    _initVDO() {
        if (typeof VDONinjaSDK === 'undefined') {
            console.warn('[Vereador] VDO.Ninja SDK não disponível');
            this._scheduleReconnect();
            return;
        }
        try {
            this.vdo = new VDONinjaSDK({
                iceServers: ICE_SERVERS,
                password: false,
                salt: 'vdo.ninja',
            });

            this.vdo.addEventListener('track', (event) => {
                const { track, streamID } = event.detail;
                if (!streamID) return;
                const slot = this.slots.find(s => s.streamID === streamID);
                if (!slot) return;

                if (!this._pendingStreams[slot.id]) {
                    this._pendingStreams[slot.id] = new MediaStream();
                }
                this._pendingStreams[slot.id].addTrack(track);

                clearTimeout(this._pendingTimeouts[slot.id]);
                this._pendingTimeouts[slot.id] = setTimeout(() => {
                    const stream = this._pendingStreams[slot.id];
                    delete this._pendingStreams[slot.id];
                    delete this._pendingTimeouts[slot.id];
                    this.connectSlot(slot.id, stream);
                }, 600);
            });

            this.vdo.addEventListener('connected', () => {
                this._vdoReady = true;
                this._reconnectAttempts = 0;
                // Se o OBS estiver transmitindo, republica o programa
                if (this.obs?.isStreaming) {
                    setTimeout(() => {
                        const stream = this.obs._getProgramStream();
                        if (stream) this.publishProgram(stream);
                    }, 500);
                }
            });

            this.vdo.addEventListener('disconnected', () => {
                this._vdoReady = false;
                this._streamingCam = false;
                this.obs?.showNotification('⚠️ VDO.Ninja desconectado — reconectando...');
                this._scheduleReconnect();
            });

            const connTimeout = setTimeout(() => {
                if (this.vdo) { try { this.vdo.disconnect(); } catch(e) {} }
                console.warn('[Vereador] Timeout conexão VDO.Ninja');
                this.obs?.showNotification('⚠️ Timeout ao conectar VDO.Ninja');
                this._scheduleReconnect();
            }, 15000);

            this.vdo.connect().then(() => {
                clearTimeout(connTimeout);
                return this.vdo.joinRoom({ room: ROOM, password: false });
            }).then(() => {
                clearTimeout(connTimeout);
                this._startViewing();
            }).catch((err) => {
                clearTimeout(connTimeout);
                console.warn('[Vereador] Erro VDO.Ninja:', err);
                this.obs?.showNotification('⚠️ Erro ao conectar VDO.Ninja: ' + (err.message || 'desconhecido'));
                this._scheduleReconnect();
            });
        } catch (e) {
            console.warn('[Vereador] Falha ao iniciar VDO.Ninja:', e);
            this.obs?.showNotification('⚠️ Falha ao iniciar VDO.Ninja');
            this._scheduleReconnect();
        }
    }

    _scheduleReconnect() {
        if (this._destroyed) return;
        if (this._reconnectAttempts >= 10) {
            this.obs?.showNotification('❌ VDO.Ninja: máximo de tentativas excedido. Recarregue a página.');
            return;
        }
        if (this._reconnectTimer) return;
        const delay = Math.min(2000 * Math.pow(1.5, this._reconnectAttempts), 30000);
        this._reconnectAttempts++;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (this._destroyed) return;
            if (this.vdo) {
                try { this.vdo.disconnect(); } catch(e) {}
                this.vdo = null;
            }
            this._vdoReady = false;
            this._initVDO();
        }, delay);
    }

    _startViewing() {
        this.slots.forEach(slot => {
            if (!slot.connected && !this._viewActive[slot.id]) {
                this._viewActive[slot.id] = true;
                this.vdo.view(slot.streamID, { audio: true, video: true }).catch((err) => {
                    console.warn(`[Vereador] Erro ao visualizar ${slot.streamID}:`, err);
                });
            }
        });
    }

    renderGrid() {
        const grid = document.getElementById('vereador-grid');
        if (!grid) return;
        const connected = this.slots.filter(s => s.connected);
        const count = connected.length;

        const ce = document.getElementById('vereador-count');
        if (ce) ce.textContent = `${count}/12`;

        if (count === 0) {
            grid.innerHTML = `<div class="vereador-empty"><span class="vereador-empty-text">Nenhum vereador conectado</span></div>`;
            this._stopCycle();
            return;
        }

        if (this._currentCycleIndex >= count) this._currentCycleIndex = 0;

        const slot = connected[this._currentCycleIndex];
        const stream = this.connections[slot.id];
        const audioMuted = grid.querySelector(`.vereador-slot-video`)?.muted ?? false;

        grid.innerHTML = `
            <div class="vereador-slot connected single" data-slot="${slot.id}">
                <video class="vereador-slot-video" autoplay playsinline ${audioMuted ? 'muted' : ''}></video>
                <div class="vereador-slot-info">
                    <span class="status-dot status-online"></span>
                    <span class="vereador-slot-name">${slot.label}</span>
                    <button class="vereador-slot-mute" data-slot="${slot.id}" title="Ativar som">🔇</button>
                </div>
                ${count > 1 ? `<div class="vereador-nav"><button class="vereador-nav-btn" data-nav="prev" title="Anterior">‹</button><span class="vereador-nav-count">${this._currentCycleIndex + 1}/${count}</span><button class="vereador-nav-btn" data-nav="next" title="Próximo">›</button></div>` : ''}
            </div>`;

        const video = grid.querySelector('.vereador-slot-video');
        if (video && stream) {
            video.srcObject = stream;
            video.play().catch(e => console.warn('[Vereador] Erro ao reproduzir vídeo:', e));
        }

        grid.querySelector('.vereador-slot.single')?.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('.vereador-nav')) return;
            this.addToPreview(slot.id);
        });

        grid.querySelector('.vereador-slot-mute')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const v = grid.querySelector('.vereador-slot-video');
            if (v) {
                v.muted = !v.muted;
                e.currentTarget.textContent = v.muted ? '🔇' : '🔊';
                e.currentTarget.title = v.muted ? 'Ativar som' : 'Desativar som';
            }
        });

        grid.querySelector('[data-nav="prev"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._currentCycleIndex = (this._currentCycleIndex - 1 + count) % count;
            this.renderGrid();
        });
        grid.querySelector('[data-nav="next"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._currentCycleIndex = (this._currentCycleIndex + 1) % count;
            this.renderGrid();
        });

        if (count > 1) this._startCycle();
        else this._stopCycle();
    }

    _startCycle() {
        this._stopCycle();
        this._cycleTimer = setInterval(() => {
            const connected = this.slots.filter(s => s.connected);
            if (connected.length > 1) {
                this._currentCycleIndex = (this._currentCycleIndex + 1) % connected.length;
                this.renderGrid();
            }
        }, 5000);
    }

    _stopCycle() {
        if (this._cycleTimer) {
            clearInterval(this._cycleTimer);
            this._cycleTimer = null;
        }
    }

    renderSlot(slot) {
        if (slot.connected) {
            return `<div class="vereador-slot connected" data-slot="${slot.id}">
                <video class="vereador-slot-video" autoplay playsinline muted></video>
                <div class="vereador-slot-info">
                    <span class="status-dot status-online"></span>
                    <span class="vereador-slot-name">${slot.label}</span>
                    <button class="vereador-slot-mute" data-slot="${slot.id}" title="Ativar som">🔇</button>
                    <button class="vereador-slot-rename" data-slot="${slot.id}" title="Renomear">✏️</button>
                    <button class="vereador-slot-desconectar" data-slot="${slot.id}" title="Desconectar">✕</button>
                    <button class="vereador-slot-excluir" data-slot="${slot.id}" title="Excluir">🗑️</button>
                </div>
            </div>`;
        }
        return `<div class="vereador-slot offline" data-slot="${slot.id}">
            <div class="vereador-slot-empty">${slot.label}</div>
            <div class="vereador-slot-actions">
                <button class="vereador-slot-conectar" data-slot="${slot.id}">📱 Conectar</button>
                <button class="vereador-slot-copiar" data-slot="${slot.id}" title="Copiar link individual">📋 Link</button>
                <button class="vereador-slot-rename" data-slot="${slot.id}" title="Renomear">✏️</button>
                <button class="vereador-slot-excluir" data-slot="${slot.id}" title="Excluir">🗑️</button>
            </div>
        </div>`;
    }

    openConnectionModal(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;
        this.activeSlot = slotId;
        document.getElementById('vereador-modal-title').textContent = `🔗 ${slot.label} — Conectar`;
        const inp = document.getElementById('vereador-modal-link-input');
        inp.value = slot.link;
        const qr = document.getElementById('vereador-qr-img');
        if (!qr) {
            console.warn('[Vereador] Elemento QR não encontrado');
            return;
        }
        const canvas = document.createElement('canvas');
        canvas.id = 'vereador-qr-canvas';
        canvas.width = 200;
        canvas.height = 200;
        canvas.style.width = '200px';
        canvas.style.height = '200px';
        qr.parentNode?.replaceChild(canvas, qr);
        setTimeout(() => generateQRCode(canvas, slot.link), 50);
        const pv = document.getElementById('vereador-modal-video');
        pv.srcObject = null;
        pv.style.display = 'none';
        const ph = document.querySelector('.vereador-modal-video-placeholder');
        if (ph) ph.style.display = 'flex';
        this._setModalStatus('offline', 'Aguardando convidado entrar...');
        document.getElementById('modal-vereador').style.display = 'flex';
    }

    _setModalStatus(state, text) {
        const el = document.getElementById('vereador-modal-status');
        if (!el) return;
        const dot = el.querySelector('.status-dot');
        if (dot) dot.className = `status-dot status-${state}`;
        const txt = document.getElementById('vereador-modal-status-text');
        if (txt) txt.textContent = text;
    }

    closeConnectionModal() {
        const pv = document.getElementById('vereador-modal-video');
        if (pv && pv.srcObject) {
            const sid = this.activeSlot;
            const slot = sid ? this.slots.find(s => s.id === sid) : null;
            if (!slot || !slot.connected) {
                pv.srcObject.getTracks().forEach(t => t.stop());
            }
            pv.srcObject = null;
            pv.style.display = 'none';
        }
        const ph = document.querySelector('.vereador-modal-video-placeholder');
        if (ph) ph.style.display = 'flex';
        document.getElementById('modal-vereador').style.display = 'none';
        this.activeSlot = null;
    }

    destroy() {
        this._destroyed = true;
        this._stopCycle();
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.vdo) {
            try { this.vdo.disconnect(); } catch(e) {}
            this.vdo = null;
        }
    }

    async testLocal() {
        const sid = this.activeSlot;
        if (!sid) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            const pv = document.getElementById('vereador-modal-video');
            pv.srcObject = stream;
            pv.style.display = 'block';
            const ph = document.querySelector('.vereador-modal-video-placeholder');
            if (ph) ph.style.display = 'none';
            this._setModalStatus('online', '✅ Conectado (teste local)');
            this.connectSlot(sid, stream);
        } catch (err) {
            this._setModalStatus('offline', `❌ Erro: ${err.message}`);
        }
    }

    connectSlot(slotId, stream) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;
        if (slot.connected && this.connections[slotId]) {
            this.connections[slotId].getTracks().forEach(t => t.stop());
        }
        slot.connected = true;
        this.connections[slotId] = stream;
        this.obs?.setupVereadorAudio(slotId, stream, slot.label);
        this.renderGrid();
        this.obs?.renderSources();
        this.obs?.refreshVereadoresSource();
        this._setModalStatus('online', `✅ ${slot.label} conectado`);
        this.obs?.showNotification(`📹 ${slot.label} conectado`);
    }

    addToPreview(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot || !slot.connected) return;
        const stream = this.connections[slotId];
        if (!stream) return;

        const previewArea = document.getElementById('preview-area');
        if (!previewArea) return;

        const oldPip = previewArea.querySelector('.vereador-pip');
        if (oldPip) {
            const oldVideo = oldPip.querySelector('.vereador-pip-video');
            if (oldVideo) oldVideo.srcObject = null;
            oldPip.remove();
        }
        document.querySelectorAll(`.vereador-pip`).forEach(p => {
            if (p.dataset.slot !== String(slotId)) {
                const v = p.querySelector('.vereador-pip-video');
                if (v) v.srcObject = null;
                p.remove();
            }
        });

        const pip = document.createElement('div');
        pip.className = 'vereador-pip';
        pip.dataset.slot = slotId;
        pip.innerHTML = `
            <div class="vereador-pip-video-wrapper">
                <video class="vereador-pip-video" autoplay playsinline></video>
                <div class="pip-overlay-controls">
                    <button class="pip-overlay-btn pip-mute" title="Mutar/Ativar áudio">🔊</button>
                    <button class="pip-overlay-btn pip-video-toggle" title="Desativar/Ativar vídeo">📹</button>
                    <button class="pip-overlay-btn vereador-pip-close" title="Remover">✕</button>
                </div>
            </div>
            <div class="vereador-pip-resize-handle"></div>
        `;
        previewArea.appendChild(pip);

        const video = pip.querySelector('.vereador-pip-video');
        video.srcObject = stream;
        video.play().catch(e => console.warn('[Vereador] Erro ao reproduzir PiP:', e));

        pip.querySelector('.vereador-pip-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this._removePipCompletely(slotId);
        });

        pip.querySelector('.pip-mute').addEventListener('click', (e) => {
            e.stopPropagation();
            video.muted = !video.muted;
            e.currentTarget.textContent = video.muted ? '🔇' : '🔊';
            e.currentTarget.classList.toggle('muted', video.muted);
        });

        pip.querySelector('.pip-video-toggle').addEventListener('click', (e) => {
            e.stopPropagation();
            const tracks = stream.getVideoTracks();
            const enabled = tracks.length ? tracks[0].enabled : true;
            tracks.forEach(t => t.enabled = !enabled);
            e.currentTarget.textContent = enabled ? '🚫' : '📹';
            e.currentTarget.classList.toggle('muted', enabled);
        });

        this._initPipResize(pip);
        this._initPipDrag(pip);
        this.obs?.showNotification(`📹 ${slot.label} no preview`);
    }

    _removePipCompletely(slotId) {
        document.querySelectorAll(`.vereador-pip[data-slot="${slotId}"]`).forEach(p => {
            const v = p.querySelector('.vereador-pip-video');
            if (v) v.srcObject = null;
            p.remove();
        });
    }

    _initPipResize(pip) {
        const handle = pip.querySelector('.vereador-pip-resize-handle');
        if (!handle) return;
        let isResizing = false, startX, startY, origW, origH;

        const onStart = (e) => {
            isResizing = true;
            const cx = e.clientX ?? e.touches[0].clientX;
            const cy = e.clientY ?? e.touches[0].clientY;
            startX = cx; startY = cy;
            origW = pip.offsetWidth;
            origH = pip.offsetHeight;
            pip.style.maxHeight = 'none';
            pip.style.aspectRatio = '';
            e.stopPropagation();
            e.preventDefault();
        };
        const onMove = (cx, cy) => {
            if (!isResizing) return;
            const dx = cx - startX;
            const dy = cy - startY;
            const newW = Math.max(80, origW + dx);
            const newH = Math.max(60, origH + dy);
            pip.style.width = newW + 'px';
            pip.style.height = newH + 'px';
        };
        const onUp = () => { isResizing = false; };

        handle.addEventListener('mousedown', onStart);
        document.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', onUp);
        handle.addEventListener('touchstart', onStart, { passive: false });
        document.addEventListener('touchmove', (e) => {
            if (isResizing) { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); }
        }, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    _initPipDrag(pip) {
        let isDragging = false, startX, startY, origLeft, origTop;
        const container = pip.parentElement?.closest('.preview-area') || pip.parentElement;

        const onStart = (e) => {
            if (e.target.closest('.vereador-pip-close') || e.target.closest('.vereador-pip-resize-handle') || e.target.closest('.pip-overlay-btn')) return;
            isDragging = true;
            const cx = e.clientX ?? e.touches[0].clientX;
            const cy = e.clientY ?? e.touches[0].clientY;
            startX = cx; startY = cy;
            origLeft = pip.offsetLeft;
            origTop = pip.offsetTop;
            pip.style.cursor = 'grabbing';
            e.stopPropagation();
            e.preventDefault();
        };
        const onMove = (cx, cy) => {
            if (!isDragging) return;
            let left = origLeft + (cx - startX);
            let top = origTop + (cy - startY);
            const cw = container.clientWidth;
            const ch = container.clientHeight;
            const pw = pip.offsetWidth;
            const ph = pip.offsetHeight;
            left = Math.max(0, Math.min(left, cw - pw));
            top = Math.max(0, Math.min(top, ch - ph));
            pip.style.left = left + 'px';
            pip.style.top = top + 'px';
            pip.style.right = 'auto';
            pip.style.bottom = 'auto';
        };
        const onUp = () => {
            if (!isDragging) return;
            isDragging = false;
            pip.style.cursor = '';
        };

        pip.addEventListener('mousedown', onStart);
        document.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', onUp);
        pip.addEventListener('touchstart', onStart, { passive: false });
        document.addEventListener('touchmove', (e) => {
            if (isDragging) { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); }
        }, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    renameSlot(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;
        const novo = prompt(`Novo nome para ${slot.label}:`, slot.label);
        if (novo && novo.trim()) {
            slot.label = novo.trim();
            this.renderGrid();
            this.obs?.showNotification(`✏️ Slot renomeado para "${slot.label}"`);
        }
    }

    deleteSlot(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;
        if (!confirm(`Excluir ${slot.label} permanentemente?`)) return;
        this._removePipCompletely(slotId);
        if (this.vdo) {
            try { this.vdo.stopViewing(slot.streamID); } catch(e) { console.warn('[Vereador] Erro ao parar visualização:', e); }
            delete this._viewActive[slot.id];
        }
        if (this.connections[slotId]) {
            this.connections[slotId].getTracks().forEach(t => t.stop());
            delete this.connections[slotId];
        }
        const idx = this.slots.indexOf(slot);
        if (idx !== -1) this.slots.splice(idx, 1);
        this.slots.forEach((s, i) => {
            s.id = i + 1;
            const newLabel = `VER${String(i + 1).padStart(2, '0')}`;
            s.label = newLabel;
            s.streamID = `slot_${newLabel}`;
            const u = new URL('guest.html', window.location.href);
            u.searchParams.set('slot', newLabel);
            s.link = u.href;
        });
        this.renderGrid();
        this.obs?.showNotification(`🗑️ Slot removido`);
    }

    disconnectSlot(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;
        this._removePipCompletely(slotId);
        if (this.vdo) {
            try { this.vdo.stopViewing(slot.streamID); } catch(e) { console.warn('[Vereador] Erro ao parar visualização:', e); }
            delete this._viewActive[slot.id];
        }
        this.obs?.cleanupVereadorAudio(slotId);
        if (this.connections[slotId]) {
            this.connections[slotId].getTracks().forEach(t => t.stop());
            delete this.connections[slotId];
        }
        slot.connected = false;
        this.renderGrid();
        this.obs?.renderSources();
        this.obs?.refreshVereadoresSource();
    }

    setupEvents() {
        const close = () => this.closeConnectionModal();
        document.getElementById('close-vereador-modal')?.addEventListener('click', close);
        document.getElementById('close-vereador-modal-btn')?.addEventListener('click', close);
        document.getElementById('modal-vereador')?.addEventListener('click', (e) => {
            if (e.target.id === 'modal-vereador') close();
        });
        document.getElementById('vereador-test-local-btn')?.addEventListener('click', () => this.testLocal());
        document.getElementById('vereador-copy-link-btn')?.addEventListener('click', () => {
            const inp = document.getElementById('vereador-modal-link-input');
            if (!inp) return;
            inp.select();
            document.execCommand('copy');
            this.obs?.showNotification('🔗 Link copiado!');
        });
        document.getElementById('vereador-links-btn')?.addEventListener('click', () => this.copyAllLinks());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const m = document.getElementById('modal-vereador');
                if (m && m.style.display === 'flex') close();
            }
        });
        document.getElementById('vereador-whatsapp-btn')?.addEventListener('click', () => {
            const inp = document.getElementById('vereador-modal-link-input');
            if (!inp || !inp.value) return;
            const msg = encodeURIComponent(`📹 Convidei você para participar da transmissão ao vivo! Acesse: ${inp.value}`);
            window.open(`https://wa.me/?text=${msg}`, '_blank');
        });
    }

    copyAllLinks() {
        const txt = this.slots.map(s => `${s.label}: ${s.link}`).join('\n');
        navigator.clipboard.writeText(txt).then(() => {
            this.obs?.showNotification('🔗 Links copiados!');
        }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = txt;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            this.obs?.showNotification('🔗 Links copiados!');
        });
    }

    async publishProgram(stream) {
        if (!stream) return;
        if (!this.vdo) return;
        if (!this._vdoReady) {
            console.log('[Vereador] Aguardando VDO.Ninja ficar pronto para publicar...');
            for (let tries = 0; tries < 50; tries++) {
                await new Promise(r => setTimeout(r, 200));
                if (this._vdoReady) break;
            }
            if (!this._vdoReady) {
                console.warn('[Vereador] VDO.Ninja não ficou pronto — programa não publicado');
                return;
            }
        }
        try {
            await this.vdo.publish(stream, {
                streamID: 'NossaTV_CAM',
                password: false,
            });
            try {
                await this.vdo.announce({ streamID: 'NossaTV_CAM' });
            } catch (e) {
                console.warn('[Vereador] Erro ao anunciar stream:', e);
            }
            console.log('[Vereador] Programa publicado como NossaTV_CAM');
        } catch (e) {
            console.warn('[Vereador] Erro ao publicar programa:', e);
        }
    }

    stopProgramPublish() {
        if (this.vdo) {
            try {
                this.vdo.stopPublishing();
            } catch (e) {
                console.warn('[Vereador] Erro ao parar publicação:', e);
            }
        }
    }

    publishMonitor(stream) {
        this.publishProgram(stream);
    }

    stopMonitorPublish() {
        this.stopProgramPublish();
    }

    getMonitorLink() {
        return new URL('monitor.html', window.location.href).href;
    }

    // ─────────────────────────────────────────
    //  CÂMERA VIRTUAL (VDO.Ninja Direct Link)
    // ─────────────────────────────────────────
    async startVirtualCamera(stream) {
        if (!this.vdo || !this._vdoReady) {
            throw new Error('VDO.Ninja não está conectado');
        }
        try {
            await this.vdo.publish(stream, {
                streamID: 'NossaTV_CAM',
                password: false,
            });
            this._streamingCam = true;
            const link = `https://vdo.ninja/?view=NossaTV_CAM&room=${ROOM}&solo&password=false`;
            return link;
        } catch (e) {
            throw e;
        }
    }

    stopVirtualCamera() {
        if (!this.vdo) return;
        try { this.vdo.stopPublishing(); } catch(e) {}
        this._streamingCam = false;
        // Se o OBS ainda estiver transmitindo, restaura NossaTV_CAM
        if (this.obs?.isStreaming) {
            const stream = this.obs._getProgramStream();
            if (stream) {
                setTimeout(() => this.publishProgram(stream), 300);
            }
        }
    }

    isVirtualCameraActive() {
        return !!this._streamingCam;
    }
}
