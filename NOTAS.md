# Notas - Sessão 20/06/2026

## Problema Central
O retorno de vídeo (câmera virtual `NossaTV_CAM` → monitor / guest) nunca funcionou porque o código original **nunca chamou `announce()`** após o `publish()`. O stream era publicado mas não registrado no servidor de sinalização, então ninguém conseguia encontrá-lo.

## Soluções Possíveis (pendentes)

**A) Push manual do VDO.Ninja** — abre `vdo.ninja/?push=slot_CAM&room=NossaTV` numa aba, usuário clica "Start". O site VDO.Ninja publica corretamente. *(1 clique manual, mas funciona)*

**B) Conexão WebRTC direta** — criar RTCPeerConnection manual entre site e guest, sem servidor de sinalização VDO.Ninja. *(Complexo, funciona offline)*

**C) Abordagem mista** — manter guest→site funcionando, retorno via iframe/popup do VDO.Ninja viewer. Stream precisa ser publicado por push manual ou ferramenta externa.

**D) Provedor de sinalização alternativo** — PeerJS, LiveKit, ou signaling próprio em Node.js. *(Muito trabalho)*
