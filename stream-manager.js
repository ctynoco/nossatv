import { WHIPClient } from './whip-client.js';

const RTMP_URLS = {
    youtube: key => `rtmp://a.rtmp.youtube.com/live2/${key}`,
    instagram: key => `rtmps://live.upload.instagram.com:443/rtmp/${key}`,
};

const PLATFORM_LABELS = {
    youtube: 'YouTube',
    instagram: 'Instagram',
};

export class StreamOutput {
    constructor(config) {
        this.id = config.id;
        this.platform = config.platform;
        this.key = config.key || '';
        this.url = config.url || '';
        this.orientation = config.orientation || 'horizontal';
        this.enabled = config.enabled !== false;
        this.bitrate = config.bitrate || 0;
        this.resolution = config.resolution || '';
        this.fps = config.fps || 0;
        this._whip = null;
        this._whipUrl = '';
    }

    get rtmpUrl() {
        if (this.platform === 'rtmp') return this.url;
        return RTMP_URLS[this.platform]?.(this.key) || '';
    }

    get label() {
        return PLATFORM_LABELS[this.platform] || `RTMP ${this.id}`;
    }

    get pathName() {
        return `nossatv_${this.id}_${this.platform}`;
    }

    get whipEndpoint() {
        return this._whipUrl ? `${this._whipUrl.replace(/\/+$/, '')}/${this.pathName}/whip` : '';
    }

    configure(whipBaseUrl, globalBitrate) {
        this._whipUrl = whipBaseUrl || '';
        this._globalBitrate = globalBitrate || 3500;
    }

    get effectiveBitrate() {
        return (this.bitrate > 0 ? this.bitrate : this._globalBitrate) * 1000;
    }

    async start(stream) {
        if (!this.enabled || !stream || !this.whipEndpoint) return;
        this.stop();
        this._whip = new WHIPClient(this.whipEndpoint, this.effectiveBitrate);
        try {
            await this._whip.publish(stream);
            console.log(`[StreamOutput] ${this.label} (${this.orientation}) → WHIP ${this.whipEndpoint} @ ${this.effectiveBitrate / 1000}kbps`);
        } catch (err) {
            console.warn(`[StreamOutput ${this.label}] Erro:`, err);
            this._whip = null;
            throw err;
        }
    }

    stop() {
        if (this._whip) {
            this._whip.stop();
            this._whip = null;
        }
    }

    toMediaMTXPath() {
        const url = this.rtmpUrl;
        if (!url) return '';
        const isWin = navigator.userAgent.includes('Windows');
        return `  ${this.pathName}:\n    source: publisher\n    overridePublisher: yes\n    runOnReady: ${isWin ? 'cmd /c start /b ' : ''}ffmpeg -i rtmp://localhost:1935/${this.pathName} -c copy -f flv "${url}"\n    runOnReadyRestart: yes\n`;
    }
}

export class StreamManager {
    constructor() {
        this.outputs = new Map();
        this._whipBaseUrl = '';
        this._verticalCanvas = null;
        this._verticalCtx = null;
        this._verticalStream = null;
        this._animId = null;
    }

    configure(targets, whipBaseUrl, globalBitrate) {
        this.stopAll();
        this.outputs.clear();
        this._whipBaseUrl = whipBaseUrl || '';

        for (const t of targets) {
            if (!t.enabled) continue;
            const output = new StreamOutput(t);
            output.configure(this._whipBaseUrl, globalBitrate);
            this.outputs.set(output.id, output);
        }
    }

    getVerticalOutputs() {
        return [...this.outputs.values()].filter(o => o.orientation === 'vertical');
    }

    getHorizontalOutputs() {
        return [...this.outputs.values()].filter(o => o.orientation === 'horizontal');
    }

    getEnabledOutputs() {
        return [...this.outputs.values()].filter(o => o.enabled);
    }

    async startAll(horizontalStream, verticalStream) {
        const promises = [];

        for (const output of this.outputs.values()) {
            const stream = output.orientation === 'vertical' ? verticalStream : horizontalStream;
            if (!stream) {
                console.warn(`[StreamManager] Sem stream para ${output.label} (${output.orientation})`);
                continue;
            }
            promises.push(
                output.start(stream).catch(() => {})
            );
        }

        await Promise.allSettled(promises);
    }

