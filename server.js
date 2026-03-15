const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', servei: 'TC + Iberlibro Radar', versio: '2.0.0' });
});

async function scrapeTodocoleccion(page, query) {
    const url = `https://www.todocoleccion.net/s/catalogo-libros?t=${encodeURIComponent(query)}`;
    try {
        console.log(`Buscant a TC: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

        try {
            const cookieButton = await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 3000 });
            if (cookieButton) await cookieButton.click();
        } catch (e) {}

        await new Promise(r => setTimeout(r, 1000));

        const resultats = await page.evaluate(() => {
            const items = document.querySelectorAll('.lote, .js-lot-container');
            let data = [];
            items.forEach(item => {
                const titleEl = item.querySelector('.js-lot-titles, .title, h2');
                const priceEl = item.querySelector('.price-main, .item-price, .price');
                const linkEl = item.querySelector('a.js-lot-titles, a.title, a');

                if (titleEl && priceEl) {
                    let priceText = priceEl.innerText.replace('€', '').replace('$', '').replace(',', '.').trim();
                    let price = parseFloat(priceText);
                    let title = titleEl.innerText.trim();
                    let itemUrl = linkEl ? linkEl.href : null;

                    if (!isNaN(price) && price > 0) {
                        data.push({ title, price, url: itemUrl, source: 'Todocoleccion' });
                    }
                }
            });
            return data;
        });
        return resultats;
    } catch (e) {
        console.error('Error TC:', e.message);
        return [];
    }
}

async function scrapeIberlibro(page, query) {
    const url = `https://www.iberlibro.com/servlet/SearchResults?cm_sp=SearchF-_-topnav-_-Results&kn=${encodeURIComponent(query)}&sts=t`;
    try {
        console.log(`Buscant a Iberlibro: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

        const resultats = await page.evaluate(() => {
            const items = document.querySelectorAll('.result-item, .item-display');
            let data = [];
            items.forEach(item => {
                const titleEl = item.querySelector('[itemprop="name"], .item-title');
                const priceEl = item.querySelector('.item-price, .price');
                const linkEl = item.querySelector('a[itemprop="url"], a');

                if (titleEl && priceEl) {
                    let priceText = priceEl.innerText.replace('EUR', '').replace('€', '').replace(',', '.').trim();
                    let price = parseFloat(priceText);
                    let title = titleEl.innerText.trim();
                    let itemUrl = linkEl ? linkEl.href : null;

                    if (!isNaN(price) && price > 0) {
                        data.push({ title, price, url: itemUrl, source: 'Iberlibro' });
                    }
                }
            });
            return data;
        });
        return resultats;
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
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

        const [resTC, resIber] = await Promise.all([
            scrapeTodocoleccion(page, query),
            scrapeIberlibro(page, query)
        ]);

        const allResults = [...resTC, ...resIber];
        const prices = allResults.map(r => r.price).sort((a, b) => a - b);

        res.json({
            terme: query,
            llibre: { titol, autor, isbn },
            comptador: allResults.length,
            min: prices.length > 0 ? prices[0] : null,
            max: prices.length > 0 ? prices[prices.length - 1] : null,
            mitjana: prices.length > 0 ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : null,
            results: allResults,
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
