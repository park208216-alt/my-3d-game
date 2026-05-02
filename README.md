# my-3d-game deployment

This project runs as:
- Frontend (Vite + Three.js) -> deploy to Vercel
- Multiplayer socket server (Node + Socket.IO) -> deploy to Render

## 1) Push project to GitHub

```bash
git init
git add .
git commit -m "Initial multiplayer prototype"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

## 2) Deploy socket server on Render

1. Open [https://render.com](https://render.com) and create a **Web Service**
2. Connect the GitHub repo
3. Use these settings:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm run server`
4. Add environment variable:
   - `CLIENT_ORIGIN=*` (quick start)
   - Later you can set this to your Vercel domain for tighter security
5. Deploy and copy service URL, e.g.
   - `https://my-3d-game-socket.onrender.com`

Health check endpoint:
- `https://<your-render-url>/health`

## 3) Deploy frontend on Vercel

1. Open [https://vercel.com](https://vercel.com) and import the same repo
2. Framework preset: `Vite`
3. Add environment variable in Vercel project settings:
   - `VITE_SOCKET_URL=https://<your-render-url>`
4. Deploy

## 4) Verify multiplayer

1. Open the Vercel URL on two different devices/networks
2. Click into each game view to lock mouse
3. Move with WASD and confirm both clients see each other

## 5) Local development (unchanged)

```bash
npm run server
npm run dev -- --port 5175
```

If you are using ngrok during local testing, run only one tunnel for Vite:

```bash
ngrok http 5175
```

