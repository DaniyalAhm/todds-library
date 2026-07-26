.PHONY: dev dev-backend dev-frontend dev-db migrate migrate-auto \
        lint typecheck clean docker-up docker-down docker-logs docker-rebuild \
        docker-ps docker-build bootstrap

# ── Development (host machine) ─────────────────────────
dev-db:
	@echo "Starting PostgreSQL, Redis, and MeiliSearch..."
	docker compose up -d postgres redis meilisearch

dev-backend:
	cd apps/backend && uvicorn app.main:app --reload --host 0.0.0.0 --port 8830

dev-frontend:
	pnpm --filter frontend dev

dev: dev-db
	@echo "Starting backend and frontend in parallel..."
	@$(MAKE) dev-backend & $(MAKE) dev-frontend & wait

# ── Docker Compose (development) ──────────────────────
docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f

docker-rebuild:
	docker compose build --no-cache
	docker compose up -d

docker-ps:
	docker compose ps

# ── Build (standalone images) ─────────────────────────
build:
	docker build -f apps/backend/Dockerfile -t todds-library-backend apps/backend
	docker build -f apps/frontend/Dockerfile -t todds-library-frontend .

# ── Database ──────────────────────────────────────────
migrate:
	cd apps/backend && alembic upgrade head

migrate-auto:
	cd apps/backend && alembic revision --autogenerate -m "$(msg)"

# ── Linting & Types ───────────────────────────────────
lint:
	pnpm lint

typecheck:
	pnpm typecheck

# ── Clean ─────────────────────────────────────────────
clean:
	pnpm clean
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .venv -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .next -exec rm -rf {} + 2>/dev/null || true

clean-docker:
	docker compose down -v

# ── Bootstrap ─────────────────────────────────────────
bootstrap:
	@echo "Installing Python dependencies..."
	cd apps/backend && pip install -e ".[dev]"
	@echo "Installing Node.js dependencies..."
	pnpm install
	@echo "Running database migrations..."
	cd apps/backend && alembic upgrade head
	@echo "Done!"
	@echo ""
	@echo "Quick start:"
	@echo "  make dev       — run everything on host machine"
	@echo "  docker-up      — run all services in Docker"
