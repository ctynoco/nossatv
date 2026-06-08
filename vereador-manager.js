import { generateQRCode } from './qrcode.js';

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
        this.init();
    }

    init() {
        for (let i = 1; i <= 12; i++) {
            const label = `VER${String(i).padStart(2, '0')}`;
            const guestUrl = new URL('guest', window.location.href);
            guestUrl.searchParams.set('room', 'nossatv');
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
            return;
        }
        try {
            this.vdo = new VDONinjaSDK({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                ],
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
                this._startViewing();
            });

            this.vdo.connect().then(() => {
                return this.vdo.joinRoom({ room: 'nossatv' });
            }).then(() => {
                if (this.vdo._connected) this._startViewing();
            }).catch((err) => {
                console.warn('[Vereador] Erro VDO.Ninja:', err);
                this.obs?.showNotification('⚠️ Erro ao conectar VDO.Ninja: ' + (err.message || 'desconhecido'));
            });
        } catch (e) {
            console.warn('[Vereador] Falha ao iniciar VDO.Ninja:', e);
            this.obs?.showNotification('⚠️ Falha ao iniciar VDO.Ninja');
        }
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
        const connected = this.slots.filter(s => s.connected).length;
        grid.className = 'vereador-grid';
        if (connected === 0) grid.classList.add('cols-4');
        else if (connected === 1) grid.classList.add('cols-1');
        else if (connected === 2) grid.classList.add('cols-2');
        else if (connected <= 4) grid.classList.add('cols-2');
        else grid.classList.add('cols-4');
        grid.innerHTML = this.slots.map(s => this.renderSlot(s)).join('');
        const ce = document.getElementById('vereador-count');
        if (ce) ce.textContent = `${connected}/12`;
        grid.querySelectorAll('.vereador-slot-conectar').forEach(b => {
            b.addEventListener('click', (e) => { e.stopPropagation(); this.openConnectionModal(parseInt(b.dataset.slot)); });
        });
        grid.querySelectorAll('.vereador-slot-desconectar').forEach(b => {
            b.addEventListener('click', (e) => { e.stopPropagation(); this.disconnectSlot(parseInt(b.dataset.slot)); });
        });
        grid.querySelectorAll('.vereador-slot-rename').forEach(b => {
            b.addEventListener('click', (e) => { e.stopPropagation(); this.renameSlot(parseInt(b.dataset.slot)); });
        });
        grid.querySelectorAll('.vereador-slot-excluir').forEach(b => {
            b.addEventListener('click', (e) => { e.stopPropagation(); this.deleteSlot(parseInt(b.dataset.slot)); });
        });
        grid.querySelectorAll('.vereador-slot.connected').forEach(el => {
            el.addEventListener('dblclick', () => this.addToPreview(parseInt(el.dataset.slot)));
        });
        this.slots.filter(s => s.connected).forEach(slot => {
            const videoEl = grid.querySelector(`.vereador-slot[data-slot="${slot.id}"] video`);
            if (videoEl && this.connections[slot.id]) {
                videoEl.srcObject = this.connections[slot.id];
                videoEl.play().catch(e => console.warn('[Vereador] Erro ao reproduzir vídeo:', e));
            }
        });
    }

    renderSlot(slot) {
        if (slot.connected) {
            return `<div class="vereador-slot connected" data-slot="${slot.id}">
                <video class="vereador-slot-video" autoplay playsinline muted></video>
                <div class="vereador-slot-info">
                    <span class="status-dot status-online"></span>
                    <span class="vereador-slot-name">${slot.label}</span>
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
        this.renderGrid();
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
                <div class="vereador-pip-resize-handle"></div>
            </div>
            <div class="vereador-pip-info">
                <span class="status-dot status-online"></span>
                <span class="vereador-pip-name">${slot.label}</span>
                <button class="vereador-pip-close" title="Remover">✕</button>
            </div>
        `;
        previewArea.appendChild(pip);

        const video = pip.querySelector('.vereador-pip-video');
        video.srcObject = stream;
        video.play().catch(e => console.warn('[Vereador] Erro ao reproduzir PiP:', e));

        pip.querySelector('.vereador-pip-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this._removePipCompletely(slotId);
        });

        this._initPipResize(pip);
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
            e.stopPropagation();
            e.preventDefault();
        };
        const onMove = (cx, cy) => {
            if (!isResizing) return;
            const dx = cx - startX;
            const dy = cy - startY;
            const newW = Math.max(80, origW + dx);
            const newH = Math.max(45, origH + dy);
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
            const u = new URL('guest', window.location.href);
            u.searchParams.set('room', 'nossatv');
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
        if (this.connections[slotId]) {
            this.connections[slotId].getTracks().forEach(t => t.stop());
            delete this.connections[slotId];
        }
        slot.connected = false;
        this.renderGrid();
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

    publishProgram(stream, slotLabel) {
        if (!this.vdo || !stream) return;
        try {
            const streamId = 'program_' + slotLabel;
            this.vdo.publish(stream, { streamID: streamId });
        } catch (e) {
            console.warn('[Vereador] Erro ao publicar programa:', e);
        }
    }

    stopProgramPublish(slotLabel) {
        if (!this.vdo) return;
        try {
            this.vdo.stopPublishing();
        } catch (e) {
            console.warn('[Vereador] Erro ao parar publicação:', e);
        }
    }
}
