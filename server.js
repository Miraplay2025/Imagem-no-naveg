const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');

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
            socket.emit('log', "🚀 Iniciando Puppeteer...");

            browser = await puppeteer.launch({
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });

            page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });

            // Aplicar Cookies
            const cookies = JSON.parse(Buffer.from(cookiesBase64, 'base64').toString());
            await page.setCookie(...cookies);

            socket.emit('log', `🌐 Acessando Flow...`);
            await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
            
            // Print inicial para confirmação
            const screen = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', { img: `data:image/png;base64,${screen}`, title: "VERIFICAÇÃO DE LOGIN" });
            socket.emit('automation-status', { showConfirm: true });

            // Aguarda o usuário confirmar o início real
            socket.once('confirm-start', async () => {
                socket.emit('log', "✅ Iniciando processamento da lista...");

                for (let i = 0; i < prompts.length; i++) {
                    const currentPrompt = prompts[i];
                    socket.emit('log', `📝 Injetando Prompt ${i + 1}/${prompts.length}...`);

                    // 1. Localizar e Clicar no Input
                    const selector = 'div[role="textbox"][contenteditable="true"], textarea';
                    await page.waitForSelector(selector);
                    await page.click(selector);
                    
                    // 2. Injetar texto via DataTransfer (Evita detecção)
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

                    // 3. Clicar no botão de enviar
                    await page.evaluate(() => {
                        const b = [...document.querySelectorAll("button, i, span")].find(e => 
                            e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                        );
                        if (b) b.click();
                    });

                    socket.emit('log', `⏳ Aguardando geração... (Monitorando a cada 5s)`);

                    // 4. Loop de monitoramento (Prints a cada 5 segundos)
                    const monitorGeneration = async () => {
                        return new Promise((resolve) => {
                            // Inicia o intervalo de prints
                            screenshotInterval = setInterval(async () => {
                                const screen = await page.screenshot({ encoding: 'base64' });
                                socket.emit('screenshot-update', { 
                                    img: `data:image/png;base64,${screen}`, 
                                    title: `PROCESSANDO PROMPT #${i+1}` 
                                });
                                // Envia sinal para mostrar o botão de "Próximo" no HTML
                                socket.emit('waiting-user-validation');
                            }, 5000);

                            // Escuta o clique do usuário no botão "Imagem Gerada"
                            socket.once('next-prompt', () => {
                                clearInterval(screenshotInterval);
                                resolve();
                            });
                        });
                    };

                    await monitorGeneration();
                    socket.emit('log', `✔️ Prompt ${i+1} concluído.`);
                }

                socket.emit('log', "🏁 Automação finalizada com sucesso!");
                socket.emit('automation-finished');
            });

        } catch (error) {
            socket.emit('log', `❌ Erro: ${error.message}`);
        }
    });

    socket.on('stop-automation', async () => {
        if (screenshotInterval) clearInterval(screenshotInterval);
        if (browser) await browser.close();
        socket.emit('log', "🛑 Robô parado.");
    });
});

server.listen(3000, () => console.log('Server rodando em http://localhost:3000'));
