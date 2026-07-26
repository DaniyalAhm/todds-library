#!/bin/sh
set -e

echo "Running database migrations..."
alembic upgrade head

if [ "${DEV_MODE:-false}" = "true" ]; then
    echo "Starting development server with reload..."
    exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --reload
else
    echo "Starting production server..."
    exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers "${UVICORN_WORKERS:-4}"
fi
