const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// --- SISTEMA ANTI-BLOQUEIO (STEALTH) ---
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
// ---------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

io.on('connection', (socket) => {
    console.log('Cliente conectado');
    let browser = null;
    let page = null;

    socket.on('start-automation', async (data) => {
        const { link, prompts, cookiesBase64 } = data;

        try {
            socket.emit('log', "🚀 Iniciando Navegador Camuflado (Modo Real)...");

            if (browser) await browser.close().catch(() => {});

            browser = await puppeteer.launch({
                headless: "new", // "new" é mais difícil de detectar que o headless antigo
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled', // Remove o sinalizador de automação
                    '--window-size=1280,800'
                ]
            });

            page = await browser.newPage();
            
            // Define um User-Agent de um navegador Chrome real e atualizado
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1280, height: 800 });

            socket.emit('log', "🔑 Injetando credenciais de sessão...");
            const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);

            socket.emit('log', `🌐 Navegando até o Flow...`);
            
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 80000 });
            } catch (navError) {
                socket.emit('log', "⚠️ Conexão lenta, tentando prosseguir...");
            }

            await delay(5000);

            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', {
                img: `data:image/png;base64,${screenshot}`,
                title: "NAVEGADOR REAL SIMULADO"
            });
            
            socket.emit('automation-status', { showConfirm: true });
            socket.emit('log', "👀 Verifique se o login está OK no print e confirme.");

            socket.removeAllListeners('confirm-start'); 
            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Confirmação recebida! Iniciando ciclo humano...");
                
                for (let i = 0; i < prompts.length; i++) {
                    const currentPrompt = prompts[i];
                    let attempts = 0;
                    let success = false;

                    while (attempts < 3 && !success) {
                        attempts++;
                        socket.emit('log', `📝 Prompt ${i + 1}/${prompts.length} (Tentativa ${attempts})`);

                        try {
                            if (!page) throw new Error("Página perdida");
                            
                            // Mapeia imagens antes da nova geração
                            const existingImages = await page.evaluate(() => {
                                return [...document.querySelectorAll('img[alt="Imagem gerada"]')].map(img => img.src);
                            });

                            // Espera o campo de texto aparecer
                            const selector = 'div[role="textbox"], textarea';
                            await page.waitForSelector(selector, { timeout: 15000 });

                            // --- SIMULAÇÃO DE COMPORTAMENTO HUMANO ---
                            // 1. Move o mouse até o campo antes de clicar
                            const rect = await page.evaluate((sel) => {
                                const el = document.querySelector(sel);
                                const { x, y, width, height } = el.getBoundingClientRect();
                                return { x, y, width, height };
                            }, selector);
                            await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
                            await delay(200);
                            await page.click(selector);
                            await delay(500);

                            // 2. Injeta o texto usando o comando de "paste" simulado para estabilidade
                            const sendResult = await page.evaluate(async (text) => {
                                try {
                                    const inputEl = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector("textarea");
                                    const btn = [...document.querySelectorAll("button, i, span")].find(e => 
                                        e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                                    );
                                    
                                    if (!inputEl || !btn) return { status: 'error', msg: "Interface não encontrada" };
                                    
                                    inputEl.focus(); 
                                    document.execCommand('selectAll', false, null); 
                                    document.execCommand('delete', false, null);
                                    
                                    await new Promise(r => setTimeout(r, 400)); 
                                    
                                    const dt = new DataTransfer(); 
                                    dt.setData('text/plain', text);
                                    inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                                    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                                    
                                    return { status: 'ok' };
                                } catch (e) { return { status: 'error', msg: e.message }; }
                            }, currentPrompt);

                            if (sendResult.status === 'error') throw new Error(sendResult.msg);

                            // 3. Pequena pausa "pensativa" e clica no botão de enviar
                            await delay(800);
                            const btnRect = await page.evaluate(() => {
                                const b = [...document.querySelectorAll("button, i, span")].find(e => 
                                    e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                                );
                                if (!b) return null;
                                const { x, y, width, height } = b.getBoundingClientRect();
                                return { x, y, width, height };
                            });
                            
                            if (btnRect) {
                                await page.mouse.move(btnRect.x + btnRect.width / 2, btnRect.y + btnRect.height / 2);
                                await page.mouse.down();
                                await delay(100);
                                await page.mouse.up();
                            }

                            socket.emit('log', `⏳ Aguardando processamento do Flow...`);

                            // Espera o ícone de progresso aparecer e depois sumir
                            try {
                                await page.waitForSelector('.kAxcVK', { timeout: 25000 });
                            } catch (e) {}

                            await page.waitForFunction(() => !document.querySelector('.kAxcVK'), { timeout: 200000 });
                            
                            socket.emit('log', "✅ Processamento concluído. Capturando resultados...");

                            let validImages = [];
                            let checkAttempts = 0;
                            
                            while (checkAttempts < 10 && validImages.length === 0) {
                                checkAttempts++;
                                
                                // Verifica se o site jogou erro de "Falha" (Bloqueio)
                                const siteError = await page.evaluate(() => {
                                    const t = document.body.innerText;
                                    return t.includes("Falha") || t.includes("Algo deu errado");
                                });

                                if (siteError) throw new Error("Bloqueio detectado: O site retornou 'Algo deu errado'.");

                                await delay(4000);

                                const captured = await page.evaluate(async (oldImgs) => {
                                    const allImgs = [...document.querySelectorAll('img[alt="Imagem gerada"]')];
                                    const news = allImgs.filter(img => 
                                        !oldImgs.includes(img.src) && 
                                        img.src.startsWith('http') && 
                                        img.naturalWidth > 10
                                    );
                                    
                                    return Promise.all(news.map(async (img) => {
                                        try {
                                            const resp = await fetch(img.src);
                                            const blob = await resp.blob();
                                            return new Promise(r => {
                                                const reader = new FileReader();
                                                reader.onloadend = () => r(reader.result);
                                                reader.readAsDataURL(blob);
                                            });
                                        } catch (err) { return null; }
                                    }));
                                }, existingImages);

                                validImages = captured.filter(img => img !== null);
                                if (validImages.length > 0) break;
                                socket.emit('log', `🔍 Analisando renderização (${checkAttempts}/10)...`);
                            }

                            if (validImages.length > 0) {
                                socket.emit('new-images', { index: i + 1, urls: validImages });
                                socket.emit('log', `✨ Prompt ${i+1} finalizado com sucesso!`);
                                success = true;
                            } else {
                                throw new Error("As imagens não apareceram no tempo esperado.");
                            }

                        } catch (err) {
                            const errorSnap = await page.screenshot({ encoding: 'base64' }).catch(() => null);
                            if(errorSnap) {
                                socket.emit('screenshot-update', {
                                    img: `data:image/png;base64,${errorSnap}`,
                                    title: `ERRO DE DETECÇÃO - PROMPT ${i+1}`
                                });
                            }

                            socket.emit('log', `❌ Erro: ${err.message}`, "error");
                            
                            if (attempts < 3) {
                                socket.emit('log', "🔄 Limpando cache e recarregando para nova tentativa...");
                                await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
                                await delay(5000);
                            } else {
                                socket.emit('log', `🚫 Pulando para o próximo prompt.`);
                                success = true; 
                            }
                        }
                    }
                }
                socket.emit('log', "🏁 Automação finalizada!");
            });

        } catch (error) {
            console.error(error);
            socket.emit('log', "❌ ERRO CRÍTICO: " + error.message, "error");
            if (browser) await browser.close().catch(() => {});
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) await browser.close().catch(() => {});
        socket.emit('log', "🛑 Operação interrompida.");
    });

    socket.on('disconnect', async () => {
        if (browser) await browser.close().catch(() => {});
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server ON na porta ${PORT}`));
