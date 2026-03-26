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

// Função para tirar print e enviar via socket
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
            
            await page.goto(data.link, { waitUntil: 'networkidle2' });
            await sendScreenshot(socket, page, "Página Carregada - Confirme o Início");

            socket.emit('automation-status', { msg: "Página pronta!", showConfirm: true });

        } catch (err) {
            socket.emit('log', `ERRO: ${err.message}`);
            await sendScreenshot(socket, page, "Erro no Início");
        }
    });

    socket.on('confirm-start', async () => {
        if (!page) return;

        // Exposição de funções do Node para o Browser
        await page.exposeFunction('sendScreenshotToNode', async (title) => {
            await sendScreenshot(socket, page, title);
        });

        // Monitor de Console para logs e imagens
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
                // Estado interno do Browser
                const state = {
                    isRunning: true,
                    stopRequested: false,
                    currentIndex: 0,
                    prompts: promptsList,
                    initialUrls: new Set(),
                    capturedBlobs: [],
                    blockObserver: null
                };

                localStorage.setItem("flow_persistent_assets_v3", JSON.stringify(assetsData));
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                const log = (msg, type) => { console.log(`[FLOW_LOG]|${type}|${msg}`); };

                /* ==========================================================================
                   3. BLOQUEIO DE TECLADO (Original)
                   ========================================================================== */
                const KeyboardBlocker = {
                    injectStyle: () => {
                        if (document.getElementById('awu-block-style')) return;
                        const style = document.createElement('style');
                        style.id = 'awu-block-style';
                        style.innerHTML = `input, textarea, [contenteditable="true"] { inputmode: none !important; pointer-events: none !important; } #awu-panel input, #awu-panel textarea, #awu-persistent-overlay * { pointer-events: auto !important; }`;
                        document.head.appendChild(style);
                    },
                    removeStyle: () => {
                        const style = document.getElementById('awu-block-style');
                        if (style) style.remove();
                    },
                    preventFocus: (e) => {
                        if (state.isRunning && !e.target.closest('#awu-panel')) {
                            e.preventDefault(); e.target.blur();
                        }
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

                /* ==========================================================================
                   INJECT ASSETS (Original)
                   ========================================================================== */
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
                            } catch (err) { 
                                logCallback(`Erro Persistência: ${err.message}`, "error"); 
                                await window.sendScreenshotToNode("Erro na Persistência");
                            }
                        }
                    }
                };

                /* ==========================================================================
                   PROCESS PROMPTS (Função Principal)
                   ========================================================================== */
                async function processPrompts() {
                    log("Iniciando automação...", "success"); 
                    state.isRunning = true;
                    KeyboardBlocker.startBlocking();
                    
                    const getUIStatus = () => {
                        const processing = !!document.querySelector(".kAxcVK, .fTmHUY, .dukARQ, [class*='loading']");
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
                            
                            if (!inputEl || !btn) { 
                                log("Campo de texto ou botão não encontrado. Tentando novamente...", "warning");
                                await wait(2000); continue; 
                            }
                            
                            inputEl.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
                            await wait(300); 
                            const dt = new DataTransfer(); dt.setData('text/plain', currentPrompt);
                            inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                            
                            log(`Enviando prompt [${i+1}] (T${attempts})...`, "info"); 
                            await wait(500); 
                            btn.click();

                            // Print apenas no início do primeiro prompt
                            if (i === 0 && attempts === 1) {
                                await window.sendScreenshotToNode("Iniciando Geração do Primeiro Prompt");
                            }

                            let startedProcessing = false;
                            for (let att = 0; att < 15; att++) { 
                                if (getUIStatus().processing) { startedProcessing = true; break; } 
                                await wait(1000); 
                            }
                            
                            let waitTimer = 0;
                            const MAX_WAIT = 120; 
                            while (!state.stopRequested && waitTimer < MAX_WAIT) {
                                const status = getUIStatus(); 
                                if (status.processing) { await wait(2000); waitTimer += 2; continue; }
                                
                                await wait(4000); 
                                const finalStatus = getUIStatus();
                                const newImages = finalStatus.imgs.filter(url => !state.initialUrls.has(url));
                                
                                if (newImages.length >= 2) {
                                    log(`Capturado: [${newImages.length}] imagens no prompt [${i+1}]`, "success");
                                    console.log(`[IMAGES]|${i+1}|${JSON.stringify(newImages)}`);
                                    promptResolved = true; state.currentIndex = i + 1; break;
                                } else { 
                                    if (attempts < MAX_ATTEMPTS) {
                                        log(`Aguardando renderização final...`, "warning");
                                        await wait(5000);
                                        const recheck = getUIStatus();
                                        if(recheck.imgs.filter(url => !state.initialUrls.has(url)).length >= 2) continue;
                                        log(`Reiniciando prompt [${i+1}]...`, "warning"); 
                                    } else {
                                        log(`Falha no prompt [${i+1}].`, "error");
                                        await window.sendScreenshotToNode(`Falha no Prompt ${i+1}`);
                                        state.currentIndex = i + 1; promptResolved = true;
                                    }
                                    break; 
                                }
                            }
                        }
                    }
                    if (!state.stopRequested) log("Fim da automação!", "success");
                    KeyboardBlocker.stopBlocking(); state.isRunning = false;
                }

                // Início da execução
                try {
                    await processPrompts();
                } catch (e) {
                    log("ERRO FATAL: " + e.message, "error");
                    await window.sendScreenshotToNode("Erro Fatal na Automação");
                }

            }, automationState.prompts, automationState.assets);
        } catch (err) {
            socket.emit('log', 'ERRO AO EXECUTAR JS: ' + err.message);
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) {
            await browser.close();
            browser = null; page = null;
            socket.emit('log', 'Automação parada pelo usuário.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
