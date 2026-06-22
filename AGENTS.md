# NossaTV — Project Context

## Stack
- VDO.Ninja SDK v1.3.18 (publicação/director)
- GitHub Pages (sem backend)
- Sala fixa `NossaTV`, `password: false`, `salt: "vdo.ninja"`

## WHIP / RTMP Pipeline
- **Arquitetura**: Browser → WHIP → MediaMTX → RTMP → YouTube/Instagram/Facebook
- **MediaMTX** (Go binary local ou VPS) recebe WebRTC via WHIP, converte para RTMP e distribui
- `WHIPClient` (inline em `vereador-manager.js`) publica o stream do programa via WHIP
- Configurações de stream targets (YouTube key, Instagram key, RTMP custom) geram config do MediaMTX via botão "⚙ Gerar Config MediaMTX"
- RTMP URLs padrão:
  - YouTube: `rtmp://a.rtmp.youtube.com/live2/{key}`
  - Instagram: `rtmps://live.upload.instagram.com:443/rtmp/{key}`
  - Facebook: `rtmps://live-api-s.facebook.com:443/rtmp/{key}`

## Key Decisions
- **Visualização de slots**: usar iframe `&cleanviewer&cleanoutput` em vez de `vdo.view()` — SDK dispara `enumerateDevices()` → prompt de câmera (para páginas que não têm permissão de câmera, como `vereadores.html` originalmente). Alternativa atual: `vdo.view()` no painel (slot streams via SDK).
- **Visualização do programa (NossaTV_CAM)**: usa `vdo.view()` no **guest** e **vereadores** (program panel) — essas páginas já têm permissão de câmera/mic, então `enumerateDevices()` não gera prompt. O **monitor.html** ainda usa iframe por ser uma página pura sem SDK.
- **Preview local do celular (guest.html)**: `<canvas>` overlay com `z-index:5` sobre o `<video>` original (que fica visível embaixo). O canvas renderiza frames via `requestAnimationFrame + ctx.drawImage()`. O video original precisa ficar VISÍVEL (não off-screen nem opacity:0) senão iOS bloqueia o stream do WebRTC. O canvas resolve o bug de "video preto" em alguns browsers mobile.
- **Retorno do programa (NossaTV_CAM)**: quando um track de vídeo chega via evento `track` do VDO, reseta `srcObject = null` + `srcObject = stream` e chama `video.play()`. Necessário porque o track de vídeo pode chegar depois do track de áudio e o `<video>` não renderiza sem reset explícito.
- **Slot video orientation**: CSS `aspect-ratio:16/9` no container + `position:absolute;inset:0;object-fit:contain` no video. Altura fixa do container evita "tela preta" inicial (vs `height:auto` que começa com 0px).
- **OverconstrainedError**: fonte de câmera com `deviceId` que não existe mais cai para `getUserMedia` sem deviceId (fallback para qualquer câmera).
- **SDK usado para publicar** (programa, câmera virtual, guest) — onde o prompt de câmera é esperado.
- **Áudio do retorno (guest)**: GainNode Web Audio no lugar de postMessage para iframe.
- **Speaker mute (guest)**: `video.muted` no lugar de postMessage.
- **PiP no preview-area** (`position: absolute`) sem header fixo — controles no canto inferior direito.
- **publishProgram**: aguarda VDO ficar pronto (até ~10s) antes de publicar `NossaTV_CAM`; republica automaticamente se VDO reconectar enquanto streaming estiver ativo.
- **publishProgram** agora também chama `vdo.announce()` para registrar o stream no signaling server (fix do bug conhecido).
- **publishProgram** publica para WHIP endpoints configurados via `setWhipEndpoints()`.
- **WHIP falha silenciosamente**: se MediaMTX não estiver rodando, apenas loga warning e não bloqueia a transmissão.

## Pages

### `index.html` (main page)
- Preview + Program screens
- PiP de vereador dentro do `#preview-area` com resize + drag (qualquer área do pip)
- `script.js`: `_syncProgramPip()` → programa (só video, sem header); `_clonePipToVertical()` → vertical (só video)
- `vereador-manager.js`: `addToPreview()` cria PiP com overlay de botões (mute/video/close)
- Vereador grid: **click único** adiciona ao preview
- Fonte `vereadores` (grid): mostra todos conectados em ordem aleatória, sem numeração, fundo 100% transparente

