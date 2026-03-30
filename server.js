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

            socket.emit('log', "🔑 Aplicando cookies de autenticação...");
            const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);

            socket.emit('log', `🌐 Acessando: ${link}`);
            await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });

            await delay(7000); // Aumentado para estabilidade inicial

            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', { 
                img: `data:image/png;base64,${screenshot}`, 
                title: "VERIFICAÇÃO DE LOGIN" 
            });
            socket.emit('automation-status', { showConfirm: true });
            socket.emit('log', "👀 Aguardando confirmação visual do usuário...");

            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Confirmação recebida! Injetando lógica original...");

                await page.evaluate((promptsList) => {
                    // --- ESTADO INALTERADO ---
                    window.state = {
                        prompts: promptsList,
                        currentIndex: 0,
                        isRunning: false,
                        stopRequested: false,
                        capturedBlobs: [],
                        initialUrls: new Set()
                    };

                    window.wait = (ms) => new Promise(r => setTimeout(r, ms));
                    window.log = (msg, type) => { console.log(`AUTO_LOG:${type}:${msg}`); };

                    window.KeyboardBlocker = {
                        startBlocking: () => {
                            const style = document.createElement('style');
                            style.id = 'awu-block-style';
                            style.innerHTML = `input, textarea, [contenteditable="true"] { pointer-events: none !important; }`;
                            document.head.appendChild(style);
                        },
                        stopBlocking: () => {
                            const s = document.getElementById('awu-block-style');
                            if(s) s.remove();
                        }
                    };

                    window.PersistentManager = {
                        injectAssets: async (promptText, logCallback) => {
                            const assets = JSON.parse(localStorage.getItem("flow_persistent_assets_v3") || "[]");
                            const foundAssets = assets.filter(item => new RegExp(`\\b${item.nameNoExt}\\b`, 'gi').test(promptText));
                            if (foundAssets.length === 0) return;
                            for (let item of foundAssets) {
                                try {
                                    let searchInput = document.querySelector('input[placeholder="Pesquisar recursos"]');
                                    const addBtn = document.querySelector('button[class*="sc-addd5871-0"]') || [...document.querySelectorAll("button")].find(b => b.innerHTML.includes("add_2"));
                                    if (!searchInput && addBtn) { addBtn.click(); await window.wait(800); searchInput = document.querySelector('input[placeholder="Pesquisar recursos"]'); }
                                    if (searchInput) {
                                        searchInput.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
                                        const dt = new DataTransfer(); dt.setData('text/plain', item.nameNoExt);
                                        searchInput.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                                        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                                        await window.wait(1000);
                                        const target = [...document.querySelectorAll('.sc-3038c00b-16, .sc-dbfb6b4a-16')].find(el => el.textContent.toLowerCase().includes(item.nameNoExt.toLowerCase()));
                                        if (target) { target.click(); await window.wait(1000); }
                                    }
                                } catch (e) {}
                            }
                        }
                    };

                    window.processPrompts = async function() {
                        window.log("Iniciando processo de automação...", "success"); 
                        window.state.isRunning = true; 
                        window.state.stopRequested = false;
                        window.KeyboardBlocker.startBlocking();

                        const getUIStatus = () => {
                            // Verifica se há elementos de erro na UI para evitar capturas inválidas
                            const hasError = !!document.querySelector('div[class*="error"], .sc-falha'); 
                            const processing = !!document.querySelector(".kAxcVK, .fTmHUY, .dukARQ, [class*='loading']");
                            const imgs = Array.from(document.querySelectorAll('img.sc-5923b123-1')).map(img => img.src);
                            return { processing, imgs, hasError };
                        };

                        for (let i = window.state.currentIndex; i < window.state.prompts.length; i++) {
                            if (window.state.stopRequested) break;
                            const currentPrompt = window.state.prompts[i]; 
                            console.log(`PROMPT_INDEX_UPDATE:${i + 1}`);
                            
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
                                    window.log("Interface não pronta. Aguardando...", "warning");
                                    await window.wait(3000); 
                                    continue; 
                                }
                                
                                inputEl.focus(); 
                                document.execCommand('selectAll', false, null); 
                                document.execCommand('delete', false, null);
                                await window.wait(500); 
                                
                                const dt = new DataTransfer(); 
                                dt.setData('text/plain', currentPrompt);
                                inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                                
                                window.log(`Enviando prompt [${i+1}]...`, "info"); 
                                await window.wait(800); 
                                btn.click();
                                console.log("ACTION:SCREENSHOT_PROMPT");

                                let startedProcessing = false;
                                for (let att = 0; att < 20; att++) { 
                                    if (getUIStatus().processing) { startedProcessing = true; break; } 
                                    await window.wait(1000); 
                                }
                                
                                let waitTimer = 0;
                                const MAX_WAIT = 150;
                                
                                while (!window.state.stopRequested && waitTimer < MAX_WAIT) {
                                    const status = getUIStatus(); 
                                    if (status.processing) { 
                                        await window.wait(2500); 
                                        waitTimer += 2.5; 
                                        continue; 
                                    }
                                    
                                    // Aguarda renderização final
                                    await window.wait(5000); 
                                    const finalStatus = getUIStatus();
                                    
                                    const newImages = finalStatus.imgs.filter(url => !window.state.initialUrls.has(url) && !window.state.capturedBlobs.some(b => b.url === url));
                                    
                                    if (newImages.length >= 2) {
                                        window.log(`Sucesso: [${newImages.length}] imagens capturadas.`, "success");
                                        console.log(`IMAGES_CAPTURED:${i+1}:${JSON.stringify(newImages)}`);
                                        promptResolved = true; 
                                        window.state.currentIndex = i + 1; 
                                        break;
                                    } else {
                                        window.log(`Aguardando geração completa... (T${attempts})`, "warning");
                                        await window.wait(5000);
                                        const retryStatus = getUIStatus();
                                        const retryImages = retryStatus.imgs.filter(url => !window.state.initialUrls.has(url));
                                        if(retryImages.length >= 2) continue; 
                                        break;
                                    }
                                }
                            }
                        }
                        if (!window.state.stopRequested && window.state.currentIndex >= window.state.prompts.length) { 
                            window.log("Automação concluída com sucesso!", "success"); 
                        }
                        window.KeyboardBlocker.stopBlocking();
                        window.state.isRunning = false;
                    };

                    window.processPrompts();
                }, prompts);

                page.on('console', async (msg) => {
                    const text = msg.text();
                    if (text.startsWith('AUTO_LOG:')) {
                        socket.emit('log', text.split(':').slice(2).join(':'));
                    }
                    if (text === 'ACTION:SCREENSHOT_PROMPT') {
                        await delay(2000);
                        const shot = await page.screenshot({ encoding: 'base64' });
                        socket.emit('screenshot-update', { img: `data:image/png;base64,${shot}`, title: "GERANDO IMAGENS..." });
                    }
                    if (text.startsWith('IMAGES_CAPTURED:')) {
                        const parts = text.split(':');
                        socket.emit('new-images', { index: parts[1], urls: JSON.parse(parts[2]) });
                    }
                });
            });

        } catch (error) {
            socket.emit('log', `❌ Erro Crítico: ${error.message}`);
            if (browser) await browser.close();
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) await browser.close();
        socket.emit('log', "🛑 Automação interrompida.");
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
