# Imatge base amb Node.js i Chrome preinstal·lat (necessari per Puppeteer)
FROM ghcr.io/puppeteer/puppeteer:22.6.0

# Directori de treball
WORKDIR /app

# Copiar fitxers de dependències
COPY package*.json ./

# Instal·lar dependències (sense descarregar Chrome extra, ja el tenim)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci --omit=dev

# Copiar el codi
COPY server.js ./

# El port es configura per Railway via variable d'entorn PORT
EXPOSE 3001

# Engegar el servidor
CMD ["node", "server.js"]
