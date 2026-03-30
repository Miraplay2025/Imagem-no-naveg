const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');

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
            socket.emit('log', "🚀 Iniciando Puppeteer no Render...");

            if (browser) await browser.close().catch(() => {});

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
            
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 70000 });
            } catch (navError) {
                socket.emit('log', "⚠️ Aviso: Carregamento parcial, tentando prosseguir...");
            }

            await delay(5000);

            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', {
                img: `data:image/png;base64,${screenshot}`,
                title: "VERIFICAÇÃO DE LOGIN"
            });
            
            socket.emit('automation-status', { showConfirm: true });
            socket.emit('log', "👀 Aguardando confirmação visual do usuário...");

            socket.removeAllListeners('confirm-start'); 
            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Confirmação recebida! Iniciando automação...");
                
                for (let i = 0; i < prompts.length; i++) {
                    const currentPrompt = prompts[i];
                    let attempts = 0;
                    let success = false;

                    while (attempts < 3 && !success) {
                        attempts++;
                        socket.emit('log', `📝 Processando Prompt ${i + 1}/${prompts.length} (Tentativa ${attempts})`);

                        try {
                            if (!page) throw new Error("Página perdida");
                            await page.bringToFront();

                            // Mapeia o que já existe para não capturar imagens antigas
                            const existingImages = await page.evaluate(() => {
                                return [...document.querySelectorAll('img[alt="Imagem gerada"]')].map(img => img.src);
                            });

                            await page.waitForSelector('div[role="textbox"], textarea', { timeout: 15000 });

                            const sendResult = await page.evaluate(async (text) => {
                                try {
                                    const inputEl = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector("textarea");
                                    const btn = [...document.querySelectorAll("button, i, span")].find(e => 
                                        e.innerText?.includes("arrow_forward") || 
                                        e.textContent?.includes("arrow_forward")
                                    );
                                    
                                    if (!inputEl || !btn) return { status: 'error', msg: "Elementos de interface não encontrados" };
                                    
                                    inputEl.focus(); 
                                    document.execCommand('selectAll', false, null); 
                                    document.execCommand('delete', false, null);
                                    
                                    await new Promise(r => setTimeout(r, 500)); 
                                    
                                    const dt = new DataTransfer(); 
                                    dt.setData('text/plain', text);
                                    inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                                    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                                    
                                    await new Promise(r => setTimeout(r, 800)); 
                                    btn.click();
                                    return { status: 'ok' };
                                } catch (e) {
                                    return { status: 'error', msg: e.message };
                                }
                            }, currentPrompt);

                            if (sendResult.status === 'error') throw new Error(sendResult.msg);

                            socket.emit('log', `⏳ Enviado. Aguardando aparecer o processamento...`);

                            // 1. ESPERA O CARREGADOR APARECER (kAxcVK)
                            try {
                                await page.waitForSelector('.kAxcVK', { timeout: 20000 });
                                socket.emit('log', `⚙️ Geração do prompt ${i+1} detectada (Iniciando...)`);
                            } catch (e) {
                                socket.emit('log', `⚠️ Loader não visível, mas aguardando imagens...`);
                            }
                            
                            // PRINT DO ESTADO DE GERAÇÃO (Aquele que você viu com 3%)
                            const genSnap = await page.screenshot({ encoding: 'base64' });
                            socket.emit('screenshot-update', {
                                img: `data:image/png;base64,${genSnap}`,
                                title: `GERANDO IMAGENS: PROMPT ${i+1}`
                            });

                            // 2. ESPERA O CARREGADOR SUMIR (Fim da geração)
                            await page.waitForFunction(() => !document.querySelector('.kAxcVK'), { timeout: 240000 });
                            
                            socket.emit('log', "✅ Processamento visual sumiu. Aguardando 12s para renderização final...");
                            await delay(12000); // Aumentado para garantir que a imagem carregue após o 99%

                            // 3. CAPTURA DAS NOVAS IMAGENS COM FILTRO DE SEGURANÇA
                            const newImages = await page.evaluate(async (oldImgs) => {
                                const allImgs = [...document.querySelectorAll('img[alt="Imagem gerada"]')];
                                // Filtra apenas as que não estavam lá antes e que tenham um SRC válido (não vazio ou data:vazio)
                                const news = allImgs.filter(img => !oldImgs.includes(img.src) && img.src.length > 50);
                                
                                if (news.length === 0) return [];

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

                            const validImages = newImages.filter(img => img !== null);

                            if (validImages.length > 0) {
                                socket.emit('new-images', { index: i + 1, urls: validImages });
                                socket.emit('log', `✨ Sucesso! ${validImages.length} imagens capturadas do prompt ${i+1}`);
                                success = true;
                            } else {
                                throw new Error(`Imagens não renderizadas a tempo no prompt ${i+1}`);
                            }

                        } catch (err) {
                            const errorSnap = await page.screenshot({ encoding: 'base64' }).catch(() => null);
                            if(errorSnap) {
                                socket.emit('screenshot-update', {
                                    img: `data:image/png;base64,${errorSnap}`,
                                    title: `ERRO NO PROMPT ${i+1}`
                                });
                            }

                            socket.emit('log', `❌ Erro no prompt ${i+1}: ${err.message}`, "error");
                            if (attempts < 3) {
                                socket.emit('log', `🔄 Reiniciando tentativa ${attempts + 1} para o prompt ${i+1}...`);
                                await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
                                await delay(5000);
                            } else {
                                socket.emit('log', `🚫 Falha definitiva no prompt ${i+1}. Pulando...`);
                                success = true; // Força saída do loop de tentativas para não travar a lista
                            }
                        }
                    }
                }
                socket.emit('log', "🏁 Automação de toda a lista finalizada!");
            });

        } catch (error) {
            console.error(error);
            socket.emit('log', "❌ ERRO CRÍTICO NO SISTEMA: " + error.message, "error");
            if (browser) await browser.close().catch(() => {});
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) await browser.close().catch(() => {});
        socket.emit('log', "🛑 Automação parada manualmente.");
    });

    socket.on('disconnect', async () => {
        if (browser) await browser.close().catch(() => {});
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server ON na porta ${PORT}`));
