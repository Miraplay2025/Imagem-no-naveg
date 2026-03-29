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
const EXTENSION_DIR = path.resolve(__dirname, 'temp_extension');
const USER_DATA_DIR = path.resolve(__dirname, 'puppeteer_profile');

async function sendScreenshot(socket, page, title) {
    if (page && !page.isClosed()) {
        try {
            await new Promise(r => setTimeout(r, 1000)); 
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

            socket.emit('log', '📦 Preparando ambiente e extraindo extensão...');
            if (fs.existsSync(EXTENSION_DIR)) fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
            if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
            
            fs.mkdirSync(EXTENSION_DIR, { recursive: true });
            
            const zipBuffer = Buffer.from(data.extensionZip, 'base64');
            const zipPath = path.join(__dirname, 'extension.zip');
            fs.writeFileSync(zipPath, zipBuffer);
            
            await fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: EXTENSION_DIR }))
                .promise();

            socket.emit('log', `📂 Extensão extraída com sucesso.`);

            // 2. Lançamento do Navegador (CORRIGIDO PARA LINUX/VPS)
            socket.emit('log', '🚀 Instalando extensão no navegador...');
            browser = await puppeteer.launch({
                headless: 'new', // Mantém invisível mas permite extensões
                userDataDir: USER_DATA_DIR,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--no-zygote', // Adicionado para evitar erro de processo em Linux
                    `--disable-extensions-except=${EXTENSION_DIR}`,
                    `--load-extension=${EXTENSION_DIR}`,
                    '--window-size=1280,800'
                ]
            });

            const pages = await browser.pages();
            page = pages.length > 0 ? pages[0] : await browser.newPage();
            
            socket.emit('log', '⏳ Aguardando registro da extensão (3s)...');
            await new Promise(r => setTimeout(r, 3000));

            const decodedCookies = Buffer.from(data.cookiesBase64, 'base64').toString('utf-8');
            await page.setCookie(...JSON.parse(decodedCookies));
            
            socket.emit('log', `🌐 Carregando página alvo...`);
            await page.goto(data.link, { waitUntil: 'networkidle2', timeout: 90000 });

            socket.emit('log', '⏳ Aguardando injeção final...');
            await new Promise(r => setTimeout(r, 5000));

            await sendScreenshot(socket, page, "VERIFICAÇÃO DE CARREGAMENTO");

            socket.emit('log', '📝 Localizando painel da extensão...');
            const result = await page.evaluate(async (prompts, assets) => {
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                
                for(let i=0; i<10; i++) {
                    const btn = document.querySelector('div[style*="z-index: 10001"]') || 
                                document.querySelector('div[style*="z-index: 30000"]');
                    
                    if (btn) btn.click();
                    await wait(2000);

                    const panel = document.getElementById('awu-panel');
                    if (panel) {
                        const txt = panel.querySelector('textarea');
                        if (txt) {
                            txt.value = prompts.map(p => `Prompt\n${p}`).join('\n\n');
                            txt.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        if (assets) localStorage.setItem("flow_persistent_assets_v3", JSON.stringify(assets));
                        return { success: true };
                    }
                    await wait(1000);
                }
                return { success: false };
            }, data.prompts, data.assets);

            if (!result.success) {
                throw new Error("O painel 'awu-panel' não foi detectado.");
            }

            socket.emit('log', '✅ Painel detectado e preenchido!');
            await sendScreenshot(socket, page, "PAINEL PRONTO");
            
            socket.emit('automation-status', { 
                msg: `Extensão pronta. Confirmar início?`, 
                showConfirm: true 
            });

        } catch (err) {
            await reportError(socket, page, err.message);
        }
    });

    socket.on('confirm-start', async () => {
        if (!page) return;
        try {
            socket.emit('log', '⚡ Iniciando fluxo automático...');
            await page.evaluate(() => {
                const startBtn = [...document.querySelectorAll('button')].find(b => 
                    b.innerText.includes('INICIAR') || b.innerText.includes('START')
                );
                if (startBtn) startBtn.click();
            });
        } catch (err) {
            await reportError(socket, page, `Erro no Start: ${err.message}`);
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) {
            await browser.close();
            browser = null; page = null;
            socket.emit('log', '🛑 Navegador encerrado.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 SERVER ONLINE NA PORTA ${PORT}`));
