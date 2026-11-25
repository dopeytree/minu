FROM node:22-alpine
# bash is only here so Dockge's and Unraid's console buttons work
RUN apk add --no-cache bash
WORKDIR /app
COPY package.json server.js ws.js auth.js term.js ./
COPY public ./public
ENV HOST=0.0.0.0
ENV PORT=8787
ENV MINU_DATA=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "server.js"]
