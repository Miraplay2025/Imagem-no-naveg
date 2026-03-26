const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

let browser = null;
let page = null;
let automationState = {
    isRunning: false,
    stopRequested: false,
    currentIndex: 0,
    prompts: [],
    assets: []
};

async function sendScreenshot(socket, page, title) {
    if (page) {
        try {
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
            socket.emit('screenshot-update', { 
                img: `data:image/png;base64,${screenshot}`, 
                title: title 
            });
        } catch (e) {
            socket.emit('log', 'Erro ao capturar print: ' + e.message);
        }
    }
}

io.on('connection', (socket) => {
    console.log('Cliente conectado');

    socket.on('start-automation', async (data) => {
        try {
            socket.emit('log', `Iniciando navegador para ${data.prompts.length} prompts.`);
            
            browser = await puppeteer.launch({
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800']
            });

            page = await browser.newPage();
            page.setDefaultNavigationTimeout(90000); 
            page.setDefaultTimeout(90000);

            await page.setViewport({ width: 1280, height: 800 });

            if (data.cookiesBase64) {
                try {
                    const decoded = Buffer.from(data.cookiesBase64, 'base64').toString('utf-8');
                    const cookies = JSON.parse(decoded);
                    await page.setCookie(...(Array.isArray(cookies) ? cookies : [cookies]));
                    socket.emit('log', '✅ Cookies aplicados.');
                } catch (e) {
                    socket.emit('log', '❌ Erro nos cookies.');
                    return;
                }
            }

            automationState.prompts = data.prompts;
            automationState.assets = data.assets || [];
            
            try {
                await page.goto(data.link, { waitUntil: 'networkidle2' });
                await sendScreenshot(socket, page, "Página Carregada - Confirme o Início");
                socket.emit('automation-status', { msg: "Página pronta!", showConfirm: true });
            } catch (navError) {
                socket.emit('log', `Erro de Navegação: ${navError.message}`);
                await sendScreenshot(socket, page, "Erro no Carregamento");
                throw navError;
            }

        } catch (err) {
            socket.emit('log', `ERRO: ${err.message}`);
        }
    });

    socket.on('confirm-start', async () => {
        if (!page) return;

        await page.exposeFunction('sendScreenshotToNode', async (title) => {
            await sendScreenshot(socket, page, title);
        });

        page.on('console', msg => {
            const text = msg.text();
            if (text.startsWith('[FLOW_LOG]')) {
                const [_, type, content] = text.split('|');
                socket.emit('log', content);
            } else if (text.startsWith('[IMAGES]')) {
                const [_, index, urls] = text.split('|');
                socket.emit('new-images', { index, urls: JSON.parse(urls) });
            }
        });

        try {
            await page.evaluate(async (promptsList, assetsData) => {
                const state = {
                    prompts: promptsList,
                    isRunning: true,
                    currentIndex: 0,
                    stopRequested: false,
                    initialUrls: new Set(),
                    blockObserver: null
                };

                localStorage.setItem("flow_persistent_assets_v3", JSON.stringify(assetsData));
                const wait = (ms) => new Promise(res => setTimeout(res, ms));
                const log = (msg, type) => { console.log(`[FLOW_LOG]|${type}|${msg}`); };

                const KeyboardBlocker = {
                    injectStyle: () => {
                        if (document.getElementById('awu-block-style')) return;
                        const style = document.createElement('style');
                        style.id = 'awu-block-style';
                        style.innerHTML = `input, textarea, [contenteditable="true"] { inputmode: none !important; pointer-events: none !important; }`;
                        document.head.appendChild(style);
                    },
                    removeStyle: () => {
                        const style = document.getElementById('awu-block-style');
                        if (style) style.remove();
                    },
                    preventFocus: (e) => {
                        if (state.isRunning) { e.preventDefault(); e.target.blur(); }
                    },
                    startBlocking: () => {
                        KeyboardBlocker.injectStyle();
                        const exec = () => {
                            document.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(el => {
                                el.setAttribute('inputmode', 'none'); el.setAttribute('readonly', 'true');
                            });
                        };
                        exec();
                        state.blockObserver = new MutationObserver(exec);
                        state.blockObserver.observe(document.body, { childList: true, subtree: true });
                        window.addEventListener('focusin', KeyboardBlocker.preventFocus, true);
                    },
                    stopBlocking: () => {
                        KeyboardBlocker.removeStyle();
                        if (state.blockObserver) state.blockObserver.disconnect();
                        window.removeEventListener('focusin', KeyboardBlocker.preventFocus, true);
                    }
                };

                const PersistentManager = {
                    injectAssets: async (promptText, logCallback) => {
                        const assets = JSON.parse(localStorage.getItem("flow_persistent_assets_v3") || "[]");
                        const foundAssets = assets.filter(item => new RegExp(`\\b${item.nameNoExt}\\b`, 'gi').test(promptText));
                        if (foundAssets.length === 0) return;
                        
                        for (let item of foundAssets) {
                            try {
                                let searchInput = document.querySelector('input[placeholder="Pesquisar recursos"]');
                                const addBtn = document.querySelector('button[class*="sc-addd5871-0"]') || [...document.querySelectorAll("button")].find(b => b.innerHTML.includes("add_2"));
                                if (!searchInput && addBtn) { addBtn.click(); await wait(800); searchInput = document.querySelector('input[placeholder="Pesquisar recursos"]'); }
                                if (!searchInput) continue;
                                
                                searchInput.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
                                const dt = new DataTransfer(); dt.setData('text/plain', item.nameNoExt);
                                searchInput.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                                
                                let targetItem = null;
                                for(let i=0; i<12; i++) {
                                    const items = Array.from(document.querySelectorAll('.sc-dbfb6b4a-16'));
                                    targetItem = items.find(el => el.textContent.trim().toLowerCase().replace(/\.[^/.]+$/, "") === item.nameNoExt.toLowerCase());
                                    if(targetItem) break; await wait(600);
                                }
                                if (targetItem) { targetItem.click(); logCallback(`Referência "${item.nameNoExt}" ok.`, "success"); await wait(1200); }
                            } catch (err) { logCallback(`Erro Persistência: ${err.message}`, "error"); }
                        }
                    }
                };

                async function processPrompts() {
                    log("Iniciando automação...", "success"); 
                    state.isRunning = true;
                    KeyboardBlocker.startBlocking();
                    
                    const getUIStatus = () => {
                        // Lista de seletores de carregamento extraídos da extensão
                        const processing = !!document.querySelector(".kAxcVK, .fTmHUY, .dukARQ, [class*='loading'], [class*='Generating']");
                        const imgs = Array.from(document.querySelectorAll('img.sc-5923b123-1')).map(img => img.src);
                        return { processing, imgs };
                    };

                    for (let i = state.currentIndex; i < state.prompts.length; i++) {
                        if (state.stopRequested) break;
                        const currentPrompt = state.prompts[i]; 
                        
                        let promptResolved = false; 
                        let attempts = 0; 
                        const MAX_ATTEMPTS = 3;

                        while (!promptResolved && !state.stopRequested && attempts < MAX_ATTEMPTS) {
                            attempts++;
                            state.initialUrls = new Set(getUIStatus().imgs);
                            await PersistentManager.injectAssets(currentPrompt, log);
                            
                            const inputEl = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector("textarea");
                            const btn = [...document.querySelectorAll("button, i")].find(e => e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward"));
                            
                            if (!inputEl || !btn) { await wait(2000); continue; }
                            
                            inputEl.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
                            await wait(300); 
                            const dt = new DataTransfer(); dt.setData('text/plain', currentPrompt);
                            inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                            
                            log(`Enviando prompt [${i+1}] (T${attempts})...`, "info"); 
                            await wait(500); 
                            btn.click();

                            // Espera o início do processamento
                            let startedProcessing = false;
                            for (let att = 0; att < 15; att++) { 
                                if (getUIStatus().processing) { startedProcessing = true; break; } 
                                await wait(1000); 
                            }
                            
                            // Espera o fim do processamento com lógica de segurança da extensão
                            let waitTimer = 0;
                            const MAX_WAIT = 150; 
                            while (!state.stopRequested && waitTimer < MAX_WAIT) {
                                const status = getUIStatus(); 
                                
                                // Se ainda estiver processando, continua esperando
                                if (status.processing) { 
                                    await wait(2000); 
                                    waitTimer += 2; 
                                    continue; 
                                }

                                // Se parou de "carregar", fazemos a verificação de imagens (Igual ao content.js)
                                await wait(5000); // Pausa estratégica para renderização final
                                const finalCheck = getUIStatus();
                                const newImages = finalCheck.imgs.filter(url => !state.initialUrls.has(url));

                                // Só considera finalizado se o carregamento sumiu E apareceram imagens novas (min 2)
                                if (newImages.length >= 2) {
                                    log(`Renderizado com sucesso: [${newImages.length}] imagens.`, "success");
                                    console.log(`[IMAGES]|${i+1}|${JSON.stringify(newImages)}`);
                                    promptResolved = true; 
                                    state.currentIndex = i + 1; 
                                    break;
                                } else {
                                    // Se o carregamento sumiu mas não há imagens, espera mais um pouco
                                    log(`Aguardando exibição das imagens...`, "warning");
                                    await wait(5000);
                                    waitTimer += 5;
                                }
                            }

                            if (!promptResolved && attempts === MAX_ATTEMPTS) {
                                log(`Timeout ou erro no prompt [${i+1}]. Pulando...`, "error");
                                state.currentIndex = i + 1;
                                promptResolved = true;
                            }
                        }
                        await wait(2000); // Intervalo entre prompts
                    }
                    if (!state.stopRequested) log("Fim da automação!", "success");
                    KeyboardBlocker.stopBlocking(); state.isRunning = false;
                }

                try {
                    await processPrompts();
                } catch (e) {
                    log("ERRO FATAL: " + e.message, "error");
                    await window.sendScreenshotToNode("Erro Fatal");
                }

            }, automationState.prompts, automationState.assets);
        } catch (err) {
            socket.emit('log', 'ERRO JS: ' + err.message);
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) {
            await browser.close();
            browser = null; page = null;
            socket.emit('log', 'Robô finalizado.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
