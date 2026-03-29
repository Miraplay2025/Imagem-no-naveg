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
    if (page && !page.isClosed()) {
        try {
            // Pequena espera para garantir que o buffer de imagem esteja pronto
            await new Promise(r => setTimeout(r, 500));
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
            socket.emit('screenshot-update', { 
                img: `data:image/png;base64,${screenshot}`, 
                title: title 
            });
        } catch (e) {
            console.log('Erro ao capturar screenshot:', e.message);
        }
    }
}

async function reportError(socket, page, errorMsg) {
    if (page && !page.isClosed()) {
        await sendScreenshot(socket, page, "❌ ESTADO DO ERRO");
    }
    socket.emit('log', `❌ LOG DE ERRO: ${errorMsg}`);
    console.error(`[Erro]: ${errorMsg}`);
}

io.on('connection', (socket) => {
    console.log('Cliente conectado ao Server Pro');
    socket.emit('log', '✅ Conectado ao Servidor');

    socket.on('start-automation', async (data) => {
        try {
            if (!data.extensionZip || !data.prompts || !data.cookiesBase64) {
                socket.emit('log', '⚠️ Erro: Dados insuficientes para iniciar.');
                return;
            }

            socket.emit('log', '📦 Extraindo extensão...');
            if (fs.existsSync(EXTENSION_DIR)) fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
            fs.mkdirSync(EXTENSION_DIR, { recursive: true });
            
            const zipBuffer = Buffer.from(data.extensionZip, 'base64');
            const zipPath = path.join(__dirname, 'extension.zip');
            fs.writeFileSync(zipPath, zipBuffer);
            await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: EXTENSION_DIR })).promise();
            
            socket.emit('log', '🚀 Lançando navegador...');
            browser = await puppeteer.launch({
                headless: 'new', 
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    `--disable-extensions-except=${EXTENSION_DIR}`,
                    `--load-extension=${EXTENSION_DIR}`,
                    '--window-size=1280,800'
                ]
            });

            const pages = await browser.pages();
            page = pages.length > 0 ? pages[0] : await browser.newPage();
            page.setDefaultTimeout(60000);

            const decoded = Buffer.from(data.cookiesBase64, 'base64').toString('utf-8');
            await page.setCookie(...JSON.parse(decoded));
            
            socket.emit('log', `🌐 Navegando para: ${data.link}`);
            
            // Navegação com tratamento para evitar "Main frame too early"
            try {
                await page.goto(data.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
                // Espera extra para estabilização de rede
                await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }).catch(() => {});
            } catch (e) {
                socket.emit('log', `⚠️ Aviso de carregamento: ${e.message}`);
            }

            // --- ETAPA SOLICITADA: PRINT E VERIFICAÇÃO ANTES DE QUALQUER INTERAÇÃO ---
            socket.emit('log', '📸 Verificando integridade da página...');
            await sendScreenshot(socket, page, "PÁGINA INICIAL (PRÉ-INTERAÇÃO)");

            const currentUrl = page.url();
            if (!currentUrl.includes("labs.google") || currentUrl.includes("signin")) {
                socket.emit('log', `⚠️ REDIRECIONAMENTO DETECTADO: ${currentUrl}`);
                await sendScreenshot(socket, page, "TELA DE REDIRECIONAMENTO/LOGIN");
                // Não interrompe, mas avisa o usuário
            }
            // -----------------------------------------------------------------------

            socket.emit('log', '📝 Preparando injeção no painel...');
            
            const detection = await page.evaluate(async (prompts, assets) => {
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                
                // Busca o botão de toggle da sua extensão
                const toggleBtn = document.querySelector('div[style*="z-index: 10001"]');
                if (toggleBtn) {
                    toggleBtn.click();
                    await wait(2000); // Tempo para o painel abrir
                }

                const panel = document.getElementById('awu-panel');
                if (!panel) return { error: "Painel não localizado. Verifique se a extensão carregou." };

                const textarea = panel.querySelector('textarea');
                if (textarea) {
                    textarea.value = prompts.map(p => `Prompt\n${p}`).join('\n\n');
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }

                if (assets) localStorage.setItem("flow_persistent_assets_v3", JSON.stringify(assets));

                await wait(1000);
                const counter = panel.querySelector('.text-blue-400.font-bold') || panel.querySelector('span[style*="color"]');
                return { total: counter ? counter.innerText.replace(/\D/g, "") : prompts.length };
            }, data.prompts, data.assets);

            if (detection.error) throw new Error(detection.error);

            await sendScreenshot(socket, page, "PAINEL PRONTO");
            socket.emit('automation-status', { 
                msg: `Detectados ${detection.total} prompts. Iniciar execução?`, 
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

            page.on('console', async msg => {
                const text = msg.text();
                if (text.startsWith('[EXT_PANEL_LOG]|')) socket.emit('log', text.split('|')[1]);
                if (text.includes('[IMAGES]')) {
                    const parts = text.split('|');
                    const base64Images = await page.evaluate(async (urls) => {
                        const conv = async (u) => {
                            const r = await fetch(u);
                            const b = await r.blob();
                            return new Promise(res => {
                                const rd = new FileReader();
                                rd.onloadend = () => res(rd.result);
                                rd.readAsDataURL(b);
                            });
                        };
                        return Promise.all(urls.map(u => conv(u)));
                    }, JSON.parse(parts[2]));
                    socket.emit('new-images', { index: parts[1], urls: base64Images });
                }
            });

            await page.evaluate(() => {
                const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('INICIAR') || b.innerText.includes('START'));
                if (btn) btn.click();
            });
        } catch (err) {
            await reportError(socket, page, `Erro no início: ${err.message}`);
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) {
            await browser.close();
            browser = null; page = null;
            socket.emit('log', '🛑 Navegador encerrado.');
        }
    });

    socket.on('disconnect', () => console.log('Cliente saiu.'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 SERVER ONLINE NA PORTA ${PORT}`));
