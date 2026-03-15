const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function similarity(s1, s2) {
    if (!s1 || !s2) return 0;
    const n1 = s1.toLowerCase();
    const n2 = s2.toLowerCase();
    let common = 0;
    const words = n1.split(/\s+/);
    words.forEach(w => { if (w.length > 2 && n2.includes(w)) common++; });
    return common / words.length;
}

async function test() {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const query = '9788420658827';
    const targetTitle = 'Mala hierba';
    
    console.log('Testing Todocoleccion...');
    const urlTC = `https://www.todocoleccion.net/s/catalogo-libros?t=${encodeURIComponent(query)}`;
    await page.goto(urlTC, { waitUntil: 'networkidle2' });
    const resTC = await page.evaluate(() => {
        const items = document.querySelectorAll('.lote, .js-lot-container, .lot-box, .card-lot');
        let data = [];
        items.forEach(item => {
            const titleEl = item.querySelector('.js-lot-titles, .title, [id^="lot-title-"]');
            const priceEl = item.querySelector('.precio-actual, .price-main, .lote-precio, .item-price');
            if (titleEl && priceEl) {
                data.push({ title: titleEl.innerText.trim(), price: priceEl.innerText });
            }
        });
        return data;
    });
    console.log('TC Results:', resTC);

    console.log('Testing Iberlibro...');
    const urlIber = `https://www.iberlibro.com/servlet/SearchResults?kn=${encodeURIComponent(query)}&sts=t`;
    await page.goto(urlIber, { waitUntil: 'networkidle2' });
    const resIber = await page.evaluate(() => {
        const items = document.querySelectorAll('.result-item, .item-display, [data-testid="listing-container"], .srp-item');
        let data = [];
        items.forEach(item => {
            const titleEl = item.querySelector('[data-testid="listing-title"], .item-title, [itemprop="name"]');
            const priceEl = item.querySelector('[data-testid="listing-price"], .item-price, .price');
            if (titleEl && priceEl) {
                data.push({ title: titleEl.innerText.trim(), price: priceEl.innerText });
            }
        });
        return data;
    });
    console.log('Iberlibro Results:', resIber);

    await browser.close();
}

test();