    stopAll() {
        for (const output of this.outputs.values()) {
            output.stop();
        }
        this._stopVerticalCanvas();
    }

    hasEnabled() {
        return this.getEnabledOutputs().length > 0;
    }

    generateMediaMTXConfig() {
        const targets = this.getEnabledOutputs();
        const now = new Date().toISOString().slice(0, 10);

        let config = `# MediaMTX config — gerado por NossaTV em ${now}\n`;
        config += `# https://github.com/bluenviron/mediamtx\n\n`;
        config += `logLevel: info\n\n`;
        config += `rtmp: yes\nrtmpAddress: :1935\n\n`;
        config += `webrtc: yes\nwebrtcAddress: :8889\nwebrtcLocalUDPAddress: :8189\nwebrtcIPsFromInterfaces: yes\n\n`;
        config += `hls: yes\nhlsAddress: :8888\nhlsVariant: lowLatency\n\n`;
        config += `rtsp: no\nsrt: no\nmoq: no\n\n`;
        config += `paths:\n`;

        let hasPaths = false;
        for (const t of targets) {
            const pathBlock = t.toMediaMTXPath();
            if (pathBlock) {
                config += pathBlock;
                hasPaths = true;
            }
        }

        if (!hasPaths) {
            config += `  nossatv:\n    source: publisher\n    overridePublisher: yes\n`;
        }

        const blob = new Blob([config], { type: 'text/yaml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'mediamtx.yml';
        a.click();
        URL.revokeObjectURL(a.href);
        return config;
    }

    startVerticalCanvas(programVideo, settings) {
        this._stopVerticalCanvas();

        const width = 720;
        const height = 1280;
        this._verticalCanvas = document.createElement('canvas');
        this._verticalCanvas.width = width;
        this._verticalCanvas.height = height;
        this._verticalCanvas.style.display = 'none';
        document.body.appendChild(this._verticalCanvas);
        this._verticalCtx = this._verticalCanvas.getContext('2d');

        let bgImg = null;
        let logoImg = null;
        const v = settings?.vertical || {};

        if (v.backgroundImage) {
            bgImg = new Image();
            bgImg.src = v.backgroundImage;
        }
        if (v.logo?.src) {
            logoImg = new Image();
            logoImg.src = v.logo.src;
        }

        const drawFrame = () => {
            const ctx = this._verticalCtx;
            if (!ctx || !this._verticalCanvas) return;
            const vw = this._verticalCanvas.width;
            const vh = this._verticalCanvas.height;

            if (bgImg && bgImg.complete && bgImg.naturalWidth > 0) {
                ctx.drawImage(bgImg, 0, 0, vw, vh);
            } else {
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, vw, vh);
            }

            if (programVideo && programVideo.videoWidth > 0) {
                const vidW = programVideo.videoWidth;
                const vidH = programVideo.videoHeight;
                const scale = Math.min(vw / vidW, vh / vidH);
                const dx = (vw - vidW * scale) / 2;
                const dy = (vh - vidH * scale) / 2;
                ctx.drawImage(programVideo, dx, dy, vidW * scale, vidH * scale);
            }

            if (logoImg && logoImg.complete && logoImg.naturalWidth > 0) {
                const lx = v.logo?.x ?? 8;
                const ly = v.logo?.y ?? 8;
                const lw = v.logo?.width ?? 60;
                const lh = v.logo?.height ?? 60;
                ctx.drawImage(logoImg, vw - lx - lw, ly, lw, lh);
            }

            this._animId = requestAnimationFrame(drawFrame);
        };

        this._animId = requestAnimationFrame(drawFrame);
        this._verticalStream = this._verticalCanvas.captureStream(30);
        return this._verticalStream;
    }

    getVerticalStream() {
        return this._verticalStream;
    }

    _stopVerticalCanvas() {
        if (this._animId) {
            cancelAnimationFrame(this._animId);
            this._animId = null;
        }
        if (this._verticalStream) {
            this._verticalStream.getTracks().forEach(t => t.stop());
            this._verticalStream = null;
        }
        if (this._verticalCanvas?.parentNode) {
            this._verticalCanvas.parentNode.removeChild(this._verticalCanvas);
        }
        this._verticalCanvas = null;
        this._verticalCtx = null;
    }
}
