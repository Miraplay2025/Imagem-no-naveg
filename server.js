const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// --- NOVO: Configuração Stealth para evitar detecção ---
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
// -------------------------------------------------------

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
            socket.emit('log', "🚀 Iniciando Puppeteer em Modo Camuflado (Stealth)...");

            if (browser) await browser.close().catch(() => {});

            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled', // Remove o aviso de "sendo controlado"
                    '--use-gl=desktop',
                    '--window-size=1280,800'
                ]
            });

            page = await browser.newPage();
            
            // Camuflagem extra de User-Agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            
            await page.setViewport({ width: 1280, height: 800 });

            socket.emit('log', "🔑 Aplicando cookies...");
            const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);

            socket.emit('log', `🌐 Acessando site...`);
            
            await page.goto(link, { waitUntil: 'networkidle2', timeout: 90000 });
            await delay(5000);

            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', {
                img: `data:image/png;base64,${screenshot}`,
                title: "MODO STEALTH ATIVADO"
            });
            
            socket.emit('automation-status', { showConfirm: true });

            socket.removeAllListeners('confirm-start'); 
            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Iniciando Processamento...");
                
                for (let i = 0; i < prompts.length; i++) {
                    const currentPrompt = prompts[i];
                    let attempts = 0;
                    let success = false;

                    while (attempts < 3 && !success) {
                        attempts++;
                        socket.emit('log', `📝 Prompt ${i + 1}/${prompts.length} (Tentativa ${attempts})`);

                        try {
                            const existingImages = await page.evaluate(() => {
                                return [...document.querySelectorAll('img[alt="Imagem gerada"]')].map(img => img.src);
                            });

                            await page.waitForSelector('div[role="textbox"], textarea', { timeout: 15000 });

                            // Simula um clique real antes de digitar
                            await page.click('div[role="textbox"], textarea');
                            await delay(500);

                            const sendResult = await page.evaluate(async (text) => {
                                try {
                                    const inputEl = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector("textarea");
                                    const btn = [...document.querySelectorAll("button, i, span")].find(e => 
                                        e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                                    );
                                    
                                    if (!inputEl || !btn) return { status: 'error', msg: "Input não encontrado" };
                                    
                                    inputEl.focus();
                                    document.execCommand('selectAll', false, null); 
                                    document.execCommand('delete', false, null);
                                    
                                    await new Promise(r => setTimeout(r, 500)); 
                                    
                                    const dt = new DataTransfer(); 
                                    dt.setData('text/plain', text);
                                    inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                                    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                                    
                                    await new Promise(r => setTimeout(r, 1000)); 
                                    btn.click();
                                    return { status: 'ok' };
                                } catch (e) { return { status: 'error', msg: e.message }; }
                            }, currentPrompt);

                            if (sendResult.status === 'error') throw new Error(sendResult.msg);

                            socket.emit('log', `⏳ Gerando...`);
                            
                            // Espera o progresso sumir
                            await page.waitForFunction(() => !document.querySelector('.kAxcVK'), { timeout: 200000 });
                            
                            // Checagem de erro do site
                            const hasError = await page.evaluate(() => document.body.innerText.includes("Falha") || document.body.innerText.includes("Algo deu errado"));
                            if (hasError) throw new Error("O Flow bloqueou a geração (Detecção de Bot?)");

                            let validImages = [];
                            for(let c=0; c<10; c++) {
                                await delay(4000);
                                const captured = await page.evaluate(async (oldImgs) => {
                                    const allImgs = [...document.querySelectorAll('img[alt="Imagem gerada"]')];
                                    const news = allImgs.filter(img => !oldImgs.includes(img.src) && img.src.startsWith('http') && img.naturalWidth > 10);
                                    
                                    return Promise.all(news.map(async (img) => {
                                        const resp = await fetch(img.src);
                                        const blob = await resp.blob();
                                        return new Promise(r => {
                                            const reader = new FileReader();
                                            reader.onloadend = () => r(reader.result);
                                            reader.readAsDataURL(blob);
                                        });
                                    }));
                                }, existingImages);
                                
                                validImages = captured.filter(img => img);
                                if (validImages.length > 0) break;
                                socket.emit('log', `🔍 Buscando imagem (${c+1}/10)...`);
                            }

                            if (validImages.length > 0) {
                                socket.emit('new-images', { index: i + 1, urls: validImages });
                                socket.emit('log', `✨ Sucesso no prompt ${i+1}`);
                                success = true;
                            } else {
                                throw new Error("Timeout ao carregar imagens");
                            }

                        } catch (err) {
                            socket.emit('log', `❌ Erro: ${err.message}`, "error");
                            if (attempts < 3) {
                                socket.emit('log', "🔄 Reiniciando página para limpar detecção...");
                                await page.reload({ waitUntil: 'networkidle2' });
                                await delay(5000);
                            } else {
                                success = true;
                            }
                        }
                    }
                }
                socket.emit('log', "🏁 Finalizado!");
            });

        } catch (error) {
            socket.emit('log', "❌ ERRO: " + error.message, "error");
            if (browser) await browser.close();
        }
    });

    socket.on('stop-automation', async () => { if (browser) await browser.close(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server ON na porta ${PORT}`));
