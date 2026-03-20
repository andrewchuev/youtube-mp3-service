cd D:\Projects\internal\youtube-mp3-service\frontend
npm install
Set-Content .env.local "NEXT_PUBLIC_API_BASE_URL=http://localhost:8000"
npm run dev