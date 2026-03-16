const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', servei: 'TC Radar de Preus', versio: '3.0.0' });
});

// =====================================================
// FUNCIO AUXILIAR: Acceptar cookies de TC
// =====================================================
async function acceptCookies(page) {
    try {
        // Esperar que aparegui el banner de cookies (màx 3s)
        await page.waitForSelector('button', { timeout: 3000 });
        const buttons = await page.$$('button');
        for (const btn of buttons) {
            const text = await page.evaluate(el => el.textContent.trim(), btn);
            if (text.includes('ACEPTAR TODO') || text.includes('Aceptar todo')) {
                await btn.click();
                await new Promise(r => setTimeout(r, 500));
                console.log('  Cookies acceptades');
                return;
            }
        }
    } catch (e) {
        // No hi ha banner, no passa res
    }
}

// =====================================================
// SCRAPER TODOCOLECCION (Selectors actualitzats Mar 2026)
// =====================================================
// Estructura real HTML de TC:
//   .card-lote.card-lote-as-gallery[data-testid="ID"]
//     a[id="lot-title-ID"].stretched-link.js-lot-titles
//       title="TITOL COMPLET" href="/categoria/slug~xID"
//     span.card-price  → "12,00 €"
//     strike.card-offer-price → preu original tatxat (opcional)
//     a.fs-14.text-gray-500 → categoria
// =====================================================
async function scrapeTodocoleccion(page, query) {
    // URL CORRECTA: /buscador?bu=QUERY (no /s/catalogo-libros ni ?t=)
    const url = `https://www.todocoleccion.net/buscador?bu=${encodeURIComponent(query)}`;
    try {
        console.log(`[TC] Buscant: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Acceptar cookies si apareixen
        await acceptCookies(page);
        
        // Esperar que carreguin els resultats
        await new Promise(r => setTimeout(r, 2000));

        const resultats = await page.evaluate(() => {
            // Cada lot és un .card-lote amb data-testid
            const items = document.querySelectorAll('.card-lote[data-testid]');
            let data = [];
            
            items.forEach(item => {
                // Títol i link: a.js-lot-titles (stretched-link)
                const linkEl = item.querySelector('a.js-lot-titles, a[id^="lot-title-"]');
                // Preu actual: span.card-price
                const priceEl = item.querySelector('span.card-price');
                // Categoria (opcional)
                const catEl = item.querySelector('a.fs-14.text-gray-500');
                // Imatge
                const imgEl = item.querySelector('img');

                if (linkEl && priceEl) {
                    // El títol està a l'atribut 'title' del link
                    const title = linkEl.getAttribute('title') || linkEl.textContent.trim();
                    
                    // Preu: "12,00 €" → 12.00
                    let priceText = priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.').trim();
                    let price = parseFloat(priceText);
                    
                    // URL del lot (relativa, cal afegir el domini)
                    let href = linkEl.getAttribute('href') || '';
                    if (href && !href.startsWith('http')) {
                        href = 'https://www.todocoleccion.net' + href;
                    }
                    
                    // ID del lot
                    const lotId = item.getAttribute('data-testid') || '';
                    
                    // Categoria
                    const category = catEl ? catEl.textContent.trim() : '';
                    
                    // Imatge
                    const image = imgEl ? (imgEl.getAttribute('src') || '') : '';

                    if (!isNaN(price) && price > 0 && title.length > 0) {
                        data.push({ 
                            title, 
                            price, 
                            url: href, 
                            lotId,
                            category,
                            image,
                            source: 'Todocoleccion' 
                        });
                    }
                }
            });
            
            // També capturem el nombre total de resultats
            let totalText = '';
            const totalEl = document.querySelector('.search-count, [class*="lotes"]');
            if (totalEl) totalText = totalEl.textContent.trim();
            // Alternativa: buscar text tipus "41.158 lotes"
            const bodyText = document.body.innerText;
            const totalMatch = bodyText.match(/([\d.]+)\s*lotes/);
            const totalLots = totalMatch ? totalMatch[1] : '0';
            
            return { items: data, totalLots };
        });

        console.log(`[TC] Trobats: ${resultats.items.length} lots (total al catàleg: ${resultats.totalLots})`);
        return resultats;
    } catch (e) {
        console.error('[TC] Error:', e.message);
        return { items: [], totalLots: '0' };
    }
}

// =====================================================
// SCRAPER IBERLIBRO (si falla, només retorna buit)
// =====================================================
async function scrapeIberlibro(page, query) {
    const url = `https://www.iberlibro.com/servlet/SearchResults?kn=${encodeURIComponent(query)}&sts=t`;
    try {
        console.log(`[IB] Buscant: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
        await new Promise(r => setTimeout(r, 2000));

        const resultats = await page.evaluate(() => {
            const items = document.querySelectorAll('[data-cy="listing-item"], .result-item, .srp-item');
            let data = [];
            items.forEach(item => {
                const titleEl = item.querySelector('[data-cy="listing-title"], .title, h2, [itemprop="name"]');
                const priceEl = item.querySelector('[data-cy="listing-price"], .item-price, .price, [itemprop="price"]');
                const linkEl = item.querySelector('a[data-cy="listing-title"], a[itemprop="url"], a');

                if (titleEl && priceEl) {
                    let title = titleEl.textContent.trim();
                    let priceText = priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.').trim();
                    let price = parseFloat(priceText);
                    let href = linkEl ? linkEl.href : '';
                    
                    if (!isNaN(price) && price > 0 && title.length > 0) {
                        data.push({ 
                            title, 
                            price, 
                            url: href, 
                            source: 'Iberlibro' 
                        });
                    }
                }
            });
            return data;
        });

        console.log(`[IB] Trobats: ${resultats.length} resultats`);
        return resultats;
    } catch (e) {
        console.error('[IB] Error:', e.message);
        return [];
    }
}

// =====================================================
// API ENDPOINT: /api/tassa
// =====================================================
app.get('/api/tassa', async (req, res) => {
    const { isbn, titol, autor } = req.query;
    
    // Construir query de cerca: prioritzar ISBN si existeix
    let query = '';
    if (isbn && isbn.length >= 10) {
        query = isbn;
    } else {
        query = `${titol || ''} ${autor || ''}`.trim();
    }

    if (!query) return res.status(400).json({ error: 'Falta paràmetre de cerca (isbn, titol o autor)' });

    console.log(`\n========== NOVA TASSACIÓ: "${query}" ==========`);

    const browser = await puppeteer.launch({ 
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        // Paral·lelitzem TC i Iberlibro
        const [resTC, resIber] = await Promise.all([
            (async () => {
                const p = await browser.newPage();
                await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
                const res = await scrapeTodocoleccion(p, query);
                await p.close();
                return res;
            })(),
            (async () => {
                const p = await browser.newPage();
                await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
                const res = await scrapeIberlibro(p, query);
                await p.close();
                return res;
            })()
        ]);

        const tcItems = resTC.items || [];
        const ibItems = resIber || [];
        const allResults = [...tcItems, ...ibItems];
        
        // Ordenar per preu i agafar els 30 millors
        const sortedResults = allResults.sort((a, b) => a.price - b.price).slice(0, 30);
        const prices = sortedResults.map(r => r.price);

        const response = {
            terme: query,
            llibre: { titol: titol || '', autor: autor || '', isbn: isbn || '' },
            comptador: sortedResults.length,
            totalTC: resTC.totalLots || '0',
            min: prices.length > 0 ? prices[0] : null,
            max: prices.length > 0 ? prices[prices.length - 1] : null,
            mitjana: prices.length > 0 ? parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)) : null,
            results: sortedResults,
            fonts: { tc: tcItems.length, iberlibro: ibItems.length }
        };
        
        console.log(`========== RESULTAT: ${sortedResults.length} items, preu mitjà: ${response.mitjana}€ ==========\n`);
        res.json(response);

    } catch (error) {
        console.error('Error global:', error.message);
        res.status(500).json({ error: error.message });
    } finally {
        await browser.close();
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Radar de Preus v3.0 actiu al port ${PORT}`);
    console.log(`   Endpoint: http://localhost:${PORT}/api/tassa?isbn=9788420412146`);
    console.log(`   Endpoint: http://localhost:${PORT}/api/tassa?titol=quijote&autor=cervantes\n`);
});
