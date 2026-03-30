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

// Função de espera para usar dentro do Puppeteer
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

io.on('connection', (socket) => {
    console.log('Cliente conectado');

    socket.on('start-automation', async (data) => {
        const { link, prompts, cookiesBase64, assets } = data;

        try {
            socket.emit('log', "🚀 Iniciando Puppeteer no Render...");

            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--window-size=1280,800'
                ]
            });

            page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });

            // 1. Aplicar Cookies
            socket.emit('log', "🔑 Aplicando cookies de autenticação...");
            const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);

            // 2. Acessar Link
            socket.emit('log', `🌐 Acessando: ${link}`);
            await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });

            // Aguarda um pouco mais para garantir renderização 200%
            await delay(5000);

            // 3. Tirar Print para Confirmação do Usuário
            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', { 
                img: `data:image/png;base64,${screenshot}`, 
                title: "VERIFICAÇÃO DE LOGIN" 
            });
            socket.emit('automation-status', { showConfirm: true });
            socket.emit('log', "👀 Aguardando confirmação visual do usuário...");

            // Ouvir confirmação
            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Confirmação recebida! Injetando scripts de automação...");

                // Injetar os Assets (Imagens de Referência) no LocalStorage do navegador remoto
                await page.evaluate((assets) => {
                    const formattedAssets = assets.map(a => ({
                        id: a.id,
                        nameNoExt: a.name.replace(/\.[^/.]+$/, ""),
                        data: a.data
                    }));
                    localStorage.setItem("flow_persistent_assets_v3", JSON.stringify(formattedAssets));
                }, assets);

                // Injetar a lógica original de automação enviada
                await page.evaluate((promptsList) => {
                    // Estado interno do Script Injetado
                    window.state = {
                        prompts: promptsList,
                        currentIndex: 0,
                        isRunning: false,
                        stopRequested: false,
                        capturedBlobs: [],
                        initialUrls: new Set()
                    };

                    window.wait = (ms) => new Promise(r => setTimeout(r, ms));
                    
                    // Funções de Log que se comunicam de volta com o servidor via console
                    window.log = (msg, type) => {
                        console.log(`AUTO_LOG:${type}:${msg}`);
                    };

                    // ---- INSERÇÃO DOS SEUS SCRIPTS ORIGINAIS ----
                    
                    // 1. KeyboardBlocker
                    window.KeyboardBlocker = {
                        injectStyle: () => {
                            if (document.getElementById('awu-block-style')) return;
                            const style = document.createElement('style');
                            style.id = 'awu-block-style';
                            style.innerHTML = `
                                input, textarea, [contenteditable="true"] { 
                                    inputmode: none !important; 
                                    pointer-events: none !important; 
                                }
                                #awu-panel input, #awu-panel textarea, #awu-persistent-overlay * { 
                                    pointer-events: auto !important; 
                                }
                            `;
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
                            window.KeyboardBlocker.injectStyle();
                            const exec = () => {
                                document.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(el => {
                                    el.setAttribute('inputmode', 'none');
                                    el.setAttribute('readonly', 'true');
                                });
                            };
                            exec();
                            window.state.blockObserver = new MutationObserver(exec);
                            window.state.blockObserver.observe(document.body, { childList: true, subtree: true });
                            window.addEventListener('focusin', window.KeyboardBlocker.preventFocus, true);
                        },
                        stopBlocking: () => {
                            window.KeyboardBlocker.removeStyle();
                            if (window.state.blockObserver) {
                                window.state.blockObserver.disconnect();
                                window.state.blockObserver = null;
                            }
                            window.removeEventListener('focusin', window.KeyboardBlocker.preventFocus, true);
                            document.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(el => {
                                el.removeAttribute('inputmode');
                                el.removeAttribute('readonly');
                            });
                        }
                    };

                    // 2. PersistentManager
                    window.PersistentManager = {
                        injectAssets: async (promptText, logCallback) => {
                            const assets = JSON.parse(localStorage.getItem("flow_persistent_assets_v3") || "[]");
                            const foundAssets = assets.filter(item => new RegExp(`\\b${item.nameNoExt}\\b`, 'gi').test(promptText));
                            if (foundAssets.length === 0) return;
                            for (let idx = 0; idx < foundAssets.length; idx++) {
                                const item = foundAssets[idx];
                                try {
                                    let searchInput = document.querySelector('input[placeholder="Pesquisar recursos"]');
                                    const addBtn = document.querySelector('button[class*="sc-addd5871-0"]') || [...document.querySelectorAll("button")].find(b => b.innerHTML.includes("add_2"));
                                    if (!searchInput && addBtn) { addBtn.click(); await window.wait(800); searchInput = document.querySelector('input[placeholder="Pesquisar recursos"]'); }
                                    if (!searchInput) continue;
                                    searchInput.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
                                    const dt = new DataTransfer(); dt.setData('text/plain', item.nameNoExt);
                                    searchInput.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                                    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                                    let targetItem = null;
                                    for(let i=0; i<12; i++) {
                                        const items = Array.from(document.querySelectorAll('.sc-3038c00b-16, .sc-dbfb6b4a-16'));
                                        targetItem = items.find(el => {
                                            const flowFileName = el.textContent.trim().toLowerCase();
                                            const flowFileNameNoExt = flowFileName.replace(/\.[^/.]+$/, ""); 
                                            return flowFileNameNoExt === item.nameNoExt.toLowerCase();
                                        });
                                        if(targetItem) break; await window.wait(600);
                                    }
                                    if (targetItem) { 
                                        targetItem.click(); 
                                        logCallback(`Imagem de Referência "${item.nameNoExt}" incluída.`, "success"); 
                                        await window.wait(1200); 
                                    } else { 
                                        logCallback(`Não encontramos "${item.nameNoExt}" na lista do Flow.`, "error");
                                        if (idx === foundAssets.length - 1) {
                                             searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                                             document.body.click(); 
                                        }
                                    }
                                } catch (err) { logCallback(`Erro Persistência: ${err.message}`, "error"); }
                            }
                        }
                    };

                    // 3. processPrompts
                    window.processPrompts = async () => {
                        window.log("Iniciando processo de automação...", "success"); 
                        window.state.isRunning = true; 
                        window.state.stopRequested = false;
                        window.KeyboardBlocker.startBlocking();

                        const getUIStatus = () => {
                            const processing = !!document.querySelector(".kAxcVK, .fTmHUY, .dukARQ, [class*='loading']");
                            const imgs = Array.from(document.querySelectorAll('img.sc-5923b123-1')).map(img => img.src);
                            return { processing, imgs };
                        };

                        for (let i = window.state.currentIndex; i < window.state.prompts.length; i++) {
                            if (window.state.stopRequested) break;
                            const currentPrompt = window.state.prompts[i]; 
                            console.log(`PROMPT_INDEX_UPDATE:${i + 1}`); // Envia para o servidor

                            let promptResolved = false; 
                            let attempts = 0; 
                            const MAX_ATTEMPTS = 3;

                            while (!promptResolved && !window.state.stopRequested && attempts < MAX_ATTEMPTS) {
                                attempts++;
                                window.state.initialUrls = new Set(getUIStatus().imgs);
                                await window.PersistentManager.injectAssets(currentPrompt, window.log);
                                
                                const inputEl = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector("textarea");
                                const btn = [...document.querySelectorAll("button, i")].find(e => e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward"));
                                
                                if (!inputEl || !btn) { 
                                    window.log("Elementos de interface não encontrados. Aguardando...", "warning");
                                    await window.wait(2000); 
                                    continue; 
                                }
                                
                                inputEl.focus(); 
                                document.execCommand('selectAll', false, null); 
                                document.execCommand('delete', false, null);
                                await window.wait(300); 
                                
                                const dt = new DataTransfer(); 
                                dt.setData('text/plain', currentPrompt);
                                inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                                
                                window.log(`Enviando prompt [${i+1}] (Tentativa ${attempts})...`, "info"); 
                                await window.wait(500); 
                                btn.click();

                                // Notificar servidor para tirar print do envio
                                console.log("ACTION:SCREENSHOT_PROMPT");

                                let startedProcessing = false;
                                for (let att = 0; att < 15; att++) { 
                                    if (getUIStatus().processing) { startedProcessing = true; break; } 
                                    await window.wait(1000); 
                                }
                                
                                let waitTimer = 0;
                                const MAX_WAIT = 120;
                                while (!window.state.stopRequested && waitTimer < MAX_WAIT) {
                                    const status = getUIStatus(); 
                                    if (status.processing) { 
                                        await window.wait(2000); 
                                        waitTimer += 2; 
                                        continue; 
                                    }
                                    
                                    await window.wait(4000); 
                                    const finalStatus = getUIStatus();
                                    const newImages = finalStatus.imgs.filter(url => !window.state.initialUrls.has(url) && !window.state.capturedBlobs.some(b => b.url === url));
                                    
                                    if (newImages.length >= 2) {
                                        window.log(`Sucesso: [${newImages.length}] imagens no prompt [${i+1}]`, "success");
                                        console.log(`IMAGES_CAPTURED:${i+1}:${JSON.stringify(newImages)}`);

                                        promptResolved = true; 
                                        window.state.currentIndex = i + 1; 
                                        break;
                                    } else if (newImages.length === 1) {
                                        window.log(`Apenas 1 imagem detectada. Reiniciando prompt [${i+1}]...`, "warning");
                                        await window.wait(3000);
                                        break; 
                                    } else { 
                                        if (attempts < MAX_ATTEMPTS) {
                                            window.log(`Aguardando renderização final do prompt [${i+1}]...`, "warning");
                                            await window.wait(5000);
                                            const recheck = getUIStatus();
                                            const reImages = recheck.imgs.filter(url => !window.state.initialUrls.has(url));
                                            if(reImages.length >= 2) continue;
                                            window.log(`Nenhuma imagem detectada após carregamento (T${attempts}). Reiniciando...`, "reinject"); 
                                        } else {
                                            window.log(`Falha definitiva no prompt [${i+1}] após ${MAX_ATTEMPTS} tentativas.`, "error");
                                            window.state.currentIndex = i + 1;
                                            promptResolved = true;
                                        }
                                        break; 
                                    }
                                }
                            }
                        }
                        if (!window.state.stopRequested && window.state.currentIndex >= window.state.prompts.length) { 
                            window.log("Automação finalizada!", "success"); 
                        }
                        window.KeyboardBlocker.stopBlocking();
                        window.state.isRunning = false;
                    };

                    // Inicia o processo
                    window.processPrompts();

                }, prompts);

                // Capturar logs e eventos do navegador remoto
                page.on('console', async (msg) => {
                    const text = msg.text();
                    if (text.startsWith('AUTO_LOG:')) {
                        const [_, type, message] = text.split(':');
                        socket.emit('log', message);
                    }
                    if (text === 'ACTION:SCREENSHOT_PROMPT') {
                        await delay(1000);
                        const shot = await page.screenshot({ encoding: 'base64' });
                        socket.emit('screenshot-update', { img: `data:image/png;base64,${shot}`, title: "GERANDO IMAGENS..." });
                    }
                    if (text.startsWith('IMAGES_CAPTURED:')) {
                        const parts = text.split(':');
                        const index = parts[1];
                        const urls = JSON.parse(parts[2]);
                        socket.emit('new-images', { index, urls });
                    }
                });
            });

        } catch (error) {
            socket.emit('log', `❌ Erro Crítico: ${error.message}`);
            if (browser) await browser.close();
        }
    });

    socket.on('confirm-start', () => {
        // Apenas um gatilho para o servidor
    });

    socket.on('stop-automation', async () => {
        if (browser) await browser.close();
        socket.emit('log', "🛑 Automação parada pelo usuário.");
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
