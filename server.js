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
            try { await browser.close(); } catch (e) {}
        }
        browser = null;
        page = null;
    };

    socket.on('start-automation', async (data) => {
        const { link, prompts, cookiesBase64 } = data;

        try {
            socket.emit('log', "🚀 Iniciando Puppeteer em modo Mobile...");

            if (browser) await browser.close().catch(() => {});

            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--no-first-run',
                    '--no-service-autorun',
                    '--password-store=basic',
                    '--user-agent=Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
                ]
            });

            page = await browser.newPage();

            // EMULAÇÃO DE DISPOSITIVO MÓVEL (Baseado no seu link do Samsung)
            await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36');
            await page.setViewport({ 
                width: 390, 
                height: 844, 
                isMobile: true, 
                hasTouch: true, 
                deviceScaleFactor: 3 
            });

            // OCULTAÇÃO DE BOT (Deep Stealth)
            await page.evaluateOnNewDocument(() => {
                // Remove a flag webdriver
                delete navigator.__proto__.webdriver;
                // Simula plugins reais
                window.navigator.chrome = { runtime: {} };
                // Simula permissões
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
                );
            });

            socket.emit('log', "🔑 Aplicando cookies...");
            const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);

            socket.emit('log', `🌐 Acessando: ${link}`);
            
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 80000 });
            } catch (navError) {
                socket.emit('log', "⚠️ Carregamento demorado, prosseguindo...");
            }

            await delay(5000);
            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', { img: `data:image/png;base64,${screenshot}`, title: "MOBILE PREVIEW" });
            
            socket.emit('automation-status', { showConfirm: true });

            socket.removeAllListeners('confirm-start'); 
            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Iniciando geração...");

                for (let i = 0; i < prompts.length; i++) {
                    if (!page) break;

                    const currentPrompt = prompts[i];
                    socket.emit('log', `📝 Prompt ${i + 1}/${prompts.length}...`);

                    const selector = 'div[role="textbox"][contenteditable="true"], textarea';
                    await page.waitForSelector(selector, { timeout: 40000 });
                    await page.focus(selector);
                    await delay(500);

                    // Digitação humana (mais lenta e segura)
                    await page.keyboard.type(currentPrompt, { delay: 30 });

                    await delay(1500);

                    // Clicar no botão de enviar
                    await page.evaluate(() => {
                        const btns = [...document.querySelectorAll("button, i, span, div")];
                        const b = btns.find(e => 
                            e.innerText?.includes("arrow_forward") || 
                            e.textContent?.includes("arrow_forward") ||
                            e.getAttribute('aria-label')?.includes("Send")
                        );
                        if (b) b.click();
                    });

                    socket.emit('log', `⏳ Monitorando geração...`);

                    const monitorGeneration = async () => {
                        return new Promise((resolve) => {
                            screenshotInterval = setInterval(async () => {
                                try {
                                    if (page && !page.isClosed()) {
                                        const screen = await page.screenshot({ encoding: 'base64' });
                                        socket.emit('screenshot-update', { 
                                            img: `data:image/png;base64,${screen}`, 
                                            title: `GERANDO PROMPT #${i+1}` 
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
                }
                socket.emit('log', "🏁 Finalizado!");
                socket.emit('automation-finished');
            });

        } catch (error) {
            socket.emit('log', `❌ Erro: ${error.message}`);
            await closeEverything();
        }
    });

    socket.on('stop-automation', async () => {
        await closeEverything();
        socket.emit('log', "🛑 Robô desligado.");
        socket.emit('automation-stopped-confirmed');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
