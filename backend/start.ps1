cd D:\Projects\internal\youtube-mp3-service\backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
mkdir data -ErrorAction SilentlyContinue
$env:APP_DATA_DIR = (Resolve-Path .\data).Path
$env:CORS_ALLOWED_ORIGINS = "http://localhost:3000"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000