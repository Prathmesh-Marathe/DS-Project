FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --no-package-lock --omit=dev
COPY . .
EXPOSE 5000
CMD ["node", "index.js"]
