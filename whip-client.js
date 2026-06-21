const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
];

export class WHIPClient {
    constructor(url, bitrate) {
        this.url = url;
        this.bitrate = bitrate || 0;
        this.pc = null;
    }

    async publish(stream) {
        this.stop();
        this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const senders = [];
        for (const track of stream.getTracks()) {
            const sender = this.pc.addTrack(track, stream);
            senders.push(sender);
        }
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);

        if (this.bitrate > 0) {
            for (const sender of senders) {
                if (sender.track?.kind !== 'video') continue;
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || params.encodings.length === 0) {
                        params.encodings = [{}];
                    }
                    params.encodings.forEach(e => e.maxBitrate = this.bitrate);
                    await sender.setParameters(params);
                } catch (err) {
                    console.warn(`[WHIP] Erro ao aplicar bitrate:`, err);
                }
            }
        }

        const response = await fetch(this.url, {
            method: 'POST',
            body: offer.sdp,
            headers: { 'Content-Type': 'application/sdp' }
        });
        if (!response.ok) {
            throw new Error(`WHIP ${response.status}: ${response.statusText}`);
        }
        const answerSDP = await response.text();
        await this.pc.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: answerSDP
        }));
    }

    async stop() {
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }
    }
}
