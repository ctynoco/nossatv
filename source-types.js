export const SOURCE_TYPES = {
    camera:             { label: 'Câmera',                  icon: '📷' },
    screen:             { label: 'Captura de Monitor',       icon: '🖥️' },
    window:             { label: 'Captura de Janela',        icon: '🪟' },
    image:              { label: 'Captura de Imagem',        icon: '🖼️' },
    text:               { label: 'Texto',                   icon: '📝' },
    audio:              { label: 'Captura de Entrada Áudio', icon: '🎤' },
    browser:            { label: 'Navegador',               icon: '🌐' },
    color:              { label: 'Cor',                     icon: '🎨' },
    slideshow:          { label: 'Apresentação de Slides',   icon: '📽️' },
    gameCapture:        { label: 'Captura de Jogo',         icon: '🎮' },
    audioOutputCapture: { label: 'Captura de Saída Áudio',  icon: '🔊' },
    videoCaptureDevice: { label: 'Dispositivo Captura Vídeo', icon: '📹' },
    media:              { label: 'Mídia',                   icon: '🎬' },
    vereador:           { label: 'Vereador',                icon: '👤' },
    vereadores:         { label: 'VEREADORES GRID',         icon: '👥' },
    entrevistas:        { label: 'ENTREVISTAS',             icon: '🎙️' },
};

