const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let browser = null;
let page = null;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('start-automation', async (data) => {
        const { link, prompts, cookiesBase64, assets } = data;

        try {
            socket.emit('log', "🚀 Iniciando Puppeteer (Ambiente Render)...");
            
            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', '--disable-gpu',
                    '--window-size=1280,800'
                ]
            });

            page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });

            // 1. Aplicação de Cookies
            socket.emit('log', "🔑 Aplicando cookies de sessão...");
            const cookiesRaw = Buffer.from(cookiesBase64, 'base64').toString('utf-8');
            const cookies = JSON.parse(cookiesRaw);
            await page.setCookie(...cookies);

            // 2. Navegação Inicial
            socket.emit('log', `🌐 Navegando para o Flow...`);
            await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(5000);

            // 3. Verificação de Login com Print
            const initialShot = await page.screenshot({ encoding: 'base64' });
            socket.emit('screenshot-update', { 
                img: `data:image/png;base64,${initialShot}`, 
                title: "STATUS: AGUARDANDO CONFIRMAÇÃO" 
            });
            socket.emit('automation-status', { showConfirm: true });
            socket.emit('log', "👀 Verifique a tela. Se estiver logado, clique em INJETAR.");

            // 4. Início da Automação após confirmação
            socket.once('confirm-start', async () => {
                socket.emit('log', "🛡️ Ativando Bloqueador de Teclado e Iniciando...");

                for (let i = 0; i < prompts.length; i++) {
                    const currentPrompt = prompts[i];
                    let success = false;
                    let attempts = 0;

                    socket.emit('log', `--- 📝 Processando Prompt ${i + 1}/${prompts.length} ---`);

                    while (attempts < 3 && !success) {
                        attempts++;
                        if (attempts > 1) socket.emit('log', `🔄 Tentativa ${attempts} para o prompt ${i+1}...`);

                        // Captura de tela antes de começar o prompt
                        const startShot = await page.screenshot({ encoding: 'base64' });
                        socket.emit('screenshot-update', { 
                            img: `data:image/png;base64,${startShot}`, 
                            title: `EXECUTANDO PROMPT #${i+1}` 
                        });

                        // EXECUÇÃO NO BROWSER
                        const executionResult = await page.evaluate(async (pText, pAssets) => {
                            const wait = (ms) => new Promise(r => setTimeout(r, ms));
                            const logs = [];
                            
                            // A. Bloquear Teclado
                            const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"]');
                            inputs.forEach(el => {
                                el.style.pointerEvents = 'none';
                                el.readOnly = true;
                                el.setAttribute('inputmode', 'none');
                                if (el.getAttribute('contenteditable')) el.setAttribute('contenteditable', 'false');
                            });

                            // B. Mapear imagens existentes
                            const getImages = () => Array.from(document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]')).map(img => img.src);
                            const imagensAntes = getImages();

                            // C. Injeção de Assets
                            const nameNoExt = (name) => name.replace(/\.[^/.]+$/, "");
                            const foundAssets = pAssets.filter(item => 
                                new RegExp(`\\b${nameNoExt(item.name)}\\b`, 'gi').test(pText)
                            );

                            for (const asset of foundAssets) {
                                const assetName = nameNoExt(asset.name);
                                logs.push(`🔍 Buscando asset: "${assetName}"`);
                                
                                const btnAdd = document.querySelector('.sc-addd5871-0') || [...document.querySelectorAll('button')].find(b => b.innerText.includes('add') || b.textContent.includes('add'));
                                if (btnAdd) {
                                    btnAdd.click();
                                    await wait(800);
                                }
                                
                                const searchInput = document.querySelector('input[placeholder*="Pesquisar"]');
                                if (searchInput) {
                                    searchInput.focus();
                                    document.execCommand('insertText', false, assetName);
                                    await wait(1200);
                                    
                                    const items = document.querySelectorAll('.sc-3038c00b-16, .sc-dbfb6b4a-16');
                                    const target = [...items].find(el => el.textContent.toLowerCase().includes(assetName.toLowerCase()));
                                    
                                    if (target) {
                                        target.click();
                                        logs.push(`✅ Imagem de referência "${assetName}" incluída.`);
                                    } else {
                                        logs.push(`❌ Erro: Imagem "${assetName}" não encontrada na lista.`);
                                    }
                                }
                                await wait(500);
                            }

                            // D. Inserir Texto do Prompt
                            const box = document.querySelector('div[role="textbox"]') || document.querySelector('textarea');
                            if (box) {
                                box.focus();
                                document.execCommand('selectAll', false, null);
                                document.execCommand('delete', false, null);
                                
                                const dt = new DataTransfer();
                                dt.setData('text/plain', pText);
                                box.dispatchEvent(new ClipboardEvent('paste', {
                                    clipboardData: dt, bubbles: true, cancelable: true
                                }));
                                await wait(600);

                                const btnSend = [...document.querySelectorAll("button, i")].find(e => 
                                    e.innerText?.includes("arrow_forward") || e.textContent?.includes("arrow_forward")
                                );
                                if (btnSend) {
                                    btnSend.click();
                                    logs.push(`🚀 Prompt enviado para o Flow.`);
                                }
                            }

                            return { imagensAntes, logs };
                        }, currentPrompt, assets);

                        // Repassar logs da página para o HTML
                        executionResult.logs.forEach(msg => socket.emit('log', msg));

                        // E. Monitoramento da Geração (Classe 99%)
                        let generating = true;
                        let timer = 0;
                        socket.emit('log', "🎨 Gerando imagens... Monitorando progresso.");

                        while (generating && timer < 60) { // Timeout de 120 seg (60*2)
                            await delay(2000);
                            timer++;
                            
                            const isLoading = await page.evaluate(() => !!document.querySelector('.sc-55ebc859-7'));
                            if (!isLoading) {
                                await delay(6000); // Espera render final
                                generating = false;
                            }
                            
                            // Atualiza print durante geração
                            if (timer % 5 === 0) {
                                const midShot = await page.screenshot({ encoding: 'base64' });
                                socket.emit('screenshot-update', { 
                                    img: `data:image/png;base64,${midShot}`, 
                                    title: `GERANDO PROMPT #${i+1} (${Math.min(timer*3, 99)}%)` 
                                });
                            }
                        }

                        // F. Captura e Comparação Final
                        const finalCheck = await page.evaluate((antes) => {
                            const atuais = Array.from(document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]'))
                                          .map(img => img.src);
                            const novas = atuais.filter(src => !antes.includes(src));
                            return { novas, count: novas.length };
                        }, executionResult.imagensAntes);

                        if (finalCheck.count >= 2) {
                            socket.emit('log', `✅ Sucesso: ${finalCheck.count} imagens encontradas.`);
                            socket.emit('new-images', { index: i + 1, urls: finalCheck.novas });
                            success = true;
                        } else if (finalCheck.count === 1) {
                            socket.emit('log', `⚠️ Erro: Apenas 1 imagem gerada. Reenviando prompt...`);
                        } else {
                            socket.emit('log', `❌ Erro: Nenhuma imagem nova detectada. Reenviando prompt...`);
                        }
                    }

                    if (!success) {
                        socket.emit('log', `🔴 Falha definitiva no Prompt ${i+1} após 3 tentativas.`);
                    }
                }

                socket.emit('log', "🏁 AUTOMAÇÃO FINALIZADA COM SUCESSO!");
                // Desbloqueio final
                await page.evaluate(() => {
                    const inputs = document.querySelectorAll('input, textarea');
                    inputs.forEach(el => { el.style.pointerEvents = 'auto'; el.readOnly = false; });
                });
            });

        } catch (err) {
            socket.emit('log', `💥 ERRO NO SERVIDOR: ${err.message}`);
        }
    });

    socket.on('stop-automation', async () => {
        if (browser) await browser.close();
        socket.emit('log', "🛑 Operação interrompida pelo usuário.");
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server Ultra Pro rodando na porta ${PORT}`));
