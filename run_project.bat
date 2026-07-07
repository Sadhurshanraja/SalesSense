@echo off
echo Starting SalesSense Backend...
start cmd /k "cd backend && python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000"

echo Starting SalesSense Frontend...
start cmd /k "cd frontend && npm run dev"

echo Both servers are starting in separate windows.
pause
