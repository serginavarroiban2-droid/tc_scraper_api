const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', servei: 'TC Radar de Preus', versio: '3.1.0' });
});

// =====================================================
// VALIDACIÓ D'ISBN
// Un ISBN vàlid té 10 o 13 dígits (pot tenir un X al final en ISBN-10)
// "S/I-64854040" NO és vàlid. "9788420412146" SÍ.
// =====================================================
function isValidIsbn(isbn) {
    if (!isbn) return false;
    const cleaned = isbn.replace(/[-\s]/g, '');
    // ISBN-13: 13 dígits
    if (/^\d{13}$/.test(cleaned)) return true;
    // ISBN-10: 9 dígits + (dígit o X)
    if (/^\d{9}[\dXx]$/.test(cleaned)) return true;
    return false;
}

// =====================================================
// FILTRE DE RELLEVÀNCIA
// Compara el títol del resultat amb el títol cercat.
// Retorna un score de 0 a 1. Mínim 0.25 per acceptar.
// =====================================================
function relevanceScore(resultTitle, searchTitle) {
    if (!resultTitle || !searchTitle) return 0;
    
    const stopWords = new Set([
        'la', 'lo', 'el', 'un', 'una', 'de', 'del', 'en', 'y', 'a', 
        'con', 'por', 'para', 'los', 'las', 'les', 'al', 'se', 'su',
        'o', 'e', 'i', 'the', 'of', 'and', 'in', 'to',
        // Paraules massa genèriques en context TC
        'libro', 'libros', 'segunda', 'mano', 'edición', 'edicion',
        'editorial', 'tomo', 'vol', 'volumen',
    ]);
    
    // Normalitzar: minúscules, treure puntuació, accents simplificats
    const normalize = (s) => s.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // treure accents
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()'"¿¡\[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    const n1 = normalize(searchTitle);
    const n2 = normalize(resultTitle);
    
    // Extracció de paraules significatives (>2 lletres, no stop words)
    const words1 = n1.split(' ').filter(w => w.length > 2 && !stopWords.has(w));
    const words2 = n2.split(' ').filter(w => w.length > 2 && !stopWords.has(w));
    
    if (words1.length === 0) return 0;
    
    // Comptar paraules del títol cercat que apareixen al resultat
    let matches = 0;
    for (const w of words1) {
        // Cercar com a substring (per capturar plurals, etc.)
        if (words2.some(w2 => w2.includes(w) || w.includes(w2))) {
            matches++;
        }
    }
    
    const score = matches / words1.length;
    return score;
}