export const SOURCE_FORMS = {
    camera: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Câmera" />
        </div>
        <div class="form-group">
            <label>Dispositivo</label>
            <select id="src-device" class="device-select" data-device-kind="videoinput"><option value="">Selecionar dispositivo...</option></select>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Largura</label>
                <input type="number" id="src-width" value="1920" min="320" max="7680" step="10" />
            </div>
            <div class="form-group">
                <label>Altura</label>
                <input type="number" id="src-height" value="1080" min="240" max="4320" step="10" />
            </div>
        </div>`,

    screen: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Captura de Tela" />
        </div>
        <p style="color:#aaa;font-size:0.82em">O navegador solicitará permissão para capturar a tela.</p>
        <div class="form-row">
            <div class="form-group">
                <label>Largura</label>
                <input type="number" id="src-width" value="1920" min="320" max="7680" step="10" />
            </div>
            <div class="form-group">
                <label>Altura</label>
                <input type="number" id="src-height" value="1080" min="240" max="4320" step="10" />
            </div>
        </div>`,

    window: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Captura de Janela" />
        </div>
        <p style="color:#aaa;font-size:0.82em">Selecione uma janela específica na próxima etapa.</p>
        <div class="form-row">
            <div class="form-group">
                <label>Largura</label>
                <input type="number" id="src-width" value="1920" min="320" max="7680" step="10" />
            </div>
            <div class="form-group">
                <label>Altura</label>
                <input type="number" id="src-height" value="1080" min="240" max="4320" step="10" />
            </div>
        </div>`,

    image: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Imagem" />
        </div>
        <div class="form-group">
            <label>Arquivo de imagem</label>
            <input type="file" id="src-file" accept="image/*" />
        </div>`,

    text: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Texto" />
        </div>
        <div class="form-group">
            <label>Conteúdo do texto</label>
            <textarea id="src-text">Meu texto aqui</textarea>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Cor do texto</label>
                <input type="color" id="src-color" value="#ffffff" />
            </div>
            <div class="form-group">
                <label>Tamanho (px)</label>
                <input type="number" id="src-fontsize" value="48" min="10" max="200" />
            </div>
        </div>
        <div class="form-group">
            <label>Fundo</label>
            <input type="color" id="src-bg" value="#000000" />
        </div>`,

    audio: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Microfone" />
        </div>
        <div class="form-group">
            <label>Dispositivo de áudio</label>
            <select id="src-device" class="device-select" data-device-kind="audioinput"><option value="">Selecionar dispositivo...</option></select>
        </div>`,

    browser: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Navegador" />
        </div>
        <div class="form-group">
            <label>URL</label>
            <input type="url" id="src-url" value="https://example.com" placeholder="https://" />
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Largura</label>
                <input type="number" id="src-width" value="1280" />
            </div>
            <div class="form-group">
                <label>Altura</label>
                <input type="number" id="src-height" value="720" />
            </div>
        </div>`,

    color: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Cor Sólida" />
        </div>
        <div class="form-group">
            <label>Cor</label>
            <input type="color" id="src-color" value="#1a1a2e" />
        </div>`,

    slideshow: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Apresentação" />
        </div>
        <div class="form-group">
            <label>Imagens para o slideshow</label>
            <input type="file" id="src-slideshow-files" accept="image/*" multiple />
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Intervalo (ms)</label>
                <input type="number" id="src-slideshow-interval" value="3000" min="500" max="30000" step="500" />
            </div>
            <div class="form-group">
                <label>Modo de transição</label>
                <select id="src-slideshow-transition">
                    <option value="fade">Fade</option>
                    <option value="cut">Cut</option>
                </select>
            </div>
        </div>`,

    gameCapture: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Captura de Jogo" />
        </div>
        <p style="color:#aaa;font-size:0.82em">O navegador solicitará permissão para capturar a tela do jogo.</p>
        <div class="form-group">
            <label>Modo de captura</label>
            <select id="src-game-mode">
                <option value="any">Qualquer tela</option>
                <option value="borderless">Janela sem borda</option>
            </select>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Largura</label>
                <input type="number" id="src-width" value="1920" min="320" max="7680" step="10" />
            </div>
            <div class="form-group">
                <label>Altura</label>
                <input type="number" id="src-height" value="1080" min="240" max="4320" step="10" />
            </div>
        </div>`,

    audioOutputCapture: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Áudio do Sistema" />
        </div>
        <p style="color:#aaa;font-size:0.82em">Captura o áudio que está sendo reproduzido no sistema.</p>`,

    videoCaptureDevice: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Dispositivo de Vídeo" />
        </div>
        <div class="form-group">
            <label>Dispositivo</label>
            <select id="src-video-device" class="device-select" data-device-kind="videoinput"><option value="">Selecionar dispositivo...</option></select>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Largura</label>
                <input type="number" id="src-video-width" value="1920" min="320" max="7680" step="10" />
            </div>
            <div class="form-group">
                <label>Altura</label>
                <input type="number" id="src-video-height" value="1080" min="240" max="4320" step="10" />
            </div>
        </div>`,

    media: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Mídia" />
        </div>
        <div class="form-group">
            <label>Arquivo de mídia</label>
            <input type="file" id="src-media-file" accept="video/*,audio/*" />
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Loop</label>
                <select id="src-media-loop">
                    <option value="true">Sim</option>
                    <option value="false">Não</option>
                </select>
            </div>
            <div class="form-group">
                <label>Reproduzir automaticamente</label>
                <select id="src-media-autoplay">
                    <option value="true">Sim</option>
                    <option value="false" selected>Não</option>
                </select>
            </div>
        </div>`,

    vereador: () => `
        <div class="form-group">
            <label>Nome do Vereador</label>
            <input type="text" id="src-vereador-name" value="Vereador" />
        </div>
        <div class="form-group">
            <label>Partido</label>
            <input type="text" id="src-vereador-partido" value="PARTIDO" />
        </div>
        <div class="form-group">
            <label>Foto do Vereador</label>
            <input type="file" id="src-vereador-photo" accept="image/*" />
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Cor do nome</label>
                <input type="color" id="src-vereador-color" value="#ffffff" />
            </div>
            <div class="form-group">
                <label>Cor do fundo</label>
                <input type="color" id="src-vereador-bg" value="#1a1a2e" />
            </div>
        </div>`,

    vereadores: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Todos Vereadores" />
        </div>
        <div class="form-group">
            <label>Colunas</label>
            <select id="src-ver-grid-cols">
                <option value="2">2</option>
                <option value="3" selected>3</option>
                <option value="4">4</option>
                <option value="6">6</option>
            </select>
        </div>`,

    entrevistas: () => `
        <div class="form-group">
            <label>Nome da fonte</label>
            <input type="text" id="src-name" value="Entrevistas" />
        </div>
        <div class="form-group">
            <label>Layout</label>
            <select id="src-entrevistas-layout">
                <option value="2">2 Telas (1 Convidado + 1 Entrevistador)</option>
                <option value="3">3 Telas (2 Convidados + 1 Entrevistador)</option>
                <option value="4">4 Telas (3 Convidados + 1 Entrevistador)</option>
            </select>
        </div>
        <p style="color:#aaa;font-size:0.82em">Após criar, arraste fontes da lista para cada tela ou rearranje as telas com drag & drop.</p>`,
};

export const VIDEO_SOURCE_TYPES = ['camera', 'screen', 'window', 'videoCaptureDevice', 'media', 'gameCapture', 'entrevistas'];

export const AUDIO_SOURCE_TYPES = ['camera', 'screen', 'window', 'audio'];
