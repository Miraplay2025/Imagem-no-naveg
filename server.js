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
app.use(express.json({ limit: '100mb' })); // Aumentado para suportar tráfego de imagens Base64

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

let browser = null;
let page = null;
const EXTENSION_DIR = path.join(__dirname, 'temp_extension');

/**
 * FUNÇÃO PARA TIRAR PRINT E ENVIAR VIA SOCKET
 * Mantida 100% original conforme solicitado.
 */
async function sendScreenshot(socket, page, title) {
    if (page) {
        try {
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
            socket.emit('screenshot-update', { 
                img: `data:image/png;base64,${screenshot}`, 
                title: title 
            });
        } catch (e) {
            socket.emit('log', 'Erro ao capturar print: ' + e.message);
        }
    }
}

/**
 * FUNÇÃO DE CAPTURA DE ERRO COM PRINT
 */
async function reportError(socket, page, errorMsg) {
    if (page) {
        await sendScreenshot(socket, page, "❌ ERRO DETECTADO");
    }
    socket.emit('log', `❌ LOG DE ERRO: ${errorMsg}`);
}

io.on('connection', (socket) => {
    console.log('Cliente conectado ao Server Pro');

    socket.on('start-automation', async (data) => {
        try {
            if (!data.extensionZip || !data.prompts || !data.cookiesBase64) {
                socket.emit('log', '⚠️ Erro: Falta Extensão, Prompts ou Cookies!');
                return;
            }

            socket.emit('log', '📦 Processando extensão recebida...');

            // 1. Extração da Extensão
            try {
                if (fs.existsSync(EXTENSION_DIR)) fs.rmSync(EXTENSION_DIR, { recursive: true });
                fs.mkdirSync(EXTENSION_DIR);
                const zipBuffer = Buffer.from(data.extensionZip, 'base64');
                const zipPath = path.join(__dirname, 'extension.zip');
                fs.writeFileSync(zipPath, zipBuffer);
                await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: EXTENSION_DIR })).promise();
            } catch (zipErr) {
                throw new Error(`Falha ao extrair ZIP: ${zipErr.message}`);
            }

            socket.emit('log', '✅ Extensão pronta. Abrindo navegador...');

            // 2. Iniciar Puppeteer
            browser = await puppeteer.launch({
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    `--disable-extensions-except=${EXTENSION_DIR}`,
                    `--load-extension=${EXTENSION_DIR}`,
                    '--window-size=1280,800'
                ]
            });

            const pages = await browser.pages();
            page = pages[0];
            page.setDefaultTimeout(90000);

            // 3. Cookies
            try {
                const decoded = Buffer.from(data.cookiesBase64, 'base64').toString('utf-8');
                const cookies = JSON.parse(decoded);
                await page.setCookie(...(Array.isArray(cookies) ? cookies : [cookies]));
                socket.emit('log', '✅ Cookies aplicados.');
            } catch (e) {
                throw new Error(`Cookies Inválidos: ${e.message}`);
            }

            // 4. Navegação
            await page.goto(data.link, { waitUntil: 'networkidle2' });
            await sendScreenshot(socket, page, "Página Carregada - Confirme o Início");
            socket.emit('automation-status', { msg: "Pronto para iniciar!", showConfirm: true });
            page.automationData = data;

        } catch (err) {
            await reportError(socket, page, err.message);
        }
    });

    socket.on('confirm-start', async () => {
        if (!page) return;
        const data = page.automationData;

        try {
            await page.exposeFunction('sendScreenshotToNode', (title) => sendScreenshot(socket, page, title));

            // LÓGICA DE CAPTURA E CONVERSÃO DE BLOBS PARA BASE64
            page.on('console', async msg => {
                const text = msg.text();
                
                if (text.includes('[FLOW_LOG]')) {
                    socket.emit('log', text.split('|')[2] || text);
                }

                if (text.includes('[IMAGES]')) {
                    const parts = text.split('|');
                    const index = parts[1];
                    const blobUrls = JSON.parse(parts[2]);

                    socket.emit('log', `🖼️ Convertendo ${blobUrls.length} imagens para formato persistente...`);

                    // Converte cada Blob URL em Base64 dentro do contexto do navegador
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

                    // Envia os links em Base64 (persistentes) para o HTML
                    socket.emit('new-images', { index: index, urls: base64Images });
                    socket.emit('log', `✅ Imagens do prompt ${index} enviadas com sucesso!`);
                }
            });

            socket.emit('log', '🚀 Configurando painel da extensão...');

            // 5. Interação com o Painel
            await page.evaluate(async (prompts, assets) => {
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                const toggleBtn = document.querySelector('div[style*="z-index: 10001"]');
                if (toggleBtn) toggleBtn.click();
                await wait(1000);

                const panel = document.getElementById('awu-panel');
                if (!panel) throw new Error("Painel não encontrado!");

                const textarea = panel.querySelector('textarea');
                if (textarea) {
                    textarea.value = prompts.join('\n');
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }

                localStorage.setItem("flow_persistent_assets_v3", JSON.stringify(assets));

                const startBtn = [...panel.querySelectorAll('button')].find(b => b.innerText.includes('INICIAR'));
                if (startBtn) {
                    startBtn.click();
                    window.sendScreenshotToNode("Iniciando Geração via Painel");
                }
            }, data.prompts, data.assets);

        } catch (err) {
            await reportError(socket, page, `Erro na Automação: ${err.message}`);
        }
    });

    socket.on('stop-automation', async () => {
        if (page) {
            await page.evaluate(() => {
                const panel = document.getElementById('awu-panel');
                const stopBtn = [...panel.querySelectorAll('button')].find(b => b.innerText.includes('PARAR'));
                if (stopBtn) stopBtn.click();
            });
            socket.emit('log', '🛑 Automação interrompida.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server Super Pro Ativo na porta ${PORT}`));
