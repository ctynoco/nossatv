# NossaTV — Project Context

## Stack
- VDO.Ninja SDK v1.3.18 (publicação/director apenas)
- GitHub Pages (sem backend)
- Sala fixa `NossaTV`, `password: false`, `salt: "vdo.ninja"`

## Key Decisions
- **Visualização**: usar iframe `&cleanviewer&cleanoutput` em vez de `vdo.view()` — SDK dispara `enumerateDevices()` → prompt de câmera.
- **SDK usado apenas para publicar** (programa, câmera virtual) — onde o prompt de câmera é esperado.
- **PiP no preview-area** (`position: absolute`) com resize handle + drag pelo header.

## Pages

### `index.html` (main page)
- Preview + Program screens
- PiP de vereador dentro do `#preview-area` com resize + drag
- `script.js`: `_syncProgramPip()` → programa; `_clonePipToVertical()` → vertical
- `vereador-manager.js`: `addToPreview()` cria PiP com header + mute/video toggle + resize + drag

### `vereadores.html` (vereadores panel)
- Grid de 12 slots, cada um com VU meter, sliders input/output, mute, conectar
- Master bar: volume global input/output + mute all + toggles Eco/Microfonia/Gain
- Programa panel flutuante com `#program-iframe` (VDO.Ninja viewer)
- QR code + links para copiar/enviar

### `guest.html` (página do vereador no celular)
- Publica câmera + microfone via SDK director
- Retorno do programa via iframe VDO.Ninja
- Painel de áudio flutuante (esquerda): volume input, volume output (postMessage), Eco/Microfonia/Gain
- Botões: Chat, Speaker (postMessage mute), Microfone, Câmera, Flip, Settings, Hangup

### `monitor.html`
- Iframe simples com `&cleanviewer`, sem SDK

## Audio System
- **Input volume**: Web Audio API GainNode (por slot em vereadores, global em guest)
- **Output volume**: postMessage `{ volume }` + `{ setAudioVolume }` para iframe VDO.Ninja
- **Eco**: `echoCancellation` toggle (recria audio track)
- **Microfonia**: `noiseSuppression` toggle (recria audio track)
- **Gain**: `autoGainControl` toggle (recria audio track)
- **Mute**: `track.enabled = false` para mic; postMessage `{ mute }` para return

## PiP (Picture-in-Picture)
- `aspect-ratio: 16/9` (igual ao slot)
- Cabeçalho: status dot + nome + mute 🔊/🔇 + video 📹/🚫 + close ✕
- Arrastável pelo header dentro do preview-area
- Redimensionável pelo handle no canto inferior direito
- `muted` removido do `<video>` (controlado pelo botão mute)
- Programa/vertical: só wrapper + video, sem header/borda

## Build
```powershell
node build.js
```

## Deploy
```powershell
git add -A; git commit -m "mensagem"; git push
```

## Analysis Checklist (every session)
- [ ] Audio return no guest funciona no celular? (postMessage mute/volume)
- [ ] Speaker button aparece no mobile?
- [ ] PiP sync preview → programa → vertical OK?
- [ ] Audio toggles (Eco/Microfonia/Gain) funcionam ao recriar track?
- [ ] VU meters atualizando?
- [ ] Program iframe carregando `NossaTV_CAM`?
- [ ] Guest publicando com áudio + vídeo?
- [ ] `&cleanviewer&cleanoutput` ainda sem prompt de câmera?