// =====================================================
// FUNCIO AUXILIAR: Acceptar cookies de TC
// =====================================================
async function acceptCookies(page) {
    try {
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
async function scrapeTodocoleccion(page, query) {
    const url = `https://www.todocoleccion.net/buscador?bu=${encodeURIComponent(query)}`;
    try {
        console.log(`[TC] Buscant: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await acceptCookies(page);
        await new Promise(r => setTimeout(r, 2000));

        const resultats = await page.evaluate(() => {
            const items = document.querySelectorAll('.card-lote[data-testid]');
            let data = [];
            
            items.forEach(item => {
                const linkEl = item.querySelector('a.js-lot-titles, a[id^="lot-title-"]');
                const priceEl = item.querySelector('span.card-price');
                const catEl = item.querySelector('a.fs-14.text-gray-500');
                const imgEl = item.querySelector('img');

                if (linkEl && priceEl) {
                    const title = linkEl.getAttribute('title') || linkEl.textContent.trim();
                    let priceText = priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.').trim();
                    let price = parseFloat(priceText);
                    let href = linkEl.getAttribute('href') || '';
                    if (href && !href.startsWith('http')) {
                        href = 'https://www.todocoleccion.net' + href;
                    }
                    const lotId = item.getAttribute('data-testid') || '';
                    const category = catEl ? catEl.textContent.trim() : '';
                    const image = imgEl ? (imgEl.getAttribute('src') || '') : '';

                    if (!isNaN(price) && price > 0 && title.length > 0) {
                        data.push({ title, price, url: href, lotId, category, image, source: 'Todocoleccion' });
                    }
                }
            });
            
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
// SCRAPER IBERLIBRO
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
                    let title = titleEl.innerText || titleEl.textContent || '';
                    title = title.trim();
                    let priceText = priceEl.innerText || priceEl.textContent || '';
                    priceText = priceText.replace(/[^\d.,]/g, '').replace(',', '.').trim();
                    let price = parseFloat(priceText);
                    let href = linkEl ? linkEl.href : '';
                    
                    if (!isNaN(price) && price > 0 && title.length > 0) {
                        data.push({ title, price, url: href, source: 'Iberlibro' });
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
    
    // ---- LÒGICA DE CONSTRUCCIÓ DE QUERY ----
    // A TC l'ISBN funciona molt malament perquè gairebé cap venedor l'introdueix bé.
    // L'usuari ha demanat prioritzar SEMPRE la cerca per Títol + Autor si estan disponibles.
    
    const cleanIsbn = isbn ? isbn.replace(/[-\s]/g, '') : '';
    const hasValidIsbn = isValidIsbn(cleanIsbn);
    const titleForSearch = (titol || '').trim();
    const authorForSearch = (autor || '').trim();
    
    let query = '';
    let searchStrategy = '';
    
    if (titleForSearch) {
        // Cerca òptima per gairebé tot arreu són títol + autor
        query = authorForSearch ? `${titleForSearch} ${authorForSearch}` : titleForSearch;
        searchStrategy = 'TÍTOL+AUTOR';
    } else if (hasValidIsbn) {
        // Només buscar per ISBN si no tenim absolutament res més (cas rar a l'app)
        query = cleanIsbn;
        searchStrategy = 'NOMÉS ISBN';
    } else {
        return res.status(400).json({ 
            error: 'No es pot fer la cerca: falta títol per buscar i ISBN és invàlid o absent.',
            isbn_rebut: isbn,
            isbn_valid: false 
        });
    }

    console.log(`\n========== NOVA TASSACIÓ ==========`);
    console.log(`  ISBN rebut: "${isbn}" → Vàlid: ${hasValidIsbn}`);
    console.log(`  Títol: "${titleForSearch}"`);
    console.log(`  Autor: "${authorForSearch}"`);
    console.log(`  Query final: "${query}" (estratègia: ${searchStrategy})`);

    const browser = await puppeteer.launch({ 
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
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
        let allResults = [...tcItems, ...ibItems];
        
        // ---- FILTRE DE RELLEVÀNCIA ----
        // Si busquem per títol (no per ISBN), filtrar resultats no rellevants
        // Quan busques per ISBN, TC ja retorna resultats precisos
        const unfilteredCount = allResults.length;
        
        if (titleForSearch && allResults.length > 0) {
            const MIN_RELEVANCE = 0.25; // Mínim 25% de paraules en comú
            
            allResults = allResults.map(r => ({
                ...r,
                relevance: relevanceScore(r.title, titleForSearch)
            }));
            
            // Log de rellevància per depuració
            console.log('\n  --- Rellevància dels resultats ---');
            allResults.forEach(r => {
                const passFail = r.relevance >= MIN_RELEVANCE ? '✅' : '❌';
                console.log(`  ${passFail} ${r.relevance.toFixed(2)} | ${r.title.substring(0, 60)}`);
            });
            
            allResults = allResults.filter(r => r.relevance >= MIN_RELEVANCE);
            console.log(`  Filtrats: ${unfilteredCount} → ${allResults.length} (mínim rellevància: ${MIN_RELEVANCE})`);
        }
        
        // Ordenar per preu i agafar els 30 millors
        const sortedResults = allResults.sort((a, b) => a.price - b.price).slice(0, 30);
        const prices = sortedResults.map(r => r.price);

        const response = {
            terme: query,
            estrategia: searchStrategy,
            llibre: { titol: titol || '', autor: autor || '', isbn: isbn || '' },
            comptador: sortedResults.length,
            totalTC: resTC.totalLots || '0',
            filtrats: unfilteredCount - sortedResults.length,
            min: prices.length > 0 ? prices[0] : null,
            max: prices.length > 0 ? prices[prices.length - 1] : null,
            mitjana: prices.length > 0 ? parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)) : null,
            results: sortedResults,
            fonts: { tc: tcItems.length, iberlibro: ibItems.length }
        };
        
        console.log(`========== RESULTAT: ${sortedResults.length} rellevants de ${unfilteredCount}, preu mitjà: ${response.mitjana}€ ==========\n`);
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
    console.log(`\n🚀 Radar de Preus v3.1 actiu al port ${PORT}`);
    console.log(`   Endpoint: http://localhost:${PORT}/api/tassa?isbn=9788420412146`);
    console.log(`   Endpoint: http://localhost:${PORT}/api/tassa?titol=quijote&autor=cervantes\n`);
});
