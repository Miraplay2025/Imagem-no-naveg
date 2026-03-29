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
            await new Promise(r => setTimeout(r, 800)); // Buffer para renderização
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
                socket.emit('log', '⚠️ Erro: Dados insuficientes.');
                return;
            }

            socket.emit('log', '📦 Preparando Extensão...');
            if (fs.existsSync(EXTENSION_DIR)) fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
            fs.mkdirSync(EXTENSION_DIR, { recursive: true });
            
            const zipBuffer = Buffer.from(data.extensionZip, 'base64');
            const zipPath = path.join(__dirname, 'extension.zip');
            fs.writeFileSync(zipPath, zipBuffer);
            await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: EXTENSION_DIR })).promise();
            
            socket.emit('log', '🚀 Iniciando Navegador Seguro...');
            browser = await puppeteer.launch({
                headless: 'new', 
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    `--disable-extensions-except=${EXTENSION_DIR}`,
                    `--load-extension=${EXTENSION_DIR}`,
                    '--window-size=1280,800'
                ]
            });

            const pages = await browser.pages();
            page = pages.length > 0 ? pages[0] : await browser.newPage();
            page.setDefaultTimeout(60000);

            // Injeta Cookies
            const decoded = Buffer.from(data.cookiesBase64, 'base64').toString('utf-8');
            await page.setCookie(...JSON.parse(decoded));
            
            socket.emit('log', `🌐 Acessando Flow: ${data.link}`);
            
            await page.goto(data.link, { waitUntil: 'networkidle2', timeout: 60000 });

            // --- VERIFICAÇÃO DE CARREGAMENTO 100% ---
            socket.emit('log', '⏳ Aguardando estabilização total da página...');
            await page.waitForFunction(() => document.body && document.body.innerText.length > 100);
            await new Promise(r => setTimeout(r, 3000)); // Pausa técnica para a extensão "acordar"

            // Screenshot inicial para o usuário validar
            await sendScreenshot(socket, page, "PÁGINA CARREGADA (VERIFICAÇÃO)");

            socket.emit('log', '📝 Tentando localizar painel da extensão...');
            
            // --- LÓGICA DE DETECÇÃO COM RETRY ---
            const detection = await page.evaluate(async (prompts, assets) => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                
                let attempts = 0;
                let found = false;

                while (attempts < 5 && !found) {
                    // Tenta clicar no botão de olho/toggle (Z-INDEX 10001 ou 30000)
                    const toggle = document.querySelector('div[style*="z-index: 10001"]') || 
                                   document.querySelector('div[style*="z-index: 10000"]');
                    
                    if (toggle) {
                        toggle.click();
                        await sleep(1500);
                    }

                    const panel = document.getElementById('awu-panel');
                    if (panel) {
                        found = true;
                        // Injeta os dados
                        const textarea = panel.querySelector('textarea');
                        if (textarea) {
                            textarea.value = prompts.map(p => `Prompt\n${p}`).join('\n\n');
                            textarea.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        if (assets) localStorage.setItem("flow_persistent_assets_v3", JSON.stringify(assets));
                        
                        return { success: true, total: prompts.length };
                    }

                    attempts++;
                    await sleep(2000); // Espera 2s antes da próxima tentativa
                }

                return { success: false, error: "Extensão não respondeu após 5 tentativas. Verifique o print." };
            }, data.prompts, data.assets);

            if (!detection.success) {
                throw new Error(detection.error);
            }

            socket.emit('log', `✅ Sucesso: ${detection.total} prompts injetados.`);
            await sendScreenshot(socket, page, "PAINEL PRONTO PARA INICIAR");
            
            socket.emit('automation-status', { 
                msg: `Pronto! Clique em confirmar para dar o START final.`, 
                showConfirm: true 
            });

        } catch (err) {
            await reportError(socket, page, err.message);
        }
    });

    socket.on('confirm-start', async () => {
        if (!page) return;
        try {
            socket.emit('log', '⚡ Enviando comando de START para a extensão...');
            
            page.on('console', msg => {
                const text = msg.text();
                if (text.startsWith('[EXT_PANEL_LOG]|')) socket.emit('log', text.split('|')[1]);
            });

            await page.evaluate(() => {
                const btn = [...document.querySelectorAll('button')].find(b => 
                    b.innerText.includes('INICIAR') || 
                    b.innerText.includes('START') ||
                    b.innerText.includes('SIM')
                );
                if (btn) btn.click();
            });
            
            socket.emit('log', '🚀 Operação em andamento...');
        } catch (err) {
            await reportError(socket, page, `Erro ao clicar no Start: ${err.message}`);
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) {
            await browser.close();
            browser = null; page = null;
            socket.emit('log', '🛑 Navegador encerrado pelo usuário.');
        }
    });

    socket.on('disconnect', () => console.log('Cliente desconectado.'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 SERVER ULTRA PRO ONLINE NA PORTA ${PORT}`));
