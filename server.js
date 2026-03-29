const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const unzipper = require('unzipper');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

let browser = null;
let page = null;
const EXTENSION_DIR = path.join(__dirname, 'temp_extension');

async function sendScreenshot(socket, page, title) {
    if (page) {
        try {
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
            socket.emit('screenshot-update', { 
                img: `data:image/png;base64,${screenshot}`, 
                title: title 
            });
        } catch (e) {
            console.log('Erro screenshot:', e.message);
        }
    }
}

async function reportError(socket, page, errorMsg) {
    if (page) {
        await sendScreenshot(socket, page, "❌ ERRO DETECTADO");
    }
    socket.emit('log', `❌ LOG DE ERRO: ${errorMsg}`);
    console.error(`[Erro]: ${errorMsg}`);
}

io.on('connection', (socket) => {
    console.log('Cliente conectado ao Server Pro');
    socket.emit('log', '✅ Conectado ao Servidor de Automação');
    socket.emit('connection-success', { status: 'connected' });

    socket.on('start-automation', async (data) => {
        try {
            if (!data.extensionZip || !data.prompts || !data.cookiesBase64) {
                socket.emit('log', '⚠️ Erro: Falta Extensão, Prompts ou Cookies!');
                return;
            }

            socket.emit('log', '📦 Preparando ambiente e extensão...');

            if (fs.existsSync(EXTENSION_DIR)) {
                fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
            }
            fs.mkdirSync(EXTENSION_DIR, { recursive: true });
            
            const zipBuffer = Buffer.from(data.extensionZip, 'base64');
            const zipPath = path.join(__dirname, 'extension.zip');
            fs.writeFileSync(zipPath, zipBuffer);

            await fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: EXTENSION_DIR }))
                .promise();
            
            socket.emit('log', '✅ Extensão extraída.');

            browser = await puppeteer.launch({
                headless: 'new', 
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-zygote',
                    '--single-process',
                    `--disable-extensions-except=${EXTENSION_DIR}`,
                    `--load-extension=${EXTENSION_DIR}`,
                    '--window-size=1280,800'
                ]
            });

            const pages = await browser.pages();
            page = pages[0];
            page.setDefaultTimeout(60000);

            const decoded = Buffer.from(data.cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(decoded);
            await page.setCookie(...(Array.isArray(cookies) ? cookies : [cookies]));
            
            socket.emit('log', `🌐 Navegando para: ${data.link}`);

            // --- CORREÇÃO DO ERRO 'FRAME DETACHED' E CHECAGEM DE REDIRECIONAMENTO ---
            try {
                await Promise.all([
                    page.goto(data.link, { waitUntil: 'domcontentloaded', timeout: 60000 }),
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null)
                ]);
            } catch (navError) {
                console.log("Aviso de Navegação:", navError.message);
                // Não trava o fluxo, tenta prosseguir se a página existir
            }

            const finalUrl = page.url();
            if (!finalUrl.includes(data.link.split('?')[0])) {
                socket.emit('log', `⚠️ Redirecionamento detectado! URL atual: ${finalUrl}`);
                await sendScreenshot(socket, page, "Página Pós-Redirecionamento");
            }
            // -----------------------------------------------------------------------

            socket.emit('log', '📝 Preenchendo dados no painel...');
            
            const detection = await page.evaluate(async (prompts, assets) => {
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                const toggleBtn = document.querySelector('div[style*="z-index: 10001"]');
                if (toggleBtn) toggleBtn.click();
                await wait(1500);

                const panel = document.getElementById('awu-panel');
                if (!panel) return { error: "Painel não encontrado" };

                const formattedPrompts = prompts.map(p => `Prompt\n${p}`).join('\n\n');
                
                const textarea = panel.querySelector('textarea');
                if (textarea) {
                    textarea.value = formattedPrompts;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }

                if (assets) {
                    localStorage.setItem("flow_persistent_assets_v3", JSON.stringify(assets));
                }

                await wait(500);
                const counterElement = panel.querySelector('.text-blue-400.font-bold') || panel.querySelector('span[style*="color"]');
                const totalDetected = counterElement ? counterElement.innerText.replace(/\D/g, "") : prompts.length;

                return { total: totalDetected };
            }, data.prompts, data.assets);

            if (detection.error) throw new Error(detection.error);

            await sendScreenshot(socket, page, "Dados Preenchidos");
            socket.emit('automation-status', { 
                msg: `Extensão detectou ${detection.total} prompts. Pronto para iniciar?`, 
                showConfirm: true 
            });
            
            page.automationData = data;

        } catch (err) {
            await reportError(socket, page, err.message);
        }
    });

    socket.on('confirm-start', async () => {
        if (!page) return;

        try {
            await page.exposeFunction('sendScreenshotToNode', (title) => sendScreenshot(socket, page, title));

            await page.evaluate(() => {
                const logDiv = document.querySelector("#awu-log");
                if (logDiv) {
                    const observer = new MutationObserver((mutations) => {
                        mutations.forEach((mutation) => {
                            if (mutation.addedNodes.length) {
                                const newLog = mutation.addedNodes[0].innerText;
                                console.log(`[EXT_PANEL_LOG]|${newLog}`);
                            }
                        });
                    });
                    observer.observe(logDiv, { childList: true });
                }
            });

            page.on('console', async msg => {
                const text = msg.text();
                if (text.startsWith('[EXT_PANEL_LOG]|')) {
                    socket.emit('log', text.split('|')[1]);
                }

                if (text.includes('[IMAGES]')) {
                    const parts = text.split('|');
                    const index = parts[1];
                    const blobUrls = JSON.parse(parts[2]);

                    const base64Images = await page.evaluate(async (urls) => {
                        const convert = async (url) => {
                            const response = await fetch(url);
                            const blob = await response.blob();
                            return new Promise((resolve) => {
                                const reader = new FileReader();
                                reader.onloadend = () => resolve(reader.result);
                                reader.readAsDataURL(blob);
                            });
                        };
                        return Promise.all(urls.map(u => convert(u)));
                    }, blobUrls);

                    socket.emit('new-images', { index: index, urls: base64Images });
                }
            });

            await page.evaluate(() => {
                const panel = document.getElementById('awu-panel');
                const startBtn = [...panel.querySelectorAll('button')].find(b => 
                    b.innerText.includes('INICIAR') || b.innerText.includes('START')
                );
                if (startBtn) startBtn.click();
            });

        } catch (err) {
            await reportError(socket, page, `Falha no Início: ${err.message}`);
        }
    });

    socket.on('stop-automation', async () => {
        socket.emit('log', '🛑 Parando...');
        if (browser) {
            await browser.close();
            browser = null; page = null;
        }
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado.');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 SERVER PRO ATIVO NA PORTA ${PORT}`);
});
