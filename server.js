const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let browser = null;
let screenshotInterval = null;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

io.on('connection', (socket) => {
    console.log('Cliente conectado');
    socket.emit('log', "🔌 Conectado ao Servidor.");

    socket.on('start-automation', async (data) => {
        const { link, prompts, cookiesBase64 } = data;

        try {
            socket.emit('log', "🚀 Iniciando Puppeteer...");
            
            browser = await puppeteer.launch({
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });

            const cookies = JSON.parse(Buffer.from(cookiesBase64, 'base64').toString());
            await page.setCookie(...cookies);

            socket.emit('log', `🌐 Acessando: ${link}`);
            await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
            
            const screen = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', { img: `data:image/png;base64,${screen}`, title: "VERIFICAÇÃO DE LOGIN" });
            socket.emit('automation-status', { showConfirm: true });

            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Processando prompts...");

                for (let i = 0; i < prompts.length; i++) {
                    if (!browser) break; // Interrompe se o browser foi fechado

                    const currentPrompt = prompts[i];
                    socket.emit('log', `📝 Enviando Prompt ${i + 1}/${prompts.length}`);

                    const selector = 'div[role="textbox"][contenteditable="true"], textarea';
                    await page.waitForSelector(selector);
                    
                    await page.evaluate((text) => {
                        const el = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector("textarea");
                        el.focus();
                        document.execCommand('selectAll', false, null);
                        document.execCommand('delete', false, null);
                        const dt = new DataTransfer();
                        dt.setData('text/plain', text);
                        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                    }, currentPrompt);

                    await delay(800);
                    await page.evaluate(() => {
                        const b = [...document.querySelectorAll("button, i, span")].find(e => 
                            e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                        );
                        if (b) b.click();
                    });

                    // Loop de Prints a cada 5 segundos
                    await new Promise((resolve) => {
                        screenshotInterval = setInterval(async () => {
                            if (!browser) return clearInterval(screenshotInterval);
                            const screen = await page.screenshot({ encoding: 'base64' });
                            socket.emit('screenshot-update', { img: `data:image/png;base64,${screen}`, title: `PROMPT #${i+1} EM ANDAMENTO` });
                            socket.emit('waiting-user-validation');
                        }, 5000);

                        socket.once('next-prompt', () => {
                            clearInterval(screenshotInterval);
                            resolve();
                        });
                    });
                }
                socket.emit('log', "🏁 Automação concluída!");
            });

        } catch (error) {
            socket.emit('log', `❌ Erro: ${error.message}`);
        }
    });

    // ENCERRAR SEM RECARREGAR
    socket.on('stop-automation', async () => {
        if (screenshotInterval) clearInterval(screenshotInterval);
        if (browser) {
            await browser.close();
            browser = null;
        }
        socket.emit('log', "🚫 AUTOMAÇÃO ENCERRADA PELO USUÁRIO.");
        socket.emit('automation-stopped-confirm'); // Confirmação para o HTML
    });
});

server.listen(3000, () => console.log('http://localhost:3000'));
