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

    // Função para limpar processos antigos antes de começar
    const cleanUp = async () => {
        if (screenshotInterval) clearInterval(screenshotInterval);
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                console.log("Erro ao fechar browser antigo:", e.message);
            }
        }
        browser = null;
        page = null;
    };

    socket.on('start-automation', async (data) => {
        const { link, prompts, cookiesBase64 } = data;

        try {
            await cleanUp();
            socket.emit('log', "🚀 Iniciando Puppeteer...");

            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // Vital para evitar crash de memória
                    '--disable-gpu',
                    '--no-zygote',
                    '--single-process'
                ]
            });

            page = await browser.newPage();
            
            // Impede que a página feche por timeout de script
            page.setDefaultNavigationTimeout(90000); 
            await page.setViewport({ width: 1280, height: 800 });

            socket.emit('log', "🔑 Injetando cookies...");
            const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);

            socket.emit('log', `🌐 Navegando para o Flow...`);
            
            // Tenta acessar com retry simples
            try {
                await page.goto(link, { waitUntil: 'networkidle2' });
            } catch (err) {
                socket.emit('log', "⚠️ Conexão instável, verificando estado da página...");
            }

            await delay(5000);
            
            // Verifica se a página ainda está aberta antes do screenshot
            if (!page || page.isClosed()) throw new Error("A página foi fechada inesperadamente.");

            const screenshot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', {
                img: `data:image/png;base64,${screenshot}`,
                title: "VERIFICAÇÃO DE LOGIN"
            });

            socket.emit('automation-status', { showConfirm: true });

            socket.removeAllListeners('confirm-start');
            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Confirmação recebida! Processando...");

                for (let i = 0; i < prompts.length; i++) {
                    if (!page || page.isClosed()) break;

                    const currentPrompt = prompts[i];
                    socket.emit('log', `📝 Prompt ${i + 1}/${prompts.length}: Enviando...`);

                    const selector = 'div[role="textbox"][contenteditable="true"], textarea';
                    await page.waitForSelector(selector, { timeout: 20000 });
                    await page.click(selector);
                    
                    await page.evaluate((text) => {
                        const inputEl = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector("textarea");
                        inputEl.focus();
                        document.execCommand('selectAll', false, null);
                        document.execCommand('delete', false, null);
                        const dt = new DataTransfer();
                        dt.setData('text/plain', text);
                        inputEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, dataTransfer: dt, inputType: 'insertFromPaste' }));
                    }, currentPrompt);

                    await delay(1000);
                    
                    // Clique no botão de envio
                    await page.evaluate(() => {
                        const btn = [...document.querySelectorAll("button, i, span")].find(e =>
                            e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                        );
                        if (btn) btn.click();
                    });

                    // Loop de monitoramento de 5s
                    const monitor = () => new Promise((resolve) => {
                        screenshotInterval = setInterval(async () => {
                            if (!page || page.isClosed()) {
                                clearInterval(screenshotInterval);
                                return resolve();
                            }
                            try {
                                const screen = await page.screenshot({ encoding: 'base64' });
                                socket.emit('screenshot-update', {
                                    img: `data:image/png;base64,${screen}`,
                                    title: `MONITORANDO PROMPT #${i+1}`
                                });
                                socket.emit('waiting-user-validation');
                            } catch (e) { clearInterval(screenshotInterval); resolve(); }
                        }, 5000);

                        socket.once('next-prompt', () => {
                            clearInterval(screenshotInterval);
                            resolve();
                        });
                    });

                    await monitor();
                }
                socket.emit('log', "🏁 Automação finalizada!");
                socket.emit('automation-finished');
            });

        } catch (error) {
            console.error(error);
            socket.emit('log', `❌ Erro Fatal: ${error.message}`);
            await cleanUp();
        }
    });

    socket.on('stop-automation', async () => {
        await cleanUp();
        socket.emit('log', "🛑 Automação parada e browser fechado.");
        socket.emit('automation-stopped-confirmed');
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
        // Opcional: cleanUp(); // Fecha o browser se o usuário fechar a aba do navegador
    });
});

server.listen(3000, () => console.log('Servidor rodando em http://localhost:3000'));
