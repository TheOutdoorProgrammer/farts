BIN := $(HOME)/bin/farts

.PHONY: build image test

build:
	npm ci --no-audit --no-fund
	npm run build
	goreleaser release --snapshot --clean --skip=publish

image: build
	docker build --build-arg VERSION="$$(jq -r .version release/metadata.json)" --build-arg COMMIT="$$(git rev-parse HEAD)" -t farts:local .

test:
	go test -race ./...
	go vet ./...
	npm test
