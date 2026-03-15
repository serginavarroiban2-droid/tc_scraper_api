const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', servei: 'TC + Iberlibro Radar', versio: '2.1.0' });
});

function similarity(s1, s2) {
    if (!s1 || !s2) return 0;
    const n1 = s1.toLowerCase();
    const n2 = s2.toLowerCase();
    let common = 0;
    const words = n1.split(/\s+/);
    words.forEach(w => { if (w.length > 2 && n2.includes(w)) common++; });
    return common / words.length;
}

async function scrapeTodocoleccion(page, query, targetTitle) {
    const url = `https://www.todocoleccion.net/s/catalogo-libros?t=${encodeURIComponent(query)}`;
    try {
        console.log(`Buscant a TC: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

        // Verifiquem si hi ha el missatge de "no s'han trobat resultats"
        const noResults = await page.evaluate(() => {
            return document.body.innerText.includes('No hemos encontrado resultados') || 
                   document.body.innerText.includes('0 lotes encontrados');
        });
        if (noResults) return [];

        const resultats = await page.evaluate(() => {
            const items = document.querySelectorAll('.lote, .js-lot-container');
            let data = [];
            items.forEach(item => {
                const titleEl = item.querySelector('.js-lot-titles, .title, h2');
                const priceEl = item.querySelector('.price-main, .item-price, .price, .item-price-current');
                const linkEl = item.querySelector('a.js-lot-titles, a.title, a');

                if (titleEl && priceEl) {
                    let priceText = priceEl.innerText.replace('€', '').replace('$', '').replace(',', '.').replace(/[^\d.]/g, '').trim();
                    let price = parseFloat(priceText);
                    let title = titleEl.innerText.trim();
                    let itemUrl = linkEl ? linkEl.href : null;

                    if (!isNaN(price) && price > 0 && itemUrl) {
                        data.push({ title, price, url: itemUrl });
                    }
                }
            });
            return data;
        });

        // Filtrar resultats poc rellevants si tenim un títol objectiu
        if (targetTitle && resultats.length > 0) {
            return resultats.filter(r => similarity(targetTitle, r.title) > 0.3)
                            .map(r => ({ ...r, source: 'Todocoleccion' }));
        }

        return resultats.map(r => ({ ...r, source: 'Todocoleccion' }));
    } catch (e) {
        console.error('Error TC:', e.message);
        return [];
    }
}

async function scrapeIberlibro(page, query, targetTitle) {
    const url = `https://www.iberlibro.com/servlet/SearchResults?cm_sp=SearchF-_-topnav-_-Results&kn=${encodeURIComponent(query)}&sts=t`;
    try {
        console.log(`Buscant a Iberlibro: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

        const resultats = await page.evaluate(() => {
            const items = document.querySelectorAll('.result-item, .item-display');
            let data = [];
            items.forEach(item => {
                const titleEl = item.querySelector('[itemprop="name"], .item-title');
                const priceEl = item.querySelector('.item-price, .price');
                const linkEl = item.querySelector('a[itemprop="url"], a');

                if (titleEl && priceEl) {
                    let priceText = priceEl.innerText.replace('EUR', '').replace('€', '').replace(',', '.').replace(/[^\d.]/g, '').trim();
                    let price = parseFloat(priceText);
                    let title = titleEl.innerText.trim();
                    let itemUrl = linkEl ? linkEl.href : null;

                    if (!isNaN(price) && price > 0 && itemUrl) {
                        data.push({ title, price, url: itemUrl });
                    }
                }
            });
            return data;
        });

        if (targetTitle && resultats.length > 0) {
            return resultats.filter(r => similarity(targetTitle, r.title) > 0.3)
                            .map(r => ({ ...r, source: 'Iberlibro' }));
        }

        return resultats.map(r => ({ ...r, source: 'Iberlibro' }));
    } catch (e) {
        console.error('Error Iberlibro:', e.message);
        return [];
    }
}

app.get('/api/tassa', async (req, res) => {
    const { isbn, titol, autor } = req.query;
    let query = isbn || `${titol || ''} ${autor || ''}`.trim();

    if (!query) return res.status(400).json({ error: 'Falta paràmetre de cerca' });

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    const browser = await puppeteer.launch({ 
        headless: 'new',
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        // Timeout global per cada cerca per evitar penjaments
        const [resTC, resIber] = await Promise.all([
            (async () => {
                const p = await browser.newPage();
                await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                const res = await scrapeTodocoleccion(p, query, titol);
                await p.close();
                return res;
            })(),
            (async () => {
                const p = await browser.newPage();
                await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                const res = await scrapeIberlibro(p, query, titol);
                await p.close();
                return res;
            })()
        ]);

        const allResults = [...resTC, ...resIber];
        // Triem els millors 20 resultats per preu
        const sortedResults = allResults.sort((a, b) => a.price - b.price).slice(0, 20);
        const prices = sortedResults.map(r => r.price);

        res.json({
            terme: query,
            llibre: { titol, autor, isbn },
            comptador: sortedResults.length,
            min: prices.length > 0 ? prices[0] : null,
            max: prices.length > 0 ? prices[prices.length - 1] : null,
            mitjana: prices.length > 0 ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : null,
            results: sortedResults,
            fonts: { tc: resTC.length, iberlibro: resIber.length }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        await browser.close();
    }
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server v2 actiu al port ${PORT}`);
});