### `vereadores.html` (vereadores panel)
- Grid de 12 slots, cada um com VU meter, sliders input/output, mute, conectar
- Master bar: volume global input/output + mute all + toggles Eco/Microfonia/Gain
- **Programa panel**: `<video id="program-video">` com `vdo.view('NossaTV_CAM')` (não usa mais iframe)
- Output volume controla `masterDestGain.gain.value` (sem postMessage)

### `guest.html` (página do vereador no celular)
- Publica câmera + microfone via SDK director
- **Preview local**: `<video>` original fica visível (`position:absolute;inset:0`) com `<canvas>` overlay (`z-index:5`). Canvas renderiza frames via `requestAnimationFrame + drawImage` — contorna bug de video preto em browsers mobile.
- **Retorno do programa**: `<video id="return-video">` com `vdo.view('NossaTV_CAM')`, áudio roteado por GainNode Web Audio. Track handler reseta `srcObject` quando track de vídeo chega.
- Speaker: `video.muted` toggle
- Volume output: GainNode conectado ao `audioCtx.destination`
- Painel de áudio flutuante (esquerda): volume input (GainNode), volume output (GainNode), toggles Eco/Microfonia/Gain
- Botões: Chat, Speaker, Microfone, Câmera, Flip, Settings, Hangup
- Toggles de áudio recriam a audio track via getUserMedia com novas constraints

### `monitor.html`
- Iframe simples com `&cleanviewer&cleanoutput` (viewer VDO.Ninja puro)

## Audio System
- **Input volume**: Web Audio API GainNode (por slot em vereadores, global em guest)
- **Output volume (guest)**: GainNode no `audioCtx.destination`
- **Output volume (vereadores)**: GainNode mestre (`masterDestGain`)
- **Speaker mute**: `video.muted` (guest), `outputGain.gain.value = 0` (vereadores)
- **Mute mic**: `track.enabled = false`
- **Eco/Microfonia/Gain**: recria audio track via getUserMedia com novas constraints

## PiP (Picture-in-Picture)
- `object-fit: cover` no video
- Wrapper com `position: absolute; inset: 0` (sem aspect-ratio, preenche o pip)
- Controles: 🔊 mute, 📹 video toggle, ✕ close — mini-botões no canto inferior direito
- Sem header/barra preta fixa
- Arrastável clicando em qualquer lugar do pip (exceto botões e resize-handle)
- Redimensionável pelo handle no canto inferior direito

## Source Types
### `vereador` (singular)
- Mostra foto + nome + partido com fundo personalizável

### `vereadores` (grid)
- Grid de **todos os vereadores conectados** em **ordem aleatória** a cada refresh
- Fundo **100% transparente**, sem bordas, sem numeração
- Layout responsivo (colunas configurável: 2-6)

## Build & Deploy
```powershell
node build.js
git add -A; git commit -m "mensagem"; git push
```
GitHub Actions faz deploy automático do diretório `public/`.

## Analysis Checklist (every session)
- [ ] Guest conecta com áudio + vídeo?
- [ ] Retorno do programa aparece no guest? (`vdo.view`)
- [ ] Speaker button funciona no mobile? (`video.muted`)
- [ ] VU meters atualizando?
- [ ] PiP sync preview → programa → vertical OK?
- [ ] Áudio toggles (Eco/Microfonia/Gain) funcionam ao recriar track?
- [ ] Programa panel no vereadores mostra o stream? (`vdo.view`)
- [ ] Monitor.html carrega via iframe VDO.Ninja?
- [ ] publishProgram executa quando VDO está ready?
- [ ] publishProgram chama announce() corretamente?
- [ ] WHIPClient publica para MediaMTX quando streaming inicia?
- [ ] WHIPClient para quando streaming para?
- [ ] "Gerar Config MediaMTX" baixa YAML com destinos RTMP?
- [ ] Configurações WHIP persistem no localStorage?
