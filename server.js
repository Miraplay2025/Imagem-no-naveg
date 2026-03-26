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
    capturedBlobs: []
};

// Função auxiliar para tirar print em caso de erro
async function sendErrorScreenshot(socket, page, errorMsg) {
    if (page) {
        try {
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
            socket.emit('error-screenshot', { 
                img: `data:image/png;base64,${screenshot}`, 
                error: errorMsg 
            });
        } catch (e) {
            socket.emit('log', 'Não foi possível capturar o print do erro.');
        }
    }
}

io.on('connection', (socket) => {
    console.log('Cliente conectado via Socket');

    socket.on('start-automation', async (data) => {
        try {
            socket.emit('log', `Iniciando processo para ${data.prompts.length} prompts.`);
            
            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox', 
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--window-size=1280,800'
                ],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
            });

            page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });
            // Aumentado para 2 minutos para evitar o erro de timeout em conexões lentas
            await page.setDefaultNavigationTimeout(120000); 

            if (data.cookiesBase64) {
                try {
                    const decodedCookies = Buffer.from(data.cookiesBase64, 'base64').toString('utf-8');
                    const cookies = JSON.parse(decodedCookies);
                    await page.setCookie(...cookies);
                    socket.emit('log', `✅ Cookies decodificados e aplicados (${cookies.length}).`);
                } catch (e) {
                    socket.emit('log', '❌ ERRO NA DECODIFICAÇÃO: O arquivo Base64 é inválido.');
                    if (browser) await browser.close();
                    return;
                }
            }

            automationState.prompts = data.prompts;
            automationState.currentIndex = 0;
            automationState.stopRequested = false;

            socket.emit('log', 'Acessando Flow... (Isso pode demorar)');
            
            try {
                await page.goto(data.link, { waitUntil: 'networkidle2' });
            } catch (navError) {
                socket.emit('log', `❌ ERRO DE NAVEGAÇÃO: ${navError.message}`);
                await sendErrorScreenshot(socket, page, navError.message);
                if (browser) await browser.close();
                return;
            }

            const currentUrl = page.url();
            if (currentUrl.includes('accounts.google.com') || currentUrl.includes('login')) {
                socket.emit('log', '⚠️ SESSÃO INVÁLIDA: O Google pediu login.');
                await sendErrorScreenshot(socket, page, "Redirecionado para Login");
                if (browser) await browser.close();
                return;
            }

            socket.emit('automation-status', { 
                msg: "Conectado e validado!", 
                showConfirm: true 
            });

        } catch (err) {
            socket.emit('log', `ERRO CRÍTICO: ${err.message}`);
            await sendErrorScreenshot(socket, page, err.message);
            if (browser) await browser.close();
        }
    });

    socket.on('confirm-start', async () => {
        if (!page) return;
        socket.emit('log', 'Iniciando loop de automação...');

        await page.evaluate(async (promptsList, assetsData) => {
            window.state = {
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
                    if (window.state.isRunning && !e.target.closest('#awu-panel')) {
                        e.preventDefault();
                        e.target.blur();
                    }
                },
                startBlocking: () => {
                    KeyboardBlocker.injectStyle();
                    const exec = () => {
                        document.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(el => {
                            el.setAttribute('inputmode', 'none');
                            el.setAttribute('readonly', 'true');
                        });
                    };
                    exec();
                    window.state.blockObserver = new MutationObserver(exec);
                    window.state.blockObserver.observe(document.body, { childList: true, subtree: true });
                    window.addEventListener('focusin', KeyboardBlocker.preventFocus, true);
                },
                stopBlocking: () => {
                    KeyboardBlocker.removeStyle();
                    if (window.state.blockObserver) { window.state.blockObserver.disconnect(); window.state.blockObserver = null; }
                    window.removeEventListener('focusin', KeyboardBlocker.preventFocus, true);
                    document.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(el => {
                        el.removeAttribute('inputmode'); el.removeAttribute('readonly');
                    });
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
                window.state.isRunning = true; 
                KeyboardBlocker.startBlocking();
                const getUIStatus = () => {
                    const processing = !!document.querySelector(".kAxcVK, .fTmHUY, .dukARQ, [class*='loading']");
                    const imgs = Array.from(document.querySelectorAll('img.sc-5923b123-1')).map(img => img.src);
                    return { processing, imgs };
                };
                for (let i = window.state.currentIndex; i < window.state.prompts.length; i++) {
                    if (window.state.stopRequested) break;
                    const currentPrompt = window.state.prompts[i];
                    console.log(`[PROGRESS]|${i+1}`);
                    let promptResolved = false; let attempts = 0;
                    while (!promptResolved && !window.state.stopRequested && attempts < 3) {
                        attempts++;
                        window.state.initialUrls = new Set(getUIStatus().imgs);
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
                        await wait(500); btn.click();
                        let startedProcessing = false;
                        for (let att = 0; att < 15; att++) { if (getUIStatus().processing) { startedProcessing = true; break; } await wait(1000); }
                        let waitTimer = 0;
                        while (!window.state.stopRequested && waitTimer < 120) {
                            const status = getUIStatus();
                            if (status.processing) { await wait(2000); waitTimer += 2; continue; }
                            await wait(4000);
                            const finalStatus = getUIStatus();
                            const newImages = finalStatus.imgs.filter(url => !window.state.initialUrls.has(url));
                            if (newImages.length >= 2) {
                                log(`Capturado: [${newImages.length}] imagens no prompt [${i+1}]`, "success");
                                console.log(`[IMAGES]|${i+1}|${JSON.stringify(newImages)}`);
                                promptResolved = true; window.state.currentIndex = i + 1; break;
                            } else {
                                if (attempts < 3) { log(`Reiniciando prompt [${i+1}]...`, "warning"); await wait(5000); }
                                else { log(`Falha no prompt [${i+1}].`, "error"); window.state.currentIndex = i + 1; promptResolved = true; }
                                break;
                            }
                        }
                    }
                }
                log("Fim da automação!", "success");
                KeyboardBlocker.stopBlocking(); window.state.isRunning = false;
            }
            processPrompts();
        }, automationState.prompts, data.assets || []);

        page.on('console', msg => {
            const text = msg.text();
            if (text.startsWith('[FLOW_LOG]')) {
                const [_, type, content] = text.split('|');
                socket.emit('log', content);
            }
            if (text.startsWith('[IMAGES]')) {
                const [_, index, urls] = text.split('|');
                socket.emit('new-images', { index, urls: JSON.parse(urls) });
            }
        });
    });

    socket.on('stop-automation', async () => {
        if (browser) {
            await browser.close();
            browser = null; page = null;
            socket.emit('automation-finished', 'Finalizado.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
