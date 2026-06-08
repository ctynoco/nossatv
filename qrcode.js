export function generateQRCode(canvas, text) {
    if (typeof qrcode === 'undefined') {
        console.warn('[QRCode] Biblioteca não disponível');
        return;
    }
    try {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const size = qr.getModuleCount() * 8;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const tile = 8;
        for (let r = 0; r < qr.getModuleCount(); r++) {
            for (let c = 0; c < qr.getModuleCount(); c++) {
                ctx.fillStyle = qr.isDark(r, c) ? '#000' : '#fff';
                ctx.fillRect(c * tile, r * tile, tile, tile);
            }
        }
    } catch (e) {
        console.error('[QRCode] Erro ao gerar QR:', e);
    }
}
