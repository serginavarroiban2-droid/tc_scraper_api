const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

// Health check per Railway
app.get('/', (req, res) => {
    res.json({ status: 'ok', servei: 'TC Radar de Preus' });
});

async function extreurePreusTC(termeCerca) {
    // Quan corre al Docker de Railway, el Chrome és al path estàndard de la imatge puppeteer
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    const browser = await puppeteer.launch({ 
        headless: 'new',
        executablePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
        ] 
    });
    const page = await browser.newPage();

    const url = `https://www.todocoleccion.net/s/catalogo-libros?t=${encodeURIComponent(termeCerca)}`;

    try {
        console.log(`Buscant a TC: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Esperem una mica aleatòriament com un humà
        const waitTime = Math.floor(Math.random() * 2000) + 1000;
        await new Promise(r => setTimeout(r, waitTime));

        const preus = await page.evaluate(() => {
            const elementsPreu = document.querySelectorAll('.item-price, .price, .price-value, [data-price]');
            
            let llistaPreus = [];
            
            elementsPreu.forEach(el => {
                let textPreu = el.innerText || el.getAttribute('data-price') || '';
                if (!textPreu) return;
                
                textPreu = textPreu.replace('€', '').replace(',', '.').trim();
                let preuNumeric = parseFloat(textPreu);
                
                if (!isNaN(preuNumeric) && preuNumeric > 0) {
                    llistaPreus.push(preuNumeric);
                }
            });
            
            return llistaPreus;
        });

        await browser.close();
        
        return [...new Set(preus)].sort((a, b) => a - b);

    } catch (error) {
        console.error('Error durant el scraping:', error);
        await browser.close();
        return [];
    }
}

app.get('/api/tassa', async (req, res) => {
    const { q } = req.query;
    if (!q) {
        return res.status(400).json({ error: 'Falta el paràmetre "q"' });
    }

    try {
        const prices = await extreurePreusTC(q);
        res.json({
            terme: q,
            preus: prices,
            comptador: prices.length,
            min: prices.length > 0 ? prices[0] : null,
            max: prices.length > 0 ? prices[prices.length - 1] : null,
            mitjana: prices.length > 0 ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : null
        });
    } catch (error) {
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// Railway assigna el PORT via variable d'entorn
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Radar de preus en marxa al port ${PORT}`);
});
