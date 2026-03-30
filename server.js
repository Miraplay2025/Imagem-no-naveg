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

            // Se já houver um browser aberto para esta conexão, fecha antes de iniciar
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

            // Tratamento de erros de desconexão de frame/navegação
            page.on('error', err => {
                socket.emit('log', `❌ Erro na página: ${err.message}`, "error");
            });

            socket.emit('log', "🔑 Aplicando cookies de autenticação...");
            const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);

            socket.emit('log', `🌐 Acessando: ${link}`);
            
            // Try-catch específico para a navegação inicial
            try {
                await page.goto(link, { 
                    waitUntil: 'networkidle2', 
                    timeout: 70000 
                });
            } catch (navError) {
                socket.emit('log', "⚠️ Aviso: A página demorou a carregar 100%, tentando prosseguir mesmo assim...");
            }

            await delay(5000);

            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', {
                img: `data:image/png;base64,${screenshot}`,
                title: "VERIFICAÇÃO DE LOGIN"
            });
            
            socket.emit('automation-status', { showConfirm: true });
            socket.emit('log', "👀 Aguardando confirmação visual do usuário...");

            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Confirmação recebida! Iniciando automação...");
                
                for (let i = 0; i < prompts.length; i++) {
                    const currentPrompt = prompts[i];
                    let attempts = 0;
                    let success = false;

                    while (attempts < 3 && !success) {
                        attempts++;
                        socket.emit('log', `📝 Processando Prompt ${i + 1} (Tentativa ${attempts})`);

                        try {
                            // Salvar imagens atuais antes de enviar
                            const existingImages = await page.evaluate(() => {
                                return [...document.querySelectorAll('img[alt="Imagem gerada"]')].map(img => img.src);
                            });

                            // Injeção de Prompt (Simulação de Colagem)
                            await page.evaluate((text) => {
                                const inputEl = document.querySelector('div[role="textbox"]') || document.querySelector('textarea');
                                if (!inputEl) throw new Error("Campo de texto não encontrado");

                                inputEl.focus();
                                document.execCommand('selectAll', false, null);
                                document.execCommand('delete', false, null);

                                const dt = new DataTransfer();
                                dt.setData('text/plain', text);
                                const pasteEvent = new ClipboardEvent('paste', {
                                    clipboardData: dt, bubbles: true, cancelable: true
                                });
                                inputEl.dispatchEvent(pasteEvent);
                                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                            }, currentPrompt);

                            await delay(800);

                            // Clique no botão enviar
                            const clicked = await page.evaluate(() => {
                                const btn = [...document.querySelectorAll("button, i, span")].find(e => 
                                    e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                                );
                                if (btn) { btn.click(); return true; }
                                return false;
                            });

                            if (!clicked) throw new Error("Botão de envio não encontrado");

                            // Monitorar carregamento
                            try {
                                await page.waitForSelector('.kAxcVK', { timeout: 15000 });
                                socket.emit('log', `carregamento de imagem de prompt ${i+1} iniciado`);
                                const loadingSnap = await page.screenshot({ encoding: 'base64' });
                                socket.emit('screenshot-update', { img: `data:image/png;base64,${loadingSnap}`, title: "GERANDO..." });
                            } catch (e) {
                                socket.emit('log', "⏳ Aguardando processamento...");
                            }

                            // Esperar finalização
                            await page.waitForFunction(() => !document.querySelector('.kAxcVK'), { timeout: 120000 });
                            socket.emit('log', "processamento sumir, aguardado alguns segundos...");
                            await delay(6000);

                            // Capturar novas imagens
                            const newImages = await page.evaluate((oldImgs) => {
                                const news = [...document.querySelectorAll('img[alt="Imagem gerada"]')].filter(img => !oldImgs.includes(img.src));
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

                            if (newImages.length > 0) {
                                socket.emit('new-images', { index: i + 1, urls: newImages });
                                socket.emit('log', `✅ sucesso ${newImages.length} de imagens capturadas de prompt ${i+1}`);
                                success = true;
                            } else {
                                throw new Error(`nenhuma imagem encontrada no prompt ${i+1}`);
                            }

                        } catch (err) {
                            socket.emit('log', `❌ Erro no prompt ${i+1}: ${err.message}`);
                            if (attempts < 3) {
                                socket.emit('log', `reiviado o prompt ${i+1}...`);
                                await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
                                await delay(4000);
                            } else {
                                socket.emit('log', `🚫 erro definitive ao gerar imagens de prompt ${i+1} proseguindo pra o proximo prompt ${i+2}`);
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
        socket.emit('log', "🛑 Operação parada.");
    });

    socket.on('disconnect', async () => {
        if (browser) await browser.close().catch(() => {});
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
