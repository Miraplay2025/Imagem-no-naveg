const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

io.on('connection', (socket) => {
    console.log('Cliente conectado via Socket');

    socket.on('start-automation', async (data) => {
        try {
            // Feedback dos dados recebidos
            socket.emit('log', `Dados recebidos: ${data.prompts.length} prompts e ${data.assets?.length || 0} referências.`);
            if (data.cookies) socket.emit('log', 'Arquivo de cookies detectado.');

            socket.emit('log', 'Iniciando navegador no Render...');
            
            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox', 
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
            });

            page = await browser.newPage();
            
            if (data.cookies) {
                try {
                    const cookies = JSON.parse(data.cookies);
                    await page.setCookie(...cookies);
                    socket.emit('log', `Sucesso: ${cookies.length} cookies injetados no navegador.`);
                } catch (e) {
                    socket.emit('log', 'ERRO CRÍTICO NOS COOKIES: ' + e.message);
                    throw new Error("Formato de cookies inválido. Use JSON.");
                }
            }

            automationState.prompts = data.prompts;
            automationState.currentIndex = 0;
            automationState.stopRequested = false;

            socket.emit('log', 'Acessando Flow...');
            const response = await page.goto(data.link, { waitUntil: 'networkidle2', timeout: 60000 });

            // VERIFICAÇÃO DE LOGIN / REDIRECIONAMENTO
            const currentUrl = page.url();
            socket.emit('log', `URL Atual: ${currentUrl}`);

            if (currentUrl.includes('accounts.google.com') || currentUrl.includes('login')) {
                socket.emit('log', 'ALERTA: Redirecionado para página de Login. Os cookies falharam ou expiraram.');
                await browser.close();
                return socket.emit('log', 'ERRO: Sessão não autorizada. Verifique seus cookies.');
            }

            socket.emit('automation-status', { 
                msg: "Login verificado e página carregada com sucesso!", 
                showConfirm: true 
            });

        } catch (err) {
            // Retorna o erro real para depuração
            console.error(err);
            socket.emit('log', `ERRO DE DEPURAÇÃO: ${err.stack || err.message}`);
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
        if (page) {
            await page.evaluate(() => { window.state.stopRequested = true; });
            socket.emit('log', 'Parando automação...');
            await browser.close();
            browser = null; page = null;
            socket.emit('automation-finished', 'Processo finalizado.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
