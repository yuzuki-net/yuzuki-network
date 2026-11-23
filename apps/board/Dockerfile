FROM docker.io/oven/bun:1.4.5-alpine AS bun

FROM docker.io/library/rust:1.100-alpine3.24 AS builder

RUN apk add --no-cache libstdc++
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY apps/client/ apps/client/
COPY apps/node/ apps/node/
COPY crates/ crates/
COPY config/cores.toml config/cores.toml
COPY apps/board/Cargo.toml apps/board/build.rs apps/board/
COPY apps/board/src/ apps/board/src/
COPY apps/board/frontend/*.html apps/board/frontend/*.json apps/board/frontend/*.ts apps/board/frontend/bun.lock apps/board/frontend/
COPY apps/board/frontend/src/ apps/board/frontend/src/

RUN cargo build --locked --release --package board

FROM docker.io/library/alpine:3.24

RUN apk add --no-cache ca-certificates \
    && addgroup -S board \
    && adduser -S -G board board
COPY --from=builder /src/target/release/board /usr/local/bin/board

ENV YUZUKI_BIND=0.0.0.0:3000
EXPOSE 3000
USER board
STOPSIGNAL SIGINT
ENTRYPOINT ["board"]
CMD ["serve"]
