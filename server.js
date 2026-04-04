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
    socket.emit('log', "🔌 Socket conectado com sucesso!");

    let browser = null;
    let page = null;
    let screenshotInterval = null;

    const closeEverything = async () => {
        if (screenshotInterval) clearInterval(screenshotInterval);
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                console.log("Erro ao fechar browser:", e.message);
            }
        }
        browser = null;
        page = null;
    };

    socket.on('start-automation', async (data) => {
        const { link, prompts, cookiesBase64 } = data;

        try {
            socket.emit('log', "🚀 Iniciando Puppeteer no Render...");

            if (browser) await browser.close().catch(() => {});

            // Lógica de abertura GARANTIDA + Modo Anti-Detecção
            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--window-size=1280,800',
                    '--disable-blink-features=AutomationControlled', // Remove flag de robô
                    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                ]
            });

            page = await browser.newPage();

            // Script para mascarar o Puppeteer (Evita erros de geração de imagem)
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

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
                    if (!browser || !page) break;

                    const currentPrompt = prompts[i];
                    socket.emit('log', `📝 Injetando Prompt ${i + 1}/${prompts.length}...`);

                    const selector = 'div[role="textbox"][contenteditable="true"], textarea';
                    await page.waitForSelector(selector, { timeout: 30000 });
                    await page.click(selector);
                    
                    await page.evaluate((text) => {
                        const el = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector("textarea");
                        el.focus();
                        document.execCommand('selectAll', false, null);
                        document.execCommand('delete', false, null);
                        const dt = new DataTransfer();
                        dt.setData('text/plain', text);
                        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                    }, currentPrompt);

                    await delay(1200); // Delay levemente maior para segurança

                    await page.evaluate(() => {
                        const b = [...document.querySelectorAll("button, i, span")].find(e => 
                            e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                        );
                        if (b) b.click();
                    });

                    socket.emit('log', `⏳ Aguardando geração do Prompt #${i+1}...`);

                    const monitorGeneration = async () => {
                        return new Promise((resolve) => {
                            screenshotInterval = setInterval(async () => {
                                try {
                                    if (page && !page.isClosed()) {
                                        const screen = await page.screenshot({ encoding: 'base64' });
                                        socket.emit('screenshot-update', { 
                                            img: `data:image/png;base64,${screen}`, 
                                            title: `PROCESSANDO PROMPT #${i+1}` 
                                        });
                                        socket.emit('waiting-user-validation');
                                    }
                                } catch (e) { clearInterval(screenshotInterval); }
                            }, 5000);

                            socket.once('next-prompt', () => {
                                clearInterval(screenshotInterval);
                                resolve();
                            });
                        });
                    };

                    await monitorGeneration();
                    socket.emit('log', `✔️ Prompt ${i+1} concluído.`);
                }

                socket.emit('log', "🏁 Automação finalizada!");
                socket.emit('automation-finished');
            });

        } catch (error) {
            socket.emit('log', `❌ Erro Fatal: ${error.message}`);
            await closeEverything();
        }
    });

    socket.on('stop-automation', async () => {
        await closeEverything();
        socket.emit('log', "🛑 Robô parado com sucesso!");
        socket.emit('automation-stopped-confirmed');
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server rodando em http://localhost:${PORT}`));
