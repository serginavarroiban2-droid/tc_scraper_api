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

        // Acceptar cookies si apareix el botó
        try {
            const cookieButton = await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 3000 });
            if (cookieButton) await cookieButton.click();
        } catch (e) {}

        await new Promise(r => setTimeout(r, 1000));

        const preus = await page.evaluate(() => {
            // Selectors actualitzats de TC
            const selectors = ['.price-main', '.item-price', '.price', '.price-value'];
            let resultats = [];
            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    let text = el.innerText.replace('€', '').replace('$', '').replace(',', '.').trim();
                    let p = parseFloat(text);
                    if (!isNaN(p) && p > 0) resultats.push(p);
                });
            });
            return resultats;
        });
        return preus;
    } catch (e) {
        console.error('Error TC:', e.message);
        return [];
    }
}

async function scrapeIberlibro(page, query) {
    // Busquem per paraules clau al camp de cerca general
    const url = `https://www.iberlibro.com/servlet/SearchResults?cm_sp=SearchF-_-topnav-_-Results&kn=${encodeURIComponent(query)}&sts=t`;
    try {
        console.log(`Buscant a Iberlibro: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

        const preus = await page.evaluate(() => {
            const elements = document.querySelectorAll('.item-price, .price');
            let resultats = [];
            elements.forEach(el => {
                let text = el.innerText.replace('EUR', '').replace('€', '').replace(',', '.').trim();
                let p = parseFloat(text);
                if (!isNaN(p) && p > 0) resultats.push(p);
            });
            return resultats;
        });
        return preus;
    } catch (e) {
        console.error('Error Iberlibro:', e.message);
        return [];
    }
}

app.get('/api/tassa', async (req, res) => {
    const { q, isbn, titol, autor } = req.query;
    let query = q || isbn || `${titol || ''} ${autor || ''}`.trim();

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

        const [preusTC, preusIber] = await Promise.all([
            scrapeTodocoleccion(page, query),
            scrapeIberlibro(page, query)
        ]);

        const allPrices = [...preusTC, ...preusIber].sort((a, b) => a - b);
        const uniquePrices = [...new Set(allPrices)];

        res.json({
            terme: query,
            comptador: uniquePrices.length,
            min: uniquePrices.length > 0 ? uniquePrices[0] : null,
            max: uniquePrices.length > 0 ? uniquePrices[uniquePrices.length - 1] : null,
            mitjana: uniquePrices.length > 0 ? (uniquePrices.reduce((a, b) => a + b, 0) / uniquePrices.length).toFixed(2) : null,
            preus: uniquePrices,
            fonts: { tc: preusTC.length, iberlibro: preusIber.length }
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
