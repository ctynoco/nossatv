# NossaTV

Software de transmissão ao vivo e gravação para navegador — inspirado no OBS Studio.

## Funcionalidades

- **Fontes**: 14 tipos (câmera, tela, janela, imagem, texto, áudio, navegador, cor, slideshow, mídia, captura de jogo, etc.)
- **Cenas**: Múltiplas cenas com reordenação drag-and-drop e renomeação
- **Transições**: Cut e Fade entre cenas com duração configurável
- **Mixer de Áudio**: Volume, mute, VU meter, compressor, noise gate, limitador, supressor de ruído, cancelamento de eco, ganho
- **Chroma Key**: Substituição de fundo verde/azul em tempo real
- **Gravação**: Gravação real com MediaRecorder API (download em .webm)
- **Multi-Stream**: Configuração de múltiplos destinos (YouTube, Instagram, RTMP)
- **Vereadores**: 12 slots para participantes remotos via VDO.Ninja com PiP
- **Janela Vertical**: Monitor 9:16 flutuante com logo e fundo personalizáveis
- **Projetar**: Pop-up para projetar em monitor externo
- **Backup**: Snapshots automáticos com restauração
- **Temas**: Escuro, Claro ou seguindo o sistema
- **PWA**: Suporte a instalação como aplicativo

## Pré-requisitos

- Node.js 20+
- Navegador moderno (Chrome, Edge, Firefox, Safari)

## Instalação

```bash
npm ci
```

## Desenvolvimento

Abra `index.html` diretamente no navegador (sem build).

## Build de produção

```bash
npm run build
```

Gera arquivos minificados em `public/`.

## Preview do build

```bash
npm run preview
```

## Estrutura do Projeto

```
nossaTV/
├── index.html              # Aplicação principal
├── guest.html              # Página do convidado (Vereador)
├── script.js               # Classe OBSClone (lógica principal)
├── source-types.js         # Definições de tipos de fonte (módulo)
├── vereador-manager.js     # Gerenciador de Vereadores (módulo)
├── styles.css              # Estilos
├── service-worker.js       # Service Worker para PWA
├── manifest.json           # Manifesto PWA
├── build.js                # Script de build
├── public/                 # Saída do build
└── .github/workflows/pages.yml  # CI/CD GitHub Pages
```

## Stack

- Vanilla JS (ES Modules)
- VDO.Ninja SDK (p2p vídeo)
- localStorage para persistência
- html-minifier-terser, cssnano para build

## Limitações Conhecidas

- Streaming RTMP requer servidor intermediário (não enviado diretamente do navegador)
- Câmera Virtual não é suportada em navegadores padrão
- Fontes com streams (câmera/tela) são recriadas ao recarregar a página
