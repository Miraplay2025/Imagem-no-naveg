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

    socket.on('start-automation', async (data) => {
        const { link, prompts, cookiesBase64 } = data;

        try {
            socket.emit('log', "🚀 Iniciando Puppeteer (Modo Robustez)...");

            if (browser) await browser.close().catch(() => {});

            browser = await puppeteer.launch({
                headless: "new",
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null, // Importante para o Render
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-zygote',
                    '--single-process',
                    '--disable-web-security',
                    '--window-size=1280,800'
                ]
            });

            page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });

            socket.emit('log', "🔑 Aplicando cookies...");
            try {
                const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
                const cookies = JSON.parse(cookiesRaw);
                await page.setCookie(...cookies);
            } catch (e) {
                socket.emit('log', "❌ Erro nos cookies: Formato inválido.");
                return;
            }

            socket.emit('log', `🌐 Acessando: ${link}`);
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 70000 });
            } catch (navError) {
                socket.emit('log', "⚠️ Aviso: Carregamento lento, tentando prosseguir...");
            }

            await delay(5000);
            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', {
                img: `data:image/png;base64,${screenshot}`,
                title: "VERIFICAÇÃO DE LOGIN"
            });

            socket.emit('automation-status', { showConfirm: true });
            socket.emit('log', "👀 Aguardando confirmação visual...");

            socket.removeAllListeners('confirm-start');
            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Iniciando lista de prompts...");

                for (let i = 0; i < prompts.length; i++) {
                    const currentPrompt = prompts[i];
                    socket.emit('log', `📝 Enviando Prompt ${i + 1}/${prompts.length}...`);

                    const selector = 'div[role="textbox"][contenteditable="true"], textarea';
                    await page.waitForSelector(selector, { timeout: 15000 });
                    await page.click(selector);
                    await delay(500);

                    // Injeta o texto
                    await page.evaluate((text) => {
                        const inputEl = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector("textarea");
                        inputEl.focus();
                        document.execCommand('selectAll', false, null);
                        document.execCommand('delete', false, null);
                        const dt = new DataTransfer();
                        dt.setData('text/plain', text);
                        inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                    }, currentPrompt);

                    await delay(1000);

                    // Clica no Botão de Enviar
                    await page.evaluate(() => {
                        const btn = [...document.querySelectorAll("button, i, span")].find(e =>
                            e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                        );
                        if (btn) btn.click();
                    });

                    // Loop de Prints a cada 5 segundos
                    const waitResult = () => new Promise((resolve) => {
                        screenshotInterval = setInterval(async () => {
                            try {
                                const screen = await page.screenshot({ encoding: 'base64' });
                                socket.emit('screenshot-update', {
                                    img: `data:image/png;base64,${screen}`,
                                    title: `PROCESSANDO PROMPT #${i + 1}`
                                });
                                socket.emit('waiting-user-validation');
                            } catch (err) { clearInterval(screenshotInterval); }
                        }, 5000);

                        socket.once('next-prompt', () => {
                            clearInterval(screenshotInterval);
                            resolve();
                        });
                    });

                    await waitResult();
                    socket.emit('log', `✔️ Prompt ${i + 1} validado pelo usuário.`);
                }

                socket.emit('log', "🏁 Automação finalizada!");
                socket.emit('automation-finished');
            });

        } catch (error) {
            socket.emit('log', `❌ Erro Fatal: ${error.message}`);
            if (browser) await browser.close();
        }
    });

    socket.on('stop-automation', async () => {
        if (screenshotInterval) clearInterval(screenshotInterval);
        if (browser) await browser.close();
        browser = null;
        socket.emit('log', "🛑 Operação interrompida.");
        socket.emit('automation-stopped-confirmed');
    });
});

server.listen(3000, () => console.log('Servidor rodando na porta 3000'));
