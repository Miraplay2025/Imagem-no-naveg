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
    console.log('Cliente conectado:', socket.id);
    let browser = null;
    let page = null;

    socket.on('start-automation', async (data) => {
        const { link, prompts, cookiesBase64 } = data;

        try {
            socket.emit('log', "🚀 Iniciando Puppeteer no Render...");

            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process'
                ]
            });

            page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });

            socket.emit('log', "🔑 Aplicando cookies de autenticação...");
            const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);

            socket.emit('log', `🌐 Acessando: ${link}`);
            await page.goto(link, { waitUntil: 'networkidle2', timeout: 90000 });

            await delay(5000);

            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', {
                img: `data:image/png;base64,${screenshot}`,
                title: "VERIFICAÇÃO DE LOGIN"
            });
            
            socket.emit('automation-status', { showConfirm: true });
            socket.emit('log', "⚠️ Aguardando sua confirmação no painel para injetar os prompts...");

            // Aguarda o clique no botão "Confirmar" do HTML
            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Confirmação recebida! Iniciando ciclo de prompts...");
                
                for (let i = 0; i < prompts.length; i++) {
                    const currentPrompt = prompts[i];
                    let attempts = 0;
                    let success = false;

                    while (attempts < 3 && !success) {
                        attempts++;
                        socket.emit('log', `📝 Processando Prompt ${i + 1}/${prompts.length} (Tentativa ${attempts})`);

                        try {
                            // 1. Mapear imagens existentes para ignorar depois
                            const existingImages = await page.evaluate(() => {
                                return [...document.querySelectorAll('img[alt="Imagem gerada"]')].map(img => img.src);
                            });

                            // 2. Injetar o Prompt via simulação de colagem (DataTransfer)
                            const injectionResult = await page.evaluate((text) => {
                                const inputEl = document.querySelector('div[role="textbox"]') || document.querySelector('textarea');
                                if (!inputEl) return false;

                                inputEl.focus();
                                document.execCommand('selectAll', false, null);
                                document.execCommand('delete', false, null);

                                const dt = new DataTransfer();
                                dt.setData('text/plain', text);
                                
                                const pasteEvent = new ClipboardEvent('paste', {
                                    clipboardData: dt,
                                    bubbles: true,
                                    cancelable: true
                                });
                                inputEl.dispatchEvent(pasteEvent);

                                // Disparar eventos de input para o React/Angular detectar mudança
                                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                                return true;
                            }, currentPrompt);

                            if (!injectionResult) {
                                throw new Error("Campo de texto não encontrado na página.");
                            }

                            await delay(800);

                            // 3. Clicar no botão de envio (arrow_forward)
                            const clickResult = await page.evaluate(() => {
                                const btn = [...document.querySelectorAll("button, i, span")].find(e => 
                                    e.innerText?.includes("arrow_forward") || 
                                    e.textContent?.includes("arrow_forward")
                                );
                                if (btn) {
                                    btn.click();
                                    return true;
                                }
                                return false;
                            });

                            if (!clickResult) {
                                throw new Error("Botão de envio não encontrado.");
                            }

                            socket.emit('log', `⏳ Aguardando início da geração...`);

                            // 4. Detectar classe de carregamento (ex: "kAxcVK")
                            try {
                                await page.waitForSelector('.kAxcVK', { timeout: 15000 });
                                socket.emit('log', `📸 Geração iniciada! Capturando status...`);
                                const loadingSnap = await page.screenshot({ encoding: 'base64' });
                                socket.emit('log', `carregamento de imagem de prompt ${i+1} iniciado`);
                            } catch (e) {
                                socket.emit('log', "⚠️ Classe de carregamento não vista, verificando imagens diretamente...");
                            }

                            // 5. Aguardar o processamento sumir
                            socket.emit('log', "⚙️ Processando... aguardando finalização.");
                            await page.waitForFunction(() => !document.querySelector('.kAxcVK'), { timeout: 120000 });
                            
                            socket.emit('log', "🔍 Processamento finalizado. Buscando novas imagens...");
                            await delay(5000); // Delay de segurança para as imagens renderizarem

                            // 6. Capturar apenas as novas imagens
                            const newImagesBase64 = await page.evaluate((oldImgs) => {
                                const currentImgs = [...document.querySelectorAll('img[alt="Imagem gerada"]')];
                                // Filtra imagens que não estavam na lista inicial
                                const news = currentImgs.filter(img => !oldImgs.includes(img.src));
                                
                                // Função auxiliar para converter img para base64 dentro do browser
                                return Promise.all(news.map(async (img) => {
                                    try {
                                        const response = await fetch(img.src);
                                        const blob = await response.blob();
                                        return new Promise((resolve) => {
                                            const reader = new FileReader();
                                            reader.onloadend = () => resolve(reader.result);
                                            reader.readAsDataURL(blob);
                                        });
                                    } catch (err) { return null; }
                                }));
                            }, existingImages);

                            const validImages = newImagesBase64.filter(img => img !== null);

                            if (validImages.length > 0) {
                                socket.emit('new-images', {
                                    index: i + 1,
                                    urls: validImages
                                });
                                socket.emit('log', `✅ Sucesso! ${validImages.length} imagens capturadas do prompt ${i+1}`);
                                success = true;
                            } else {
                                throw new Error(`Nenhuma imagem nova encontrada no prompt ${i+1}`);
                            }

                        } catch (err) {
                            socket.emit('log', `❌ Erro: ${err.message}`, "error");
                            if (attempts < 3) {
                                socket.emit('log', `🔄 Reinviando prompt ${i+1}...`);
                                await page.reload({ waitUntil: 'networkidle2' });
                                await delay(3000);
                            } else {
                                socket.emit('log', `🚫 Erro definitivo no prompt ${i+1}. Prosseguindo para o próximo...`);
                            }
                        }
                    }
                }
                socket.emit('log', "🏁 Automação finalizada com sucesso!");
            });

        } catch (error) {
            console.error(error);
            socket.emit('log', "❌ ERRO CRÍTICO: " + error.message, "error");
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) await browser.close();
        socket.emit('log', "🛑 Robô desligado pelo usuário.");
    });

    socket.on('disconnect', async () => {
        if (browser) await browser.close();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server rodando na porta ${PORT}`));
