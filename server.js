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

            // 1. Limpeza e Extração
            socket.emit('log', '📦 Extraindo extensão...');
            if (fs.existsSync(EXTENSION_DIR)) fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
            fs.mkdirSync(EXTENSION_DIR, { recursive: true });
            
            const zipBuffer = Buffer.from(data.extensionZip, 'base64');
            const zipPath = path.join(__dirname, 'extension.zip');
            fs.writeFileSync(zipPath, zipBuffer);
            
            await fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: EXTENSION_DIR }))
                .promise();

            // Verificar se o manifest está na raiz da pasta extraída
            const files = fs.readdirSync(EXTENSION_DIR);
            socket.emit('log', `📂 Arquivos extraídos: ${files.join(', ')}`);

            // 2. Lançamento do Navegador com Perfil Persistente
            socket.emit('log', '🚀 Lançando navegador com extensão...');
            browser = await puppeteer.launch({
                headless: 'new',
                userDataDir: USER_DATA_DIR, // Ajuda a manter a extensão carregada
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
            
            // 3. Cookies e Navegação
            const decodedCookies = Buffer.from(data.cookiesBase64, 'base64').toString('utf-8');
            await page.setCookie(...JSON.parse(decodedCookies));
            
            socket.emit('log', `🌐 Carregando página do Flow...`);
            await page.goto(data.link, { waitUntil: 'networkidle2', timeout: 90000 });

            // Aguarda a página e dá um tempo extra para scripts da extensão injetarem
            await page.waitForFunction(() => document.body && document.body.innerText.length > 50);
            socket.emit('log', '⏳ Aguardando injeção da extensão (5s)...');
            await new Promise(r => setTimeout(r, 5000));

            await sendScreenshot(socket, page, "VERIFICAÇÃO DE CARREGAMENTO");

            // 4. Detecção e Injeção de Dados
            socket.emit('log', '📝 Localizando painel...');
            const result = await page.evaluate(async (prompts, assets) => {
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                
                // Tenta abrir o painel clicando no botão de toggle da sua extensão
                for(let i=0; i<5; i++) {
                    const btn = document.querySelector('div[style*="z-index: 10001"]') || 
                                document.querySelector('div[style*="z-index: 30000"]');
                    
                    if (btn) btn.click();
                    await wait(1500);

                    const panel = document.getElementById('awu-panel');
                    if (panel) {
                        // Preenche os prompts
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
                throw new Error("Extensão instalada, mas o painel 'awu-panel' não apareceu.");
            }

            socket.emit('log', '✅ Extensão pronta e carregada!');
            await sendScreenshot(socket, page, "PAINEL LOCALIZADO");
            
            socket.emit('automation-status', { 
                msg: `Extensão detectada com sucesso. Iniciar?`, 
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
