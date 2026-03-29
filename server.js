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

// Serve os arquivos da pasta public (onde deve estar seu index.html)
app.use(express.static('public'));

let browser = null;
let page = null;
const EXTENSION_DIR = path.join(__dirname, 'temp_extension');

/**
 * FUNÇÃO PARA TIRAR PRINT E ENVIAR VIA SOCKET
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
            console.log('Erro screenshot:', e.message);
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
    console.error(`[Erro]: ${errorMsg}`);
}

io.on('connection', (socket) => {
    // REQUISITO: Notificar o HTML que a conexão foi estabelecida
    console.log('Cliente conectado ao Server Pro');
    socket.emit('log', '✅ Conectado ao Servidor de Automação');
    socket.emit('connection-success', { status: 'connected' });

    socket.on('start-automation', async (data) => {
        try {
            if (!data.extensionZip || !data.prompts || !data.cookiesBase64) {
                socket.emit('log', '⚠️ Erro: Falta Extensão, Prompts ou Cookies!');
                return;
            }

            socket.emit('log', '📦 Processando extensão e preparando ambiente...');

            // 1. Extração Segura da Extensão
            try {
                if (fs.existsSync(EXTENSION_DIR)) {
                    fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
                }
                fs.mkdirSync(EXTENSION_DIR, { recursive: true });
                
                const zipBuffer = Buffer.from(data.extensionZip, 'base64');
                const zipPath = path.join(__dirname, 'extension.zip');
                fs.writeFileSync(zipPath, zipBuffer);

                // Aguarda a extração terminar completamente
                await fs.createReadStream(zipPath)
                    .pipe(unzipper.Extract({ path: EXTENSION_DIR }))
                    .promise();
                
                socket.emit('log', '✅ Extensão extraída com sucesso.');
            } catch (zipErr) {
                throw new Error(`Falha crítica no ZIP: ${zipErr.message}`);
            }

            socket.emit('log', '🚀 Abrindo navegador Puppeteer...');

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
            page.setDefaultTimeout(60000);

            // 3. Cookies
            try {
                const decoded = Buffer.from(data.cookiesBase64, 'base64').toString('utf-8');
                const cookies = JSON.parse(decoded);
                await page.setCookie(...(Array.isArray(cookies) ? cookies : [cookies]));
                socket.emit('log', '✅ Sessão (Cookies) restaurada.');
            } catch (e) {
                throw new Error(`Erro nos Cookies JSON: ${e.message}`);
            }

            // 4. Navegação
            socket.emit('log', `🌐 Navegando para: ${data.link}`);
            await page.goto(data.link, { waitUntil: 'networkidle2' });
            
            await sendScreenshot(socket, page, "Página Carregada - Confirme o Início");
            socket.emit('automation-status', { msg: "Pronto para iniciar!", showConfirm: true });
            
            // Salva os dados para o próximo passo (confirmação)
            page.automationData = data;

        } catch (err) {
            await reportError(socket, page, err.message);
        }
    });

    socket.on('confirm-start', async () => {
        if (!page) return;
        const data = page.automationData;

        try {
            // Expõe a função para a extensão chamar o print do Node
            await page.exposeFunction('sendScreenshotToNode', (title) => sendScreenshot(socket, page, title));

            // Monitor de Console (Logs da Extensão)
            page.on('console', async msg => {
                const text = msg.text();
                
                if (text.includes('[FLOW_LOG]')) {
                    const logContent = text.split('|')[2] || text;
                    socket.emit('log', logContent);
                }

                if (text.includes('[IMAGES]')) {
                    const parts = text.split('|');
                    const index = parts[1];
                    const blobUrls = JSON.parse(parts[2]);

                    socket.emit('log', `🖼️ Capturando ${blobUrls.length} imagens geradas...`);

                    // Converte Blob URLs em Base64 para persistência no HTML
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
                    socket.emit('log', `✅ Prompt #${index} finalizado e enviado.`);
                }
            });

            socket.emit('log', '⚙️ Injetando comandos no painel da extensão...');

            // 5. Automação do Painel Interno
            await page.evaluate(async (prompts, assets) => {
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                
                // Abre o painel se estiver fechado (baseado no seletor do toggleBtn)
                const toggleBtn = document.querySelector('div[style*="z-index: 10001"]');
                if (toggleBtn) toggleBtn.click();
                await wait(1500);

                const panel = document.getElementById('awu-panel');
                if (!panel) return console.error("Painel da extensão não injetado!");

                const textarea = panel.querySelector('textarea');
                if (textarea) {
                    textarea.value = prompts.join('\n');
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }

                // Salva assets no localStorage para a extensão ler
                localStorage.setItem("flow_persistent_assets_v3", JSON.stringify(assets));

                // Clica no botão de iniciar da EXTENSÃO
                const startBtn = [...panel.querySelectorAll('button')].find(b => 
                    b.innerText.includes('INICIAR') || b.innerText.includes('START')
                );
                
                if (startBtn) {
                    startBtn.click();
                    window.sendScreenshotToNode("Iniciando Fluxo de Geração");
                }
            }, data.prompts, data.assets);

        } catch (err) {
            await reportError(socket, page, `Falha na Injeção: ${err.message}`);
        }
    });

    socket.on('stop-automation', async () => {
        socket.emit('log', '🛑 Comando de parada recebido.');
        if (browser) {
            await browser.close();
            browser = null;
            page = null;
        }
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado.');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`🚀 SERVER PRO ATIVO: http://localhost:${PORT}`);
    console.log(`========================================\n`);
});
